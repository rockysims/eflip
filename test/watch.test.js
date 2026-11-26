const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createSyncService } = require('../lib/sync');
const { createTokenStore } = require('../lib/tokenStore');
const { acquireLock } = require('../lib/dataFiles');
const derive = require('../lib/derive');
const {
	ALL_SCOPES, makeClock, tmpDataDir, makeLog, makeTokens, createFakeEsi,
	order, asset, tx, journalRow,
} = require('../test-support/esi-fake');

// The watch refresh (syncWatch): our open orders, then the book and history of the types listed.
// Every ESI answer comes from test-support/esi-fake.js.

const IVAN = 90000001;
const REGION = 10000043;
const OTHER_REGION = 10000002;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const setup = (t, { characters = [IVAN], scopes = ALL_SCOPES, fake: fakeOptions = {} } = {}) => {
	const dataDir = tmpDataDir(t);
	const clock = makeClock();
	const fake = createFakeEsi({ now: clock, ...fakeOptions });
	const store = createTokenStore({ dataDir });
	for (const id of characters) {
		store.upsert({ characterId: id, name: id === IVAN ? 'Ivan Tester' : 'Grant Tester', ownerHash: `owner-${id}`, scopes, refreshToken: `refresh-${id}`, status: 'ok' });
		fake.character(id);
	}
	const tokens = makeTokens();
	const log = makeLog();
	const service = createSyncService({ dataDir, fetch: fake.fetch, now: clock, log, tokenStore: store, tokens, userAgent: 'eflip-test/1.0' });
	return { dataDir, clock, fake, store, tokens, log, service };
};

// a competing (or our own) order as the public book lists it
const bookOrder = (id, typeId, price, o = {}) => ({
	order_id: id, type_id: typeId, price, is_buy_order: false, volume_remain: 5, volume_total: 10,
	issued: '2026-11-20T10:00:00Z', duration: 90, range: 'region', location_id: 60008494, system_id: 30002187, min_volume: 1, ...o,
});

// Ivan lists 35 and 36 in REGION and 38 in another region, and has a buy order for 37.
const listIvan = (fake) => {
	fake.character(IVAN, {
		orders: [
			order(8001, { type_id: 35, price: 1000 }),
			order(8002, { type_id: 36, price: 2000 }),
			order(8003, { type_id: 37, is_buy_order: true, price: 50 }),
			order(8004, { type_id: 38, region_id: OTHER_REGION, price: 70 }),
		],
		assets: [asset(1, { type_id: 34 })],
	});
	fake.market.orders.set(`${REGION}:35`, [bookOrder(8001, 35, 1000), bookOrder(9001, 35, 1010)]);
	fake.market.orders.set(`${REGION}:36`, [bookOrder(8002, 36, 2000)]);
	fake.market.orders.set(`${REGION}:37`, [bookOrder(9002, 37, 49, { is_buy_order: true })]);
	fake.market.orders.set(`${OTHER_REGION}:38`, [bookOrder(8004, 38, 70)]);
	fake.market.orders.set(`${REGION}:99`, [bookOrder(9003, 99, 5)]);
	fake.market.history.set(`${REGION}:35`, [{ date: '2026-11-19', average: 1000, highest: 1100, lowest: 900, order_count: 4, volume: 40 }]);
};

// book logs and public market raw are gzipped (`.json.gz`)
const readJson = (file) => JSON.parse(file.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8') : fs.readFileSync(file, 'utf8'));
const rawNames = (dataDir, owner, slug) => {
	try {
		return fs.readdirSync(path.join(dataDir, 'raw', String(owner), slug)).filter(name => /\.json(?:\.gz)?$/.test(name)).sort();
	} catch (e) {
		return [];
	}
};
const orderLog = (dataDir, id = IVAN) => readJson(path.join(dataDir, 'ledger', String(id), 'order-log.json'));
const logFile = (dataDir, typeId, region = REGION) => path.join(dataDir, 'ledger', 'market', String(region), `${typeId}.json.gz`);
const bookLog = (dataDir, typeId, region = REGION) => readJson(logFile(dataDir, typeId, region));
const publicLogs = (service) => service.raw.syncLogStamps('public').map(stamp => service.raw.readSyncLog('public', stamp));
const marketCalls = (fake) => fake.callsTo(/^\/markets\//);
// every file of a character's ledger, path -> bytes
const ledgerTree = (dataDir, id = IVAN) => {
	const root = path.join(dataDir, 'ledger', String(id));
	const out = {};
	const visit = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) visit(full);
			else if (!entry.name.startsWith('.')) out[path.relative(root, full).split(path.sep).join('/')] = fs.readFileSync(full);
		}
	};
	if (fs.existsSync(root)) visit(root);
	return out;
};

test('a tick stores our orders and a book per listed type, and nothing for unlisted ones', async (t) => {
	const { dataDir, fake, service, clock } = setup(t);
	listIvan(fake);
	const tick = await service.syncWatch({ regionIds: [REGION] });

	assert.equal(tick.tickedAt, new Date(clock()).toISOString());
	assert.deepEqual(Object.keys(tick.characters), [String(IVAN)]);
	const ivan = tick.characters[IVAN];
	assert.equal(ivan.status, 'ok');
	assert.equal(ivan.name, 'Ivan Tester');
	assert.equal(ivan.orders, 'stored');
	assert.equal(ivan.openSellOrders, 3, 'two here, one in the other region; the buy order is not a sell order');
	assert.match(ivan.expires, /^2026-11-20T12:20:00/);
	assert.equal(tick.market.status, 'ok');
	assert.deepEqual(tick.market.regionIds, [REGION]);
	assert.deepEqual(tick.market.types.map(type => [type.typeId, type.outcome, type.history]), [[35, 'stored', 'stored'], [36, 'stored', 'stored']]);
	assert.equal(tick.stop, null);

	// what went out: one orders call, a book and a history call for each of the two types, no more
	assert.equal(fake.callsTo(/^\/characters\/\d+\/orders$/).length, 1);
	assert.deepEqual(fake.callsTo(/^\/markets\/\d+\/orders$/).map(call => call.query.type_id).sort(), ['35', '36']);
	assert.deepEqual(fake.callsTo(/^\/markets\/\d+\/history$/).map(call => call.query.type_id).sort(), ['35', '36']);
	assert.ok(fake.callsTo(/^\/markets\//).every(call => call.path.startsWith(`/markets/${REGION}/`)));
	assert.ok(fake.callsTo(/^\/markets\//).every(call => call.headers.authorization === undefined));

	// stored raw: the books of 35 and 36 only
	for (const typeId of [35, 36]) assert.equal(rawNames(dataDir, 'public', `markets-${REGION}-orders-type-id-${typeId}`).length, 1, String(typeId));
	for (const typeId of [37, 38, 99]) assert.equal(rawNames(dataDir, 'public', `markets-${REGION}-orders-type-id-${typeId}`).length, 0, `type ${typeId} is not listed here`);
	assert.equal(rawNames(dataDir, 'public', `markets-${OTHER_REGION}-orders-type-id-38`).length, 0, 'another region is not watched');
	assert.equal(rawNames(dataDir, IVAN, 'orders').length, 1);

	// the logs: all four orders of the character, a book log for the two types
	assert.deepEqual(Object.keys(orderLog(dataDir)), ['8001', '8002', '8003', '8004']);
	assert.equal(orderLog(dataDir)[8003].isBuy, true);
	assert.deepEqual(fs.readdirSync(path.join(dataDir, 'ledger', 'market', String(REGION))).sort(), ['35.json.gz', '36.json.gz']);
	const log35 = bookLog(dataDir, 35);
	assert.deepEqual(log35.samples, [{ at: log35.samples[0].at, stored: true }]);
	assert.deepEqual(Object.keys(log35.orders), ['8001', '9001']);

	// the tick is on disk, and leaves the hourly sync alone
	const saved = readJson(path.join(dataDir, 'esi-cache', 'public', '_watch.json'));
	assert.deepEqual(saved, JSON.parse(JSON.stringify(tick)));
	const status = service.watchStatus();
	assert.equal(status.running, false);
	assert.equal(status.tickedAt, tick.tickedAt);
	assert.equal(service.characterStatus(IVAN).syncedAt, null, 'a tick is not a sync');
	assert.equal(service.status().market.syncedAt, null);
	assert.ok(!fs.existsSync(path.join(dataDir, 'raw', String(IVAN), '_sync-log')), 'no character sync log from a tick');
	const logs = publicLogs(service);
	assert.equal(logs.length, 1);
	assert.equal(logs[0].source, 'watch');
	assert.deepEqual(logs[0].books.map(book => [book.regionId, book.typeId, book.outcome]), [[REGION, 35, 'stored'], [REGION, 36, 'stored']]);
});

test('before any tick the status is empty, and a second tick inside the cache windows makes no call', async (t) => {
	const { fake, service, clock, dataDir } = setup(t);
	listIvan(fake);
	assert.deepEqual(service.watchStatus(), { tickedAt: null, finishedAt: null, characters: {}, market: null, stop: null, running: false });
	await service.syncWatch({ regionIds: [REGION] });
	const rawBefore = rawNames(dataDir, 'public', `markets-${REGION}-orders-type-id-35`).length;
	const logsBefore = publicLogs(service).length;

	clock.advance(2 * MINUTE);
	fake.reset();
	const second = await service.syncWatch({ regionIds: [REGION] });
	assert.equal(fake.calls.length, 0, 'inside five minutes nothing is asked');
	assert.equal(second.characters[IVAN].orders, 'not-due');
	assert.deepEqual(second.market.types.map(type => [type.typeId, type.outcome, type.history]), [[35, 'not-due', 'not-due'], [36, 'not-due', 'not-due']]);
	assert.equal(second.market.calls, 0);
	assert.equal(rawNames(dataDir, 'public', `markets-${REGION}-orders-type-id-35`).length, rawBefore);
	assert.equal(publicLogs(service).length, logsBefore, 'a tick that called nothing leaves no log');
	assert.equal(bookLog(dataDir, 35).samples.length, 1, 'and no sample: nothing was checked');
	assert.equal(service.watchStatus().tickedAt, second.tickedAt);

	// five minutes in: the books are due again, our orders (20 minutes) and the history (a day) are not
	clock.advance(4 * MINUTE);
	fake.reset();
	const third = await service.syncWatch({ regionIds: [REGION] });
	assert.deepEqual(fake.calls.map(call => [call.path, call.status]), [[`/markets/${REGION}/orders`, 304], [`/markets/${REGION}/orders`, 304]]);
	assert.equal(third.characters[IVAN].orders, 'not-due');
	assert.deepEqual(third.market.types.map(type => [type.typeId, type.outcome, type.history]), [[35, 'not-modified', 'not-due'], [36, 'not-modified', 'not-due']]);
	assert.equal(rawNames(dataDir, 'public', `markets-${REGION}-orders-type-id-35`).length, 1, 'a 304 stores nothing');

	// after 20 minutes our orders are asked too, and nothing changed
	clock.advance(15 * MINUTE);
	fake.reset();
	const fourth = await service.syncWatch({ regionIds: [REGION] });
	assert.equal(fourth.characters[IVAN].orders, 'not-modified');
	assert.equal(fake.callsTo(/^\/characters\//).length, 1);
	assert.equal(rawNames(dataDir, IVAN, 'orders').length, 1);
});

test('a book-log sample records a 304 as not stored, and an order is last confirmed by the stored check that lists it', async (t) => {
	const { fake, service, clock, dataDir } = setup(t);
	listIvan(fake);
	const first = await service.syncWatch({ regionIds: [REGION] });
	clock.advance(6 * MINUTE);
	const second = await service.syncWatch({ regionIds: [REGION] });
	assert.deepEqual(second.market.types.map(type => type.outcome), ['not-modified', 'not-modified']);

	const log = bookLog(dataDir, 35);
	assert.deepEqual(log.samples.map(sample => sample.stored), [true, false]);
	assert.equal(log.samples[0].at, first.market.types[0].at, 'a stored check is at its first answer');
	assert.equal(log.samples[1].at, new Date(clock()).toISOString(), 'a 304 at the time it came');
	assert.equal(log.orders[8001].firstSeen, log.samples[0].at);
	assert.equal(log.orders[8001].lastSeen, log.samples[0].at, 'only a stored check lists orders');
	assert.deepEqual(log.orders[8001].path, [{ at: log.samples[0].at, price: 1000, volumeRemain: 5, issued: '2026-11-20T10:00:00Z' }]);

	// the book moves: a competitor undercuts, our order sells a unit
	clock.advance(6 * MINUTE);
	fake.market.orders.set(`${REGION}:35`, [bookOrder(8001, 35, 1000, { volume_remain: 4 }), bookOrder(9001, 35, 1010), bookOrder(9004, 35, 999, { issued: '2026-11-20T12:15:00Z' })]);
	await service.syncWatch({ regionIds: [REGION] });
	const moved = bookLog(dataDir, 35);
	assert.deepEqual(moved.samples.map(sample => sample.stored), [true, false, true]);
	assert.deepEqual(moved.orders[8001].path.map(entry => entry.volumeRemain), [5, 4], 'a path entry for the change only');
	assert.deepEqual(moved.orders[9001].path.length, 1, 'an unchanged competitor adds nothing');
	assert.equal(moved.orders[9001].lastSeen, moved.samples[2].at);
	assert.deepEqual(moved.orders[9004], {
		isBuy: false, locationId: 60008494, systemId: 30002187, volumeTotal: 10, duration: 90, minVolume: 1, range: 'region',
		firstSeen: moved.samples[2].at, lastSeen: moved.samples[2].at,
		path: [{ at: moved.samples[2].at, price: 999, volumeRemain: 5, issued: '2026-11-20T12:15:00Z' }],
	});
});

test('a watch tick followed by the hourly sync still writes a snapshot, and it names the tick\'s raw orders file', async (t) => {
	const { fake, service, clock, dataDir } = setup(t);
	listIvan(fake);
	await service.syncWatch({ regionIds: [REGION] });
	const tickStamp = service.raw.latestStamp(IVAN, 'orders');
	assert.ok(tickStamp);

	clock.advance(MINUTE);
	const hourly = await service.syncCharacter(IVAN, { force: true });
	assert.equal(hourly.status, 'ok', JSON.stringify(hourly.errors));
	assert.equal(hourly.routes.orders.notDue, 1, 'the hourly orders call finds the tick\'s answer still current');
	assert.equal(hourly.routes.orders.calls, 0);
	assert.equal(fake.callsTo(/^\/characters\/\d+\/orders$/).length, 1, 'one orders call in all');
	assert.equal(hourly.snapshot, 'written');
	const logs = service.raw.syncLogStamps(IVAN).map(stamp => service.raw.readSyncLog(IVAN, stamp));
	assert.equal(logs.length, 1, 'only the hourly sync writes a character sync log');
	assert.equal(logs[0].snapshot.orders, tickStamp, 'the snapshot is built from the tick\'s file');
	const snapshots = fs.readdirSync(path.join(dataDir, 'ledger', String(IVAN), 'snapshots'));
	assert.equal(snapshots.length, 1);
	assert.deepEqual(readJson(path.join(dataDir, 'ledger', String(IVAN), 'snapshots', snapshots[0])).orders.map(row => row.order_id), [8001, 8002, 8003, 8004]);
	assert.equal(service.characterStatus(IVAN).syncedAt, hourly.syncedAt, 'the hourly sync ran although a tick came first');
	assert.deepEqual(Object.keys(orderLog(dataDir)), ['8001', '8002', '8003', '8004']);
});

test('a ledger deleted while its raw is not is rebuilt by the watch tick that finds it gone, so the hourly sync after it does not stay empty', async (t) => {
	const { fake, service, clock, dataDir } = setup(t);
	listIvan(fake);
	fake.character(IVAN, { transactions: [tx(6001), tx(6002, { is_buy: false })], journal: [journalRow(7001)] });
	const first = await service.syncCharacter(IVAN, { force: true });
	assert.equal(first.status, 'ok', JSON.stringify(first.errors));
	const before = service.ledger.readRows(IVAN, 'transactions');
	assert.equal(before.length, 2);

	fs.rmSync(path.join(dataDir, 'ledger', String(IVAN)), { recursive: true });
	clock.advance(30 * MINUTE);
	const tick = await service.syncWatch({ regionIds: [REGION] });
	assert.equal(tick.characters[IVAN].status, 'ok', JSON.stringify(tick.characters[IVAN]));
	assert.deepEqual(service.ledger.readRows(IVAN, 'transactions'), before, 'rebuilt by the tick');

	clock.advance(2 * HOUR);
	const hourly = await service.syncCharacter(IVAN, { force: true });
	assert.equal(hourly.status, 'ok', JSON.stringify(hourly.errors));
	assert.equal(hourly.routes.transactions.notModified, 1, 'the walk saw a 304 and refilled nothing itself');
	assert.deepEqual(service.ledger.readRows(IVAN, 'transactions'), before);
	assert.equal(service.ledger.readRows(IVAN, 'journal').length, 1);

	// the ledger is what a rebuild from raw alone gives
	const fresh = tmpDataDir(t);
	fs.cpSync(path.join(dataDir, 'raw'), path.join(fresh, 'raw'), { recursive: true });
	derive.rebuildAll({ dataDir: fresh, log: makeLog() });
	assert.deepEqual(ledgerTree(dataDir), ledgerTree(fresh));
});

test('without a region the watch uses the sell region the characters list in, once an hourly sync has shown it', async (t) => {
	const { fake, service, clock } = setup(t);
	listIvan(fake);
	const early = await service.syncWatch();
	assert.equal(early.characters[IVAN].orders, 'stored');
	assert.equal(early.market.status, 'skipped');
	assert.match(early.market.reason, /no destination region/);
	assert.equal(marketCalls(fake).length, 0);

	// 8001, 8002 and 8004 are sell orders; two of them are in REGION
	await service.syncCharacter(IVAN, { force: true });
	clock.advance(MINUTE);
	const tick = await service.syncWatch();
	assert.deepEqual(tick.market.regionIds, [REGION]);
	assert.deepEqual(tick.market.types.map(type => type.typeId), [35, 36]);

	// nothing listed in the region: nothing to fetch, said so
	const empty = setup(t);
	empty.fake.character(IVAN, { orders: [order(8001, { type_id: 35, is_buy_order: true })] });
	const none = await empty.service.syncWatch({ regionIds: [REGION] });
	assert.equal(none.market.status, 'skipped');
	assert.match(none.market.reason, /no open sell orders/);
});

test('the watch pauses under 20 percent of the market-order bucket, like the market snapshot', async (t) => {
	const { fake, service, clock } = setup(t);
	listIvan(fake);
	fake.rateRemaining = { 'market-order': 2000 };
	const first = await service.syncWatch({ regionIds: [REGION] });
	assert.equal(first.market.status, 'ok', 'the call that showed the low count went through');

	clock.advance(6 * MINUTE);
	fake.reset();
	const paused = await service.syncWatch({ regionIds: [REGION] });
	assert.equal(marketCalls(fake).length, 0, 'the bucket is left alone');
	assert.equal(paused.market.status, 'partial');
	assert.equal(paused.stop.reason, 'paused');
	assert.equal(paused.stop.group, 'market-order');
	assert.ok(paused.stop.until > clock());
	assert.equal(paused.characters[IVAN].status, 'ok', 'our orders are not in that bucket');
	assert.equal(service.watchStatus().stop.reason, 'paused');
});

test('a 401 is not retried: the character is reported failed and the tick goes on', async (t) => {
	const { fake, service, tokens } = setup(t);
	listIvan(fake);
	fake.character(IVAN).rejectToken = true;
	const tick = await service.syncWatch({ regionIds: [REGION] });
	assert.equal(fake.calls.length, 1, 'one call, no retry');
	assert.equal(tick.characters[IVAN].status, 'failed');
	assert.equal(tick.characters[IVAN].orders, 'auth');
	assert.match(tick.characters[IVAN].reason, /invalid|unauthorized/);
	assert.deepEqual(tokens.forgotten, [IVAN], 'the cached access token is dropped so the next call refreshes');
	assert.equal(tick.stop, null, 'a 401 ends the character\'s step, not the tick');
	assert.equal(tick.market.status, 'skipped', 'and no order is known to list');
});

test('the legacy error limit and a 429 end the tick; characters after the stop are skipped', async (t) => {
	const low = setup(t, { characters: [IVAN, 90000002] });
	listIvan(low.fake);
	low.fake.errorLimitRemain = 10;
	const first = await low.service.syncWatch({ regionIds: [REGION] });
	assert.equal(first.characters[IVAN].orders, 'stored', 'the call that showed the low count is kept');
	assert.equal(first.characters[90000002].status, 'paused', 'the next call waits for the error-limit window');
	assert.equal(low.fake.callsTo(/^\/characters\//).length, 1);
	assert.equal(first.stop.reason, 'error-limit');
	assert.ok(first.stop.until > low.clock());
	assert.equal(first.market.status, 'skipped');
	assert.equal(marketCalls(low.fake).length, 0);

	// one character after the stop is told so
	const three = setup(t, { characters: [IVAN, 90000002, 90000003] });
	listIvan(three.fake);
	three.fake.errorLimitRemain = 10;
	const stopped = await three.service.syncWatch({ characterIds: [IVAN, 90000002, 90000003], regionIds: [REGION] });
	assert.deepEqual([IVAN, 90000002, 90000003].map(id => stopped.characters[id].status), ['ok', 'paused', 'skipped']);
	assert.match(stopped.characters[90000003].reason, /stopped \(error-limit\)/);

	const limited = setup(t);
	listIvan(limited.fake);
	limited.fake.respondWith = (call) => (call.path.endsWith('/orders') && call.path.startsWith('/characters') ? new Response(JSON.stringify({ error: 'slow down' }), { status: 429, headers: { 'retry-after': '90' } }) : null);
	const tick = await limited.service.syncWatch({ regionIds: [REGION] });
	assert.equal(tick.characters[IVAN].status, 'rate-limited');
	assert.deepEqual({ reason: tick.stop.reason, retryAfter: tick.stop.retryAfter }, { reason: 'rate-limited', retryAfter: 90 });
	assert.equal(marketCalls(limited.fake).length, 0);
});

test('a busy market lock skips the market step without failing the tick, and a busy character is skipped on its own', async (t) => {
	const { fake, service, clock, dataDir } = setup(t);
	listIvan(fake);
	const release = acquireLock(dataDir, 'market');
	assert.ok(release);
	const tick = await service.syncWatch({ regionIds: [REGION] });
	assert.equal(tick.characters[IVAN].status, 'ok');
	assert.equal(tick.market.status, 'busy');
	assert.equal(tick.stop, null);
	assert.equal(marketCalls(fake).length, 0);
	assert.deepEqual(Object.keys(orderLog(dataDir)), ['8001', '8002', '8003', '8004'], 'our orders were still folded');
	release();

	// the lock is gone: the next tick takes the books
	clock.advance(MINUTE);
	const next = await service.syncWatch({ regionIds: [REGION] });
	assert.equal(next.market.status, 'ok');
	assert.equal(marketCalls(fake).filter(call => call.path.endsWith('/orders')).length, 2);

	// a character another process syncs: busy, no call for it, the market step still runs from the log
	clock.advance(6 * MINUTE);
	fake.reset();
	const hold = acquireLock(dataDir, `character-${IVAN}`);
	assert.ok(hold);
	const busy = await service.syncWatch({ regionIds: [REGION] });
	hold();
	assert.equal(busy.characters[IVAN].status, 'busy');
	assert.equal(fake.callsTo(/^\/characters\//).length, 0);
	assert.equal(busy.market.status, 'ok');
	assert.equal(marketCalls(fake).filter(call => call.path.endsWith('/orders')).length, 2);
});

test('characters that cannot be watched are reported: not linked, no scope, needs re-linking', async (t) => {
	const { fake, service, store, dataDir } = setup(t, { characters: [IVAN, 90000002] });
	listIvan(fake);
	store.upsert({ characterId: 90000003, name: 'Scopeless', ownerHash: 'o', scopes: ALL_SCOPES.filter(scope => !scope.includes('orders')), refreshToken: 'r', status: 'ok' });
	store.setStatus(90000002, 'relink', 'invalid_grant');
	const tick = await service.syncWatch({ characterIds: [IVAN, 90000002, 90000003, 4242], regionIds: [REGION] });
	assert.equal(tick.characters[IVAN].status, 'ok');
	assert.deepEqual([tick.characters[90000002].status, tick.characters[90000002].reason], ['relink', 'invalid_grant']);
	assert.equal(tick.characters[90000003].status, 'skipped');
	assert.match(tick.characters[90000003].reason, /missing scope esi-markets/);
	assert.deepEqual([tick.characters[4242].status, tick.characters[4242].reason], ['failed', 'not linked']);
	assert.equal(fake.callsTo(/^\/characters\//).length, 1);
	assert.ok(!fs.existsSync(path.join(dataDir, 'ledger', '90000002')));
});

test('ticks do not overlap: a caller during a tick gets that tick\'s answer', async (t) => {
	const { fake, service } = setup(t);
	listIvan(fake);
	const [a, b] = await Promise.all([service.syncWatch({ regionIds: [REGION] }), service.syncWatch({ regionIds: [REGION] })]);
	assert.equal(a, b);
	assert.equal(fake.callsTo(/^\/characters\/\d+\/orders$/).length, 1);
});

test('the market snapshot folds the book log too, and a tick after it reads 304 against its stored books', async (t) => {
	const { fake, service, clock, dataDir } = setup(t);
	listIvan(fake);
	await service.syncCharacter(IVAN, { force: true });
	const snapshot = await service.syncMarket({ force: true, concurrency: 1 });
	assert.equal(snapshot.status, 'ok');
	const log35 = bookLog(dataDir, 35);
	assert.deepEqual(log35.samples.map(sample => sample.stored), [true]);
	assert.ok(fs.existsSync(logFile(dataDir, 34)), 'every type of the snapshot, listed or not');
	const entry = publicLogs(service)[0];
	assert.equal(entry.source, 'market');
	assert.ok(entry.books.length >= 4);
	assert.ok(entry.books.every(book => book.outcome === 'stored'));
	assert.deepEqual(entry.books.find(book => book.typeId === 35).stamps, { 1: log35.samples[0].at });

	clock.advance(6 * MINUTE);
	fake.reset();
	const tick = await service.syncWatch({ regionIds: [REGION] });
	assert.deepEqual(tick.market.types.map(type => type.outcome), ['not-modified', 'not-modified']);
	assert.deepEqual(bookLog(dataDir, 35).samples.map(sample => sample.stored), [true, false]);
});

test('a book log that will not fold is reported but does not stop the tick; a damaged order log fails its character and the market step, not the tick', async (t) => {
	const { fake, service, clock, dataDir, log } = setup(t);
	listIvan(fake);
	await service.syncWatch({ regionIds: [REGION] });
	fs.writeFileSync(logFile(dataDir, 35), '{not gzip');
	clock.advance(6 * MINUTE);
	fake.market.orders.set(`${REGION}:35`, [bookOrder(8001, 35, 999), bookOrder(9001, 35, 1010)]);
	const tick = await service.syncWatch({ regionIds: [REGION] });
	assert.deepEqual(tick.market.types.map(type => [type.typeId, type.outcome]), [[35, 'stored'], [36, 'not-modified']], 'the raw book was stored regardless');
	assert.equal(tick.market.status, 'partial');
	assert.ok(tick.market.errors.some(e => e.route === 'bookLog' && /35/.test(e.message)));
	assert.ok(log.lines.some(line => line.startsWith('warn: book log 10000043/35')));
	assert.equal(rawNames(dataDir, 'public', `markets-${REGION}-orders-type-id-35`).length, 2);
	assert.equal(bookLog(dataDir, 36).samples.length, 2, 'the other types went on');

	// a rebuild repairs the damaged log from raw
	require('../lib/derive').rebuildBookLogs({ dataDir });
	assert.deepEqual(bookLog(dataDir, 35).samples.map(sample => sample.stored), [true, true]);
	assert.equal(bookLog(dataDir, 35).orders[8001].path.length, 2);

	// a damaged order log: that character fails, the market step reports it, the tick still answers and is saved
	fs.writeFileSync(path.join(dataDir, 'ledger', String(IVAN), 'order-log.json'), '{not json');
	clock.advance(21 * MINUTE);
	const broken = await service.syncWatch({ regionIds: [REGION] });
	assert.equal(broken.characters[IVAN].status, 'failed');
	assert.equal(broken.market.status, 'failed');
	assert.equal(service.watchStatus().tickedAt, broken.tickedAt);
});
