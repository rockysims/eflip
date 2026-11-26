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
//   book log    per region and type, market/<regionId>/<typeId>.json.gz: foldBook over the checks
//               of the public book. A check is a stored raw record (`stored: true`) or an answer that
//               changed nothing (`stored: false`, a 304). The checks are named in the public sync
//               logs (`books`), which also say how many pages the book had and which raw page files
//               that check stored; a stored raw page no log names is a check of its own, and a log
//               entry written before `books` existed counts every type it lists as checked at its
//               syncedAt (stored when raw holds a page from its window). The hourly regional
//               snapshot (sync.js doSyncRegionBook) adds checks of its own, folded from the
//               regional order pages by updateBookLogWithRows; its `kind: 'regionBook'` sync log
//               entry names the page files (`pageStamps`), and the rebuild replays those snapshots
//               in time order with the per-type checks (buildBookLogs).
//
// The storage budget (lib/storage.js) deletes the oldest public market raw and cuts the oldest
// history from the book logs. A rebuild then reproduces what raw still holds: a regional snapshot
// whose page files are gone, or a stored per-type check whose page file is gone, is skipped and
// counted, and the rebuilt log starts at the oldest raw that is left (the folded logs are the
// durable record beyond it, so a rebuild after trimming gives shorter logs than the live ones; which
// is why rebuildAll leaves the book logs alone unless asked).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createRawStore, acquireLock, ensureDir } = require('./dataFiles');
const { KINDS, classifySlug, overlay, sortedRows, createLedger, orderLogText } = require('./ledger');
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

// The time of the newest `orders` record folded into a log: every record that was folded left its
// stamp as the lastSeen of an order it listed or the end.at of one it ended, or changed nothing. ''
// for an empty log.
const orderLogAt = (log) => {
	let newest = '';
	for (const entry of Object.values(log)) {
		if (entry.lastSeen > newest) newest = entry.lastSeen;
		if (entry.end && entry.end.at > newest) newest = entry.end.at;
	}
	return newest;
};

// sync.js: the same folds on the log on disk. Raw says which `orders` answers are not in the log
// yet, with no state of its own: every record stamped after the newest time the log holds is folded,
// in stamp order (so an answer stored by a run killed before it folded is folded by the next), with
// buildOrderLog's guard against a body that is not a list. A record that changed nothing may be
// folded again, which changes nothing again. Written only when that or the history overlay changed
// the text (or there is no file yet).
const updateOrderLog = ({ raw, ledger, characterId }) => {
	const id = Number(characterId);
	const log = ledger.readOrderLog(id);
	const before = ledger.hasOrderLog(id) ? orderLogText(log) : null;
	const warnings = [];
	const since = orderLogAt(log);
	for (const stamp of raw.list(id, 'orders')) {
		if (stamp <= since) continue;
		const record = raw.read(id, 'orders', stamp);
		if (record && Array.isArray(record.body)) foldOrders(log, record, warnings);
	}
	applyHistory(log, ledger.readRows(id, 'orders-history'));
	if (orderLogText(log) !== before) ledger.writeOrderLog(id, log);
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

// ---- the regional snapshots (sync.js runRegionBook): what the rebuild replays and the budget trims

// Slug of the n-th page (1-based) of a region's whole book; matches esi.js `slugFor` (`order_type`
// sorts before `page`).
const regionPageSlug = (regionId, page = 1) => slugFor(`/markets/${regionId}/orders`, page > 1 ? { order_type: 'all', page } : { order_type: 'all' });
const REGION_PAGE_SLUG = /^markets-(\d+)-orders-order-type-all(?:-page-(\d+))?$/;

// The raw page files a regionBook sync log entry names, page 1 first: [{page, slug, stamp}].
const snapshotPages = (entry) => {
	const stamps = entry && Array.isArray(entry.pageStamps) ? entry.pageStamps : [];
	const out = [];
	stamps.forEach((stamp, i) => {
		if (typeof stamp === 'string') out.push({ page: i + 1, slug: regionPageSlug(entry.regionId, i + 1), stamp });
	});
	return out;
};

// Whether a regionBook entry is a snapshot the job folded: it ran to the end (no stop) and named a
// page file for every page. A partial or paused run folded nothing, so there is nothing to replay.
const snapshotFolded = (entry) => Boolean(entry) && entry.kind === 'regionBook' && !entry.stop
	&& typeof entry.fetchedAt === 'string' && Number.isSafeInteger(Number(entry.regionId))
	&& Array.isArray(entry.pageStamps) && entry.pageStamps.length > 0 && entry.pageStamps.length === entry.pages
	&& entry.pageStamps.every(stamp => typeof stamp === 'string');

// The regionBook entries of the public sync log, oldest first.
const regionBookEntries = (raw) => {
	const entries = [];
	for (const stamp of raw.syncLogStamps('public')) {
		const entry = raw.readSyncLog('public', stamp);
		if (entry && entry.kind === 'regionBook') entries.push(entry);
	}
	return entries;
};

// One snapshot's orders by type id, read page by page (a whole Domain snapshot is about 194 pages
// and 46 MB of JSON, so only one snapshot is held at a time), with the live fold's rule for a row
// (sync.js runRegionBook). null when a page file is gone or unreadable.
const snapshotRows = (raw, entry) => {
	const byType = new Map();
	for (const { slug, stamp } of snapshotPages(entry)) {
		let record = null;
		try {
			record = raw.read('public', slug, stamp);
		} catch (e) {
			record = null;
		}
		if (!record || !Array.isArray(record.body)) return null;
		for (const row of record.body) {
			if (row === null || typeof row !== 'object') continue;
			const typeId = Number(row.type_id);
			if (!Number.isSafeInteger(typeId) || typeId <= 0) continue;
			const rows = byType.get(typeId);
			if (rows === undefined) byType.set(typeId, [row]);
			else rows.push(row);
		}
	}
	return byType;
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
// are samples), the entries written before `books` existed, and the newest cutoff a storage run
// trimmed the per-type book raw at (`typeBooksCutoff`, null when none did).
const indexPublic = (raw) => {
	const byKey = new Map();
	const old = [];
	let typeBooksCutoff = null;
	for (const stamp of raw.syncLogStamps('public')) {
		const entry = raw.readSyncLog('public', stamp);
		if (!entry || typeof entry !== 'object') continue;
		// a regional snapshot or a storage run: no per-type check in it
		if (entry.kind !== undefined) {
			const cut = entry.kind === 'storage' && entry.trims && entry.trims.typeBooks ? entry.trims.typeBooks.cutoffAt : null;
			if (typeof cut === 'string' && (typeBooksCutoff === null || cut > typeBooksCutoff)) typeBooksCutoff = cut;
			continue;
		}
		if (!Array.isArray(entry.books)) {
			old.push(entry);
			continue;
		}
		for (const b of entry.books) {
			if (!b || (b.outcome !== 'stored' && b.outcome !== 'not-modified')) continue;
			const key = `${b.regionId}:${b.typeId}`;
			if (!byKey.has(key)) byKey.set(key, []);
			byKey.get(key).push({ ...b, logAt: entry.syncedAt });
		}
	}
	return { byKey, old, typeBooksCutoff };
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
		checks.push({ at: b.at, outcome: b.outcome, pages: Number.isInteger(b.pages) ? b.pages : null, stamps, logAt: b.logAt || null });
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

// The checks of one book a rebuild can replay: a stored check whose page file the storage budget
// trimmed is left out (its rows are gone), and counted. With all raw present nothing is left out.
// A page the check found unchanged was read from an older file, and the typeBooks trim (one cutoff
// for every route, keeping each route's newest file before it) can remove that file while keeping
// the check's own: the edge is an earlier check whose unchanged page a later check before the cutoff
// stored anew (the last check before the cutoff is always whole). So a check older than the newest
// cutoff a storage run recorded, with its page count known, also needs a file at or before its own
// newest stamp for every page; otherwise it is left out and counted rather than replayed with part
// of its book. Only for those: a check the order-call budget cut short also names more pages than it
// read, and with nothing trimmed it must be replayed short, as it was folded.
const replayableChecks = ({ raw, book, index }) => {
	const lists = new Map(book.pages.map(page => [page, raw.list('public', bookSlug(book.regionId, book.typeId, page))]));
	const held = new Map([...lists].map(([page, list]) => [page, new Set(list)]));
	const cutoff = index && index.typeBooksCutoff ? index.typeBooksCutoff : null;
	let skipped = 0;
	const checks = bookChecks({ raw, book, index }).filter(check => {
		if (check.outcome !== 'stored') return true;
		const stamps = Object.entries(check.stamps || {});
		let whole = stamps.every(([page, stamp]) => (held.get(Number(page)) || new Set()).has(stamp));
		const limit = stamps.map(([, stamp]) => stamp).sort().pop();
		if (whole && cutoff !== null && Number.isInteger(check.pages) && limit < cutoff) {
			for (let page = 1; whole && page <= check.pages; page++) whole = (lists.get(page) || [])[0] <= limit; // the lists are sorted
		}
		if (!whole) skipped++;
		return whole;
	});
	return { checks, skipped };
};

const buildBookLog = ({ raw, book, index }) => {
	const reader = createBookReader(raw, book.regionId, book.typeId);
	const log = { samples: [], orders: {} };
	for (const check of replayableChecks({ raw, book, index }).checks) {
		const stored = check.outcome === 'stored';
		foldBook(log, { at: check.at, stored, rows: stored ? reader.rowsFor(check) : null });
	}
	return log;
};

// Whether a per-type check came before a regional snapshot: by time, and at the same time by the
// order the sync log entries were written (a market step and the region book that follows it can
// start in the same millisecond; the log names them apart).
const checkBefore = (check, snapshot) => check.at < snapshot.fetchedAt || (check.at === snapshot.fetchedAt && (check.logAt || '') <= snapshot.syncedAt);

// The book logs of one region, from its per-type books and its regional snapshots, folded in time
// order on disk the way the live jobs fold them: each per-type check as sync.js fetchPairs does,
// each snapshot as runRegionBook does (a stored sample for every type in it, and an empty one for
// every type whose log exists by then but has no orders in it). One snapshot's rows are in memory
// at a time; the logs are read and written per snapshot, as the live fold does.
const buildRegionBookLogs = ({ raw, ledger, regionId, books, snapshots, index }) => {
	const pending = new Map(); // type id -> {checks, next, reader}
	let checksSkipped = 0;
	for (const book of books) {
		const { checks, skipped } = replayableChecks({ raw, book, index });
		checksSkipped += skipped;
		pending.set(book.typeId, { checks, next: 0, reader: createBookReader(raw, regionId, book.typeId) });
	}
	const started = new Set(); // the logs this rebuild has written: read back from disk from then on
	const load = (typeId) => (started.has(typeId) ? ledger.readBookLog(regionId, typeId) : { samples: [], orders: {} });
	const save = (typeId, log) => {
		ledger.writeBookLog(regionId, typeId, log);
		started.add(typeId);
	};
	const hasPendingBefore = (p, snapshot) => p.next < p.checks.length && (snapshot === null || checkBefore(p.checks[p.next], snapshot));
	const foldPending = (typeId, log, snapshot) => {
		const p = pending.get(typeId);
		let folded = 0;
		while (p !== undefined && hasPendingBefore(p, snapshot)) {
			const check = p.checks[p.next++];
			const stored = check.outcome === 'stored';
			foldBook(log, { at: check.at, stored, rows: stored ? p.reader.rowsFor(check) : null });
			folded++;
		}
		return folded;
	};

	let replayed = 0;
	let unreadable = 0;
	for (const snapshot of snapshots) {
		const byType = snapshotRows(raw, snapshot);
		if (byType === null) {
			unreadable++;
			continue;
		}
		replayed++;
		const types = new Set([...byType.keys(), ...started]);
		for (const [typeId, p] of pending) if (hasPendingBefore(p, snapshot)) types.add(typeId);
		for (const typeId of [...types].sort((a, b) => a - b)) {
			const existed = started.has(typeId);
			const log = load(typeId);
			const folded = foldPending(typeId, log, snapshot);
			const rows = byType.get(typeId);
			if (rows !== undefined) foldBook(log, { at: snapshot.fetchedAt, stored: true, rows });
			else if (existed || folded > 0) foldBook(log, { at: snapshot.fetchedAt, stored: true, rows: [] }); // its orders all ended
			save(typeId, log);
		}
		byType.clear();
	}
	for (const [typeId, p] of [...pending].sort((a, b) => a[0] - b[0])) {
		if (!hasPendingBefore(p, null)) continue;
		const log = load(typeId);
		foldPending(typeId, log, null);
		save(typeId, log);
	}
	return { logs: started.size, replayed, unreadable, checksSkipped };
};

// Every book in raw, per-type and regional. A regional snapshot is replayed when every page file
// its entry names is still in raw; one whose pages were trimmed (or are missing) is skipped and
// counted. Answers {logs, regionSnapshots (replayed), regionSnapshotsSkipped, checksSkipped (stored
// per-type checks whose page file was trimmed)}.
const buildBookLogs = ({ raw, ledger }) => {
	const books = bookPages(raw);
	const byRegion = new Map(); // region id -> {books, snapshots}
	const regionOf = (regionId) => {
		if (!byRegion.has(regionId)) byRegion.set(regionId, { books: [], snapshots: [] });
		return byRegion.get(regionId);
	};
	for (const book of books.values()) regionOf(book.regionId).books.push(book);
	let skipped = 0;
	for (const entry of regionBookEntries(raw)) {
		if (!snapshotFolded(entry)) continue;
		if (snapshotPages(entry).some(({ slug, stamp }) => raw.fileFor('public', slug, stamp) === null)) {
			skipped++;
			continue;
		}
		regionOf(Number(entry.regionId)).snapshots.push(entry);
	}
	const result = { logs: 0, regionSnapshots: 0, regionSnapshotsSkipped: skipped, checksSkipped: 0 };
	if (byRegion.size === 0) return result;
	const index = indexPublic(raw);
	for (const regionId of [...byRegion.keys()].sort((a, b) => a - b)) {
		const { books: regionBooks, snapshots } = byRegion.get(regionId);
		regionBooks.sort((a, b) => a.typeId - b.typeId);
		// sync log order is the order the snapshots were taken
		const built = buildRegionBookLogs({ raw, ledger, regionId, books: regionBooks, snapshots, index });
		result.logs += built.logs;
		result.regionSnapshots += built.replayed;
		result.regionSnapshotsSkipped += built.unreadable;
		result.checksSkipped += built.checksSkipped;
	}
	return result;
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
// `-page-<n>`), and the public sync log entry of the snapshot (`kind: 'regionBook'`) names the page
// files each snapshot was cut from (`pageStamps`), which is how buildBookLogs replays them.
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

// The book logs of every region and type with raw (per-type books and regional snapshots), written
// in place under the market lock (the watch refresh, the market snapshot and the region book hold
// it while they fold). A log with no raw behind it at all is left as it is.
const rebuildBookLogs = ({ dataDir }) => {
	const release = acquireLock(dataDir, 'market');
	if (!release) throw new Error('derive: the market is being synced; try again in a moment');
	try {
		return buildBookLogs({ raw: createRawStore({ dataDir }), ledger: createLedger({ dataDir }) });
	} finally {
		release();
	}
};

// How far back the raw behind the book logs reaches: {regionSnapshotAt (the fetchedAt of the oldest
// regional snapshot a rebuild could replay), typeBookAt (the oldest per-type book page file)}, each
// null when there is none. What is older than both is in the live logs only.
const bookLogRawReach = (raw) => {
	let regionSnapshotAt = null;
	for (const entry of regionBookEntries(raw)) {
		if (!snapshotFolded(entry) || snapshotPages(entry).some(({ slug, stamp }) => raw.fileFor('public', slug, stamp) === null)) continue;
		if (regionSnapshotAt === null || entry.fetchedAt < regionSnapshotAt) regionSnapshotAt = entry.fetchedAt;
	}
	let typeBookAt = null;
	for (const book of bookPages(raw).values()) {
		for (const page of book.pages) {
			const first = raw.list('public', bookSlug(book.regionId, book.typeId, page))[0];
			if (first !== undefined && (typeBookAt === null || first < typeBookAt)) typeBookAt = first;
		}
	}
	return { regionSnapshotAt, typeBookAt };
};

// Every character with raw data and the structure names; the book logs only when asked
// (`bookLogs: true`). The live book logs keep history after the storage budget has trimmed the raw
// behind it, so rebuilding them from raw shortens them to what raw still holds: a plain rebuild
// leaves them as they are and answers how far back their raw reaches (`bookLogRawFrom`) instead.
// The book log fields are there either way: zero when the logs were left alone.
const rebuildAll = ({ dataDir, log = console, bookLogs = false }) => {
	const raw = createRawStore({ dataDir });
	const characters = {};
	for (const owner of raw.owners()) {
		if (owner === 'public') continue;
		characters[owner] = rebuildCharacter({ dataDir, characterId: owner });
		log.info(`derive: ${owner} rebuilt`);
	}
	const structures = buildStructures({ raw, ledger: createLedger({ dataDir }) });
	if (!bookLogs) {
		return { characters, structures, bookLogsRebuilt: false, bookLogs: 0, regionSnapshots: 0, regionSnapshotsSkipped: 0, bookChecksSkipped: 0, bookLogRawFrom: bookLogRawReach(raw) };
	}
	const books = rebuildBookLogs({ dataDir });
	if (books.logs > 0) log.info(`derive: ${books.logs} book logs rebuilt`);
	return { characters, structures, bookLogsRebuilt: true, bookLogs: books.logs, regionSnapshots: books.regionSnapshots, regionSnapshotsSkipped: books.regionSnapshotsSkipped, bookChecksSkipped: books.checksSkipped, bookLogRawFrom: null };
};

module.exports = {
	assetSlug,
	snapshotFromRefs,
	profileFromRaw,
	structureEntry,
	foldOrders,
	applyHistory,
	buildOrderLog,
	updateOrderLog,
	ensureOrderLog,
	bookSlug,
	bookPages,
	indexPublic,
	REGION_PAGE_SLUG,
	snapshotPages,
	snapshotFolded,
	regionBookEntries,
	foldBook,
	createBookReader,
	buildBookLogs,
	updateBookLog,
	updateBookLogWithRows,
	ensureBookLog,
	rebuildCharacterLocked,
	rebuildCharacter,
	rebuildBookLogs,
	bookLogRawReach,
	rebuildAll,
};
