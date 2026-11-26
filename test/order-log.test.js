const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createSyncService } = require('../lib/sync');
const { createTokenStore } = require('../lib/tokenStore');
const { createLedger, orderLogText, bookLogText } = require('../lib/ledger');
const { createRawStore } = require('../lib/dataFiles');
const derive = require('../lib/derive');
const {
	ALL_SCOPES, makeClock, tmpDataDir, makeLog, makeTokens, createFakeEsi,
	order, historyOrder, asset,
} = require('../test-support/esi-fake');

// The two derived logs of Phase 1 (docs/order-monitor-plan.md): the order log of each character and
// the book log of each region and type, folded step by step by lib/sync.js and in one go from raw
// by lib/derive.js. A rebuild must land on the same bytes.

const IVAN = 90000001;
const REGION = 10000043;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// ---- the folds, on hand-made records

const rec = (fetchedAt, rows) => ({ fetchedAt, body: rows });
const row = (id, o = {}) => order(id, { price: 1000, volume_remain: 5, issued: '2026-11-18T10:00:00Z', ...o });
const T = (minutes) => new Date(Date.UTC(2026, 10, 20, 12, minutes)).toISOString();

test('the order log gets a path entry only when price, volume or issued changed, and the first sighting is one', () => {
	const log = {};
	const warnings = [];
	derive.foldOrders(log, rec(T(0), [row(8001), row(8002, { type_id: 36 })]), warnings);
	derive.foldOrders(log, rec(T(5), [row(8001, { duration: 30, escrow: 7 }), row(8002, { type_id: 36 })]), warnings);
	assert.deepEqual(log[8001].path, [{ at: T(0), price: 1000, volumeRemain: 5, issued: '2026-11-18T10:00:00Z' }], 'a field the log does not follow changed: no entry');
	assert.equal(log[8001].lastSeen, T(5));
	assert.equal(log[8001].firstSeen, T(0));

	derive.foldOrders(log, rec(T(10), [row(8001, { price: 990, issued: '2026-11-20T12:09:00Z' }), row(8002, { type_id: 36 })]), warnings);
	derive.foldOrders(log, rec(T(15), [row(8001, { price: 990, issued: '2026-11-20T12:09:00Z', volume_remain: 3 }), row(8002, { type_id: 36 })]), warnings);
	derive.foldOrders(log, rec(T(20), [row(8001, { price: 990, issued: '2026-11-20T12:09:00Z', volume_remain: 3 }), row(8002, { type_id: 36 })]), warnings);
	assert.deepEqual(log[8001].path.map(entry => [entry.at, entry.price, entry.volumeRemain, entry.issued]), [
		[T(0), 1000, 5, '2026-11-18T10:00:00Z'],
		[T(10), 990, 5, '2026-11-20T12:09:00Z'],
		[T(15), 990, 3, '2026-11-20T12:09:00Z'],
	]);
	assert.equal(log[8002].path.length, 1, 'an order that never changed has one entry');
	assert.deepEqual(warnings, []);
	assert.deepEqual(Object.keys(log[8001]).sort(), ['duration', 'end', 'firstSeen', 'isBuy', 'lastSeen', 'locationId', 'path', 'regionId', 'typeId', 'volumeTotal']);
	assert.deepEqual([log[8001].typeId, log[8001].locationId, log[8001].regionId, log[8001].isBuy, log[8001].volumeTotal, log[8001].duration], [34, 60008494, REGION, false, 10, 90]);
});

test('an order ends at the first answer that no longer lists it; history fills its state, now or later', () => {
	const log = {};
	derive.foldOrders(log, rec(T(0), [row(8001), row(8002), row(8003, { is_buy_order: true })]));
	derive.foldOrders(log, rec(T(20), [row(8001), row(8003, { is_buy_order: true })]));
	assert.deepEqual(log[8002].end, { state: null, volumeRemain: null, at: T(20) });
	assert.equal(log[8002].lastSeen, T(0));
	assert.equal(log[8001].end, null);
	assert.equal(log[8003].isBuy, true);

	// the row for a still-listed order is ignored; the one for an ended order fills in
	derive.applyHistory(log, [historyOrder(8001, { state: 'cancelled' }), historyOrder(8002, { state: 'expired', volume_remain: 0 }), historyOrder(9999)]);
	assert.equal(log[8001].end, null);
	assert.deepEqual(log[8002].end, { state: 'expired', volumeRemain: 0, at: T(20) });
	assert.equal(log[9999], undefined);

	// an order that ran out of time keeps its remainder; applying again changes nothing
	derive.foldOrders(log, rec(T(40), [row(8001, { price: 990 })]));
	derive.applyHistory(log, [historyOrder(8002, { state: 'expired', volume_remain: 0 }), historyOrder(8003, { state: 'cancelled', volume_remain: 4 })]);
	derive.applyHistory(log, [historyOrder(8002, { state: 'expired', volume_remain: 0 }), historyOrder(8003, { state: 'cancelled', volume_remain: 4 })]);
	assert.deepEqual(log[8003].end, { state: 'cancelled', volumeRemain: 4, at: T(40) });
	assert.deepEqual(log[8002].end, { state: 'expired', volumeRemain: 0, at: T(20) });
});

test('a volume that rises, or an ended order that comes back, is recorded and raised as a warning', () => {
	const log = {};
	const warnings = [];
	derive.foldOrders(log, rec(T(0), [row(8001, { volume_remain: 3 }), row(8002)]), warnings);
	derive.foldOrders(log, rec(T(5), [row(8001, { volume_remain: 8 }), row(8002)]), warnings);
	assert.deepEqual(log[8001].path.map(entry => entry.volumeRemain), [3, 8], 'still recorded');
	assert.deepEqual(warnings, [{ orderId: 8001, at: T(5), kind: 'volume-rise', from: 3, to: 8 }]);

	derive.foldOrders(log, rec(T(10), [row(8001, { volume_remain: 8 })]), warnings);
	assert.equal(log[8002].end.at, T(10));
	derive.foldOrders(log, rec(T(15), [row(8001, { volume_remain: 8 }), row(8002)]), warnings);
	assert.equal(log[8002].end, null, 'listed again: open again');
	assert.deepEqual(warnings[1], { orderId: 8002, at: T(15), kind: 'reappeared', endedAt: T(10) });
	assert.equal(warnings.length, 2);
});

test('rows without an order id are skipped, and a record that lists nothing ends every open order', () => {
	const log = {};
	derive.foldOrders(log, rec(T(0), [null, { price: 1 }, row(8001)]));
	assert.deepEqual(Object.keys(log), ['8001']);
	derive.foldOrders(log, rec(T(5), []));
	assert.equal(log[8001].end.at, T(5));
});

test('a book check is a sample; only a stored one adds orders and their price path', () => {
	const log = { samples: [], orders: {} };
	const book = (rows) => rows.map(r => ({ order_id: r[0], price: r[1], volume_remain: r[2], issued: r[3] || '2026-11-20T10:00:00Z', is_buy_order: false, volume_total: 9, duration: 90, min_volume: 1, range: 'region', location_id: 60008494, system_id: 30002187 }));
	derive.foldBook(log, { at: T(0), stored: true, rows: book([[1, 100, 5], [2, 110, 5]]) });
	derive.foldBook(log, { at: T(5), stored: false, rows: null });
	derive.foldBook(log, { at: T(10), stored: true, rows: book([[1, 100, 5], [2, 105, 5, T(9)], [3, 99, 2, T(8)]]) });
	assert.deepEqual(log.samples, [{ at: T(0), stored: true }, { at: T(5), stored: false }, { at: T(10), stored: true }]);
	assert.deepEqual(log.orders[1].path, [{ at: T(0), price: 100, volumeRemain: 5, issued: '2026-11-20T10:00:00Z' }]);
	assert.equal(log.orders[1].lastSeen, T(10));
	assert.deepEqual(log.orders[2].path.map(entry => [entry.price, entry.issued]), [[110, '2026-11-20T10:00:00Z'], [105, T(9)]]);
	assert.equal(log.orders[3].firstSeen, T(10));
	assert.deepEqual(log.orders[3], {
		isBuy: false, locationId: 60008494, systemId: 30002187, volumeTotal: 9, duration: 90, minVolume: 1, range: 'region',
		firstSeen: T(10), lastSeen: T(10), path: [{ at: T(10), price: 99, volumeRemain: 2, issued: T(8) }],
	});
});

test('the logs are written one order per line in numeric id order, keys sorted, whatever order they were folded in', (t) => {
	const text = orderLogText({ 7467834499: { b: 1, a: [{ z: 1, y: undefined }] }, 5: { x: null }, 99: {} });
	assert.equal(text, '{\n"5":{"x":null},\n"99":{},\n"7467834499":{"a":[{"z":1}],"b":1}\n}\n');
	assert.equal(orderLogText({}), '{}\n');
	assert.equal(bookLogText({ samples: [], orders: {} }), '{\n"samples":[],\n"orders":{}\n}\n');
	assert.equal(bookLogText({ samples: [{ stored: true, at: 'x' }], orders: { 2: { b: 1 }, 1: { a: 1 } } }), '{\n"samples":[\n{"at":"x","stored":true}\n],\n"orders":{\n"1":{"a":1},\n"2":{"b":1}\n}\n}\n');

	// through the ledger: the file is private, empty logs read back as empty
	const ledger = createLedger({ dataDir: tmpDataDir(t) });
	assert.deepEqual(ledger.readOrderLog(IVAN), {});
	assert.deepEqual(ledger.readBookLog(REGION, 34), { samples: [], orders: {} });
	assert.equal(ledger.hasOrderLog(IVAN), false);
	assert.equal(ledger.hasBookLog(REGION, 34), false);
	ledger.writeOrderLog(IVAN, { 7467834499: { a: 1 }, 5: { a: 2 } });
	ledger.writeBookLog(REGION, 34, { samples: [{ at: 'x', stored: false }], orders: {} });
	assert.deepEqual(Object.keys(ledger.readOrderLog(IVAN)), ['5', '7467834499']);
	assert.deepEqual(ledger.readBookLog(REGION, 34).samples, [{ at: 'x', stored: false }]);
	assert.equal(fs.statSync(path.join(ledger.dirOf(IVAN), 'order-log.json')).mode & 0o777, 0o600);
	assert.ok(ledger.hasOrderLog(IVAN) && ledger.hasBookLog(REGION, 34));
});

// ---- from raw alone

const rawBook = (raw, typeId, stamp, rows, page = 1) => raw.write('public', derive.bookSlug(REGION, typeId, page), { fetchedAt: stamp, url: 'x', status: 200, headers: {}, body: rows });
const bookRow = (id, price, o = {}) => ({ order_id: id, type_id: 34, price, is_buy_order: false, volume_remain: 5, volume_total: 10, issued: '2026-11-20T10:00:00Z', duration: 90, range: 'region', location_id: 60008494, system_id: 30002187, min_volume: 1, ...o });

test('buildOrderLog folds the raw orders records in time order and keeps the ledger\'s history rows; no raw, no file', (t) => {
	const dataDir = tmpDataDir(t);
	const raw = createRawStore({ dataDir });
	const ledger = createLedger({ dataDir });
	assert.deepEqual(derive.buildOrderLog({ raw, ledger, characterId: IVAN }), { orders: 0, warnings: [] });
	assert.equal(ledger.hasOrderLog(IVAN), false);

	// written out of order on purpose; the stamp names put them right
	const write = (stamp, rows) => raw.write(IVAN, 'orders', { fetchedAt: stamp, url: 'x', status: 200, headers: {}, body: rows });
	write(T(20), [row(8001, { price: 990 })]);
	write(T(0), [row(8001), row(8002)]);
	write(T(10), [row(8001), row(8002, { volume_remain: 9 })]);
	ledger.mergeInto(IVAN, 'orders-history', [historyOrder(8002, { state: 'expired', volume_remain: 0 })]);
	const built = derive.buildOrderLog({ raw, ledger, characterId: IVAN });
	assert.equal(built.orders, 2);
	assert.deepEqual(built.warnings, [{ orderId: 8002, at: T(10), kind: 'volume-rise', from: 5, to: 9 }], 'the builder hands the warnings back');
	const log = ledger.readOrderLog(IVAN);
	assert.deepEqual(log[8001].path.map(entry => [entry.at, entry.price]), [[T(0), 1000], [T(20), 990]]);
	assert.deepEqual(log[8002].end, { state: 'expired', volumeRemain: 0, at: T(20) });

	// a raw record that is an empty list still makes a log
	const quiet = tmpDataDir(t);
	createRawStore({ dataDir: quiet }).write(IVAN, 'orders', { fetchedAt: T(0), url: 'x', status: 200, headers: {}, body: [] });
	derive.buildOrderLog({ raw: createRawStore({ dataDir: quiet }), ledger: createLedger({ dataDir: quiet }), characterId: IVAN });
	assert.equal(fs.readFileSync(path.join(quiet, 'ledger', String(IVAN), 'order-log.json'), 'utf8'), '{}\n');
});

test('updateOrderLog folds every raw orders record newer than anything the log holds, in stamp order, and skips one whose body is not a list', (t) => {
	const dataDir = tmpDataDir(t);
	const raw = createRawStore({ dataDir });
	const ledger = createLedger({ dataDir });
	const write = (stamp, body) => raw.write(IVAN, 'orders', { fetchedAt: stamp, url: 'x', status: 200, headers: {}, body });
	write(T(0), [row(8001), row(8002)]);
	derive.updateOrderLog({ raw, ledger, characterId: IVAN });
	assert.deepEqual(Object.keys(ledger.readOrderLog(IVAN)), ['8001', '8002'], 'an empty log takes every record');

	// two answers stored since (say one by a run killed before it folded), written out of order
	write(T(20), [row(8001, { price: 990 })]);
	write(T(10), [row(8001), row(8002, { volume_remain: 3 })]);
	derive.updateOrderLog({ raw, ledger, characterId: IVAN });
	const log = ledger.readOrderLog(IVAN);
	assert.deepEqual(log[8001].path.map(entry => [entry.at, entry.price]), [[T(0), 1000], [T(20), 990]]);
	assert.deepEqual(log[8002].path.map(entry => [entry.at, entry.volumeRemain]), [[T(0), 5], [T(10), 3]]);
	assert.deepEqual(log[8002].end, { state: null, volumeRemain: null, at: T(20) });
	const built = createLedger({ dataDir, root: path.join(path.dirname(dataDir), 'built') });
	derive.buildOrderLog({ raw, ledger: built, characterId: IVAN });
	assert.equal(orderLogText(ledger.readOrderLog(IVAN)), orderLogText(built.readOrderLog(IVAN)), 'what a build from raw gives');

	// an answer that is not a list is no answer: open orders stay open, and folding again changes nothing
	write(T(30), 'Service Unavailable');
	const text = orderLogText(ledger.readOrderLog(IVAN));
	derive.updateOrderLog({ raw, ledger, characterId: IVAN });
	assert.equal(ledger.readOrderLog(IVAN)[8001].end, null);
	derive.updateOrderLog({ raw, ledger, characterId: IVAN });
	assert.equal(orderLogText(ledger.readOrderLog(IVAN)), text);
});

test('book checks come from the sync logs and the raw page files: new entries, old entries, and files nothing names', (t) => {
	const dataDir = tmpDataDir(t);
	const raw = createRawStore({ dataDir });
	const ledger = createLedger({ dataDir });
	// 34: a book of two pages. Before `books`: the hourly entry at T(0) lists 34, its window holds both pages.
	rawBook(raw, 34, T(0) .replace('.000Z', '.100Z'), [bookRow(1, 100), bookRow(2, 110)], 1);
	rawBook(raw, 34, T(0).replace('.000Z', '.300Z'), [bookRow(3, 120)], 2);
	raw.writeSyncLog('public', { syncedAt: T(0), finishedAt: T(0).replace('.000Z', '.900Z'), regionIds: [REGION], typeIds: [34, 35], status: 'ok', calls: 4 });
	// the same type an hour later: nothing stored in the window of this old entry, so a check that changed nothing
	raw.writeSyncLog('public', { syncedAt: T(60), finishedAt: T(60).replace('.000Z', '.500Z'), regionIds: [REGION], typeIds: [34], status: 'ok', calls: 2 });
	// a new entry: page 1 answered 304, page 2 stored; two pages
	rawBook(raw, 34, T(70).replace('.000Z', '.200Z'), [bookRow(3, 118)], 2);
	raw.writeSyncLog('public', { syncedAt: T(70), finishedAt: T(70).replace('.000Z', '.900Z'), source: 'watch', regionIds: [REGION], typeIds: [34], status: 'ok', calls: 3, books: [
		{ regionId: REGION, typeId: 34, outcome: 'stored', at: T(70), pages: 2, stamps: { 2: T(70).replace('.000Z', '.200Z') }, history: 'not-due' },
		{ regionId: REGION, typeId: 99, outcome: 'stored', at: T(70), pages: 1, stamps: { 1: T(70) }, history: null },
	] });
	// a stored file no entry names (the sync that wrote it died before its log): a check of its own
	rawBook(raw, 34, T(80), [bookRow(1, 95), bookRow(2, 110)], 1);
	// and an entry that failed to answer is not a sample
	raw.writeSyncLog('public', { syncedAt: T(90), finishedAt: T(90), source: 'watch', regionIds: [REGION], typeIds: [34], status: 'partial', calls: 1, books: [{ regionId: REGION, typeId: 34, outcome: 'error', at: T(90), pages: 1, stamps: {}, history: null }] });

	assert.deepEqual(derive.buildBookLogs({ raw, ledger }), { logs: 1, regionSnapshots: 0, regionSnapshotsSkipped: 0, checksSkipped: 0 }, 'type 35 and 99 have no raw book: no log without one');
	const log = ledger.readBookLog(REGION, 34);
	assert.deepEqual(log.samples, [
		{ at: T(0).replace('.000Z', '.100Z'), stored: true },
		{ at: T(60), stored: false },
		{ at: T(70), stored: true },
		{ at: T(80), stored: true },
	]);
	// the first check read both pages; the third took page 1 as it was and page 2 as stored then;
	// the fourth (page 1 stored alone) read page 2 as the third had stored it
	assert.deepEqual(log.orders[3].path.map(entry => [entry.at, entry.price]), [[T(0).replace('.000Z', '.100Z'), 120], [T(70), 118]]);
	assert.equal(log.orders[3].lastSeen, T(80), 'a page a check did not store is read as it was stored last');
	assert.equal(log.orders[1].lastSeen, T(80));
	assert.deepEqual(log.orders[1].path.map(entry => entry.price), [100, 95]);
	assert.equal(log.orders[2].lastSeen, T(80));
	assert.equal(log.orders[2].path.length, 1);
});

// ---- through the services

const setup = (t) => {
	const dataDir = tmpDataDir(t);
	const clock = makeClock();
	const fake = createFakeEsi({ now: clock, pageSize: 2 });
	const store = createTokenStore({ dataDir });
	store.upsert({ characterId: IVAN, name: 'Ivan Tester', ownerHash: 'o', scopes: ALL_SCOPES, refreshToken: 'r', status: 'ok' });
	fake.character(IVAN);
	const make = () => createSyncService({ dataDir, fetch: fake.fetch, now: clock, log: makeLog(), tokenStore: store, tokens: makeTokens(), userAgent: 'eflip-test/1.0' });
	return { dataDir, clock, fake, make, service: make() };
};

const bookOrder = (id, typeId, price, o = {}) => bookRow(id, price, { type_id: typeId, ...o });
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('the order log appends only on change and closes an order from the history of the hourly sync', async (t) => {
	const { dataDir, fake, service, clock } = setup(t);
	fake.character(IVAN, { orders: [order(8001, { type_id: 35 }), order(8002, { type_id: 36 }), order(8003, { type_id: 37 })], assets: [asset(1, { type_id: 34 })] });
	const logFile = path.join(dataDir, 'ledger', String(IVAN), 'order-log.json');
	const tick = async () => service.syncWatch({ regionIds: [REGION] });

	await tick();
	const first = fs.readFileSync(logFile, 'utf8');
	clock.advance(21 * MINUTE);
	const quiet = await tick();
	assert.equal(quiet.characters[IVAN].orders, 'not-modified');
	assert.equal(fs.readFileSync(logFile, 'utf8'), first, 'an answer that changed nothing leaves the log as it was');

	clock.advance(21 * MINUTE);
	fake.character(IVAN).orders[0] = order(8001, { type_id: 35, price: 990, issued: '2026-11-20T12:41:00Z' });
	await tick();
	clock.advance(21 * MINUTE);
	fake.character(IVAN).orders[0] = order(8001, { type_id: 35, price: 990, issued: '2026-11-20T12:41:00Z', volume_remain: 3 });
	await tick();
	const afterFill = readJson(logFile);
	assert.deepEqual(afterFill[8001].path.map(entry => [entry.price, entry.volumeRemain, entry.issued]), [
		[1000, 5, '2026-11-18T10:00:00Z'],
		[990, 5, '2026-11-20T12:41:00Z'],
		[990, 3, '2026-11-20T12:41:00Z'],
	]);
	assert.equal(afterFill[8002].end, null);

	// 8002 sells out and 8003 is withdrawn after a partial fill: the answer that drops them dates the end
	clock.advance(21 * MINUTE);
	fake.character(IVAN).orders = [fake.character(IVAN).orders[0]];
	await tick();
	const stamps = service.raw.list(IVAN, 'orders');
	const ended = readJson(logFile);
	assert.deepEqual(ended[8002].end, { state: null, volumeRemain: null, at: stamps[stamps.length - 1] });
	assert.equal(ended[8002].lastSeen, stamps[stamps.length - 2]);
	assert.deepEqual(ended[8003].end, { state: null, volumeRemain: null, at: stamps[stamps.length - 1] });

	// the hourly sync brings orders/history: states arrive, the end times stay
	clock.advance(MINUTE);
	fake.character(IVAN).ordersHistory = [historyOrder(8002, { type_id: 36, price: 2000 }), historyOrder(8003, { type_id: 37, state: 'cancelled', volume_remain: 4 })];
	const hourly = await service.syncCharacter(IVAN, { force: true });
	assert.equal(hourly.routes.orders.notDue, 1);
	const closed = readJson(logFile);
	assert.deepEqual(closed[8002].end, { state: 'expired', volumeRemain: 0, at: ended[8002].end.at });
	assert.deepEqual(closed[8003].end, { state: 'cancelled', volumeRemain: 4, at: ended[8003].end.at });
	assert.equal(closed[8001].end, null);
});

test('an hourly sync alone keeps the order log: an answer it stores is folded, and so are history rows that come later', async (t) => {
	const { dataDir, fake, service, clock } = setup(t);
	fake.character(IVAN, { orders: [order(8001, { type_id: 35 }), order(8002, { type_id: 36 })], assets: [asset(1, { type_id: 34 })] });
	await service.syncCharacter(IVAN, { force: true });
	const logFile = path.join(dataDir, 'ledger', String(IVAN), 'order-log.json');
	assert.deepEqual(Object.keys(readJson(logFile)), ['8001', '8002']);

	clock.advance(2 * HOUR);
	fake.character(IVAN).orders = [order(8001, { type_id: 35, price: 995 })];
	fake.character(IVAN).ordersHistory = [historyOrder(8002, { type_id: 36 })];
	await service.syncCharacter(IVAN, { force: true });
	const log = readJson(logFile);
	assert.equal(log[8001].path.length, 2);
	assert.deepEqual(log[8002].end, { state: 'expired', volumeRemain: 0, at: log[8002].end.at });
	assert.ok(log[8002].end.at > log[8002].lastSeen);

	// history rows only (the open orders did not change): the log still picks them up
	clock.advance(2 * HOUR);
	fake.character(IVAN).orders = [order(8001, { type_id: 35, price: 995 })];
	fake.character(IVAN).ordersHistory.push(historyOrder(8009, { type_id: 38 }));
	const before = fs.readFileSync(logFile, 'utf8');
	await service.syncCharacter(IVAN, { force: true });
	assert.equal(fs.readFileSync(logFile, 'utf8'), before, 'a history row for an order the log never saw is not added');
});

test('an orders answer stored by a sync killed before it folded is folded by the next sync, which stores nothing new', async (t) => {
	const { dataDir, fake, service, clock } = setup(t);
	fake.character(IVAN, { orders: [order(8001, { type_id: 35 })] });
	await service.syncCharacter(IVAN, { force: true });
	const logFile = path.join(dataDir, 'ledger', String(IVAN), 'order-log.json');
	assert.equal(readJson(logFile)[8001].end, null);

	// the answer a killed run stored (Ctrl-C during the orders-history walk): in raw, never folded
	const killedAt = new Date(clock() + 30 * MINUTE).toISOString();
	service.raw.write(IVAN, 'orders', { fetchedAt: killedAt, url: `https://esi.evetech.net/characters/${IVAN}/orders`, status: 200, headers: {}, body: [] });

	clock.advance(2 * HOUR);
	fake.character(IVAN).orders = [];
	const next = await service.syncCharacter(IVAN, { force: true });
	assert.equal(next.status, 'ok', JSON.stringify(next.errors));
	assert.equal(next.routes.orders.stored, 0, 'the same body as the stored answer: nothing new');
	assert.deepEqual(readJson(logFile)[8001].end, { state: null, volumeRemain: null, at: killedAt });

	const fresh = tmpDataDir(t);
	fs.cpSync(path.join(dataDir, 'raw'), path.join(fresh, 'raw'), { recursive: true });
	derive.rebuildAll({ dataDir: fresh, log: makeLog() });
	assert.equal(fs.readFileSync(path.join(fresh, 'ledger', String(IVAN), 'order-log.json'), 'utf8'), fs.readFileSync(logFile, 'utf8'), 'the order log a rebuild gives');
});

// path (relative, slash-separated) -> text of every file under `dir`; a gzipped file (the book
// logs) by its decompressed text, so what compares is the stable text inside.
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

// Hourly syncs, ticks and 304s over two hours of a character whose orders change, sell out and end,
// and of a three-page book that is undercut, partly changed (page 2 alone) and shifted.
const history = async (ctx) => {
	const { fake, clock, service } = ctx;
	fake.character(IVAN, {
		orders: [order(8001, { type_id: 35, price: 1000 }), order(8002, { type_id: 36, price: 2000 }), order(8003, { type_id: 37, is_buy_order: true, price: 50 })],
		assets: [asset(1, { type_id: 34 })],
	});
	const book35 = [bookOrder(8001, 35, 1000), bookOrder(9001, 35, 1010), bookOrder(9002, 35, 1020), bookOrder(9003, 35, 1030), bookOrder(9004, 35, 1040)];
	fake.market.orders.set(`${REGION}:35`, book35);
	fake.market.orders.set(`${REGION}:36`, [bookOrder(8002, 36, 2000), bookOrder(9010, 36, 2010)]);
	fake.market.history.set(`${REGION}:35`, [{ date: '2026-11-19', average: 1000, highest: 1100, lowest: 900, order_count: 4, volume: 40 }]);
	const watch = () => service.syncWatch({ regionIds: [REGION] });

	await service.syncAll({ force: true });
	clock.advance(6 * MINUTE);
	await watch(); // books answer 304
	clock.advance(10 * MINUTE);
	book35[3] = bookOrder(9003, 35, 1029, { issued: '2026-11-20T12:15:00Z' }); // page 2 alone changes
	await watch();
	clock.advance(6 * MINUTE);
	fake.character(IVAN).orders[0] = order(8001, { type_id: 35, price: 990, issued: '2026-11-20T12:21:00Z', volume_remain: 3 });
	book35.unshift(bookOrder(9100, 35, 985, { issued: '2026-11-20T12:20:00Z' })); // every page shifts
	book35[1] = bookOrder(8001, 35, 990, { issued: '2026-11-20T12:21:00Z', volume_remain: 3 });
	await watch();
	clock.advance(15 * MINUTE);
	fake.character(IVAN).orders = [fake.character(IVAN).orders[0], fake.character(IVAN).orders[2]]; // 8002 sold out
	fake.market.orders.set(`${REGION}:36`, [bookOrder(9010, 36, 2010)]);
	fake.character(IVAN).ordersHistory = [historyOrder(8002, { type_id: 36, price: 2000 })];
	await watch();
	clock.advance(HOUR);
	await service.syncAll({ force: true }); // brings the history row and the hourly books
	clock.advance(6 * MINUTE);
	await watch();
	clock.advance(25 * HOUR);
	await service.syncAll({ force: true }); // everything expired, nothing new but a 304 each
};

test('re-deriving from raw gives byte-for-byte the order log and the book logs the sync folded', async (t) => {
	const ctx = setup(t);
	await history(ctx);
	const { dataDir } = ctx;
	const incremental = treeOf(path.join(dataDir, 'ledger'));

	// the history really exercised the pieces
	const orderLog = JSON.parse(incremental[`${IVAN}/order-log.json`].replace(/^\{\n/, '{').replace(/\n\}\n$/, '}'));
	assert.deepEqual(Object.keys(orderLog), ['8001', '8002', '8003']);
	assert.equal(orderLog[8001].path.length, 2);
	assert.equal(orderLog[8002].end.state, 'expired');
	assert.equal(orderLog[8002].end.volumeRemain, 0);
	assert.equal(orderLog[8001].end, null);
	const names = Object.keys(incremental).filter(name => name.startsWith('market/'));
	assert.deepEqual(names, [`market/${REGION}/34.json.gz`, `market/${REGION}/35.json.gz`, `market/${REGION}/36.json.gz`], 'the types of the snapshot; the buy-order-only type 37 is not one');
	const log35 = JSON.parse(incremental[`market/${REGION}/35.json.gz`]);
	assert.ok(log35.samples.some(sample => sample.stored) && log35.samples.some(sample => !sample.stored), 'stored checks and 304s');
	assert.equal(Object.keys(log35.orders).length, 6, 'the three pages as assembled, the new one included');
	assert.deepEqual(log35.orders[9003].path.map(entry => entry.price), [1030, 1029]);
	const entries = ctx.service.raw.syncLogStamps('public').map(stamp => ctx.service.raw.readSyncLog('public', stamp));
	const partial = entries.flatMap(entry => entry.books || []).find(book => book.typeId === 35 && book.outcome === 'stored' && Object.keys(book.stamps).join() === '2');
	assert.ok(partial, 'a check that stored page 2 alone');
	assert.equal(partial.pages, 3);
	assert.ok(entries.some(entry => entry.source === 'watch') && entries.some(entry => entry.source === 'market'));

	// (a) rebuilt in place (the book logs only when asked)
	const result = derive.rebuildAll({ dataDir, log: makeLog(), bookLogs: true });
	assert.equal(result.bookLogs, 3);
	assert.equal(result.characters[IVAN].orderLog, 3);
	assert.deepEqual(result.characters[IVAN].orderLogWarnings, []);
	assert.deepEqual(treeOf(path.join(dataDir, 'ledger')), incremental);

	// (b) from raw alone
	const fresh = tmpDataDir(t);
	fs.cpSync(path.join(dataDir, 'raw'), path.join(fresh, 'raw'), { recursive: true });
	derive.rebuildAll({ dataDir: fresh, log: makeLog(), bookLogs: true });
	assert.deepEqual(treeOf(path.join(fresh, 'ledger')), incremental);
});

test('logs that predate the watch are built from raw and the old sync logs first, then folded on: same bytes as a rebuild', async (t) => {
	const ctx = setup(t);
	const { fake, clock, dataDir } = ctx;
	fake.character(IVAN, { orders: [order(8001, { type_id: 35 })], assets: [asset(1, { type_id: 34 })] });
	fake.market.orders.set(`${REGION}:35`, [bookOrder(8001, 35, 1000), bookOrder(9001, 35, 1010)]);
	await ctx.service.syncAll({ force: true });
	clock.advance(HOUR);
	await ctx.service.syncAll({ force: true });

	// back to before the logs: no order log, no book logs, public sync logs without `books`
	fs.rmSync(path.join(dataDir, 'ledger', 'market'), { recursive: true });
	fs.rmSync(path.join(dataDir, 'ledger', String(IVAN), 'order-log.json'));
	const raw = createRawStore({ dataDir });
	for (const stamp of raw.syncLogStamps('public')) {
		const entry = raw.readSyncLog('public', stamp);
		delete entry.books;
		delete entry.source;
		raw.writeSyncLog('public', entry);
	}

	// a new service (a restarted server) goes on: the first tick builds, then folds
	clock.advance(HOUR);
	fake.character(IVAN).orders = [order(8001, { type_id: 35, price: 990, issued: '2026-11-20T14:00:00Z' })];
	fake.market.orders.set(`${REGION}:35`, [bookOrder(8001, 35, 990, { issued: '2026-11-20T14:00:00Z' }), bookOrder(9001, 35, 1010)]);
	const restarted = ctx.make();
	const tick = await restarted.syncWatch({ regionIds: [REGION] });
	assert.equal(tick.market.types[0].outcome, 'stored');
	const log = createLedger({ dataDir }).readBookLog(REGION, 35);
	assert.deepEqual(log.samples.map(sample => sample.stored), [true, false, true], 'the two hourly checks from the old logs, and this one');
	assert.equal(readJson(path.join(dataDir, 'ledger', String(IVAN), 'order-log.json'))[8001].path.length, 2);

	// the held type 34 is only in the hourly snapshot: its log is built when that next checks it
	assert.ok(!createLedger({ dataDir }).hasBookLog(REGION, 34));
	clock.advance(10 * MINUTE);
	await restarted.syncAll({ force: true });
	assert.deepEqual(createLedger({ dataDir }).readBookLog(REGION, 34).samples.map(sample => sample.stored), [true, false, false]);

	const incremental = treeOf(path.join(dataDir, 'ledger'));
	derive.rebuildAll({ dataDir, log: makeLog(), bookLogs: true });
	assert.deepEqual(treeOf(path.join(dataDir, 'ledger')), incremental);
});

test('a rebuild waits for the market lock like it waits for a character\'s', async (t) => {
	const ctx = setup(t);
	const { acquireLock } = require('../lib/dataFiles');
	const hold = acquireLock(ctx.dataDir, 'market');
	assert.throws(() => derive.rebuildBookLogs({ dataDir: ctx.dataDir }), /market is being synced/);
	hold();
	assert.deepEqual(derive.rebuildBookLogs({ dataDir: ctx.dataDir }), { logs: 0, regionSnapshots: 0, regionSnapshotsSkipped: 0, checksSkipped: 0 });
});
