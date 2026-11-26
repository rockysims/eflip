// ledger.js: the derived, durable view of each character's ESI data, under
// <dataDir>/ledger/<characterId>/. It is rebuilt from data/raw/ by derive.js and extended
// incrementally by sync.js; both go through the functions here, which is what keeps the two paths
// byte-identical.
//
//   transactions.json, journal.json, orders-history.json, contracts.json
//       arrays merged by transaction_id / id / order_id / contract_id. Rows only accumulate (ESI
//       forgets wallet rows after about 30 days, the ledger does not), and a row seen again
//       replaces the old one, so an order's or contract's status is last-write-wins. Always
//       sorted by id, whatever the order they arrived in.
//   contract-items/<contractId>.json   the items of a contract, fetched once and never again
//   snapshots/<syncedAt>.json          {syncedAt, orders, assets, balance}, one per sync, skipped
//                                      when its content hash equals the previous snapshot's
//   profile.json                       {fetchedAt, skills, standings}
//   order-log.json                     {<orderId>: {...}}: every order seen in the open-order answers,
//                                      with its price path and how it ended (derive.js foldOrders)
// and, for all characters at once, <dataDir>/ledger/structures.json: structure names by id, and
// <dataDir>/ledger/market/<regionId>/<typeId>.json.gz: the book log of one type in one region, its
// check times and every order's price path (derive.js foldBook). Book logs are the one gzipped
// ledger file (bookLogText inside, so the stable text is what compares); a plain `<typeId>.json`
// from before is still read, and replaced by the gzipped file the next time the log is written.
//
// Rows are stored as ESI sent them (extra fields included): nothing is dropped or renamed.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, readJsonFile, readFirstJsonFile, firstFileOf, gzipText, hashJson, stampToFileName, fileNameToStamp } = require('./dataFiles');

// The four merged files: ledger file name, row key, and the since-filter field (ISO date).
const KINDS = Object.freeze({
	transactions: { key: 'transaction_id', dateField: 'date' },
	journal: { key: 'id', dateField: 'date' },
	'orders-history': { key: 'order_id', dateField: 'issued' },
	contracts: { key: 'contract_id', dateField: 'date_issued' },
});

// Which ledger view a raw route slug feeds. Slugs come from esi.js `slugFor`.
const SLUG_PATTERNS = [
	[/^wallet-transactions(?:-from-id-\d+)?$/, 'transactions'],
	[/^wallet-journal(?:-page-\d+)?$/, 'journal'],
	[/^orders-history(?:-page-\d+)?$/, 'orders-history'],
	[/^contracts(?:-page-\d+)?$/, 'contracts'],
	[/^contracts-(\d+)-items$/, 'contract-items'],
	[/^orders$/, 'orders'],
	[/^assets(?:-page-\d+)?$/, 'assets'],
	[/^wallet$/, 'wallet'],
	[/^skills$/, 'skills'],
	[/^standings$/, 'standings'],
	[/^universe-structures-(\d+)$/, 'structure'],
];
// {kind, id?} for a route slug, or null for a route the ledger does not use.
const classifySlug = (slug) => {
	for (const [pattern, kind] of SLUG_PATTERNS) {
		const m = pattern.exec(slug);
		if (m) return m[1] === undefined ? { kind } : { kind, id: m[1] };
	}
	return null;
};

// ---- pure merging (shared by sync and derive)

const compareKeys = (a, b) => {
	const x = Number(a);
	const y = Number(b);
	if (Number.isFinite(x) && Number.isFinite(y) && x !== y) return x - y;
	return a < b ? -1 : a > b ? 1 : 0;
};

// Rows by key. `overlay` adds rows to the map; a row with a key already there replaces it.
const rowMap = (rows, key) => {
	const map = new Map();
	overlay(map, rows, key);
	return map;
};
const overlay = (map, rows, key) => {
	let added = 0;
	let changed = 0;
	for (const row of rows) {
		if (row === null || typeof row !== 'object' || row[key] === undefined || row[key] === null) continue;
		const id = String(row[key]);
		const before = map.get(id);
		if (before === undefined) added++;
		else if (JSON.stringify(before) !== JSON.stringify(row)) changed++;
		map.set(id, row);
	}
	return { added, changed };
};
const sortedRows = (map) => [...map.entries()].sort((a, b) => compareKeys(a[0], b[0])).map(entry => entry[1]);

const mergeRows = (existing, incoming, key) => {
	const map = rowMap(existing, key);
	const { added, changed } = overlay(map, incoming, key);
	return { rows: sortedRows(map), added, changed };
};

// One row per line: diffable, and far smaller than an indented dump.
const rowsText = (rows) => (rows.length === 0 ? '[]\n' : `[\n${rows.map(row => JSON.stringify(row)).join(',\n')}\n]\n`);

// The two logs are objects keyed by order id, which JS would not keep in numeric order (ids past
// 2^32 are ordinary strings), so they are written by hand: one order per line in id order, each
// value with its keys sorted. A log folded step by step and one folded in one go from the same
// records then land on the same bytes, whatever order the keys were created in.
const stableText = (value) => {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableText).join(',')}]`;
	return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${stableText(value[key])}`).join(',')}}`;
};
const keyedBody = (map) => {
	const keys = Object.keys(map).sort(compareKeys);
	return keys.length === 0 ? '{}' : `{\n${keys.map(key => `${JSON.stringify(key)}:${stableText(map[key])}`).join(',\n')}\n}`;
};
const orderLogText = (log) => `${keyedBody(log)}\n`;
const bookLogText = (log) => `{\n"samples":${log.samples.length === 0 ? '[]' : `[\n${log.samples.map(stableText).join(',\n')}\n]`},\n"orders":${keyedBody(log.orders)}\n}\n`;

const snapshotHash = (snapshot) => hashJson({ orders: snapshot.orders, assets: snapshot.assets, balance: snapshot.balance });

const sortedKeys = (object) => Object.keys(object).sort(compareKeys);

const onOrAfter = (value, sinceMs) => {
	if (sinceMs === null) return true;
	const t = Date.parse(value);
	return Number.isFinite(t) ? t >= sinceMs : true;
};

const createLedger = ({ dataDir, root = path.join(path.resolve(dataDir), 'ledger') }) => {
	const dirOf = (characterId) => path.join(root, String(Number(characterId)));
	const fileOf = (characterId, name) => path.join(dirOf(characterId), `${name}.json`);
	const kindOf = (name) => {
		if (!Object.hasOwn(KINDS, name)) throw new Error(`ledger: unknown file ${name}`);
		return KINDS[name];
	};

	const exists = (characterId) => fs.existsSync(dirOf(characterId));

	const readRows = (characterId, name) => {
		kindOf(name);
		return readJsonFile(fileOf(characterId, name)) || [];
	};

	// Replaces a file with `rows` (already merged and sorted).
	const writeRows = (characterId, name, rows) => {
		kindOf(name);
		writeFileAtomic(fileOf(characterId, name), rowsText(rows));
	};

	// Merges `incoming` into the file and writes it. {added, changed, total}: ids new to the file,
	// ids whose row differs from the stored one, and the file's row count.
	const mergeInto = (characterId, name, incoming) => {
		const { key } = kindOf(name);
		const { rows, added, changed } = mergeRows(readRows(characterId, name), incoming, key);
		writeRows(characterId, name, rows);
		return { added, changed, total: rows.length };
	};

	const contractItemsFile = (characterId, contractId) => path.join(dirOf(characterId), 'contract-items', `${Number(contractId)}.json`);
	const hasContractItems = (characterId, contractId) => fs.existsSync(contractItemsFile(characterId, contractId));
	const writeContractItems = (characterId, contractId, items) => {
		writeFileAtomic(contractItemsFile(characterId, contractId), rowsText(items));
	};
	const readContractItems = (characterId) => {
		const dir = path.join(dirOf(characterId), 'contract-items');
		let names;
		try {
			names = fs.readdirSync(dir);
		} catch (e) {
			if (e.code === 'ENOENT') return {};
			throw e;
		}
		const out = {};
		for (const name of names.filter(n => /^\d+\.json$/.test(n)).sort(compareKeys)) {
			out[name.replace(/\.json$/, '')] = readJsonFile(path.join(dir, name));
		}
		return out;
	};

	const snapshotsDir = (characterId) => path.join(dirOf(characterId), 'snapshots');
	const snapshotStamps = (characterId) => {
		let names;
		try {
			names = fs.readdirSync(snapshotsDir(characterId));
		} catch (e) {
			if (e.code === 'ENOENT') return [];
			throw e;
		}
		return names.map(fileNameToStamp).filter(stamp => stamp !== null).sort();
	};
	const readSnapshot = (characterId, stamp) => readJsonFile(path.join(snapshotsDir(characterId), stampToFileName(stamp)));
	const latestSnapshot = (characterId) => {
		const stamps = snapshotStamps(characterId);
		return stamps.length === 0 ? null : readSnapshot(characterId, stamps[stamps.length - 1]);
	};
	// Writes the snapshot unless its content equals the previous one's; true when written.
	const writeSnapshot = (characterId, snapshot) => {
		const previous = latestSnapshot(characterId);
		if (previous && snapshotHash(previous) === snapshotHash(snapshot)) return false;
		writeFileAtomic(path.join(snapshotsDir(characterId), stampToFileName(snapshot.syncedAt)), JSON.stringify(snapshot) + '\n');
		return true;
	};
	const readSnapshots = (characterId, { since = null } = {}) => snapshotStamps(characterId)
		.filter(stamp => onOrAfter(stamp, since))
		.map(stamp => readSnapshot(characterId, stamp));

	const readProfile = (characterId) => readJsonFile(fileOf(characterId, 'profile'));
	const writeProfile = (characterId, profile) => {
		writeFileAtomic(fileOf(characterId, 'profile'), JSON.stringify(profile, null, '\t') + '\n');
	};

	// The order log of a character, {} before there is one; the book log of one type in one region,
	// {samples: [], orders: {}} before there is one.
	const orderLogFile = (characterId) => fileOf(characterId, 'order-log');
	const hasOrderLog = (characterId) => fs.existsSync(orderLogFile(characterId));
	const readOrderLog = (characterId) => readJsonFile(orderLogFile(characterId)) || {};
	const writeOrderLog = (characterId, log) => {
		writeFileAtomic(orderLogFile(characterId), orderLogText(log));
	};
	// A book log is `<typeId>.json.gz`, or `<typeId>.json` written before logs were gzipped; the
	// gzipped file is the one read when both exist.
	const bookLogDir = (regionId) => path.join(root, 'market', String(Number(regionId)));
	const bookLogFiles = (regionId, typeId) => {
		const plain = path.join(bookLogDir(regionId), `${Number(typeId)}.json`);
		return [`${plain}.gz`, plain];
	};
	// The path of a book log's file as it is on disk, or null when there is none.
	const bookLogFile = (regionId, typeId) => {
		const found = firstFileOf(bookLogFiles(regionId, typeId));
		return found === null ? null : found.file;
	};
	const hasBookLog = (regionId, typeId) => bookLogFiles(regionId, typeId).some(file => fs.existsSync(file));
	const readBookLog = (regionId, typeId) => {
		const log = readFirstJsonFile(bookLogFiles(regionId, typeId));
		return { samples: (log && log.samples) || [], orders: (log && log.orders) || {} };
	};
	// Writes the gzipped file and removes a plain one left from before. Answers the bytes written
	// (compressed).
	const writeBookLog = (regionId, typeId, log) => {
		const [gz, plain] = bookLogFiles(regionId, typeId);
		const data = gzipText(bookLogText(log));
		writeFileAtomic(gz, data);
		fs.rmSync(plain, { force: true });
		return data.length;
	};
	// The size of a book log's file in bytes (compressed when gzipped); 0 when there is none.
	const bookLogBytes = (regionId, typeId) => {
		const found = firstFileOf(bookLogFiles(regionId, typeId));
		return found === null ? 0 : found.bytes;
	};
	// The type ids that have a book log in a region, ascending, each once whichever form it is in.
	const listBookLogs = (regionId) => {
		let names;
		try {
			names = fs.readdirSync(bookLogDir(regionId));
		} catch (e) {
			if (e.code === 'ENOENT') return [];
			throw e;
		}
		const ids = new Set(names.map(name => /^(\d+)\.json(?:\.gz)?$/.exec(name)).filter(m => m !== null).map(m => Number(m[1])));
		return [...ids].sort((a, b) => a - b);
	};

	const structuresFile = path.join(root, 'structures.json');
	const readStructures = () => readJsonFile(structuresFile) || {};
	const writeStructures = (structures) => {
		const out = {};
		for (const id of sortedKeys(structures)) out[id] = structures[id];
		writeFileAtomic(structuresFile, JSON.stringify(out, null, '\t') + '\n');
	};

	// Everything the results page reads for one character. `since` (ms, or null) keeps rows dated
	// on or after it; contract items follow the contracts kept.
	const readAll = (characterId, { since = null } = {}) => {
		const pick = (name) => {
			const { dateField } = KINDS[name];
			return readRows(characterId, name).filter(row => onOrAfter(row[dateField], since));
		};
		const contracts = pick('contracts');
		const items = readContractItems(characterId);
		const contractItems = {};
		for (const contract of contracts) {
			const list = items[String(contract.contract_id)];
			if (list !== undefined) contractItems[String(contract.contract_id)] = list;
		}
		return {
			transactions: pick('transactions'),
			journal: pick('journal'),
			ordersHistory: pick('orders-history'),
			contracts,
			contractItems,
			profile: readProfile(characterId),
		};
	};

	return {
		root,
		dirOf,
		exists,
		readRows,
		writeRows,
		mergeInto,
		hasContractItems,
		writeContractItems,
		readContractItems,
		snapshotStamps,
		readSnapshots,
		latestSnapshot,
		writeSnapshot,
		readProfile,
		writeProfile,
		hasOrderLog,
		readOrderLog,
		writeOrderLog,
		bookLogFile,
		hasBookLog,
		readBookLog,
		writeBookLog,
		bookLogBytes,
		listBookLogs,
		readStructures,
		writeStructures,
		readAll,
	};
};

module.exports = {
	KINDS,
	classifySlug,
	compareKeys,
	rowMap,
	overlay,
	sortedRows,
	mergeRows,
	rowsText,
	stableText,
	orderLogText,
	bookLogText,
	snapshotHash,
	createLedger,
};
