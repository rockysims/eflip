const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createSyncService } = require('../lib/sync');
const { createTokenStore } = require('../lib/tokenStore');
const { createRawStore } = require('../lib/dataFiles');
const { createLedger } = require('../lib/ledger');
const { createRunStore } = require('../lib/runs');
const { planTrim, DEFAULT_SHARES } = require('../lib/storage-budget');
const storage = require('../lib/storage');
const { foldBook } = require('../lib/derive');
const { tmpDataDir, makeLog, makeTokens } = require('../test-support/esi-fake');

// The storage budget applied to a data directory (lib/storage.js, sync.js runStorage), on a
// hand-made directory: two regional snapshots, per-type raw of three stamps for one book, three book
// logs over six days and two saved runs with their context.

const REGION = 10000043;
const NOW = Date.UTC(2026, 10, 25, 12, 0, 0); // 2026-11-25T12:00Z
const day = (d, time = '10:00:00.000') => `2026-11-${String(d).padStart(2, '0')}T${time}Z`;
const PAGE = `markets-${REGION}-orders-order-type-all`;
const PAGE_2 = `${PAGE}-page-2`;
const BOOK_35 = `markets-${REGION}-orders-type-id-35`;
const HISTORY_35 = `markets-${REGION}-history-type-id-35`;
// a book of two pages: one check stored both on the 21st; on the 22nd page 2 alone; on the 23rd page
// 1 alone (page 2 unchanged: that check reads the 22nd's page 2); on the 24th page 2 alone
const BOOK_36 = `markets-${REGION}-orders-type-id-36`;
const BOOK_36_P2 = `markets-${REGION}-orders-page-2-type-id-36`;
const BOOK_36_FILES = [[BOOK_36, day(21, '08:00:00.000')], [BOOK_36_P2, day(21, '08:00:00.004')], [BOOK_36_P2, day(22, '08:00:00.000')], [BOOK_36, day(23, '08:00:00.000')], [BOOK_36_P2, day(24, '08:00:00.000')]];

// a page of a region's book: `count` orders, varied enough that gzip leaves them some size
const pageRows = (seed, count = 120) => Array.from({ length: count }, (_, i) => ({
	order_id: seed * 1000 + i, type_id: 30 + (i % 9), price: Math.round(1e6 / (i + seed + 1)) / 100, is_buy_order: i % 3 === 0,
	volume_remain: (i * 37 + seed) % 500, volume_total: 500, issued: `2026-11-${String(10 + (i % 9)).padStart(2, '0')}T0${i % 10}:1${i % 6}:00Z`,
	duration: 90, range: 'region', location_id: 60008494 + (i % 4), system_id: 30002187, min_volume: 1,
}));
const record = (fetchedAt, body) => ({ fetchedAt, url: 'https://esi.evetech.net/x', status: 200, headers: {}, body });

// a book log over six days (2026-11-20 to 25): a sample each day; order 1 re-priced along the way and
// still listed, order 2 last seen on the 21st, order 3 new on the 23rd
const sixDayLog = (base) => {
	const entry = (d, price, volumeRemain = 5) => ({ at: day(d), price, volumeRemain, issued: '2026-11-19T00:00:00Z' });
	const order = (firstSeen, lastSeen, pathEntries) => ({ isBuy: false, locationId: 60008494, systemId: 30002187, volumeTotal: 10, duration: 90, minVolume: 1, range: 'region', firstSeen, lastSeen, path: pathEntries });
	return {
		samples: [20, 21, 22, 23, 24, 25].map(d => ({ at: day(d), stored: true })),
		orders: {
			[base + 1]: order(day(20), day(25), [entry(20, 100), entry(21, 99.5), entry(22, 99), entry(24, 98)]),
			[base + 2]: order(day(20), day(21), [entry(20, 200)]),
			[base + 3]: order(day(23), day(25), [entry(23, 300), entry(25, 299, 4)]),
		},
	};
};

// a quiet book (folded as lib/derive.js foldBook does): one stored check on 2026-11-01 at 10:00 that
// listed orders 1 and 2, then a check every hour for five days that found the book unchanged (a 304:
// a sample `stored: false`, and no order's lastSeen moves)
const HOUR = 60 * 60 * 1000;
const QUIET_FROM = Date.UTC(2026, 10, 1, 10, 0, 0);
const isoAt = (ms) => new Date(ms).toISOString();
const bookRow = (id, price) => ({ order_id: id, price, volume_remain: 10, issued: '2026-10-30T00:00:00Z', is_buy_order: false, location_id: 60008494, system_id: 30002187, volume_total: 10, duration: 90, min_volume: 1, range: 'region' });
const quietLog = () => {
	const log = { samples: [], orders: {} };
	foldBook(log, { at: isoAt(QUIET_FROM), stored: true, rows: [bookRow(1, 100), bookRow(2, 110)] });
	for (let h = 1; h <= 5 * 24; h++) foldBook(log, { at: isoAt(QUIET_FROM + h * HOUR), stored: false, rows: null });
	return log;
};
// stored checks and 304s mixed: a 304 before any stored check, then stored on the 1st (1 and 2), 304s,
// stored on the 2nd at 05:00 (2 gone, 1 re-priced), 304s, stored on the 3rd at 13:00 and 14:00 (3 new),
// 304s to the 6th
const mixedLog = () => {
	const log = { samples: [], orders: {} };
	const at = (h) => isoAt(QUIET_FROM + h * HOUR);
	foldBook(log, { at: at(-1), stored: false, rows: null });
	foldBook(log, { at: at(0), stored: true, rows: [bookRow(1, 100), bookRow(2, 110)] });
	for (let h = 1; h < 19; h++) foldBook(log, { at: at(h), stored: false, rows: null });
	foldBook(log, { at: at(19), stored: true, rows: [bookRow(1, 95)] });
	for (let h = 20; h < 51; h++) foldBook(log, { at: at(h), stored: false, rows: null });
	foldBook(log, { at: at(51), stored: true, rows: [bookRow(1, 95), bookRow(3, 120)] });
	foldBook(log, { at: at(52), stored: true, rows: [bookRow(1, 94), bookRow(3, 120)] });
	for (let h = 53; h <= 120; h++) foldBook(log, { at: at(h), stored: false, rows: null });
	return log;
};

const runFile = (dataDir, id, copiedAt, contextSize) => {
	const context = { 35: { src: { sell: [], buy: [] }, dest: { sell: [], buy: [] }, history: Array.from({ length: contextSize }, (_, i) => ({ date: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`, average: 100 + i, volume: i })) } };
	const run = { id, copiedAt, reportGeneratedAt: copiedAt, route: { start: 'Jita', end: 'Amarr', endRegionId: REGION }, rows: [{ typeId: 35, qty: 1 }], lastCopiedAt: copiedAt, copyCount: 1, context };
	fs.mkdirSync(path.join(dataDir, 'runs'), { recursive: true });
	fs.writeFileSync(path.join(dataDir, 'runs', `${id}.json`), JSON.stringify(run) + '\n');
};
const OLD_RUN = 'Jita-Amarr-2026-11-21T00:00:00.000Z-0123456789abcdef';
const NEW_RUN = 'Jita-Amarr-2026-11-23T00:00:00.000Z-fedcba9876543210';

// Snapshot A (the 20th, two pages) and B (the 24th: page 1 new, page 2 unchanged, so B names A's file).
const SNAP_A = { syncedAt: day(20), fetchedAt: day(20), pageStamps: [day(20), day(20, '10:00:01.000')] };
const SNAP_B = { syncedAt: day(24), fetchedAt: day(24), pageStamps: [day(24), day(20, '10:00:01.000')] };

const buildFixture = (t) => {
	const dataDir = tmpDataDir(t, 'eflip-storage-test-');
	const raw = createRawStore({ dataDir });
	const ledger = createLedger({ dataDir });
	raw.write('public', PAGE, record(SNAP_A.pageStamps[0], pageRows(1)));
	raw.write('public', PAGE_2, record(SNAP_A.pageStamps[1], pageRows(2, 60)));
	raw.write('public', PAGE, record(SNAP_B.pageStamps[0], pageRows(3)));
	for (const snap of [SNAP_A, SNAP_B]) {
		raw.writeSyncLog('public', { syncedAt: snap.syncedAt, finishedAt: snap.syncedAt, status: 'ok', errors: [], stop: null, books: [], pageStamps: snap.pageStamps, kind: 'regionBook', regionId: REGION, fetchedAt: snap.fetchedAt, pages: 2, pagesRead: 2 });
	}
	for (const d of [20, 22, 24]) raw.write('public', BOOK_35, record(day(d, '09:00:00.000'), pageRows(40 + d, 8)));
	raw.write('public', HISTORY_35, record(day(24, '09:00:01.000'), [{ date: '2026-11-23', average: 9, highest: 10, lowest: 8, order_count: 2, volume: 20 }]));
	BOOK_36_FILES.forEach(([slug, stamp], i) => raw.write('public', slug, record(stamp, pageRows(60 + i, 4))));
	for (const [typeId, base] of [[34, 100], [35, 200], [36, 300]]) ledger.writeBookLog(REGION, typeId, sixDayLog(base));
	runFile(dataDir, OLD_RUN, '2026-11-21T00:00:00.000Z', 30);
	runFile(dataDir, NEW_RUN, '2026-11-23T00:00:00.000Z', 30);
	return { dataDir, raw, ledger };
};

const serviceFor = (dataDir, env) => {
	const log = makeLog();
	const service = createSyncService({ dataDir, fetch: async () => { throw new Error('no ESI call is expected'); }, now: () => NOW, log, tokenStore: createTokenStore({ dataDir }), tokens: makeTokens(), env });
	return { service, log };
};

// every file under the directory with its bytes, for "nothing changed"
const treeOf = (dir) => {
	const out = {};
	const visit = (current) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) visit(full);
			else out[path.relative(dir, full)] = fs.readFileSync(full).toString('base64');
		}
	};
	visit(dir);
	return out;
};
const storageEntries = (dataDir) => {
	const raw = createRawStore({ dataDir });
	return raw.syncLogStamps('public').map(stamp => raw.readSyncLog('public', stamp)).filter(entry => entry.kind === 'storage');
};
const exists = (raw, slug, stamp) => raw.fileFor('public', slug, stamp) !== null;

test('the kinds are measured from the disk: snapshots own their files (a shared page goes to the newer), per-type files are pieces, the logs are day buckets that add up to their bytes', async (t) => {
	const { dataDir, raw, ledger } = buildFixture(t);
	const runs = createRunStore({ dataDir, log: makeLog() });
	const usage = storage.measureUsage({ raw, ledger, runs });
	const kinds = await storage.measureKinds({ raw, ledger, runs, now: NOW });
	assert.deepEqual(kinds.map(kind => kind.name), ['regionPages', 'bookLogs', 'typeBooks', 'runContexts']);
	for (const kind of kinds) assert.equal(kind.bytes, usage[kind.name], kind.name);

	const [pages, logs, books, contexts] = kinds;
	const fileBytes = (slug, stamp) => raw.bytes('public', slug, stamp);
	assert.equal(pages.bytes, fileBytes(PAGE, SNAP_A.pageStamps[0]) + fileBytes(PAGE_2, SNAP_A.pageStamps[1]) + fileBytes(PAGE, SNAP_B.pageStamps[0]));
	assert.deepEqual(pages.items.map(item => [item.id, item.floor === true, item.files.map(f => `${f.slug}/${f.stamp}`).sort()]), [
		[SNAP_A.syncedAt, false, [`${PAGE}/${SNAP_A.pageStamps[0]}`]],
		[SNAP_B.syncedAt, true, [`${PAGE}/${SNAP_B.pageStamps[0]}`, `${PAGE_2}/${SNAP_A.pageStamps[1]}`].sort()],
	], 'A keeps only the page nobody newer names; B, the newest complete snapshot, is the floor');

	// per-type raw: day buckets, each file dated by the next file of its route (the newest of a route in none)
	const b = (slug, stamp) => fileBytes(slug, stamp);
	assert.deepEqual(books.buckets.map(bucket => [bucket.from.slice(0, 10), bucket.bytes]), [
		['2026-11-22', b(BOOK_35, day(20, '09:00:00.000')) + b(BOOK_36_P2, day(21, '08:00:00.004'))],
		['2026-11-23', b(BOOK_36, day(21, '08:00:00.000'))],
		['2026-11-24', b(BOOK_35, day(22, '09:00:00.000')) + b(BOOK_36_P2, day(22, '08:00:00.000'))],
	]);
	assert.equal(books.floorAt, undefined, 'no time floor: the newest file of each route is the floor');
	assert.equal(books.bytes, [[BOOK_35, day(20, '09:00:00.000')], [BOOK_35, day(22, '09:00:00.000')], [BOOK_35, day(24, '09:00:00.000')], [HISTORY_35, day(24, '09:00:01.000')], ...BOOK_36_FILES].reduce((sum, [slug, stamp]) => sum + b(slug, stamp), 0));

	assert.equal(logs.floorAt, '2026-11-22T12:00:00.000Z', 'now less 3 days');
	assert.deepEqual(logs.buckets.map(bucket => bucket.from.slice(0, 10)), ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25']);
	assert.ok(logs.buckets.every(bucket => bucket.to === new Date(Date.parse(bucket.from) + 86400000).toISOString()));
	assert.equal(logs.buckets.reduce((sum, bucket) => sum + bucket.bytes, 0), logs.bytes, 'scaled to the compressed bytes on disk');
	assert.equal(logs.bytes, [34, 35, 36].reduce((sum, typeId) => sum + ledger.bookLogBytes(REGION, typeId), 0));

	assert.deepEqual(contexts.items.map(item => [item.id, item.floor === true]), [[OLD_RUN, false], [NEW_RUN, true]]);
	assert.ok(contexts.items.every(item => item.bytes > 1000), JSON.stringify(contexts.items));
});

test('trimBookLog drops samples and orders older than the cutoff, and keeps the entry just before it of an order still listed', () => {
	const log = sixDayLog(0);
	const { log: trimmed, samplesDropped, entriesDropped, ordersDropped } = storage.trimBookLog(log, '2026-11-22T00:00:00.000Z');
	assert.deepEqual(trimmed.samples.map(sample => sample.at.slice(8, 10)), ['22', '23', '24', '25']);
	assert.equal(samplesDropped, 2);
	assert.deepEqual(Object.keys(trimmed.orders), ['1', '3'], 'order 2 was last seen on the 21st');
	assert.equal(ordersDropped, 1);
	assert.deepEqual(trimmed.orders[1].path.map(entry => [entry.at.slice(8, 10), entry.price]), [['21', 99.5], ['22', 99], ['24', 98]], 'the 21st is its price at the cutoff');
	assert.equal(trimmed.orders[1].firstSeen, log.orders[1].firstSeen, 'what is known of the order stays');
	assert.equal(entriesDropped, 2, 'order 1 on the 20th, order 2\'s only entry');
	assert.equal(trimmed.orders[3], log.orders[3], 'an order wholly after the cutoff is untouched');
	// a cutoff after an order's last entry keeps that entry: an order kept is never left without one
	const late = storage.trimBookLog(log, '2026-11-25T00:00:00.000Z');
	assert.deepEqual(late.log.orders[1].path.map(entry => entry.at.slice(8, 10)), ['24']);
	assert.deepEqual(late.log.orders[3].path.map(entry => entry.at.slice(8, 10)), ['23', '25']);
	// nothing before the cutoff: the same log
	assert.equal(storage.trimBookLog(log, '2026-11-01T00:00:00.000Z').entriesDropped, 0);
});

test('trimBookLog keeps an order that a 304 after the cutoff still lists', () => {
	const log = quietLog();
	const { log: trimmed, samplesDropped, entriesDropped, ordersDropped } = storage.trimBookLog(log, '2026-11-03T00:00:00.000Z');
	// the first sample kept is a 304, which stands for the stored check of the 1st: the cut moves back to it
	assert.deepEqual(trimmed.samples[0], { at: '2026-11-01T10:00:00.000Z', stored: true }, 'the stored check the 304s stand for stays');
	assert.equal(trimmed.samples.length, log.samples.length);
	assert.deepEqual(Object.keys(trimmed.orders), ['1', '2'], 'both orders are still listed after the cutoff');
	for (const id of ['1', '2']) assert.deepEqual(trimmed.orders[id].path.map(entry => entry.at), ['2026-11-01T10:00:00.000Z'], `order ${id}`);
	assert.deepEqual([samplesDropped, entriesDropped, ordersDropped], [0, 0, 0]);
	// the next stored check re-prices order 2: a re-price of the order known since the 1st, not a new order
	foldBook(trimmed, { at: '2026-11-06T11:30:00.000Z', stored: true, rows: [bookRow(1, 100), bookRow(2, 99)] });
	assert.deepEqual(trimmed.orders[2].path.map(entry => entry.price), [110, 99]);
	assert.equal(trimmed.orders[2].firstSeen, '2026-11-01T10:00:00.000Z');

	// the cut goes back to the newest stored check before the cutoff, not further: order 2, gone at
	// the 2nd's 05:00 check, goes; order 1 keeps its price before that check, which re-priced it
	const mixed = storage.trimBookLog(mixedLog(), '2026-11-03T00:00:00.000Z').log;
	assert.equal(mixed.samples[0].at, '2026-11-02T05:00:00.000Z');
	assert.deepEqual(Object.keys(mixed.orders), ['1', '3']);
	assert.deepEqual(mixed.orders[1].path.map(entry => entry.price), [100, 95, 94]);
	// a stored check is the first kept: the cut stays at the cutoff
	const atStored = storage.trimBookLog(mixedLog(), '2026-11-03T12:30:00.000Z').log;
	assert.equal(atStored.samples[0].at, '2026-11-03T13:00:00.000Z');
	// a log whose every sample is older than the cutoff (a type no longer checked): nothing is left
	assert.deepEqual(storage.trimBookLog(quietLog(), '2026-11-07T00:00:00.000Z').log, { samples: [], orders: {} });
});

test('the day buckets free what trimBookLog drops: a piece is dated by when a cutoff frees it', async (t) => {
	const pieces = [];
	storage.bookLogPieces(sixDayLog(0), (at, bytes) => pieces.push([at.slice(8, 10), bytes]));
	const plainFreed = (cutoffDay) => pieces.filter(([d]) => d < cutoffDay).reduce((sum, [, bytes]) => sum + bytes, 0);
	// cutting at the 22nd frees the samples of the 20th and 21st, order 2 whole, and order 1's first entry
	const log = sixDayLog(0);
	const expected = JSON.stringify(log.samples[0]).length + JSON.stringify(log.samples[1]).length
		+ '2'.length + JSON.stringify({ ...log.orders[2], path: undefined }).length + JSON.stringify(log.orders[2].path[0]).length
		+ JSON.stringify(log.orders[1].path[0]).length;
	assert.equal(plainFreed('22'), expected);

	// at any cutoff, what the pieces dated before it add up to is what trimBookLog drops, 304s or not
	const plainOf = (book) => {
		let sum = 0;
		storage.bookLogPieces(book, (at, bytes) => { sum += bytes; });
		return sum;
	};
	const datedBefore = (book, cutoffAt) => {
		let sum = 0;
		storage.bookLogPieces(book, (at, bytes) => { if (typeof at === 'string' && at < cutoffAt) sum += bytes; });
		return sum;
	};
	for (const [name, make] of [['six days', () => sixDayLog(0)], ['quiet', quietLog], ['mixed', mixedLog]]) {
		const book = make();
		for (let ms = Date.UTC(2026, 9, 31); ms <= Date.UTC(2026, 10, 27); ms += HOUR / 2) {
			const cutoffAt = isoAt(ms);
			assert.equal(datedBefore(book, cutoffAt), plainOf(book) - plainOf(storage.trimBookLog(book, cutoffAt).log), `${name} at ${cutoffAt}`);
		}
	}
	// the quiet book: until the cutoff passes its last 304, a cutoff frees nothing of it
	assert.equal(datedBefore(quietLog(), '2026-11-06T10:00:00.000Z'), 0);

	// as the planner gets it: one bucket, which the 3-day floor keeps, so a budget trims nothing of it
	const dataDir = tmpDataDir(t, 'eflip-storage-test-');
	const ledger = createLedger({ dataDir });
	ledger.writeBookLog(REGION, 34, quietLog());
	const kinds = await storage.measureKinds({ raw: createRawStore({ dataDir }), ledger, now: QUIET_FROM + 120 * HOUR + HOUR / 2 });
	const logs = kinds.find(kind => kind.name === 'bookLogs');
	assert.deepEqual(logs.buckets.map(bucket => bucket.from), ['2026-11-06T00:00:00.000Z']);
	assert.equal(logs.buckets.reduce((sum, bucket) => sum + bucket.bytes, 0), logs.bytes, 'the buckets add up to the bytes on disk');
	assert.equal(planTrim({ budgetBytes: 1, kinds }).trims.bookLogs.cutoffAt, null);
});

test('per-type raw is cut at one time: each route keeps its newest file before the cutoff, so a later check that read an unchanged page still finds it', async (t) => {
	const { dataDir, raw, ledger } = buildFixture(t);
	const plan = { trims: { regionPages: { itemIds: [], cutoffAt: null }, bookLogs: { itemIds: [], cutoffAt: null }, typeBooks: { itemIds: [], cutoffAt: '2026-11-23T00:00:00.000Z' }, runContexts: { itemIds: [], cutoffAt: null } } };
	const removed = await storage.applyTrims({ raw, ledger, plan, kinds: [], log: makeLog(), now: NOW });
	assert.equal(removed.typeBooks.cutoffAt, '2026-11-23T00:00:00.000Z');
	// page 2 of 36: the 21st goes (the 22nd replaced it before the cutoff); the 22nd stays, because the
	// check on the 23rd stored page 1 alone and read page 2 as the 22nd had stored it
	assert.deepEqual(raw.list('public', BOOK_36_P2), [day(22, '08:00:00.000'), day(24, '08:00:00.000')]);
	// page 1 of 36: the 21st is its newest before the cutoff, so it stays too
	assert.deepEqual(raw.list('public', BOOK_36), [day(21, '08:00:00.000'), day(23, '08:00:00.000')]);
	// 35: the 20th goes, the 22nd (its newest before the cutoff) and the 24th stay
	assert.deepEqual(raw.list('public', BOOK_35), [day(22, '09:00:00.000'), day(24, '09:00:00.000')]);
	assert.equal(removed.typeBooks.files, 2);
	// the check on the 23rd reads both its pages back from raw
	const book = require('../lib/derive').createBookReader(raw, REGION, 36).rowsFor({ pages: 2, stamps: { 1: day(23, '08:00:00.000') } });
	assert.deepEqual(book.map(row => row.order_id), [...pageRows(63, 4), ...pageRows(62, 4)].map(row => row.order_id));
});

test('over the budget: the kind furthest over its share gives up its oldest piece first, a page a newer snapshot names stays, and the run is logged', async (t) => {
	const { dataDir, raw } = buildFixture(t);
	const shares = 'regionPages:10,bookLogs:40,typeBooks:25,runContexts:25';
	const probe = serviceFor(dataDir, {}).service.storageStatus();
	assert.equal(probe.budget, null);
	// regionPages is the furthest over its share
	const sharesOf = { regionPages: 10, bookLogs: 40, typeBooks: 25, runContexts: 25 };
	const ratios = Object.entries(probe.usage).map(([kind, bytes]) => [kind, bytes / sharesOf[kind]]).sort((a, b) => b[1] - a[1]);
	assert.equal(ratios[0][0], 'regionPages', JSON.stringify(probe.usage));

	const budget = probe.total - 1;
	const { service } = serviceFor(dataDir, { EFLIP_STORAGE_BUDGET: String(budget), EFLIP_STORAGE_SHARES: shares });
	const result = await service.runStorage();
	assert.equal(result.status, 'ok', JSON.stringify(result));
	assert.equal(result.trims.regionPages.snapshots, 1);
	assert.equal(result.trims.regionPages.files, 1);
	assert.equal(result.trims.regionPages.bytesFreed, probe.usage.regionPages - result.usage.regionPages);
	assert.ok(!exists(raw, PAGE, SNAP_A.pageStamps[0]), 'the older snapshot\'s own page is gone');
	assert.ok(exists(raw, PAGE_2, SNAP_A.pageStamps[1]), 'the page B names too stays');
	assert.ok(exists(raw, PAGE, SNAP_B.pageStamps[0]));
	for (const kind of ['bookLogs', 'typeBooks', 'runContexts']) assert.equal(result.trims[kind].pieces, 0, kind);
	assert.ok(result.totalAfter <= budget);
	assert.equal(result.unmet, 0);
	assert.equal(raw.readSyncLog('public', SNAP_A.syncedAt).trimmedAt, new Date(NOW).toISOString(), 'the trimmed snapshot\'s entry is marked');
	assert.equal(raw.readSyncLog('public', SNAP_B.syncedAt).trimmedAt, undefined);

	const [entry] = storageEntries(dataDir);
	assert.deepEqual(Object.keys(entry), ['kind', 'syncedAt', 'finishedAt', 'reason', 'budgetBytes', 'shares', 'usage', 'totalBefore', 'totalAfter', 'unmet', 'trims', 'elapsedMs']);
	assert.equal(entry.reason, 'manual');
	assert.equal(entry.budgetBytes, budget);
	assert.deepEqual(entry.shares, sharesOf);
	assert.equal(entry.totalBefore, probe.total);
	assert.deepEqual(entry.usage, result.usage);
	assert.equal(entry.trims.regionPages.snapshots, 1);
	const status = service.storageStatus();
	assert.equal(status.budget, budget);
	assert.equal(status.lastTrimAt, entry.syncedAt);
	assert.equal(status.unmet, 0);
	assert.deepEqual(status.usage, result.usage);

	// under the budget now: the next run measures, trims nothing and is still logged
	const again = await service.runStorage();
	assert.equal(again.status, 'ok');
	assert.equal(storage.trimmedAnything(again.trims), false);
	assert.equal(again.lastTrimAt, entry.syncedAt, 'the last trim is carried');
	assert.equal(storageEntries(dataDir).length, 2);
});

test('a budget only the floors exceed: everything else goes, the floors stay, and what is left over is unmet', async (t) => {
	const { dataDir, raw, ledger } = buildFixture(t);
	const { service } = serviceFor(dataDir, { EFLIP_STORAGE_BUDGET: '1KB' });
	const result = await service.runStorage({ reason: 'manual' });
	assert.equal(result.status, 'ok', JSON.stringify(result));
	// regional pages: the older snapshot goes, the newest stays whole
	assert.ok(!exists(raw, PAGE, SNAP_A.pageStamps[0]));
	assert.ok(exists(raw, PAGE, SNAP_B.pageStamps[0]) && exists(raw, PAGE_2, SNAP_B.pageStamps[1]));
	// per-type raw: cut at the end of the last bucket; the newest file of each route stays
	assert.equal(result.trims.typeBooks.cutoffAt, '2026-11-25T00:00:00.000Z');
	assert.deepEqual(raw.list('public', BOOK_35), [day(24, '09:00:00.000')]);
	assert.deepEqual(raw.list('public', HISTORY_35), [day(24, '09:00:01.000')]);
	assert.deepEqual(raw.list('public', BOOK_36), [day(23, '08:00:00.000')]);
	assert.deepEqual(raw.list('public', BOOK_36_P2), [day(24, '08:00:00.000')]);
	assert.equal(result.trims.typeBooks.files, 5);
	// book logs: cut at the last day boundary at least 3 days back; the last 3 days whole
	assert.equal(result.trims.bookLogs.cutoffAt, '2026-11-22T00:00:00.000Z');
	assert.equal(result.trims.bookLogs.logs, 3);
	assert.equal(result.trims.bookLogs.ordersDropped, 3);
	for (const typeId of [34, 35, 36]) {
		const log = ledger.readBookLog(REGION, typeId);
		assert.deepEqual(log.samples.map(sample => sample.at.slice(8, 10)), ['22', '23', '24', '25'], `type ${typeId}`);
		assert.equal(Object.keys(log.orders).length, 2);
	}
	// runs: the newest keeps its context
	const runs = createRunStore({ dataDir, log: makeLog() });
	const saved = Object.fromEntries(runs.list({ context: true }).map(run => [run.id, run]));
	assert.deepEqual(saved[OLD_RUN].context, {});
	assert.equal(saved[OLD_RUN].contextTrimmedAt, new Date(NOW).toISOString());
	assert.deepEqual(saved[OLD_RUN].rows, [{ typeId: 35, qty: 1 }], 'the rows stay');
	assert.ok(Object.keys(saved[NEW_RUN].context).length > 0);
	assert.equal(saved[NEW_RUN].contextTrimmedAt, undefined);
	// what the floors hold is over the budget, and nothing is left to trim: unmet is what is still over
	assert.equal(result.unmet, result.totalAfter - 1000);
	assert.ok(result.totalAfter > 1000);
	assert.equal(service.storageStatus().unmet, result.unmet);
	// a second run finds only floors
	const again = await service.runStorage();
	assert.equal(storage.trimmedAnything(again.trims), false);
	assert.ok(again.unmet > 0);
});

test('no budget: nothing changes and nothing is logged; a setting that does not parse is logged once and counts as none', async (t) => {
	const { dataDir } = buildFixture(t);
	const before = treeOf(dataDir);
	const { service } = serviceFor(dataDir, {});
	const result = await service.runStorage();
	assert.equal(result.status, 'no-budget');
	assert.equal(result.budgetBytes, null);
	assert.ok(result.usage.regionPages > 0 && result.total > 0);
	assert.deepEqual(treeOf(dataDir), before, 'no file written, changed or removed');
	assert.deepEqual(storageEntries(dataDir), []);
	assert.equal(storage.readState(dataDir), null);

	const env = { EFLIP_STORAGE_BUDGET: 'lots' };
	const bad = serviceFor(dataDir, env);
	assert.equal((await bad.service.runStorage()).status, 'no-budget');
	await bad.service.runStorage();
	bad.service.storageStatus();
	assert.equal(bad.log.lines.filter(line => /storage budget: "lots"/.test(line)).length, 1, 'logged once');
	env.EFLIP_STORAGE_BUDGET = '1GB';
	env.EFLIP_STORAGE_SHARES = 'regionPages:90,bookLogs:20';
	assert.equal(bad.service.storageStatus().budget, null, 'shares over 100 %: no budget either');
	assert.deepEqual(bad.service.storageStatus().shares, DEFAULT_SHARES);
	assert.deepEqual(treeOf(dataDir), before);
});

test('runStorage waits for the market lock, and the plan matches what planTrim answers for the measured kinds', async (t) => {
	const { dataDir, raw, ledger } = buildFixture(t);
	const { acquireLock } = require('../lib/dataFiles');
	const { service } = serviceFor(dataDir, { EFLIP_STORAGE_BUDGET: '1KB' });
	const hold = acquireLock(dataDir, 'market');
	const busy = await service.runStorage();
	assert.equal(busy.status, 'busy');
	hold();
	const kinds = await storage.measureKinds({ raw, ledger, runs: createRunStore({ dataDir, log: makeLog() }), now: NOW });
	const plan = planTrim({ budgetBytes: 1000, shares: DEFAULT_SHARES, kinds });
	const result = await service.runStorage();
	assert.ok(plan.unmet > 0);
	assert.equal(result.unmet, result.totalAfter - 1000, 'the overage on disk, once the plan finds only floors left');
	assert.equal(result.totalBefore, plan.totalBefore);
	assert.equal(result.trims.bookLogs.cutoffAt, plan.trims.bookLogs.cutoffAt);
	assert.equal(result.trims.typeBooks.cutoffAt, plan.trims.typeBooks.cutoffAt);
	assert.equal(result.trims.runContexts.runs, plan.trims.runContexts.itemIds.length);
	assert.equal(result.trims.regionPages.pieces, plan.trims.regionPages.itemIds.length);
	assert.ok(!fs.existsSync(path.join(dataDir, 'locks', 'market.lock')));
});

test('character raw and ledgers, and the sync logs, are outside the budget: never removed', async (t) => {
	const { dataDir, raw } = buildFixture(t);
	raw.write(90000001, 'wallet', record('2026-11-01T00:00:00.000Z', 1000));
	fs.mkdirSync(path.join(dataDir, 'ledger', '90000001'), { recursive: true });
	fs.writeFileSync(path.join(dataDir, 'ledger', '90000001', 'transactions.json'), '[]\n');
	assert.throws(() => raw.remove(90000001, 'wallet', '2026-11-01T00:00:00.000Z'), /only public market records/);
	const { service } = serviceFor(dataDir, { EFLIP_STORAGE_BUDGET: '1' });
	await service.runStorage();
	assert.ok(raw.fileFor(90000001, 'wallet', '2026-11-01T00:00:00.000Z'));
	assert.ok(fs.existsSync(path.join(dataDir, 'ledger', '90000001', 'transactions.json')));
	assert.deepEqual(raw.syncLogStamps('public').filter(stamp => [SNAP_A.syncedAt, SNAP_B.syncedAt].includes(stamp)), [SNAP_A.syncedAt, SNAP_B.syncedAt]);
	// the book log files are rewritten, gzipped, never removed
	assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(dataDir, 'ledger', 'market', String(REGION), '34.json.gz'))).toString('utf8').startsWith('{\n"samples":'), true);
});

test('the config route\'s usage is measured at most once a minute, and afresh after a storage run', async (t) => {
	const { dataDir, raw } = buildFixture(t);
	let clock = NOW;
	const service = createSyncService({ dataDir, fetch: async () => { throw new Error('no ESI call is expected'); }, now: () => clock, log: makeLog(), tokenStore: createTokenStore({ dataDir }), tokens: makeTokens(), env: { EFLIP_STORAGE_BUDGET: '1GB' } });
	const first = service.storageStatus();
	assert.equal(first.measuredAt, new Date(NOW).toISOString());
	raw.write('public', BOOK_35, record(day(25, '11:00:00.000'), pageRows(90, 8)));
	clock += 59 * 1000;
	const cached = service.storageStatus();
	assert.deepEqual(cached.usage, first.usage, 'a minute is not up: the bytes measured before');
	assert.equal(cached.measuredAt, first.measuredAt);
	clock += 1000;
	const fresh = service.storageStatus();
	assert.ok(fresh.usage.typeBooks > first.usage.typeBooks, 'measured again');
	assert.equal(fresh.measuredAt, new Date(NOW + 60 * 1000).toISOString());
	raw.write('public', BOOK_35, record(day(25, '11:30:00.000'), pageRows(91, 8)));
	clock += 1000;
	await service.runStorage();
	const after = service.storageStatus();
	assert.equal(after.measuredAt, new Date(clock).toISOString(), 'a storage run clears it');
	assert.ok(after.usage.typeBooks > fresh.usage.typeBooks);
});
