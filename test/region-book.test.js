const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createSyncService } = require('../lib/sync');
const { createTokenStore } = require('../lib/tokenStore');
const { acquireLock, createRawStore } = require('../lib/dataFiles');
const { createLedger } = require('../lib/ledger');
const derive = require('../lib/derive');
const {
	ALL_SCOPES, makeClock, tmpDataDir, makeLog, makeTokens, createFakeEsi, order, asset,
} = require('../test-support/esi-fake');

// The regional book job (syncRegionBook): the destination region's whole order book, page by page,
// stored raw and folded into the per-type book logs. Every ESI answer comes from test-support/esi-fake.js.

const IVAN = 90000001;
const REGION = 10000043;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const SLUG = `markets-${REGION}-orders-order-type-all`;

const setup = (t, { fake: fakeOptions = { pageSize: 3 }, env = {} } = {}) => {
	const dataDir = tmpDataDir(t);
	const clock = makeClock();
	const fake = createFakeEsi({ now: clock, ...fakeOptions });
	const store = createTokenStore({ dataDir });
	store.upsert({ characterId: IVAN, name: 'Ivan Tester', ownerHash: `owner-${IVAN}`, scopes: ALL_SCOPES, refreshToken: `refresh-${IVAN}`, status: 'ok' });
	fake.character(IVAN);
	const log = makeLog();
	const service = createSyncService({ dataDir, fetch: fake.fetch, now: clock, log, tokenStore: store, tokens: makeTokens(), userAgent: 'eflip-test/1.0', env });
	return { dataDir, clock, fake, store, log, service };
};

// an order as the region's book lists it, any station, either side
const bookOrder = (id, typeId, price, o = {}) => ({
	order_id: id, type_id: typeId, price, is_buy_order: false, volume_remain: 5, volume_total: 10,
	issued: '2026-11-20T10:00:00Z', duration: 90, range: 'region', location_id: 60008494, system_id: 30002187, min_volume: 1, ...o,
});

// five orders over three types: 35 has two sells and a buy, 36 and 37 one sell each; at 3 a page, two pages
const SNAPSHOT_A = [
	bookOrder(1, 35, 100), bookOrder(2, 35, 110), bookOrder(3, 35, 90, { is_buy_order: true }),
	bookOrder(4, 36, 200), bookOrder(5, 37, 300),
];
// an hour later: 35's first order re-priced, a new type 34, and 37's only order gone
const SNAPSHOT_B = [
	bookOrder(1, 35, 99), bookOrder(2, 35, 110), bookOrder(3, 35, 90, { is_buy_order: true }),
	bookOrder(4, 36, 200), bookOrder(6, 34, 50, { location_id: 60003760 }),
];

// book logs and public market raw are gzipped (`.json.gz`)
const readJson = (file) => JSON.parse(file.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8') : fs.readFileSync(file, 'utf8'));
const logFile = (dataDir, typeId, region = REGION) => path.join(dataDir, 'ledger', 'market', String(region), `${typeId}.json.gz`);
const bookLog = (dataDir, typeId) => readJson(logFile(dataDir, typeId));
const hasLog = (dataDir, typeId) => createLedger({ dataDir }).hasBookLog(REGION, typeId);
const rawNames = (dataDir, slug) => {
	try {
		return fs.readdirSync(path.join(dataDir, 'raw', 'public', slug)).filter(name => /\.json(?:\.gz)?$/.test(name)).sort();
	} catch (e) {
		return [];
	}
};
const regionBookEntries = (dataDir) => {
	const raw = createRawStore({ dataDir });
	return raw.syncLogStamps('public').map(stamp => raw.readSyncLog('public', stamp)).filter(entry => entry.kind === 'regionBook');
};
const regionCalls = (fake) => fake.callsTo(/^\/markets\/\d+\/orders$/).filter(call => call.query.order_type !== undefined);
// every book log under ledger/market/, path -> the file's bytes as they are on disk (gzip and all)
const marketBytes = (dataDir) => {
	const root = path.join(dataDir, 'ledger', 'market');
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
// the book logs `--rebuild-book-logs` gives from a copy of raw/ alone
const rebuiltMarket = (t, dataDir) => {
	const fresh = tmpDataDir(t);
	fs.cpSync(path.join(dataDir, 'raw'), path.join(fresh, 'raw'), { recursive: true });
	derive.rebuildAll({ dataDir: fresh, log: makeLog(), bookLogs: true });
	return marketBytes(fresh);
};

test('two pages of a region fold into one sample per type: a new log, existing logs that gain a sample and a path, and an empty sample for a type whose orders ended', async (t) => {
	const { dataDir, fake, clock, service } = setup(t);
	fake.market.regionOrders.set(String(REGION), SNAPSHOT_A);

	const first = await service.syncRegionBook({ regionId: REGION, force: true });
	assert.equal(first.status, 'ok', JSON.stringify(first.errors));
	assert.deepEqual(regionCalls(fake).map(call => call.query), [{ order_type: 'all' }, { order_type: 'all', page: '2' }]);
	assert.ok(fake.calls.every(call => call.headers.authorization === undefined), 'a public route: no token');
	assert.equal(first.pages, 2);
	assert.equal(first.typesInSnapshot, 3);
	assert.equal(first.typesFolded, 3);
	assert.equal(first.logsCreated, 3);
	assert.equal(first.typesEnded, 0);
	// raw page by page, under esi.js's own slugs: page 1 without `page`
	assert.equal(rawNames(dataDir, SLUG).length, 1);
	assert.match(rawNames(dataDir, SLUG)[0], /\.json\.gz$/, 'a regional page is stored gzipped');
	assert.equal(rawNames(dataDir, `${SLUG}-page-2`).length, 1);
	assert.equal(rawNames(dataDir, `${SLUG}-page-3`).length, 0);
	const rawPage = readJson(path.join(dataDir, 'raw', 'public', SLUG, rawNames(dataDir, SLUG)[0]));
	assert.equal(rawPage.url, `https://esi.evetech.net/markets/${REGION}/orders?order_type=all`);
	assert.equal(rawPage.body.length, 3);
	assert.equal(readJson(path.join(dataDir, 'raw', 'public', `${SLUG}-page-2`, rawNames(dataDir, `${SLUG}-page-2`)[0])).url, `https://esi.evetech.net/markets/${REGION}/orders?order_type=all&page=2`);
	// every type of the snapshot, buy and sell, at every station
	const log35 = bookLog(dataDir, 35);
	assert.deepEqual(log35.samples, [{ at: first.fetchedAt, stored: true }]);
	assert.deepEqual(Object.keys(log35.orders), ['1', '2', '3']);
	assert.equal(log35.orders[3].isBuy, true);
	assert.equal(log35.orders[1].firstSeen, first.fetchedAt);
	assert.deepEqual(log35.orders[1].path, [{ at: first.fetchedAt, price: 100, volumeRemain: 5, issued: '2026-11-20T10:00:00Z' }]);
	assert.deepEqual(Object.keys(bookLog(dataDir, 37).orders), ['5']);
	assert.ok(!hasLog(dataDir, 34), 'no orders, no log');

	// an hour on: 35 and 36 exist and gain a sample, 34 is new, 37 has no orders left
	clock.advance(HOUR);
	fake.reset();
	fake.market.regionOrders.set(String(REGION), SNAPSHOT_B);
	const second = await service.syncRegionBook({ regionId: REGION });
	assert.equal(second.status, 'ok', JSON.stringify(second.errors));
	assert.equal(second.typesInSnapshot, 3);
	assert.equal(second.typesFolded, 4, 'three with orders and the one that has none left');
	assert.equal(second.typesEnded, 1);
	assert.equal(second.logsCreated, 1, 'only 34');
	assert.ok(second.fetchedAt > first.fetchedAt);
	const again35 = bookLog(dataDir, 35);
	assert.deepEqual(again35.samples.map(sample => sample.stored), [true, true]);
	assert.deepEqual(again35.orders[1].path.map(entry => entry.price), [100, 99], 'the path advanced');
	assert.equal(again35.orders[1].lastSeen, second.fetchedAt);
	assert.deepEqual(again35.orders[2].path.length, 1, 'an unchanged order keeps one entry');
	assert.equal(again35.orders[2].lastSeen, second.fetchedAt);
	const ended = bookLog(dataDir, 37);
	assert.deepEqual(ended.samples.map(sample => sample.stored), [true, true], 'an empty stored sample');
	assert.equal(ended.orders[5].lastSeen, first.fetchedAt, 'the order was last seen before it ended');
	assert.deepEqual(bookLog(dataDir, 34).samples, [{ at: second.fetchedAt, stored: true }]);
	assert.deepEqual(Object.keys(bookLog(dataDir, 34).orders), ['6']);
	assert.equal(bookLog(dataDir, 36).samples.length, 2);

	// a third run, nothing changed, past the cache: 304 on every page, one token each, still a sample
	clock.advance(HOUR);
	fake.reset();
	const third = await service.syncRegionBook({ regionId: REGION });
	assert.equal(third.status, 'ok');
	assert.equal(third.notModified, 2);
	assert.equal(third.tokensUsed, 2);
	assert.equal(third.rawBytes, 0);
	assert.equal(third.rawBytesStored, 0);
	assert.equal(bookLog(dataDir, 35).samples.length, 3);
	assert.equal(bookLog(dataDir, 35).orders[1].path.length, 2, 'folding the same rows again moves lastSeen, not the path');
	assert.equal(bookLog(dataDir, 35).orders[1].lastSeen, third.fetchedAt);
	assert.equal(rawNames(dataDir, SLUG).length, 2, 'nothing new stored for page 1');
});

test('the run is one entry in the public sync log with what it cost', async (t) => {
	const { dataDir, fake, clock, service } = setup(t);
	fake.market.regionOrders.set(String(REGION), SNAPSHOT_A);
	const first = await service.syncRegionBook({ regionId: REGION, force: true });
	clock.advance(HOUR);
	fake.market.regionOrders.set(String(REGION), SNAPSHOT_B);
	const second = await service.syncRegionBook({ regionId: REGION });

	const entries = regionBookEntries(dataDir);
	assert.equal(entries.length, 2);
	const [one, two] = entries;
	assert.equal(one.kind, 'regionBook');
	assert.equal(one.regionId, REGION);
	assert.equal(one.fetchedAt, first.fetchedAt);
	assert.equal(one.pages, 2);
	assert.equal(one.tokensUsed, 4, 'two 200s');
	assert.equal(one.typesInSnapshot, 3);
	assert.equal(one.typesFolded, 3);
	assert.equal(one.logsCreated, 3);
	assert.equal(one.logBytesBefore, 0);
	assert.ok(one.logBytesAfter > 0);
	assert.equal(one.partial, false);
	assert.equal(one.status, 'ok');
	assert.equal(one.elapsedMs, 0, 'the test clock did not move');
	assert.equal(one.limits.groups[`public|market-order`].group, 'market-order');
	assert.equal(one.limits.groups[`public|market-order`].limit, 12000);
	// the bytes of the page bodies as they came, and of the files written: rawBytesStored counts the
	// bytes on disk, which since P2.2 are compressed (the pages are `.json.gz`); the text inside
	// carries the headers too, so it is longer than the bodies
	const bodies = [SNAPSHOT_A.slice(0, 3), SNAPSHOT_A.slice(3)].map(rows => JSON.stringify(rows).length);
	assert.equal(one.rawBytes, bodies[0] + bodies[1]);
	const pageFiles = [SLUG, `${SLUG}-page-2`].map(slug => path.join(dataDir, 'raw', 'public', slug, rawNames(dataDir, slug)[0]));
	const onDisk = pageFiles.map(file => fs.statSync(file).size);
	assert.equal(one.rawBytesStored, onDisk[0] + onDisk[1], 'the compressed bytes on disk');
	const inside = pageFiles.map(file => zlib.gunzipSync(fs.readFileSync(file)).length);
	assert.ok(inside[0] + inside[1] > one.rawBytes);
	// the log byte counts are the files' sizes, compressed too
	const sizes = (typeIds) => typeIds.map(typeId => fs.statSync(logFile(dataDir, typeId)).size).reduce((a, b) => a + b, 0);
	assert.equal(two.logBytesAfter, sizes([34, 35, 36, 37]), 'every log the run touched, new or not');
	assert.equal(two.logBytesBefore, one.logBytesAfter);
	assert.ok(two.logBytesAfter > two.logBytesBefore);
	assert.equal(two.typesFolded, 4);
	assert.equal(two.orders, 5);
	// the page files each snapshot was cut from, for a rebuild to replay
	assert.deepEqual(one.pageStamps, [rawNames(dataDir, SLUG)[0], rawNames(dataDir, `${SLUG}-page-2`)[0]].map(name => name.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z\.json(?:\.gz)?$/, 'T$1:$2:$3.$4Z')));
	assert.deepEqual(one.books, [], 'no per-type check is recorded here');
	// the answer is the measurement too
	assert.equal(second.tokensUsed, two.tokensUsed);
	assert.equal(second.syncedAt, two.syncedAt);
	assert.equal(service.regionBookStatus().syncedAt, two.syncedAt);
	assert.equal(service.regionBookStatus().status, 'ok');
	assert.equal(service.status().regionBook.status, 'ok');
});

test('a page that fails makes the run partial and folds nothing; the next run takes the pages already stored from raw and the missing one from ESI', async (t) => {
	const { dataDir, fake, clock, service } = setup(t);
	fake.market.regionOrders.set(String(REGION), SNAPSHOT_A);
	fake.respondWith = (call) => (call.query.page === '2' ? new Response(JSON.stringify({ error: 'Internal Server Error' }), { status: 500, headers: { 'content-type': 'application/json' } }) : null);

	const partial = await service.syncRegionBook({ regionId: REGION, force: true });
	assert.equal(partial.status, 'partial');
	assert.equal(partial.pages, 2);
	assert.equal(partial.pagesRead, 1);
	assert.equal(partial.typesFolded, 0);
	assert.equal(partial.typesInSnapshot, 0);
	assert.equal(partial.tokensUsed, 2, 'page 1 only');
	assert.match(partial.reason, /page 2/);
	assert.equal(partial.errors[0].status, 500);
	assert.ok(!fs.existsSync(path.join(dataDir, 'ledger', 'market')), 'no log written from half a snapshot');
	assert.equal(rawNames(dataDir, SLUG).length, 1, 'the page that came is stored, as raw first says');
	assert.equal(rawNames(dataDir, `${SLUG}-page-2`).length, 0);
	const [entry] = regionBookEntries(dataDir);
	assert.equal(entry.partial, true);
	assert.equal(entry.status, 'partial');
	assert.equal(entry.typesFolded, 0);
	assert.equal(service.regionBookStatus().status, 'partial');
	assert.equal(service.regionBookStatus().syncedAt, null, 'a partial run does not count as the hour\'s snapshot');

	// healed a minute later, inside page 1's cache window: page 1 is read from raw (no call), page 2 comes
	fake.respondWith = null;
	clock.advance(MINUTE);
	fake.reset();
	const healed = await service.syncRegionBook({ regionId: REGION });
	assert.equal(healed.status, 'ok', JSON.stringify(healed.errors));
	assert.deepEqual(regionCalls(fake).map(call => call.query), [{ order_type: 'all', page: '2' }]);
	assert.equal(healed.notDue, 1);
	assert.equal(healed.tokensUsed, 2);
	assert.equal(healed.typesFolded, 3);
	assert.ok(healed.fetchedAt > partial.fetchedAt);
	assert.equal(healed.fetchedAt, new Date(clock()).toISOString(), 'page 1 is still cached from a run that did not fold: the snapshot is dated by the run that folds it');
	assert.equal(bookLog(dataDir, 35).orders[3].isBuy, true);
});

test('a snapshot healed after a watch tick checked one of its types is folded after that check: the log stays in time order and equals a rebuild', async (t) => {
	const { dataDir, fake, clock, service } = setup(t);
	fake.character(IVAN, { orders: [order(8001, { type_id: 35 })] });
	fake.market.regionOrders.set(String(REGION), SNAPSHOT_A);
	fake.market.orders.set(`${REGION}:35`, [bookOrder(1, 35, 100)]);
	fake.respondWith = (call) => (call.query.order_type !== undefined && call.query.page === '2' ? new Response(JSON.stringify({ error: 'Bad Gateway' }), { status: 502, headers: { 'content-type': 'application/json' } }) : null);
	const partial = await service.syncRegionBook({ regionId: REGION, force: true });
	assert.equal(partial.status, 'partial');
	fake.respondWith = null;

	// two minutes on, a watch tick checks 35's own book: re-priced
	clock.advance(2 * MINUTE);
	fake.market.orders.set(`${REGION}:35`, [bookOrder(1, 35, 95)]);
	const tick = await service.syncWatch({ regionIds: [REGION] });
	assert.equal(tick.market.status, 'ok', JSON.stringify(tick.market));
	assert.deepEqual(tick.market.types.map(type => [type.typeId, type.outcome]), [[35, 'stored']]);

	// a minute on, inside page 1's cache window: page 1 from raw, page 2 from ESI
	clock.advance(MINUTE);
	const healed = await service.syncRegionBook({ regionId: REGION });
	assert.equal(healed.status, 'ok', JSON.stringify(healed.errors));
	assert.equal(healed.notDue, 1);
	assert.equal(healed.fetchedAt, new Date(clock()).toISOString(), 'dated by the run that folded it, not by the partial run\'s page 1');
	const log35 = bookLog(dataDir, 35);
	const times = log35.samples.map(sample => sample.at);
	assert.equal(times.length, 2);
	assert.deepEqual(times, [...times].sort(), 'samples in time order');
	assert.equal(log35.orders[1].lastSeen, times[times.length - 1], 'last seen at the newest sample');
	assert.deepEqual(marketBytes(dataDir), rebuiltMarket(t, dataDir), 'a rebuild from raw gives the same bytes');

	// a forced run a minute later finds page 1 still cached from the partial run, older than the fold: folded already
	clock.advance(MINUTE);
	fake.reset();
	const again = await service.syncRegionBook({ regionId: REGION, force: true });
	assert.equal(again.status, 'skipped');
	assert.match(again.reason, /folded already/);
	assert.equal(fake.calls.length, 0);
	assert.equal(bookLog(dataDir, 35).samples.length, 2);
});

test('a snapshot already folded is not folded again inside the cache window, and an unforced run waits for the hour', async (t) => {
	const { dataDir, fake, clock, service } = setup(t);
	fake.market.regionOrders.set(String(REGION), SNAPSHOT_A);
	const first = await service.syncRegionBook({ regionId: REGION });
	assert.equal(first.status, 'ok');

	clock.advance(MINUTE);
	fake.reset();
	const forced = await service.syncRegionBook({ regionId: REGION, force: true });
	assert.equal(forced.status, 'skipped');
	assert.match(forced.reason, /folded already/);
	assert.equal(fake.calls.length, 0);
	assert.equal(bookLog(dataDir, 35).samples.length, 1, 'no second sample at the same time');

	const unforced = await service.syncRegionBook({ regionId: REGION });
	assert.equal(unforced.status, 'skipped');
	assert.match(unforced.reason, /within the last hour/);
	assert.equal(unforced.syncedAt, first.syncedAt);
	assert.equal(fake.calls.length, 0);
	assert.equal(regionBookEntries(dataDir).length, 1, 'a skipped run writes no entry');

	// the hourly job starts a little early now and then: 56 minutes after the last is enough
	clock.advance(55 * MINUTE);
	const next = await service.syncRegionBook({ regionId: REGION });
	assert.equal(next.status, 'ok');
	assert.equal(bookLog(dataDir, 35).samples.length, 2);
});

test('under 20 percent of the market-order bucket the run stops, reports paused and folds nothing', async (t) => {
	const { dataDir, fake, clock, service } = setup(t);
	fake.market.regionOrders.set(String(REGION), SNAPSHOT_A);
	fake.rateRemaining = { 'market-order': 2000 }; // under 20 % of 12000
	const result = await service.syncRegionBook({ regionId: REGION, force: true });
	assert.equal(result.status, 'paused');
	assert.match(result.reason, /market-order/);
	assert.equal(result.stop.reason, 'paused');
	assert.equal(result.partial, true);
	assert.equal(regionCalls(fake).length, 1, 'page 1 went out, page 2 did not');
	assert.equal(result.typesFolded, 0);
	assert.ok(!fs.existsSync(path.join(dataDir, 'ledger', 'market')));
	assert.equal(regionBookEntries(dataDir)[0].status, 'paused');

	// the pause outlives the process: the next run makes no call at all and writes no entry
	clock.advance(MINUTE);
	fake.reset();
	const later = await service.syncRegionBook({ regionId: REGION, force: true });
	assert.equal(later.status, 'paused');
	assert.equal(fake.calls.length, 0);
	assert.equal(regionBookEntries(dataDir).length, 1);

	// the window passes (15 minutes) and the bucket is full again
	clock.advance(15 * MINUTE);
	fake.rateRemaining = null;
	const resumed = await service.syncRegionBook({ regionId: REGION, force: true });
	assert.equal(resumed.status, 'ok');
	assert.equal(resumed.typesFolded, 3);
});

test('another market sync holds the lock: busy, no call; deferring asks nothing of ESI either', async (t) => {
	const { dataDir, fake, service } = setup(t);
	fake.market.regionOrders.set(String(REGION), SNAPSHOT_A);
	const release = acquireLock(dataDir, 'market');
	assert.ok(release);
	const busy = await service.syncRegionBook({ regionId: REGION, force: true });
	assert.equal(busy.status, 'busy');
	assert.equal(fake.calls.length, 0);
	release();

	const deferred = await service.syncRegionBook({ regionId: REGION, force: true, defer: true });
	assert.equal(deferred.status, 'deferred');
	assert.match(deferred.reason, /export run/);
	assert.equal(fake.calls.length, 0);

	const ok = await service.syncRegionBook({ regionId: REGION, force: true });
	assert.equal(ok.status, 'ok');
	assert.ok(!fs.existsSync(path.join(dataDir, 'locks', 'market.lock')), 'the lock is let go');
});

test('concurrent callers share one run', async (t) => {
	const { fake, service } = setup(t);
	fake.market.regionOrders.set(String(REGION), SNAPSHOT_A);
	const [a, b] = await Promise.all([service.syncRegionBook({ regionId: REGION, force: true }), service.syncRegionBook({ regionId: REGION, force: true })]);
	assert.equal(a, b);
	assert.equal(regionCalls(fake).length, 2);
});

test('the region is the destination region of the newest export run, else where most sell orders are; none known is a skip', async (t) => {
	const none = setup(t);
	none.fake.market.regionOrders.set(String(REGION), SNAPSHOT_A);
	const skipped = await none.service.syncRegionBook({ force: true });
	assert.equal(skipped.status, 'skipped');
	assert.match(skipped.reason, /no destination region/);
	assert.equal(none.fake.calls.length, 0);

	const { dataDir, fake, service } = setup(t);
	fake.market.regionOrders.set('10000002', [bookOrder(11, 34, 5)]);
	fs.mkdirSync(path.join(dataDir, 'runs'), { recursive: true });
	fs.writeFileSync(path.join(dataDir, 'runs', 'a.json'), JSON.stringify({ copiedAt: '2026-11-19T00:00:00Z', route: { endRegionId: 10000002 } }));
	const named = await service.syncRegionBook({ force: true });
	assert.equal(named.status, 'ok');
	assert.equal(named.regionId, 10000002);
	assert.ok(regionCalls(fake).every(call => call.path === '/markets/10000002/orders'));
	assert.ok(fs.existsSync(logFile(dataDir, 34, 10000002)));
});

test('a type with raw per-type books but no log gets its log built from them before the regional sample; a damaged log is reported and the rest fold', async (t) => {
	const { dataDir, fake, clock, service } = setup(t, { fake: { pageSize: 3 } });
	fake.character(IVAN, { orders: [order(8001, { type_id: 35 })] });
	await service.syncCharacter(IVAN, { force: true });
	fake.market.orders.set(`${REGION}:35`, [bookOrder(1, 35, 100)]);
	fake.market.history.set(`${REGION}:35`, [{ date: '2026-11-19', average: 9, highest: 10, lowest: 8, order_count: 2, volume: 20 }]);
	const market = await service.syncMarket({ force: true, concurrency: 1 });
	assert.equal(market.status, 'ok');
	assert.equal(bookLog(dataDir, 35).samples.length, 1);
	fs.rmSync(logFile(dataDir, 35));

	clock.advance(HOUR);
	fake.market.regionOrders.set(String(REGION), SNAPSHOT_A);
	const run = await service.syncRegionBook({ regionId: REGION });
	assert.equal(run.status, 'ok', JSON.stringify(run.errors));
	const log35 = bookLog(dataDir, 35);
	assert.deepEqual(log35.samples.map(sample => sample.stored), [true, true], 'the per-type check rebuilt from raw, then the regional one');
	assert.equal(log35.samples[1].at, run.fetchedAt);
	assert.equal(run.logsCreated, 3, '35 counts as new: its file was gone');

	// a log that will not parse: reported, the others still fold, the snapshot still counts as taken
	clock.advance(HOUR);
	fake.market.regionOrders.set(String(REGION), SNAPSHOT_B);
	fs.writeFileSync(logFile(dataDir, 36), '{not gzip');
	const damaged = await service.syncRegionBook({ regionId: REGION });
	assert.equal(damaged.status, 'partial');
	assert.equal(damaged.foldErrors, 1);
	assert.ok(damaged.errors.some(e => e.route === 'bookLog' && /36/.test(e.message)));
	assert.equal(damaged.typesFolded, 3, '34, 35 and the ended 37');
	assert.equal(bookLog(dataDir, 35).samples.length, 3);
	assert.equal(service.regionBookStatus().syncedAt, damaged.syncedAt);
});

test('the hourly sync takes the region book after the market only when EFLIP_REGION_BOOK=1; a deferred market defers it; the request can say yes or no', async (t) => {
	const env = {};
	const { fake, clock, service } = setup(t, { env });
	fake.character(IVAN, { orders: [order(8001, { type_id: 35 })], assets: [asset(1, { type_id: 34 })] });
	fake.market.regionOrders.set(String(REGION), SNAPSHOT_A);
	const step = () => clock.advance(10 * MINUTE);

	// off: the characters and the market, nothing of the region
	const off = await service.syncAll({ force: true });
	assert.equal(off.market.status, 'ok');
	assert.equal(off.regionBook, null);
	assert.equal(regionCalls(fake).length, 0);
	assert.equal(service.regionBookStatus().enabled, false);

	// on: after the market step
	env.EFLIP_REGION_BOOK = '1';
	assert.equal(service.regionBookStatus().enabled, true);
	step();
	fake.reset();
	const on = await service.syncAll({ force: true });
	assert.equal(on.regionBook.status, 'ok', JSON.stringify(on.regionBook.errors));
	assert.equal(on.regionBook.regionId, REGION);
	const sequence = fake.callsTo(/orders/).map(call => (call.query.order_type !== undefined ? 'region' : 'type'));
	assert.ok(sequence.includes('type') && sequence.includes('region'));
	assert.ok(sequence.lastIndexOf('type') < sequence.indexOf('region'), 'the market step first');

	// the export page defers the market (market: false); the environment's run waits with it
	step();
	fake.reset();
	const deferred = await service.syncAll({ force: true, market: false });
	assert.equal(deferred.market, null);
	assert.equal(deferred.regionBook.status, 'deferred');
	assert.equal(fake.callsTo(/markets/).length, 0);

	// regionBook: false never runs it, even when enabled
	const no = await service.syncAll({ force: true, regionBook: false });
	assert.equal(no.regionBook, null);
	assert.equal(regionCalls(fake).length, 0);

	// regionBook: true is an explicit request: it runs when the variable is off, and when the market is deferred
	delete env.EFLIP_REGION_BOOK;
	step();
	fake.reset();
	const yes = await service.syncAll({ market: false, regionBook: true });
	assert.equal(yes.market, null);
	assert.equal(yes.regionBook.status, 'ok', JSON.stringify(yes.regionBook));
	assert.equal(regionCalls(fake).length, 2);

	// any other value of the variable is off
	env.EFLIP_REGION_BOOK = 'true';
	step();
	assert.equal((await service.syncAll({ force: true })).regionBook, null);
});

test('an unforced hourly sync inside the hour of the last snapshot leaves the region alone', async (t) => {
	const { fake, clock, service } = setup(t, { env: { EFLIP_REGION_BOOK: '1' } });
	fake.character(IVAN, { orders: [order(8001, { type_id: 35 })] });
	fake.market.regionOrders.set(String(REGION), SNAPSHOT_A);
	const first = await service.syncAll({ force: true });
	assert.equal(first.regionBook.status, 'ok');
	clock.advance(20 * MINUTE);
	fake.reset();
	const second = await service.syncAll({});
	assert.equal(second.regionBook.status, 'skipped');
	assert.equal(regionCalls(fake).length, 0);
	clock.advance(40 * MINUTE);
	const third = await service.syncAll({});
	assert.equal(third.regionBook.status, 'ok');
});

test('a region book that blows up does not take the characters and the market down with it', async (t) => {
	const { fake, service, log } = setup(t, { env: { EFLIP_REGION_BOOK: '1' } });
	fake.character(IVAN, { orders: [order(8001, { type_id: 35 })] });
	service.ledger.listBookLogs = () => {
		throw new Error('disk on fire');
	};
	fake.market.regionOrders.set(String(REGION), SNAPSHOT_A);
	const result = await service.syncAll({ force: true });
	assert.equal(result.characters[0].status, 'ok');
	assert.equal(result.market.status, 'ok');
	assert.equal(result.regionBook.status, 'failed');
	assert.match(result.regionBook.reason, /disk on fire/);
	assert.ok(log.lines.some(line => line.startsWith('warn: region book')));
	assert.ok(!fs.existsSync(path.join(service.raw.root, '..', 'locks', 'market.lock')), 'the lock is let go');
});

test('the market step keeps reading its regions from the newest market entry, not from the region book\'s', async (t) => {
	const { fake, clock, service } = setup(t);
	fake.character(IVAN, { orders: [order(8001, { type_id: 35 })] });
	await service.syncCharacter(IVAN, { force: true });
	fake.market.orders.set(`${REGION}:35`, [bookOrder(1, 35, 100)]);
	await service.syncMarket({ force: true, concurrency: 1 });
	clock.advance(HOUR);
	fake.market.regionOrders.set(String(REGION), SNAPSHOT_A);
	const run = await service.syncRegionBook({ regionId: REGION });
	assert.equal(run.status, 'ok');
	clock.advance(HOUR);
	const again = await service.syncRegionBook({ regionId: REGION });
	assert.equal(again.status, 'ok');
	const read = service.readMarket({ typeIds: [35] });
	assert.deepEqual(read.regionIds, [REGION], 'the newest public log entry is a regional book run');
	assert.equal(read.types[35][REGION].orders.rows[0].order_id, 1);
});

test('with a storage budget a run that folded ends with the storage step: the older snapshot\'s pages go, its entry is marked, the newest snapshot stays whole', async (t) => {
	const env = {};
	const { dataDir, fake, clock, service } = setup(t, { env });
	fake.market.regionOrders.set(String(REGION), SNAPSHOT_A);
	const first = await service.syncRegionBook({ regionId: REGION, force: true });
	assert.equal(first.status, 'ok');
	assert.equal(first.storage, undefined, 'no budget: no storage step');

	env.EFLIP_STORAGE_BUDGET = '1';
	clock.advance(HOUR);
	fake.market.regionOrders.set(String(REGION), SNAPSHOT_B);
	const second = await service.syncRegionBook({ regionId: REGION });
	assert.equal(second.status, 'ok', JSON.stringify(second.errors));
	const step = second.storage;
	assert.equal(step.status, 'ok', JSON.stringify(step));
	assert.equal(step.reason, 'regionBook');
	assert.equal(step.trims.regionPages.snapshots, 1);
	assert.equal(step.trims.regionPages.files, 2, 'both pages of the first snapshot changed, so both were its own');
	assert.equal(step.trims.bookLogs.pieces, 0, 'the logs hold one hour: all inside the 3-day floor');
	assert.ok(step.unmet > 0);
	const [one, two] = regionBookEntries(dataDir);
	assert.ok(typeof one.trimmedAt === 'string' && one.trimmedAt <= step.syncedAt, 'marked when trimmed');
	assert.equal(two.trimmedAt, undefined);
	assert.deepEqual(rawNames(dataDir, SLUG).length, 1);
	assert.deepEqual(rawNames(dataDir, `${SLUG}-page-2`).length, 1);
	const kept = [rawNames(dataDir, SLUG)[0], rawNames(dataDir, `${SLUG}-page-2`)[0]].map(name => name.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z\.json(?:\.gz)?$/, 'T$1:$2:$3.$4Z'));
	assert.deepEqual(kept, two.pageStamps, 'the newest snapshot\'s pages');
	const raw = createRawStore({ dataDir });
	const storageEntries = raw.syncLogStamps('public').map(stamp => raw.readSyncLog('public', stamp)).filter(entry => entry.kind === 'storage');
	assert.equal(storageEntries.length, 1);
	assert.equal(storageEntries[0].reason, 'regionBook');

	// a run that is skipped does nothing more
	const skipped = await service.syncRegionBook({ regionId: REGION });
	assert.equal(skipped.status, 'skipped');
	assert.equal(skipped.storage, undefined);
	// the next hour, unchanged (304s): it names the newest files again, and the storage step keeps them
	clock.advance(HOUR);
	fake.reset();
	const third = await service.syncRegionBook({ regionId: REGION });
	assert.equal(third.status, 'ok');
	assert.equal(third.notModified, 2);
	assert.equal(third.storage.trims.regionPages.pieces, 0, 'the second snapshot\'s files are the third\'s too');
	assert.deepEqual(rawNames(dataDir, SLUG).length, 1);
	assert.equal(bookLog(dataDir, 35).samples.length, 3);
});
