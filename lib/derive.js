// derive.js: raw -> ledger. Rebuilds everything under data/ledger/ from data/raw/ alone, so a
// wrong rule is fixed by re-deriving, never by re-fetching (the Data principle).
//
// The invariant that matters: a rebuild gives byte-for-byte the ledger the incremental sync built.
// Both fold the same raw records through the same functions (ledger.js merging, the builders
// below) in the same order (fetchedAt, which esi.js keeps strictly increasing), and both write
// with the same text writers. test/derive.test.js checks exactly that.
//
// Snapshots come from the sync logs in data/raw/<id>/_sync-log/: each names the raw files that
// made up that sync's {orders, assets, balance}; a snapshot equal to the previous one is skipped.
// Structure names come from every character's universe-structures-<id> raw, newest answer wins.
//
// A rebuild is built beside the live ledger and swapped in, and a character with no raw at all is
// left alone (its ledger may predate the raw store).
//
// Two logs go beyond the retained snapshots (docs/order-monitor-plan.md, Data model). Both are
// folds: a pure function takes the log so far and one more observation, so sync.js applies it to
// the log on disk as answers arrive and a rebuild applies it to every raw record in order, and the
// two end on the same bytes.
//   order log   per character, <id>/order-log.json: foldOrders over every raw `orders` answer in
//               fetchedAt order, then applyHistory with the orders-history rows of the ledger
//               (state and remaining volume of an order that ended; null until its row is known).
//   book log    per region and type, market/<regionId>/<typeId>.json: foldBook over the checks of
//               the public book. A check is a stored raw record (`stored: true`) or an answer that
//               changed nothing (`stored: false`, a 304). The checks are named in the public sync
//               logs (`books`), which also say how many pages the book had and which raw page files
//               that check stored; a stored raw page no log names is a check of its own, and a log
//               entry written before `books` existed counts every type it lists as checked at its
//               syncedAt (stored when raw holds a page from its window). The hourly regional
//               snapshot (sync.js doSyncRegionBook) adds checks of its own, folded from the
//               regional order pages by updateBookLogWithRows; the rebuild below does not replay
//               those yet (see there).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createRawStore, acquireLock, ensureDir } = require('./dataFiles');
const { KINDS, classifySlug, rowMap, overlay, sortedRows, createLedger } = require('./ledger');
const { slugFor } = require('./esi');

// Slug of the n-th page (1-based) of the asset list; matches esi.js `slugFor`.
const assetSlug = (page) => (page === 1 ? 'assets' : `assets-page-${page}`);

// The snapshot a sync log entry describes, from the raw files it names; null when one is missing.
// refs: {orders: stamp, wallet: stamp, assets: [stamp per page, page 1 first]}.
const snapshotFromRefs = (raw, characterId, syncedAt, refs) => {
	if (!refs || !Array.isArray(refs.assets)) return null;
	const orders = raw.read(characterId, 'orders', refs.orders);
	const wallet = raw.read(characterId, 'wallet', refs.wallet);
	if (!orders || !wallet) return null;
	let assets = [];
	for (let i = 0; i < refs.assets.length; i++) {
		const page = raw.read(characterId, assetSlug(i + 1), refs.assets[i]);
		if (!page) return null;
		assets = assets.concat(page.body);
	}
	return { syncedAt, orders: orders.body, assets, balance: wallet.body };
};

// {fetchedAt, skills, standings} from the newest raw skills and standings; null with neither.
// fetchedAt is the newer of the two raw files, which is a fact about the data held (a refresh that
// found nothing changed stores no file).
const profileFromRaw = (raw, characterId) => {
	const skills = raw.latest(characterId, 'skills');
	const standings = raw.latest(characterId, 'standings');
	if (!skills && !standings) return null;
	const stamps = [skills, standings].filter(Boolean).map(record => record.fetchedAt).sort();
	return {
		fetchedAt: stamps[stamps.length - 1],
		skills: skills ? (Array.isArray(skills.body && skills.body.skills) ? skills.body.skills : []) : null,
		standings: standings ? standings.body : null,
	};
};

// A structure's ledger entry: what ESI said, plus when and through which character.
const structureEntry = (record, characterId) => ({ ...record.body, fetchedAt: record.fetchedAt, characterId: Number(characterId) });

// ---- the order log

// Adds one raw `orders` record ({fetchedAt, body: open-order rows}) to the log. Per order id: the
// fixed facts at first sight, `path` (an entry only when price, volumeRemain or issued changed;
// `at` is the record's fetchedAt), and `end` once an answer no longer lists the order. `warnings`
// collects what should never happen: a volume that rose (an order's quantity cannot be raised, so
// a drop is always a fill) and an ended order that is listed again. Both are still recorded.
const foldOrders = (log, record, warnings = []) => {
	const at = record.fetchedAt;
	const listed = new Set();
	for (const row of record.body) {
		if (row === null || typeof row !== 'object' || row.order_id === undefined || row.order_id === null) continue;
		const id = String(row.order_id);
		listed.add(id);
		let entry = log[id];
		if (entry === undefined) {
			entry = log[id] = { typeId: row.type_id, locationId: row.location_id, regionId: row.region_id, isBuy: Boolean(row.is_buy_order), volumeTotal: row.volume_total, duration: row.duration, firstSeen: at, lastSeen: at, path: [], end: null };
		} else {
			if (entry.end !== null) {
				warnings.push({ orderId: row.order_id, at, kind: 'reappeared', endedAt: entry.end.at });
				entry.end = null;
			}
			entry.lastSeen = at;
		}
		const last = entry.path[entry.path.length - 1];
		if (last === undefined || last.price !== row.price || last.volumeRemain !== row.volume_remain || last.issued !== row.issued) {
			if (last !== undefined && row.volume_remain > last.volumeRemain) warnings.push({ orderId: row.order_id, at, kind: 'volume-rise', from: last.volumeRemain, to: row.volume_remain });
			entry.path.push({ at, price: row.price, volumeRemain: row.volume_remain, issued: row.issued });
		}
	}
	for (const [id, entry] of Object.entries(log)) {
		if (entry.end === null && !listed.has(id)) entry.end = { state: null, volumeRemain: null, at };
	}
	return log;
};

// Fills `end.state` and `end.volumeRemain` of every ended order from its orders-history row. Applied
// to the whole log each time, so it does not matter whether the row or the end arrived first.
const applyHistory = (log, historyRows) => {
	for (const row of historyRows) {
		if (row === null || typeof row !== 'object' || row.order_id === undefined || row.order_id === null) continue;
		const entry = log[String(row.order_id)];
		if (entry === undefined || entry.end === null) continue;
		entry.end.state = row.state === undefined ? null : row.state;
		entry.end.volumeRemain = row.volume_remain === undefined ? null : row.volume_remain;
	}
	return log;
};

// Folds every raw `orders` record of a character into a fresh log and writes it; no file when raw
// holds no `orders` record. Answers {orders: count, warnings}.
const buildOrderLog = ({ raw, ledger, characterId }) => {
	const id = Number(characterId);
	const stamps = raw.list(id, 'orders');
	if (stamps.length === 0) return { orders: 0, warnings: [] };
	const log = {};
	const warnings = [];
	for (const stamp of stamps) {
		const record = raw.read(id, 'orders', stamp);
		if (record && Array.isArray(record.body)) foldOrders(log, record, warnings);
	}
	applyHistory(log, ledger.readRows(id, 'orders-history'));
	ledger.writeOrderLog(id, log);
	return { orders: Object.keys(log).length, warnings };
};

// sync.js: the same folds on the log on disk. `records` are the `orders` answers stored since.
const updateOrderLog = ({ ledger, characterId, records = [] }) => {
	const log = ledger.readOrderLog(characterId);
	const warnings = [];
	for (const record of records) foldOrders(log, record, warnings);
	applyHistory(log, ledger.readRows(characterId, 'orders-history'));
	ledger.writeOrderLog(characterId, log);
	return { orders: Object.keys(log).length, warnings };
};

// A log that does not exist yet is built from the raw already stored, before the first new answer
// is folded into it (a data directory that predates the log). True when it was built.
const ensureOrderLog = ({ raw, ledger, characterId }) => {
	if (ledger.hasOrderLog(characterId) || raw.list(Number(characterId), 'orders').length === 0) return false;
	buildOrderLog({ raw, ledger, characterId });
	return true;
};

// ---- the book logs

// Slug of the n-th page of one type's book; matches esi.js `slugFor` (the query keys sort, so
// `page` comes before `type_id`).
const bookSlug = (regionId, typeId, page = 1) => slugFor(`/markets/${regionId}/orders`, page > 1 ? { type_id: typeId, page } : { type_id: typeId });
const BOOK_SLUG = /^markets-(\d+)-orders(?:-page-(\d+))?-type-id-(\d+)$/;

// One check of a book ({at, stored, rows}: rows are the whole book when it was stored, else null).
// Every check is a sample; a stored one also adds each order's path, with `at` as the check time.
const foldBook = (log, check) => {
	log.samples.push({ at: check.at, stored: check.stored });
	if (!check.stored) return log;
	for (const row of check.rows) {
		if (row === null || typeof row !== 'object' || row.order_id === undefined || row.order_id === null) continue;
		const id = String(row.order_id);
		let entry = log.orders[id];
		if (entry === undefined) {
			entry = log.orders[id] = { isBuy: Boolean(row.is_buy_order), locationId: row.location_id, systemId: row.system_id, volumeTotal: row.volume_total, duration: row.duration, minVolume: row.min_volume, range: row.range, firstSeen: check.at, lastSeen: check.at, path: [] };
		} else {
			entry.lastSeen = check.at;
		}
		const last = entry.path[entry.path.length - 1];
		if (last === undefined || last.price !== row.price || last.volumeRemain !== row.volume_remain || last.issued !== row.issued) {
			entry.path.push({ at: check.at, price: row.price, volumeRemain: row.volume_remain, issued: row.issued });
		}
	}
	return log;
};

// The raw pages of one book, read lazily: a stamp list per page (listed once) and the newest
// record of a page at or before a stamp.
const createBookReader = (raw, regionId, typeId) => {
	const stamps = new Map();
	const loaded = new Map();
	const stampsOf = (page) => {
		if (!stamps.has(page)) stamps.set(page, raw.list('public', bookSlug(regionId, typeId, page)));
		return stamps.get(page);
	};
	const recordAt = (page, limit) => {
		const list = stampsOf(page);
		let low = 0;
		let high = list.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (list[mid] <= limit) low = mid + 1;
			else high = mid;
		}
		if (low === 0) return null;
		const stamp = list[low - 1];
		const held = loaded.get(page);
		if (held && held.stamp === stamp) return held.record;
		const record = raw.read('public', bookSlug(regionId, typeId, page), stamp);
		loaded.set(page, { stamp, record });
		return record;
	};
	// The book as that check saw it: each page as of the newest page file the check stored, so a
	// page the check found unchanged (or did not ask for yet) is the one stored earlier. `pages` is
	// the page count the check recorded; without it pages are taken while a file exists.
	const rowsFor = (check) => {
		const limit = Object.values(check.stamps || {}).sort().pop();
		let rows = [];
		for (let page = 1; check.pages === null || check.pages === undefined || page <= check.pages; page++) {
			const record = recordAt(page, limit);
			if (!record) {
				if (check.pages === null || check.pages === undefined) break;
				continue;
			}
			if (Array.isArray(record.body)) rows = rows.concat(record.body);
		}
		return rows;
	};
	return { rowsFor };
};

// {region:type -> {regionId, typeId, pages: [page numbers with raw]}} for every book in raw.
const bookPages = (raw) => {
	const books = new Map();
	for (const slug of raw.slugs('public')) {
		const m = BOOK_SLUG.exec(slug);
		if (!m) continue;
		const regionId = Number(m[1]);
		const typeId = Number(m[3]);
		const key = `${regionId}:${typeId}`;
		if (!books.has(key)) books.set(key, { regionId, typeId, pages: [] });
		books.get(key).pages.push(m[2] === undefined ? 1 : Number(m[2]));
	}
	return books;
};

// The public sync logs, read once: the book checks they record by region:type (only the ones that
// are samples), and the entries written before `books` existed.
const indexPublic = (raw) => {
	const byKey = new Map();
	const old = [];
	for (const stamp of raw.syncLogStamps('public')) {
		const entry = raw.readSyncLog('public', stamp);
		if (!entry || typeof entry !== 'object') continue;
		if (!Array.isArray(entry.books)) {
			old.push(entry);
			continue;
		}
		for (const b of entry.books) {
			if (!b || (b.outcome !== 'stored' && b.outcome !== 'not-modified')) continue;
			const key = `${b.regionId}:${b.typeId}`;
			if (!byKey.has(key)) byKey.set(key, []);
			byKey.get(key).push(b);
		}
	}
	return { byKey, old };
};

// The checks of one book in time order, from the public sync logs and the raw page files.
const bookChecks = ({ raw, book, index }) => {
	const { regionId, typeId } = book;
	const pageStamps = new Map(book.pages.map(page => [page, raw.list('public', bookSlug(regionId, typeId, page))]));
	const used = new Set();
	const use = (page, stamp) => used.add(`${page}|${stamp}`);
	const checks = [];
	for (const b of index.byKey.get(`${regionId}:${typeId}`) || []) {
		const stamps = b.stamps && typeof b.stamps === 'object' ? b.stamps : {};
		for (const [page, stamp] of Object.entries(stamps)) use(Number(page), stamp);
		checks.push({ at: b.at, outcome: b.outcome, pages: Number.isInteger(b.pages) ? b.pages : null, stamps });
	}
	for (const entry of index.old) {
		if (!Array.isArray(entry.regionIds) || !entry.regionIds.includes(regionId) || !Array.isArray(entry.typeIds) || !entry.typeIds.includes(typeId)) continue;
		// written before `books`: the type was checked at syncedAt; stored when a page file falls in its window
		const from = entry.syncedAt;
		const to = entry.finishedAt || entry.syncedAt;
		const stamps = {};
		for (const [page, list] of pageStamps) {
			const inside = list.filter(stamp => stamp >= from && stamp <= to);
			if (inside.length > 0) {
				stamps[page] = inside[inside.length - 1];
				for (const stamp of inside) use(page, stamp);
			}
		}
		const first = pageStamps.get(1) || [];
		if (Object.keys(stamps).length > 0) checks.push({ at: stamps[1] || Object.values(stamps).sort()[0], outcome: 'stored', pages: null, stamps });
		else if (first.length > 0 && first[0] < from) checks.push({ at: from, outcome: 'not-modified', pages: null, stamps: {} });
	}
	for (const [page, list] of pageStamps) {
		for (const stamp of list) if (!used.has(`${page}|${stamp}`)) checks.push({ at: stamp, outcome: 'stored', pages: null, stamps: { [page]: stamp } });
	}
	return checks.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
};

const buildBookLog = ({ raw, book, index }) => {
	const reader = createBookReader(raw, book.regionId, book.typeId);
	const log = { samples: [], orders: {} };
	for (const check of bookChecks({ raw, book, index })) {
		const stored = check.outcome === 'stored';
		foldBook(log, { at: check.at, stored, rows: stored ? reader.rowsFor(check) : null });
	}
	return log;
};

// Every book in raw. Answers {logs: count}.
const buildBookLogs = ({ raw, ledger }) => {
	const books = bookPages(raw);
	if (books.size === 0) return { logs: 0 };
	const index = indexPublic(raw);
	const ordered = [...books.values()].sort((a, b) => a.regionId - b.regionId || a.typeId - b.typeId);
	for (const book of ordered) ledger.writeBookLog(book.regionId, book.typeId, buildBookLog({ raw, book, index }));
	return { logs: ordered.length };
};

// sync.js: the same fold on the log on disk, for the check just made ({at, outcome, pages,
// stamps}, as recorded in the sync log). Only a stored or an unchanged answer is a sample.
const updateBookLog = ({ raw, ledger, regionId, typeId, check }) => {
	const stored = check.outcome === 'stored';
	if (!stored && check.outcome !== 'not-modified') return false;
	const log = ledger.readBookLog(regionId, typeId);
	foldBook(log, { at: check.at, stored, rows: stored ? createBookReader(raw, regionId, typeId).rowsFor(check) : null });
	ledger.writeBookLog(regionId, typeId, log);
	return true;
};

// sync.js, the regional book job (doSyncRegionBook): the same fold for a check whose rows are in
// hand. A snapshot of a whole region's orders is cut into one book per type, and each is folded as
// a stored check at the snapshot's time: `rows` are that type's orders from the snapshot (every
// station, buy and sell: the rows a per-type `/markets/<region>/orders?type_id=` answer holds), and
// an empty list says the type's orders have all ended. Unlike updateBookLog this reads no per-type
// raw: these samples come from the regional pages (raw `markets-<region>-orders-order-type-all` and
// `-page-<n>`, which the book log rebuild does not look at), and the public sync log entry of the
// snapshot (`kind: 'regionBook'`) names the page files each snapshot was cut from (`pageStamps`).
// So a rebuild from per-type raw (buildBookLogs) does not reproduce these samples yet: it has to
// learn to replay the regional snapshots, in time order with the per-type checks, in P2.2.
// Answers the bytes the log now takes.
const updateBookLogWithRows = ({ ledger, regionId, typeId, at, rows }) => {
	const log = ledger.readBookLog(regionId, typeId);
	foldBook(log, { at, stored: true, rows });
	return ledger.writeBookLog(regionId, typeId, log);
};

// A book log that does not exist yet is built from the raw and the sync logs already stored,
// before the first new check is folded into it. True when it was built. `index` (indexPublic) may
// be handed in by a caller that builds several.
const ensureBookLog = ({ raw, ledger, regionId, typeId, index = null }) => {
	if (ledger.hasBookLog(regionId, typeId)) return false;
	const book = bookPages(raw).get(`${Number(regionId)}:${Number(typeId)}`);
	if (!book) return false;
	ledger.writeBookLog(book.regionId, book.typeId, buildBookLog({ raw, book, index: index || indexPublic(raw) }));
	return true;
};

const compareStamped = (a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

const randomName = () => crypto.randomBytes(6).toString('hex');

// Builds data/ledger/<id>/ from raw into `ledger` (a createLedger instance, possibly one rooted at
// a scratch directory). Answers counts, or {skipped} when there is no raw to build from.
const buildCharacter = ({ raw, ledger, characterId }) => {
	const id = Number(characterId);
	const entries = [];
	const slugs = raw.slugs(id);
	for (const slug of slugs) {
		const cls = classifySlug(slug);
		if (!cls || !(Object.hasOwn(KINDS, cls.kind) || cls.kind === 'contract-items')) continue;
		for (const stamp of raw.list(id, slug)) entries.push({ stamp, slug, cls });
	}
	const syncLogs = raw.syncLogStamps(id);
	if (slugs.length === 0 && syncLogs.length === 0) return { skipped: 'no raw data' };
	entries.sort(compareStamped);

	const maps = {};
	const items = new Map();
	for (const { stamp, slug, cls } of entries) {
		const record = raw.read(id, slug, stamp);
		if (!record || !Array.isArray(record.body)) continue;
		if (cls.kind === 'contract-items') {
			items.set(cls.id, record.body);
		} else {
			if (!maps[cls.kind]) maps[cls.kind] = new Map();
			overlay(maps[cls.kind], record.body, KINDS[cls.kind].key);
		}
	}

	const counts = { transactions: 0, journal: 0, ordersHistory: 0, contracts: 0, contractItems: items.size, snapshots: 0, profile: false };
	const countKey = { transactions: 'transactions', journal: 'journal', 'orders-history': 'ordersHistory', contracts: 'contracts' };
	for (const kind of Object.keys(maps)) {
		const rows = sortedRows(maps[kind]);
		ledger.writeRows(id, kind, rows);
		counts[countKey[kind]] = rows.length;
	}
	for (const [contractId, body] of items) ledger.writeContractItems(id, contractId, body);

	for (const syncedAt of syncLogs) {
		const entry = raw.readSyncLog(id, syncedAt);
		if (!entry || !entry.snapshot) continue;
		const snapshot = snapshotFromRefs(raw, id, entry.syncedAt, entry.snapshot);
		if (snapshot && ledger.writeSnapshot(id, snapshot)) counts.snapshots++;
	}

	const profile = profileFromRaw(raw, id);
	if (profile) {
		ledger.writeProfile(id, profile);
		counts.profile = true;
	}
	// after the rows: the log's orders-history overlay reads them back
	const orderLog = buildOrderLog({ raw, ledger, characterId: id });
	counts.orderLog = orderLog.orders;
	counts.orderLogWarnings = orderLog.warnings;
	return counts;
};

// The ledger's structures.json from every character's raw universe-structures-<id> files.
// Returns the number of structures, or null when there is no such raw (an existing file stays).
const buildStructures = ({ raw, ledger }) => {
	const entries = [];
	for (const owner of raw.owners()) {
		if (owner === 'public') continue;
		for (const slug of raw.slugs(owner)) {
			const cls = classifySlug(slug);
			if (!cls || cls.kind !== 'structure') continue;
			for (const stamp of raw.list(owner, slug)) entries.push({ stamp, slug, owner, id: cls.id });
		}
	}
	if (entries.length === 0) return null;
	entries.sort(compareStamped);
	const structures = {};
	for (const { stamp, slug, owner, id } of entries) {
		const record = raw.read(owner, slug, stamp);
		if (record && record.body && typeof record.body === 'object') structures[id] = structureEntry(record, owner);
	}
	ledger.writeStructures(structures);
	return Object.keys(structures).length;
};

// Rebuilds one character's ledger from raw: written to a scratch directory, then swapped in.
// The caller holds the character's lock (sync.js does; rebuildCharacter below takes it).
const rebuildCharacterLocked = ({ dataDir, characterId }) => {
	const raw = createRawStore({ dataDir });
	const live = createLedger({ dataDir });
	const scratchRoot = path.join(live.root, `.rebuild-${randomName()}`);
	const scratch = createLedger({ dataDir, root: scratchRoot });
	try {
		ensureDir(scratch.dirOf(characterId)); // raw that yields no rows still replaces the old ledger with an empty one
		const counts = buildCharacter({ raw, ledger: scratch, characterId });
		if (counts.skipped) return counts;
		const target = live.dirOf(characterId);
		const old = `${target}.old-${randomName()}`;
		if (fs.existsSync(target)) fs.renameSync(target, old);
		fs.renameSync(scratch.dirOf(characterId), target);
		fs.rmSync(old, { recursive: true, force: true });
		return counts;
	} finally {
		fs.rmSync(scratchRoot, { recursive: true, force: true });
	}
};

const rebuildCharacter = ({ dataDir, characterId }) => {
	const release = acquireLock(dataDir, `character-${Number(characterId)}`);
	if (!release) throw new Error(`derive: character ${characterId} is being synced; try again in a moment`);
	try {
		return rebuildCharacterLocked({ dataDir, characterId });
	} finally {
		release();
	}
};

// The book logs of every region and type with raw, written in place under the market lock (the
// watch refresh and the market snapshot hold it while they fold).
const rebuildBookLogs = ({ dataDir }) => {
	const release = acquireLock(dataDir, 'market');
	if (!release) throw new Error('derive: the market is being synced; try again in a moment');
	try {
		return buildBookLogs({ raw: createRawStore({ dataDir }), ledger: createLedger({ dataDir }) });
	} finally {
		release();
	}
};

// Every character with raw data, then the structure names and the book logs.
const rebuildAll = ({ dataDir, log = console }) => {
	const raw = createRawStore({ dataDir });
	const characters = {};
	for (const owner of raw.owners()) {
		if (owner === 'public') continue;
		characters[owner] = rebuildCharacter({ dataDir, characterId: owner });
		log.info(`derive: ${owner} rebuilt`);
	}
	const structures = buildStructures({ raw, ledger: createLedger({ dataDir }) });
	const books = rebuildBookLogs({ dataDir });
	if (books.logs > 0) log.info(`derive: ${books.logs} book logs rebuilt`);
	return { characters, structures, bookLogs: books.logs };
};

module.exports = {
	assetSlug,
	snapshotFromRefs,
	profileFromRaw,
	structureEntry,
	buildCharacter,
	buildStructures,
	foldOrders,
	applyHistory,
	buildOrderLog,
	updateOrderLog,
	ensureOrderLog,
	bookSlug,
	bookPages,
	indexPublic,
	foldBook,
	buildBookLogs,
	updateBookLog,
	updateBookLogWithRows,
	ensureBookLog,
	rebuildCharacterLocked,
	rebuildCharacter,
	rebuildBookLogs,
	rebuildAll,
};
