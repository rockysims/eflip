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
// and, for all characters at once, <dataDir>/ledger/structures.json: structure names by id.
//
// Rows are stored as ESI sent them (extra fields included): nothing is dropped or renamed.
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, readJsonFile, hashJson, stampToFileName, fileNameToStamp } = require('./dataFiles');

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
	snapshotHash,
	createLedger,
};
