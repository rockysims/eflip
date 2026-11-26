const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createSyncService } = require('../lib/sync');
const { createTokenStore } = require('../lib/tokenStore');
const derive = require('../lib/derive');
const { createRawStore } = require('../lib/dataFiles');
const {
	ALL_SCOPES, makeClock, tmpDataDir, makeLog, makeTokens, createFakeEsi,
	tx, journalRow, order, historyOrder, asset, contract, contractItem,
} = require('../test-support/esi-fake');

// The invariant under test (Phase 3 gate): re-deriving from data/raw/ alone gives byte-for-byte the
// ledger the incremental sync built.

const IVAN = 90000001;
const GRANT = 90000002;
const STRUCTURE = 1028858195912;
const HOUR = 60 * 60 * 1000;

// path (relative, slash-separated) -> text of every file under `dir`; a gzipped file (`.gz`: book
// logs, public market raw) by its decompressed text, so what compares is the stable text inside.
const fileText = (file) => (file.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8') : fs.readFileSync(file, 'utf8'));
const treeOf = (dir) => {
	const out = {};
	const visit = (current) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) visit(full);
			else if (!entry.name.startsWith('.')) out[path.relative(dir, full).split(path.sep).join('/')] = fileText(full);
		}
	};
	if (fs.existsSync(dir)) visit(dir);
	return out;
};

const copyDir = (from, to) => fs.cpSync(from, to, { recursive: true });

const setup = (t) => {
	const dataDir = tmpDataDir(t);
	const clock = makeClock();
	const fake = createFakeEsi({ now: clock, pageSize: 2 });
	const store = createTokenStore({ dataDir });
	for (const id of [IVAN, GRANT]) {
		store.upsert({ characterId: id, name: id === IVAN ? 'Ivan Tester' : 'Grant Tester', ownerHash: `owner-${id}`, scopes: ALL_SCOPES, refreshToken: `refresh-${id}`, status: 'ok' });
		fake.character(id);
	}
	const log = makeLog();
	const service = createSyncService({ dataDir, fetch: fake.fetch, now: clock, log, tokenStore: store, tokens: makeTokens(), userAgent: 'eflip-test/1.0' });
	return { dataDir, clock, fake, service, log };
};

// Several syncs of two characters with data that grows, changes status, shrinks and goes quiet.
const history = async (ctx) => {
	const { fake, clock, service } = ctx;
	fake.structures.set(STRUCTURE, { name: 'Test Trading Tower', owner_id: 98000001, position: { x: 1, y: 2, z: 3 }, solar_system_id: 30000144, type_id: 35834 });
	fake.character(IVAN, {
		balance: 1000,
		transactions: [tx(6001), tx(6002, { is_buy: false, location_id: STRUCTURE }), tx(6003)],
		journal: [1, 2, 3, 4, 5].map(i => journalRow(7000 + i)),
		orders: [order(8001, { type_id: 35 })],
		ordersHistory: [historyOrder(8101, { state: 'cancelled', volume_remain: 4 })],
		assets: [1, 2, 3, 4, 5].map(i => asset(i, { type_id: 30 + i })),
		contracts: [contract(9001, { type: 'courier', status: 'outstanding', date_completed: undefined }), contract(9002)],
		contractItems: { 9001: [contractItem(1, 34, 60)], 9002: [contractItem(1, 35, 5)] },
		skills: { skills: [{ skill_id: 16622, trained_skill_level: 3, active_skill_level: 3, skillpoints_in_skill: 1 }], total_sp: 1, unallocated_sp: 0 },
		standings: [{ from_id: 500001, from_type: 'faction', standing: 1.5 }],
	});
	fake.character(GRANT, { balance: 77, transactions: [tx(6501, { is_buy: false })], assets: [asset(50)] });
	await service.syncAll({ force: true, market: false });

	// +2 h: new rows, the courier is delivered, an order is added, a new contract with items
	clock.advance(2 * HOUR);
	const ivan = fake.character(IVAN);
	ivan.transactions.push(tx(6004, { is_buy: false }));
	ivan.journal.push(journalRow(7006));
	ivan.orders.push(order(8002, { type_id: 36 }));
	ivan.ordersHistory.push(historyOrder(8102));
	ivan.contracts[0] = contract(9001, { type: 'courier', status: 'finished' });
	ivan.contracts.push(contract(9003, { type: 'courier', status: 'outstanding', date_completed: undefined }));
	ivan.contractItems[9003] = [contractItem(1, 36, 9)];
	ivan.balance = 2000;
	await service.syncAll({ force: true, market: false });

	// +26 h: skills move on, the asset list shrinks from three pages to two, a structure turns up forbidden
	clock.advance(24 * HOUR);
	ivan.skills = { skills: [{ skill_id: 16622, trained_skill_level: 4, active_skill_level: 4, skillpoints_in_skill: 2 }], total_sp: 2, unallocated_sp: 0 };
	ivan.assets = ivan.assets.slice(0, 3);
	ivan.transactions.push(tx(6005, { location_id: STRUCTURE + 1 }));
	fake.structures.set(STRUCTURE + 1, 'forbidden');
	await service.syncAll({ force: true, market: false });

	// +2 h: an error stop in the middle leaves no snapshot behind
	clock.advance(2 * HOUR);
	fake.errorLimitRemain = 10;
	await service.syncCharacter(IVAN, { force: true });
	fake.errorLimitRemain = 100;

	// +4 h: nothing changed at all
	clock.advance(4 * HOUR);
	await service.syncAll({ force: true, market: false });
};

test('re-deriving from raw gives byte-for-byte the ledger the incremental sync built', async (t) => {
	const ctx = await (async () => {
		const c = setup(t);
		await history(c);
		return c;
	})();
	const { dataDir } = ctx;
	const incremental = treeOf(path.join(dataDir, 'ledger'));

	// sanity: the history really exercised the pieces
	const names = Object.keys(incremental);
	assert.ok(names.includes(`${IVAN}/transactions.json`));
	assert.ok(names.includes(`${IVAN}/contract-items/9003.json`));
	assert.ok(names.includes('structures.json'));
	assert.ok(names.includes(`${IVAN}/profile.json`));
	const ivanSnapshots = names.filter(name => name.startsWith(`${IVAN}/snapshots/`));
	assert.ok(ivanSnapshots.length >= 2 && ivanSnapshots.length <= 4, `snapshots: ${ivanSnapshots.length}`);
	assert.equal(JSON.parse(incremental[`${IVAN}/profile.json`]).skills[0].active_skill_level, 4);
	assert.equal(JSON.parse(incremental[ivanSnapshots[ivanSnapshots.length - 1]]).assets.length, 3, 'the shrunken asset list, not a stale third page');
	const contracts = JSON.parse(incremental[`${IVAN}/contracts.json`]);
	assert.equal(contracts.find(c => c.contract_id === 9001).status, 'finished');

	// (a) rebuilt in place
	const result = derive.rebuildAll({ dataDir, log: makeLog() });
	assert.equal(result.characters[IVAN].transactions, 5);
	assert.equal(result.structures, 1);
	assert.deepEqual(treeOf(path.join(dataDir, 'ledger')), incremental);

	// (b) from raw alone: a data directory that holds nothing else
	const fresh = tmpDataDir(t);
	copyDir(path.join(dataDir, 'raw'), path.join(fresh, 'raw'));
	derive.rebuildAll({ dataDir: fresh, log: makeLog() });
	assert.deepEqual(treeOf(path.join(fresh, 'ledger')), incremental);
	assert.deepEqual(Object.keys(treeOf(path.join(fresh))).filter(name => !name.startsWith('raw/') && !name.startsWith('ledger/')), [], 'derive writes only under ledger/');
});

test('an error-stopped sync leaves no snapshot, and an unchanged one writes none', async (t) => {
	const ctx = setup(t);
	await history(ctx);
	const raw = createRawStore({ dataDir: ctx.dataDir });
	const logs = raw.syncLogStamps(IVAN).map(stamp => raw.readSyncLog(IVAN, stamp));
	assert.equal(logs.length, 5, 'one log per sync that called ESI');
	const stopped = logs.find(entry => entry.stop && entry.stop.reason === 'error-limit');
	assert.ok(stopped, 'the error-limit sync is logged');
	assert.equal(stopped.snapshot, null);
	const snapshots = fs.readdirSync(path.join(ctx.dataDir, 'ledger', String(IVAN), 'snapshots'));
	assert.equal(snapshots.length, logs.filter(entry => entry.snapshot).length - 1, 'the last, quiet sync repeated the previous snapshot');
});

test('a rebuild drops anything the raw store cannot account for, and re-derives the same snapshot contents', async (t) => {
	const ctx = setup(t);
	await history(ctx);
	const ledgerDir = path.join(ctx.dataDir, 'ledger', String(IVAN));
	const before = treeOf(path.join(ctx.dataDir, 'ledger'));
	fs.writeFileSync(path.join(ledgerDir, 'transactions.json'), '[{"transaction_id":999999,"bogus":true}]\n');
	fs.writeFileSync(path.join(ledgerDir, 'stray.json'), '{}');
	derive.rebuildCharacter({ dataDir: ctx.dataDir, characterId: IVAN });
	assert.deepEqual(treeOf(path.join(ctx.dataDir, 'ledger')), before);
	assert.ok(!fs.existsSync(path.join(ledgerDir, 'stray.json')));
	assert.deepEqual(fs.readdirSync(path.join(ctx.dataDir, 'ledger')).filter(name => name.startsWith('.')), [], 'no scratch directory is left behind');
});

test('a character with no raw data keeps the ledger it has', (t) => {
	const dataDir = tmpDataDir(t);
	const ledgerFile = path.join(dataDir, 'ledger', '5', 'transactions.json');
	fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
	fs.writeFileSync(ledgerFile, '[{"transaction_id":1}]\n');
	const result = derive.rebuildCharacter({ dataDir, characterId: 5 });
	assert.deepEqual(result, { skipped: 'no raw data' });
	assert.equal(fs.readFileSync(ledgerFile, 'utf8'), '[{"transaction_id":1}]\n');
	assert.deepEqual(derive.rebuildAll({ dataDir, log: makeLog() }), { characters: {}, structures: null, bookLogsRebuilt: false, bookLogs: 0, regionSnapshots: 0, regionSnapshotsSkipped: 0, bookChecksSkipped: 0, bookLogRawFrom: { regionSnapshotAt: null, typeBookAt: null } });
	assert.deepEqual(derive.rebuildAll({ dataDir, log: makeLog(), bookLogs: true }), { characters: {}, structures: null, bookLogsRebuilt: true, bookLogs: 0, regionSnapshots: 0, regionSnapshotsSkipped: 0, bookChecksSkipped: 0, bookLogRawFrom: null });
});

test('a rebuild waits for a sync in progress instead of racing it', async (t) => {
	const ctx = setup(t);
	await history(ctx);
	const lockDir = path.join(ctx.dataDir, 'locks');
	fs.mkdirSync(lockDir, { recursive: true });
	fs.writeFileSync(path.join(lockDir, `character-${IVAN}.lock`), JSON.stringify({ pid: process.ppid, at: Date.now() }));
	assert.throws(() => derive.rebuildCharacter({ dataDir: ctx.dataDir, characterId: IVAN }), /being synced/);
});

test('structure names come from every character, the newest answer winning', async (t) => {
	const ctx = setup(t);
	const { fake, clock, service } = ctx;
	fake.structures.set(STRUCTURE, { name: 'Old Name', owner_id: 1, position: { x: 1, y: 2, z: 3 }, solar_system_id: 30000144, type_id: 35834 });
	fake.character(IVAN, { transactions: [tx(1, { location_id: STRUCTURE })] });
	await service.syncCharacter(IVAN, { force: true });
	clock.advance(HOUR);
	fake.structures.set(STRUCTURE, { name: 'New Name', owner_id: 1, position: { x: 1, y: 2, z: 3 }, solar_system_id: 30000144, type_id: 35834 });
	// the ledger already knows the structure, so the second character's sync would not ask; derive
	// must still pick the newest raw answer when several exist
	const raw = createRawStore({ dataDir: ctx.dataDir });
	raw.write(GRANT, `universe-structures-${STRUCTURE}`, { fetchedAt: '2026-11-20T20:00:00.000Z', url: 'x', status: 200, headers: {}, body: { name: 'New Name', owner_id: 1, solar_system_id: 30000144, type_id: 35834, position: { x: 1, y: 2, z: 3 } } });
	derive.rebuildAll({ dataDir: ctx.dataDir, log: makeLog() });
	const structures = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'ledger', 'structures.json'), 'utf8'));
	assert.equal(structures[STRUCTURE].name, 'New Name');
	assert.equal(structures[STRUCTURE].characterId, GRANT);
	assert.equal(structures[STRUCTURE].fetchedAt, '2026-11-20T20:00:00.000Z');
});

test('derived snapshots hold the orders, assets and balance of their sync', async (t) => {
	const ctx = setup(t);
	await history(ctx);
	const snapshots = derive.rebuildCharacter({ dataDir: ctx.dataDir, characterId: IVAN });
	assert.ok(snapshots.snapshots >= 2);
	const dir = path.join(ctx.dataDir, 'ledger', String(IVAN), 'snapshots');
	const all = fs.readdirSync(dir).sort().map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
	assert.deepEqual(all.map(s => [s.orders.length, s.assets.length, s.balance]).slice(0, 2), [[1, 5, 1000], [2, 5, 2000]]);
	assert.deepEqual(all.map(s => s.syncedAt), [...all.map(s => s.syncedAt)].sort());
	assert.equal(all[all.length - 1].assets.length, 3);
});

// ---- the regional book: logs folded from rows in hand

test('a book log folded from rows in hand is the log foldBook builds, and the regional order pages in raw are not read as per-type books', async (t) => {
	const { createLedger, bookLogText } = require('../lib/ledger');
	const ctx = setup(t);
	const REGION = 10000043;
	const row = (id, typeId, price, o = {}) => ({ order_id: id, type_id: typeId, price, is_buy_order: false, volume_remain: 5, volume_total: 10, issued: '2026-11-20T10:00:00Z', duration: 90, range: 'region', location_id: 60008494, system_id: 30002187, min_volume: 1, ...o });
	const ledger = createLedger({ dataDir: ctx.dataDir });

	const first = [row(1, 35, 100), row(2, 35, 90, { is_buy_order: true })];
	const second = [row(1, 35, 99)];
	const file = path.join(ctx.dataDir, 'ledger', 'market', String(REGION), '35.json.gz');
	const bytes = derive.updateBookLogWithRows({ ledger, regionId: REGION, typeId: 35, at: '2026-11-20T12:00:00.000Z', rows: first });
	assert.equal(bytes, fs.statSync(file).size, 'the bytes it answers are the (compressed) file\'s');
	derive.updateBookLogWithRows({ ledger, regionId: REGION, typeId: 35, at: '2026-11-20T13:00:00.000Z', rows: second });
	derive.updateBookLogWithRows({ ledger, regionId: REGION, typeId: 35, at: '2026-11-20T14:00:00.000Z', rows: [] });

	const expected = { samples: [], orders: {} };
	derive.foldBook(expected, { at: '2026-11-20T12:00:00.000Z', stored: true, rows: first });
	derive.foldBook(expected, { at: '2026-11-20T13:00:00.000Z', stored: true, rows: second });
	derive.foldBook(expected, { at: '2026-11-20T14:00:00.000Z', stored: true, rows: [] });
	assert.equal(fileText(file), bookLogText(expected), 'byte for byte, inside the gzip');
	assert.deepEqual(expected.orders[1].path.map(entry => entry.price), [100, 99]);
	assert.equal(expected.orders[2].lastSeen, '2026-11-20T12:00:00.000Z', 'an order left out of a later sample keeps its last sighting');

	// a regional snapshot in raw: the pages are named `...-order-type-all[-page-n]`, which are not books
	// of a type; the rebuild replays them as the snapshot they were (and leaves 35, which has no raw)
	ctx.fake.market.regionOrders.set(String(REGION), [row(11, 34, 5), row(12, 36, 7), row(13, 36, 8)]);
	const run = await ctx.service.syncRegionBook({ regionId: REGION, force: true });
	assert.equal(run.status, 'ok');
	assert.equal(derive.bookPages(createRawStore({ dataDir: ctx.dataDir })).size, 0);
	const logDir = path.join(ctx.dataDir, 'ledger', 'market', String(REGION));
	const before = Object.fromEntries(['34', '35', '36'].map(id => [id, fileText(path.join(logDir, `${id}.json.gz`))]));
	assert.deepEqual(derive.rebuildBookLogs({ dataDir: ctx.dataDir }), { logs: 2, regionSnapshots: 1, regionSnapshotsSkipped: 0, checksSkipped: 0 }, '34 and 36 from the snapshot');
	assert.deepEqual(Object.fromEntries(['34', '35', '36'].map(id => [id, fileText(path.join(logDir, `${id}.json.gz`))])), before);
});

// ---- the regional book: the rebuild replays the snapshots with the per-type checks

const MARKET_REGION = 10000043;
const bookRow = (id, typeId, price, o = {}) => ({ order_id: id, type_id: typeId, price, is_buy_order: false, volume_remain: 5, volume_total: 10, issued: '2026-11-20T10:00:00Z', duration: 90, range: 'region', location_id: 60008494, system_id: 30002187, min_volume: 1, ...o });

// Per-type checks (the market step, a watch tick) and three regional snapshots, interleaved hour by
// hour; the last hour runs the market step and the region book in the same millisecond.
const bookHistory = async (ctx) => {
	const { fake, clock, service } = ctx;
	const R = MARKET_REGION;
	fake.character(IVAN, { orders: [order(8001, { type_id: 35 })], assets: [asset(1, { type_id: 34 })] });
	fake.market.orders.set(`${R}:35`, [bookRow(1, 35, 100), bookRow(2, 35, 110)]);
	fake.market.orders.set(`${R}:34`, [bookRow(20, 34, 50)]);
	await service.syncAll({ force: true, characterIds: [IVAN], regionBook: false });

	// +1 h, snapshot A: 35 re-priced and with a buy order, 36 and 37 new to the logs, 34 has none
	clock.advance(HOUR);
	fake.market.regionOrders.set(String(R), [bookRow(1, 35, 99), bookRow(2, 35, 110), bookRow(3, 35, 90, { is_buy_order: true }), bookRow(4, 36, 200), bookRow(5, 37, 300)]);
	const a = await service.syncRegionBook({ regionId: R });
	assert.equal(a.status, 'ok', JSON.stringify(a.errors));

	// +1 h, a watch tick: 35's own book changed again, now two pages
	clock.advance(HOUR);
	fake.market.orders.set(`${R}:35`, [bookRow(1, 35, 98), bookRow(2, 35, 110), bookRow(6, 35, 120)]);
	const tick = await service.syncWatch({ regionIds: [R] });
	assert.equal(tick.market.status, 'ok', JSON.stringify(tick.market));

	// +1 h, snapshot B: 36 re-priced, 37 gone, 34 back, 38 new
	clock.advance(HOUR);
	fake.market.regionOrders.set(String(R), [bookRow(1, 35, 98), bookRow(2, 35, 110), bookRow(6, 35, 120), bookRow(4, 36, 190), bookRow(20, 34, 49), bookRow(8, 38, 7)]);
	const b = await service.syncRegionBook({ regionId: R });
	assert.equal(b.status, 'ok', JSON.stringify(b.errors));

	// +1 h: the market step, then snapshot C (unchanged: 304s, the files B stored), at the same time
	clock.advance(HOUR);
	const both = await service.syncAll({ force: true, characterIds: [IVAN], regionBook: true });
	assert.equal(both.market.status, 'ok', JSON.stringify(both.market));
	assert.equal(both.regionBook.status, 'ok', JSON.stringify(both.regionBook));
	assert.equal(both.regionBook.notModified, both.regionBook.pages);
	return { a, b, c: both.regionBook };
};

test('the book log rebuild replays the regional snapshots in time order with the per-type checks: byte for byte what the jobs folded', async (t) => {
	const ctx = setup(t);
	const snaps = await bookHistory(ctx);
	const marketDir = path.join(ctx.dataDir, 'ledger', 'market');
	const incremental = treeOf(marketDir);
	assert.deepEqual(Object.keys(incremental).sort(), [34, 35, 36, 37, 38].map(id => `${MARKET_REGION}/${id}.json.gz`));
	const log35 = JSON.parse(incremental[`${MARKET_REGION}/35.json.gz`]);
	assert.ok(log35.samples.length >= 6, 'per-type checks and snapshots both');
	assert.ok(log35.samples.some(sample => sample.at === snaps.a.fetchedAt) && log35.samples.some(sample => sample.at === snaps.c.fetchedAt));
	assert.deepEqual(JSON.parse(incremental[`${MARKET_REGION}/37.json.gz`]).samples.length, 3, 'A, then empty samples at B and C');

	// (a) rebuilt in place
	assert.deepEqual(derive.rebuildBookLogs({ dataDir: ctx.dataDir }), { logs: 5, regionSnapshots: 3, regionSnapshotsSkipped: 0, checksSkipped: 0 });
	assert.deepEqual(treeOf(marketDir), incremental);

	// (b) from raw alone
	const fresh = tmpDataDir(t);
	copyDir(path.join(ctx.dataDir, 'raw'), path.join(fresh, 'raw'));
	const result = derive.rebuildAll({ dataDir: fresh, log: makeLog(), bookLogs: true });
	assert.equal(result.bookLogs, 5);
	assert.equal(result.regionSnapshots, 3);
	assert.equal(result.regionSnapshotsSkipped, 0);
	assert.deepEqual(treeOf(path.join(fresh, 'ledger', 'market')), incremental);
});

test('a regional snapshot whose pages were trimmed is skipped and counted, and the rebuild reproduces what raw still holds', async (t) => {
	const ctx = setup(t);
	const snaps = await bookHistory(ctx);
	const raw = createRawStore({ dataDir: ctx.dataDir });
	const entryA = raw.readSyncLog('public', snaps.a.syncedAt);
	const pageOne = `markets-${MARKET_REGION}-orders-order-type-all`;
	assert.ok(raw.remove('public', pageOne, entryA.pageStamps[0]) > 0);
	const before37 = fs.readFileSync(path.join(ctx.dataDir, 'ledger', 'market', String(MARKET_REGION), '37.json.gz'));

	const result = derive.rebuildAll({ dataDir: ctx.dataDir, log: makeLog(), bookLogs: true });
	assert.equal(result.regionSnapshots, 2);
	assert.equal(result.regionSnapshotsSkipped, 1);
	assert.equal(result.bookLogs, 4, '34, 35, 36 and 38: 37 was only ever in snapshot A');
	const ledger = require('../lib/ledger').createLedger({ dataDir: ctx.dataDir });
	const at = (typeId) => ledger.readBookLog(MARKET_REGION, typeId).samples.map(sample => sample.at);
	assert.ok(!at(35).includes(snaps.a.fetchedAt) && at(35).includes(snaps.b.fetchedAt), 'no sample from A');
	assert.deepEqual(at(36), [snaps.b.fetchedAt, snaps.c.fetchedAt], '36 starts at B');
	assert.equal(ledger.readBookLog(MARKET_REGION, 35).orders[3], undefined, 'the buy order only A saw');
	assert.deepEqual(fs.readFileSync(path.join(ctx.dataDir, 'ledger', 'market', String(MARKET_REGION), '37.json.gz')), before37, 'a log with no raw left behind it is left as it was');

	// a stored per-type check whose page file is gone is skipped too
	const firstBook = raw.list('public', `markets-${MARKET_REGION}-orders-type-id-34`)[0];
	raw.remove('public', `markets-${MARKET_REGION}-orders-type-id-34`, firstBook);
	assert.equal(derive.rebuildBookLogs({ dataDir: ctx.dataDir }).checksSkipped, 1);
	assert.ok(!at(34).includes(firstBook));
});

test('a plain rebuild leaves the book logs as they are and says how far back their raw reaches; asked, it rebuilds them', async (t) => {
	const ctx = setup(t);
	const snaps = await bookHistory(ctx);
	const marketDir = path.join(ctx.dataDir, 'ledger', 'market');
	const live = treeOf(marketDir);
	const raw = createRawStore({ dataDir: ctx.dataDir });
	// the budget trimmed snapshot A: the live logs still hold it, raw does not
	raw.remove('public', `markets-${MARKET_REGION}-orders-order-type-all`, raw.readSyncLog('public', snaps.a.syncedAt).pageStamps[0]);
	const fileTimes = () => fs.readdirSync(path.join(marketDir, String(MARKET_REGION))).map(name => fs.statSync(path.join(marketDir, String(MARKET_REGION), name)).mtimeMs);
	const before = fileTimes();

	const plain = derive.rebuildAll({ dataDir: ctx.dataDir, log: makeLog() });
	assert.equal(plain.bookLogsRebuilt, false);
	assert.deepEqual([plain.bookLogs, plain.regionSnapshots, plain.regionSnapshotsSkipped, plain.bookChecksSkipped], [0, 0, 0, 0]);
	const oldestBook = raw.slugs('public').filter(slug => /^markets-\d+-orders(?:-page-\d+)?-type-id-\d+$/.test(slug)).flatMap(slug => raw.list('public', slug)).sort()[0];
	assert.deepEqual(plain.bookLogRawFrom, { regionSnapshotAt: snaps.b.fetchedAt, typeBookAt: oldestBook }, 'B is the oldest snapshot left whole');
	assert.ok(plain.bookLogRawFrom.typeBookAt < snaps.a.fetchedAt, 'the per-type books reach back to the first market step');
	assert.deepEqual(treeOf(marketDir), live, 'not a byte changed');
	assert.deepEqual(fileTimes(), before, 'not even rewritten');
	assert.equal(plain.characters[IVAN].orderLog, 1, 'the character ledgers are rebuilt as before');

	const asked = derive.rebuildAll({ dataDir: ctx.dataDir, log: makeLog(), bookLogs: true });
	assert.equal(asked.bookLogsRebuilt, true);
	assert.equal(asked.regionSnapshotsSkipped, 1);
	assert.equal(asked.bookLogRawFrom, null);
	assert.notDeepEqual(treeOf(marketDir), live, 'rebuilt from raw: A\'s samples are gone');
});
