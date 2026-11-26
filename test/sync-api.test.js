const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { mountApi } = require('../lib/api');
const { createLedger } = require('../lib/ledger');
const {
	ALL_SCOPES, makeClock, tmpDataDir, makeLog, makeTokens, createFakeEsi,
	tx, journalRow, order, asset, contract, contractItem,
} = require('../test-support/esi-fake');
const { makeFakeTimers, timerFunctions } = require('../test-support/fake-timers');
const soldFixture = require('../test-support/sold-before-fixture');

// The /api/sync, /api/ledger, /api/snapshots and /api/market routes, against a fake ESI. The token
// manager is swapped for a stub through app.locals, so no SSO call is involved.

const IVAN = 90000001;
const GRANT = 90000002;
const HOUR = 60 * 60 * 1000;

// node:http rather than fetch: undici's fetch silently drops a custom Host header.
const request = (port, method, urlPath, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
	const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
	const h = { Host: `localhost:${port}`, ...headers };
	if (payload !== undefined) {
		h['Content-Type'] = h['Content-Type'] || 'application/json';
		h['Content-Length'] = Buffer.byteLength(payload);
	}
	const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: h }, res => {
		const chunks = [];
		res.on('data', chunk => chunks.push(chunk));
		res.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8');
			let json = null;
			try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
			resolve({ status: res.statusCode, headers: res.headers, text, json });
		});
	});
	req.on('error', reject);
	if (payload !== undefined) req.write(payload);
	req.end();
});

const startApp = async (t, { configured = true, characters = [IVAN], env: extraEnv = {} } = {}) => {
	const dataDir = tmpDataDir(t);
	const clock = makeClock();
	const fake = createFakeEsi({ now: clock });
	const app = express();
	const server = await new Promise(resolve => {
		const s = app.listen(0, '127.0.0.1', () => resolve(s));
	});
	t.after(() => new Promise(resolve => server.close(resolve)));
	const port = server.address().port;
	const env = configured
		? { EVE_CLIENT_ID: 'client-id', EVE_CLIENT_SECRET: 'client-secret', EVE_CALLBACK_URL: `http://localhost:${port}/sso/callback`, ESI_USER_AGENT: 'eflip-test/1.0' }
		: {};
	Object.assign(env, extraEnv);
	const log = makeLog();
	// the hourly region book scheduler (EFLIP_REGION_BOOK=1) runs on fake timers the test fires by hand
	const timers = makeFakeTimers();
	mountApi(app, { env, dataDir, fetch: fake.fetch, now: clock, log, timers: timerFunctions(timers) });
	t.after(() => app.locals.regionBookScheduler.stop());
	// what mountApi logged while mounting (the scheduler says whether it is on); the tests read `log` for what came after
	const startup = log.lines.splice(0);
	app.locals.tokens = configured ? makeTokens() : null;
	for (const id of characters) {
		app.locals.tokenStore.upsert({ characterId: id, name: id === IVAN ? 'Ivan Tester' : 'Grant Tester', ownerHash: `owner-${id}`, scopes: ALL_SCOPES, refreshToken: `secret-refresh-${id}`, status: 'ok' });
		fake.character(id);
	}
	return {
		app, port, dataDir, clock, fake, log, startup, timers,
		get: (p, o) => request(port, 'GET', p, o),
		post: (p, body, o = {}) => request(port, 'POST', p, { ...o, body }),
	};
};

const fillIvan = (fake) => fake.character(IVAN, {
	balance: 5000,
	transactions: [tx(6001, { date: '2026-11-10T10:00:00Z' }), tx(6002, { is_buy: false, date: '2026-11-19T10:00:00Z' })],
	journal: [journalRow(7001), journalRow(7002)],
	orders: [order(8001, { type_id: 35 })],
	assets: [asset(1, { type_id: 34 })],
	contracts: [contract(9001, { type: 'courier', status: 'outstanding', date_issued: '2026-11-19T00:00:00Z' })],
	contractItems: { 9001: [contractItem(1, 34, 10)] },
});

test('without SSO credentials the data routes answer 503, and the guards still apply', async (t) => {
	const off = await startApp(t, { configured: false, characters: [] });
	for (const [method, p] of [['GET', '/api/sync'], ['POST', '/api/sync'], ['GET', '/api/ledger'], ['GET', '/api/snapshots'], ['GET', '/api/market?typeIds=34'], ['GET', '/api/watch'], ['POST', '/api/watch'], ['GET', '/api/order-log'], ['POST', '/api/market-stats'], ['POST', '/api/sold-before']]) {
		const res = await request(off.port, method, p, method === 'POST' ? { body: {} } : {});
		assert.equal(res.status, 503, `${method} ${p}`);
		assert.deepEqual(res.json, { error: 'not configured' });
	}
	const on = await startApp(t);
	for (const [method, p] of [['GET', '/api/ledger'], ['GET', '/api/snapshots'], ['GET', '/api/sync'], ['POST', '/api/sync'], ['GET', '/api/market?typeIds=34'], ['GET', '/api/watch'], ['POST', '/api/watch'], ['GET', '/api/order-log'], ['POST', '/api/market-stats'], ['POST', '/api/sold-before'], ['GET', '/api/config']]) {
		const foreignHost = await request(on.port, method, p, { headers: { Host: 'evil.example' }, body: method === 'POST' ? {} : undefined });
		assert.equal(foreignHost.status, 403, `${method} ${p} with a foreign Host`);
		const foreignOrigin = await request(on.port, method, p, { headers: { Origin: 'http://evil.example' }, body: method === 'POST' ? {} : undefined });
		assert.equal(foreignOrigin.status, 403, `${method} ${p} with a foreign Origin`);
		assert.equal(foreignOrigin.headers['access-control-allow-origin'], undefined);
	}
	assert.equal(on.fake.calls.length, 0);
});

test('POST /api/sync syncs the linked characters, skips a recent one unless forced, and can defer the market', async (t) => {
	const ctx = await startApp(t, { characters: [IVAN, GRANT] });
	fillIvan(ctx.fake);
	const first = await ctx.post('/api/sync', { market: false });
	assert.equal(first.status, 200);
	assert.deepEqual(first.json.characters.map(c => [c.characterId, c.name, c.status]), [[IVAN, 'Ivan Tester', 'ok'], [GRANT, 'Grant Tester', 'ok']]);
	assert.equal(first.json.market, null);
	assert.equal(ctx.fake.callsTo(/markets/).length, 0);
	assert.equal(first.json.characters[0].rowsAdded.transactions, 2);
	assert.ok(!first.text.includes('secret-refresh') && !first.text.includes('token-'), 'no token in the answer');

	ctx.clock.advance(10 * 60 * 1000);
	const second = await ctx.post('/api/sync', { characterIds: [IVAN], market: false });
	assert.equal(second.json.characters[0].status, 'skipped');

	const noBody = await ctx.post('/api/sync');
	assert.equal(noBody.status, 200, 'an empty POST is a plain sync');
	assert.equal(noBody.json.characters.every(c => c.status === 'skipped'), true);
	assert.ok(noBody.json.market, 'and the market step ran (and found no destination region yet or nothing due)');

	const forced = await ctx.post('/api/sync', { characterIds: [IVAN], force: true, market: false });
	assert.equal(forced.json.characters[0].status, 'ok');
	// 10 minutes on, only the balance (2 min) and the contracts (5 min) had expired, and neither changed
	assert.equal(forced.json.characters[0].calls, 2);
	assert.equal(forced.json.characters[0].notModified, 2);
	assert.equal(forced.json.characters[0].stored, 0);
});

test('POST /api/sync rejects bad bodies and unknown characters', async (t) => {
	const ctx = await startApp(t);
	for (const body of [{ characterIds: 'x' }, { characterIds: ['abc'] }, { characterIds: [-1] }, { force: 'yes' }, { market: 1 }, { regionIds: ['x'] }]) {
		const res = await ctx.post('/api/sync', body);
		assert.equal(res.status, 400, JSON.stringify(body));
	}
	const broken = await ctx.post('/api/sync', '{not json');
	assert.equal(broken.status, 400);
	const unknown = await ctx.post('/api/sync', { characterIds: [4242] });
	assert.equal(unknown.status, 404);
	assert.equal(ctx.fake.calls.length, 0);
});

test('GET /api/sync reports each character, and the market, as of the last sync', async (t) => {
	const ctx = await startApp(t);
	fillIvan(ctx.fake);
	const before = await ctx.get('/api/sync');
	assert.equal(before.json.characters[IVAN].syncedAt, null);
	await ctx.post('/api/sync', { market: false });
	const after = await ctx.get('/api/sync');
	assert.equal(after.json.characters[IVAN].status, 'ok');
	assert.equal(after.json.characters[IVAN].syncedAt, new Date(ctx.clock()).toISOString());
	assert.equal(after.json.characters[IVAN].running, false);
	assert.deepEqual(after.json.characters[IVAN].errors, []);
});

test('GET /api/ledger returns the merged ledgers, optionally from a date', async (t) => {
	const ctx = await startApp(t, { characters: [IVAN, GRANT] });
	fillIvan(ctx.fake);
	await ctx.post('/api/sync', { market: false });

	const all = await ctx.get('/api/ledger');
	assert.equal(all.status, 200);
	assert.deepEqual(Object.keys(all.json.characters), [String(IVAN), String(GRANT)]);
	const ivan = all.json.characters[IVAN];
	assert.equal(ivan.characterId, IVAN);
	assert.deepEqual(ivan.transactions.map(row => row.transaction_id), [6001, 6002]);
	assert.equal(ivan.journal.length, 2);
	assert.deepEqual(ivan.contracts.map(row => row.contract_id), [9001]);
	assert.deepEqual(ivan.contractItems['9001'].map(item => item.type_id), [34]);
	assert.equal(ivan.sync.status, 'ok');
	assert.deepEqual(all.json.characters[GRANT].transactions, []);
	assert.deepEqual(all.json.structures, {});

	const one = await ctx.get(`/api/ledger?characterIds=${IVAN}`);
	assert.deepEqual(Object.keys(one.json.characters), [String(IVAN)]);
	const recent = await ctx.get(`/api/ledger?characterIds=${IVAN}&since=2026-11-15T00:00:00Z`);
	assert.deepEqual(recent.json.characters[IVAN].transactions.map(row => row.transaction_id), [6002]);
	const unlinked = await ctx.get('/api/ledger?characterIds=4242');
	assert.deepEqual(unlinked.json.characters[4242].transactions, [], 'a removed character with no data is simply empty');

	for (const bad of ['characterIds=abc', 'characterIds=1,,2', 'characterIds=0', `characterIds=${IVAN}&since=yesterday`, 'since=', `characterIds=${'1,'.repeat(101)}1`]) {
		assert.equal((await ctx.get(`/api/ledger?${bad}`)).status, 400, bad);
	}
	assert.ok(!all.text.includes('secret-refresh'));
});

test('GET /api/snapshots returns the retained snapshots in order', async (t) => {
	const ctx = await startApp(t);
	fillIvan(ctx.fake);
	await ctx.post('/api/sync', { market: false });
	ctx.clock.advance(2 * HOUR);
	ctx.fake.character(IVAN).orders.push(order(8002, { type_id: 36 }));
	await ctx.post('/api/sync', { market: false });

	const res = await ctx.get(`/api/snapshots?characterIds=${IVAN}`);
	assert.equal(res.status, 200);
	const list = res.json.characters[IVAN];
	assert.equal(list.length, 2);
	assert.deepEqual(list.map(s => s.orders.length), [1, 2]);
	assert.deepEqual(Object.keys(list[0]), ['syncedAt', 'orders', 'assets', 'balance']);
	assert.ok(list[0].syncedAt < list[1].syncedAt);
	const since = await ctx.get(`/api/snapshots?since=${encodeURIComponent(list[1].syncedAt)}`);
	assert.equal(since.json.characters[IVAN].length, 1);
	assert.equal((await ctx.get('/api/snapshots?since=nope')).status, 400);
});

test('GET /api/market serves the latest stored destination market for the requested types', async (t) => {
	const ctx = await startApp(t);
	fillIvan(ctx.fake);
	ctx.fake.market.orders.set('10000043:35', [{ order_id: 1, price: 10, is_buy_order: false, type_id: 35, volume_remain: 3 }]);
	ctx.fake.market.history.set('10000043:35', [{ date: '2026-11-19', average: 9, highest: 10, lowest: 8, order_count: 2, volume: 20 }]);

	assert.equal((await ctx.get('/api/market')).status, 400, 'typeIds is required');
	assert.equal((await ctx.get('/api/market?typeIds=abc')).status, 400);
	assert.equal((await ctx.get(`/api/market?typeIds=${Array.from({ length: 501 }, (_, i) => i + 1).join(',')}`)).status, 400);
	const empty = await ctx.get('/api/market?typeIds=35');
	assert.deepEqual(empty.json, { regionIds: [], syncedAt: null, types: { 35: {} } });

	const synced = await ctx.post('/api/sync', {});
	assert.equal(synced.json.market.status, 'ok');
	assert.deepEqual(synced.json.market.regionIds, [10000043]);
	const res = await ctx.get('/api/market?typeIds=35,34');
	assert.equal(res.status, 200);
	assert.deepEqual(res.json.regionIds, [10000043]);
	assert.equal(res.json.syncedAt, synced.json.market.syncedAt);
	assert.deepEqual(Object.keys(res.json.types), ['34', '35']);
	const listed = res.json.types[35][10000043];
	assert.equal(listed.orders.rows[0].order_id, 1);
	assert.equal(listed.history.rows[0].volume, 20);
	assert.match(listed.orders.fetchedAt, /^\d{4}-\d\d-\d\dT/);

	const other = await ctx.get('/api/market?typeIds=35&regionIds=10000002');
	assert.deepEqual(other.json.types[35][10000002], { orders: null, history: null });
});

test('a market sync can be requested for a named region', async (t) => {
	const ctx = await startApp(t);
	fillIvan(ctx.fake);
	const res = await ctx.post('/api/sync', { regionIds: [10000002] });
	assert.deepEqual(res.json.market.regionIds, [10000002]);
	assert.ok(ctx.fake.callsTo(/markets\/10000002\/orders/).length > 0);
	assert.equal(ctx.fake.callsTo(/markets\/10000043/).length, 0);
});

// ---- the order monitor: /api/watch, /api/order-log, /api/market?log=1, /api/config env

const REGION = 10000043;
const listed = (fake) => {
	fillIvan(fake);
	fake.market.orders.set(`${REGION}:35`, [{ order_id: 8001, type_id: 35, price: 1000, is_buy_order: false, volume_remain: 5, volume_total: 10, issued: '2026-11-18T10:00:00Z', duration: 90, range: 'region', location_id: 60008494, system_id: 30002187, min_volume: 1 }]);
};

test('POST /api/watch runs one tick and answers what it did; GET /api/watch answers the same, plus running', async (t) => {
	const ctx = await startApp(t, { characters: [IVAN, GRANT] });
	listed(ctx.fake);
	assert.deepEqual((await ctx.get('/api/watch')).json, { tickedAt: null, finishedAt: null, characters: {}, market: null, stop: null, running: false });

	// no hourly sync yet: our orders are taken, and there is no destination region to take books for
	const early = await ctx.post('/api/watch', {});
	assert.equal(early.status, 200);
	assert.equal(early.json.characters[IVAN].status, 'ok');
	assert.equal(early.json.market.status, 'skipped');

	await ctx.post('/api/sync', { characterIds: [IVAN], market: false });
	ctx.clock.advance(6 * 60 * 1000);
	const first = await ctx.post('/api/watch', { characterIds: [IVAN] });
	assert.equal(first.status, 200);
	assert.deepEqual(Object.keys(first.json.characters), [String(IVAN)], 'only the character asked for');
	assert.equal(first.json.characters[IVAN].openSellOrders, 1);
	assert.deepEqual(first.json.market.regionIds, [REGION]);
	assert.deepEqual(first.json.market.types.map(type => [type.typeId, type.outcome]), [[35, 'stored']]);
	assert.ok(ctx.fake.callsTo(/markets\/10000043\/orders/).length > 0);
	assert.ok(!first.text.includes('secret-refresh') && !first.text.includes('token-'), 'no token in the answer');

	// inside the cache windows: no ESI call, said so
	ctx.clock.advance(60 * 1000);
	ctx.fake.reset();
	const second = await ctx.post('/api/watch');
	assert.equal(ctx.fake.callsTo(/^\/(characters|markets)\/.*orders$/).length, 0);
	assert.equal(second.json.characters[IVAN].orders, 'not-due');
	assert.deepEqual(second.json.market.types.map(type => type.outcome), ['not-due']);

	const status = await ctx.get('/api/watch');
	assert.equal(status.status, 200);
	assert.deepEqual({ ...status.json, running: undefined }, { ...second.json, running: undefined });
	assert.equal(status.json.running, false);
});

test('POST /api/watch rejects bad bodies and unknown characters before any ESI call', async (t) => {
	const ctx = await startApp(t);
	for (const body of [{ characterIds: 'x' }, { characterIds: ['abc'] }, { characterIds: [-1] }]) {
		assert.equal((await ctx.post('/api/watch', body)).status, 400, JSON.stringify(body));
	}
	assert.equal((await ctx.post('/api/watch', '{not json')).status, 400);
	assert.equal((await ctx.post('/api/watch', { characterIds: [4242] })).status, 404);
	const big = await ctx.post('/api/watch', { characterIds: Array.from({ length: 5000 }, (_, i) => i + 1) });
	assert.equal(big.status, 413, 'a body past 16 kb');
	assert.equal(ctx.fake.calls.length, 0);
});

test('GET /api/order-log serves the log of each character, and the book log rides along on /api/market?log=1', async (t) => {
	const ctx = await startApp(t, { characters: [IVAN, GRANT] });
	listed(ctx.fake);
	await ctx.post('/api/sync', { characterIds: [IVAN], market: false });
	ctx.clock.advance(6 * 60 * 1000);
	await ctx.post('/api/watch', { characterIds: [IVAN] });

	const all = await ctx.get('/api/order-log');
	assert.equal(all.status, 200);
	assert.deepEqual(Object.keys(all.json.characters), [String(IVAN), String(GRANT)]);
	assert.deepEqual(Object.keys(all.json.characters[IVAN]), ['8001']);
	assert.deepEqual(all.json.characters[IVAN][8001].path.map(entry => entry.price), [1000]);
	assert.deepEqual(all.json.characters[GRANT], {}, 'no log yet: empty');
	const one = await ctx.get(`/api/order-log?characterIds=${IVAN}`);
	assert.deepEqual(Object.keys(one.json.characters), [String(IVAN)]);
	for (const bad of ['characterIds=abc', 'characterIds=1,,2', 'characterIds=0', `characterIds=${'1,'.repeat(101)}1`]) {
		assert.equal((await ctx.get(`/api/order-log?${bad}`)).status, 400, bad);
	}

	const plain = await ctx.get('/api/market?typeIds=35,36');
	assert.deepEqual(Object.keys(plain.json.types[35][REGION]), ['orders', 'history'], 'the log only comes when asked for');
	const withLog = await ctx.get('/api/market?typeIds=35,36&log=1');
	assert.equal(withLog.status, 200);
	const log = withLog.json.types[35][REGION].log;
	assert.deepEqual(Object.keys(log), ['samples', 'orders']);
	assert.deepEqual(log.samples.map(sample => sample.stored), [true]);
	assert.deepEqual(Object.keys(log.orders), ['8001']);
	assert.equal(withLog.json.types[35][REGION].orders.rows[0].order_id, 8001);
	assert.equal(withLog.json.types[36][REGION].log, null, 'a type with no log yet');
	assert.equal((await ctx.get('/api/market?typeIds=35&log=0')).json.types[35][REGION].log, undefined);
});

// ---- POST /api/market-stats: the observed figures of the types' book logs at one station

const STATION = 60008494;
const HOUR_AT = (h) => new Date(Date.UTC(2026, 10, 20, h, 0, 0)).toISOString();
// Three hourly checks (09:00, 10:00, 11:00 UTC on the test clock's day) of one station sell order that
// re-prices once, from 100 to 95 at 10:00; another order sits at a different station and is ignored.
const smallBookLog = () => ({
	samples: [9, 10, 11].map(h => ({ at: HOUR_AT(h), stored: true })),
	orders: {
		8001: {
			isBuy: false, locationId: STATION, firstSeen: HOUR_AT(9), lastSeen: HOUR_AT(11),
			path: [
				{ at: HOUR_AT(9), price: 100, volumeRemain: 10, issued: HOUR_AT(8) },
				{ at: HOUR_AT(10), price: 95, volumeRemain: 10, issued: HOUR_AT(10) }
			]
		},
		8002: {
			isBuy: false, locationId: 60003760, firstSeen: HOUR_AT(9), lastSeen: HOUR_AT(11),
			path: [{ at: HOUR_AT(9), price: 5, volumeRemain: 1, issued: HOUR_AT(8) }, { at: HOUR_AT(10), price: 4, volumeRemain: 1, issued: HOUR_AT(10) }]
		}
	}
});
const writeBookLogs = (ctx, typeIds, region = REGION) => {
	const ledger = createLedger({ dataDir: ctx.dataDir });
	for (const typeId of typeIds) ledger.writeBookLog(region, typeId, smallBookLog());
};
const statsBody = (over = {}) => ({ regionId: REGION, stationId: STATION, windowDays: 1, types: [{ typeId: 35, ordersPerDay: 1 }], ...over });

test('POST /api/market-stats answers each type from its book log, null for one without a log, and takes the server clock without a now', async (t) => {
	const ctx = await startApp(t);
	writeBookLogs(ctx, [35, 37]);
	const res = await ctx.post('/api/market-stats', statsBody({ types: [{ typeId: 35, ordersPerDay: 1 }, { typeId: 36, ordersPerDay: 1 }, { typeId: 37, ordersPerDay: 48 }] }));
	assert.equal(res.status, 200, res.text);
	assert.deepEqual(Object.keys(res.json), ['regionId', 'stationId', 'windowDays', 'now', 'types']);
	assert.deepEqual([res.json.regionId, res.json.stationId, res.json.windowDays], [REGION, STATION, 1]);
	assert.equal(res.json.now, '2026-11-20T12:00:00.000Z', 'the server clock');
	assert.deepEqual(Object.keys(res.json.types).sort(), ['35', '36', '37']);
	assert.equal(res.json.types[36], null, 'no book log for this type');

	const stats = res.json.types[35];
	assert.deepEqual(Object.keys(stats), ['coverage', 'repriceEvents', 'avgDaysIdle', 'censored', 'undercutsPerDay', 'fillsPerDay', 'vanishedUnitsPerDay', 'stockTrendPerDay']);
	assert.equal(stats.coverage.samples, 3);
	assert.equal(stats.coverage.to, HOUR_AT(11));
	assert.equal(stats.coverage.events.gapHours, 12, 'ordersPerDay 1: half a day');
	assert.equal(stats.repriceEvents, 1, 'the order of this station re-priced once; the other station is ignored');
	assert.equal(stats.censored, false);
	assert.ok(Math.abs(stats.avgDaysIdle - 2 / 24) < 1e-3, `${stats.avgDaysIdle}`); // 2 covered hours / 1 re-price
	assert.ok(Math.abs(stats.coverage.events.fraction - 2 / 24) < 1e-3);
	// a busier type (48 orders a day: a gap of 10 minutes) is not covered by hourly checks, but the volume is
	const busy = res.json.types[37];
	assert.equal(busy.coverage.events.fraction, 0);
	assert.equal(busy.coverage.volume.fraction > 0, true);
	assert.equal(busy.avgDaysIdle, null);

	// an explicit now, and another station or region, change the answer
	const earlier = await ctx.post('/api/market-stats', statsBody({ now: HOUR_AT(9) }));
	assert.equal(earlier.json.now, HOUR_AT(9));
	assert.equal(earlier.json.types[35].coverage.samples, 1, 'only the 09:00 check is at or before it');
	const elsewhere = await ctx.post('/api/market-stats', statsBody({ stationId: 60003760 }));
	assert.equal(elsewhere.json.types[35].repriceEvents, 1, 'the other station\'s order re-priced too (5 to 4)');
	assert.equal((await ctx.post('/api/market-stats', statsBody({ regionId: REGION + 1 }))).json.types[35], null, 'no log in that region');
	const before = await ctx.post('/api/market-stats', statsBody({ now: HOUR_AT(1) }));
	assert.equal(before.json.types[35], null, 'a log with no sample at or before now');
	assert.equal(ctx.fake.calls.length, 0, 'nothing reaches ESI');
	assert.deepEqual(ctx.log.lines, []);
});

test('POST /api/market-stats: a type with a bad pace or id answers null without failing the batch; a log that cannot be read warns once', async (t) => {
	const ctx = await startApp(t);
	writeBookLogs(ctx, [35, 37, 38, 39]);
	// a broken file for two types: the batch still answers, each null, and the log says so once
	for (const typeId of [38, 39]) fs.writeFileSync(path.join(ctx.dataDir, 'ledger', 'market', String(REGION), `${typeId}.json.gz`), '{not gzip');
	const types = [
		{ typeId: 35, ordersPerDay: 1 },
		{ typeId: 37, ordersPerDay: -1 },
		{ typeId: 40, ordersPerDay: 'many' },
		{ typeId: 41 },
		{ typeId: 38, ordersPerDay: 1 },
		{ typeId: 39, ordersPerDay: 1 },
		{ typeId: 'x', ordersPerDay: 1 },
		{ typeId: 0, ordersPerDay: 1 },
		{ typeId: 35, ordersPerDay: 99 }
	];
	const res = await ctx.post('/api/market-stats', statsBody({ types }));
	assert.equal(res.status, 200, res.text);
	assert.deepEqual(Object.keys(res.json.types).sort(), ['35', '37', '38', '39', '40', '41']);
	assert.equal(res.json.types[35].coverage.events.gapHours, 12, 'a type named twice is answered from its first entry');
	for (const typeId of [37, 40, 41, 38, 39]) assert.equal(res.json.types[typeId], null, String(typeId));
	assert.equal(ctx.log.lines.length, 1, 'one line for the request');
	assert.match(ctx.log.lines[0], /^warn: market stats: type 38 in region 10000043 failed: /);
	const zero = await ctx.post('/api/market-stats', statsBody({ types: [{ typeId: 35, ordersPerDay: 0 }] }));
	assert.equal(zero.json.types[35].coverage.events.gapHours, 24, 'a pace of 0 is allowed: the longest gap');
});

test('POST /api/market-stats rejects malformed bodies with 400', async (t) => {
	const ctx = await startApp(t);
	writeBookLogs(ctx, [35]);
	const type = { typeId: 35, ordersPerDay: 1 };
	const bad = [
		['an array body', []],
		['no types', statsBody({ types: undefined })],
		['an empty types list', statsBody({ types: [] })],
		['types that is not a list', statsBody({ types: { 35: 1 } })],
		['501 types', statsBody({ types: Array.from({ length: 501 }, (_, i) => ({ typeId: i + 1, ordersPerDay: 1 })) })],
		['a type that is not an object', statsBody({ types: [type, 35] })],
		['a null type', statsBody({ types: [null] })],
		['no regionId', statsBody({ regionId: undefined })],
		['a regionId of 0', statsBody({ regionId: 0 })],
		['a regionId as text', statsBody({ regionId: String(REGION) })],
		['a fractional stationId', statsBody({ stationId: 60008494.5 })],
		['no stationId', statsBody({ stationId: undefined })],
		['windowDays 0', statsBody({ windowDays: 0 })],
		['windowDays 0.5', statsBody({ windowDays: 0.5 })],
		['windowDays 61', statsBody({ windowDays: 61 })],
		['windowDays as text', statsBody({ windowDays: '3' })],
		['no windowDays', statsBody({ windowDays: undefined })],
		['a now that is not a time', statsBody({ now: 'sometime' })],
		['a now that is a number', statsBody({ now: 1766000000000 })],
		['a null now', statsBody({ now: null })]
	];
	for (const [label, body] of bad) {
		const res = await ctx.post('/api/market-stats', body);
		assert.equal(res.status, 400, label);
		assert.deepEqual(res.json, { error: 'bad request' }, label);
	}
	assert.equal((await ctx.post('/api/market-stats', '{not json')).status, 400);
	assert.equal((await ctx.post('/api/market-stats', 'plain text', { headers: { 'Content-Type': 'text/plain' } })).status, 400);
	// the edges that are fine: 500 types, windowDays 1 and 60
	const edge = await ctx.post('/api/market-stats', statsBody({ windowDays: 60, types: Array.from({ length: 500 }, (_, i) => ({ typeId: 35 + i, ordersPerDay: 1 })) }));
	assert.equal(edge.status, 200);
	assert.equal(Object.keys(edge.json.types).length, 500);
	assert.equal((await ctx.post('/api/market-stats', statsBody({ windowDays: 1 }))).status, 200);
	// a body over the limit is 413
	const huge = await ctx.post('/api/market-stats', statsBody({ types: [type], pad: 'x'.repeat(1024 * 1024 + 10) }));
	assert.equal(huge.status, 413);
});

// ---- POST /api/sold-before: what the linked characters sold at one station, from the ledger

// The fixture's two characters' ledgers (test-support/sold-before-fixture.js) on disk, as a sync would leave them.
const writeSoldLedgers = (ctx, { ids = [IVAN, GRANT] } = {}) => {
	const ledger = createLedger({ dataDir: ctx.dataDir });
	const { ledgers, snapshots } = soldFixture.buildLedgers();
	for (const id of ids) {
		ledger.mergeInto(id, 'transactions', ledgers[id].transactions);
		ledger.mergeInto(id, 'journal', ledgers[id].journal);
		for (const snapshot of snapshots[id]) ledger.writeSnapshot(id, snapshot);
	}
	return ledger;
};
const soldBody = (over = {}) => ({ stationId: soldFixture.AMARR, typeIds: [34, 35, 36, 37, 38, 99], days: 90, sourceStationId: soldFixture.JITA, ...over });

test('POST /api/sold-before pools every linked character\'s ledger and answers the types sold at the station, and only those', async (t) => {
	const ctx = await startApp(t, { characters: [IVAN, GRANT] });
	writeSoldLedgers(ctx);
	// a ledger on disk of a character that is not linked is not pooled
	const stranger = 90000003;
	createLedger({ dataDir: ctx.dataDir }).mergeInto(stranger, 'transactions', [tx(9001, { is_buy: false, location_id: soldFixture.AMARR, type_id: 34, quantity: 1000, date: '2026-11-19T11:00:00Z' })]);

	const res = await ctx.post('/api/sold-before', soldBody());
	assert.equal(res.status, 200, res.text);
	assert.deepEqual(Object.keys(res.json), ['stationId', 'days', 'types']);
	assert.deepEqual([res.json.stationId, res.json.days], [soldFixture.AMARR, 90]);
	assert.deepEqual(res.json.types, soldFixture.EXPECTED, 'types 35 (a buy), 37 (inside the pool), 38 (a corporation) and 99 (never traded) are left out');
	assert.deepEqual(Object.keys(res.json.types[34]), ['units', 'sales', 'lastSoldAt', 'netMarginMilPerUnit', 'medianDaysOnMarket']);
	assert.equal(res.json.types[36].netMarginMilPerUnit, null, 'a sale no bought lot stands behind has no margin');
	assert.equal(res.json.types[36].medianDaysOnMarket, null);

	// only the types asked for come back; days defaults to 90; the source station is optional
	const one = await ctx.post('/api/sold-before', { stationId: soldFixture.AMARR, typeIds: [36, 36] });
	assert.deepEqual(one.json, { stationId: soldFixture.AMARR, days: 90, types: { 36: soldFixture.EXPECTED[36] } });
	assert.deepEqual((await ctx.post('/api/sold-before', soldBody({ typeIds: [35, 99] }))).json.types, {});
	// another station answers its own sales; FIFO takes the oldest lots (3 at 0.5M, 4 at 1.0M): (14.7M - 1.1025M tax - 5.5M) / 7
	assert.deepEqual((await ctx.post('/api/sold-before', soldBody({ stationId: soldFixture.OTHER }))).json.types, { 34: { units: 7, sales: 1, lastSoldAt: '2026-11-17T10:00:00Z', netMarginMilPerUnit: 1.156786, medianDaysOnMarket: null } });
	// the window follows days: 5 days back is 2026-11-15T12:00Z, past the type 36 sale; 2 days leaves the one sale of 5 units
	const five = await ctx.post('/api/sold-before', soldBody({ days: 5 }));
	assert.deepEqual(Object.keys(five.json.types), ['34']);
	assert.equal(five.json.days, 5);
	assert.equal(five.json.types[34].units, 15);
	const two = await ctx.post('/api/sold-before', soldBody({ days: 2 }));
	assert.deepEqual([two.json.types[34].units, two.json.types[34].sales, two.json.types[34].netMarginMilPerUnit], [5, 1, 0.835]); // 4.175M profit over 5 units
	assert.equal(two.json.types[34].medianDaysOnMarket, 9.417);
	assert.equal(ctx.fake.calls.length, 0, 'nothing reaches ESI');
	assert.deepEqual(ctx.log.lines, []);
});

test('POST /api/sold-before answers {} for linked characters with no ledger yet, and with no characters linked', async (t) => {
	const bare = await startApp(t, { characters: [IVAN] });
	const res = await bare.post('/api/sold-before', soldBody());
	assert.equal(res.status, 200, res.text);
	assert.deepEqual(res.json.types, {});
	const none = await startApp(t, { characters: [] });
	assert.deepEqual((await none.post('/api/sold-before', soldBody())).json.types, {});
});

test('POST /api/sold-before keeps the answer for a minute, so the batches of one run share one pass over the ledger', async (t) => {
	const ctx = await startApp(t, { characters: [IVAN, GRANT] });
	const ledger = writeSoldLedgers(ctx);
	const before = await ctx.post('/api/sold-before', soldBody({ typeIds: [34] }));
	assert.equal(before.json.types[34].units, 15);
	ledger.mergeInto(IVAN, 'transactions', [tx(9100, { is_buy: false, location_id: soldFixture.AMARR, type_id: 34, quantity: 2, unit_price: 2500000, date: '2026-11-20T11:00:00Z' })]);
	ctx.clock.advance(30 * 1000);
	assert.equal((await ctx.post('/api/sold-before', soldBody({ typeIds: [34] }))).json.types[34].units, 15, 'within the minute: the kept answer');
	assert.equal((await ctx.post('/api/sold-before', soldBody({ typeIds: [34], days: 30 }))).json.types[34].units, 17, 'another window is its own answer');
	ctx.clock.advance(31 * 1000);
	const after = await ctx.post('/api/sold-before', soldBody({ typeIds: [34] }));
	assert.equal(after.json.types[34].units, 17, 'a minute on: worked out again');
	assert.equal(after.json.types[34].sales, 3);
	assert.equal(after.json.types[34].lastSoldAt, '2026-11-20T11:00:00Z');
});

test('POST /api/sold-before rejects malformed bodies with 400', async (t) => {
	const ctx = await startApp(t, { characters: [IVAN, GRANT] });
	writeSoldLedgers(ctx);
	const bad = [
		['an array body', []],
		['no stationId', soldBody({ stationId: undefined })],
		['a stationId of 0', soldBody({ stationId: 0 })],
		['a stationId as text', soldBody({ stationId: '60008494' })],
		['a fractional stationId', soldBody({ stationId: 60008494.5 })],
		['no typeIds', soldBody({ typeIds: undefined })],
		['an empty typeIds', soldBody({ typeIds: [] })],
		['typeIds that is not a list', soldBody({ typeIds: { 34: true } })],
		['501 typeIds', soldBody({ typeIds: Array.from({ length: 501 }, (_, i) => i + 1) })],
		['a typeId of 0', soldBody({ typeIds: [34, 0] })],
		['a typeId as text', soldBody({ typeIds: ['34'] })],
		['a fractional typeId', soldBody({ typeIds: [34.5] })],
		['a null typeId', soldBody({ typeIds: [null] })],
		['days 0', soldBody({ days: 0 })],
		['days 366', soldBody({ days: 366 })],
		['fractional days', soldBody({ days: 1.5 })],
		['days as text', soldBody({ days: '90' })],
		['null days', soldBody({ days: null })],
		['a sourceStationId of 0', soldBody({ sourceStationId: 0 })],
		['a sourceStationId as text', soldBody({ sourceStationId: '60003760' })]
	];
	for (const [label, body] of bad) {
		const res = await ctx.post('/api/sold-before', body);
		assert.equal(res.status, 400, label);
		assert.deepEqual(res.json, { error: 'bad request' }, label);
	}
	assert.equal((await ctx.post('/api/sold-before', '{not json')).status, 400);
	assert.equal((await ctx.post('/api/sold-before', 'plain text', { headers: { 'Content-Type': 'text/plain' } })).status, 400);
	// the edges that are fine: 500 types, days 1 and 365, a null or absent source station
	const edge = await ctx.post('/api/sold-before', soldBody({ typeIds: Array.from({ length: 500 }, (_, i) => 34 + i), days: 365 }));
	assert.equal(edge.status, 200);
	assert.deepEqual(Object.keys(edge.json.types), ['34', '36']);
	assert.equal((await ctx.post('/api/sold-before', soldBody({ days: 1 }))).status, 200);
	assert.equal((await ctx.post('/api/sold-before', soldBody({ sourceStationId: null }))).status, 200);
	assert.equal((await ctx.post('/api/sold-before', { stationId: soldFixture.AMARR, typeIds: [34] })).status, 200);
	// a body over the limit is 413
	const huge = await ctx.post('/api/sold-before', soldBody({ pad: 'x'.repeat(256 * 1024 + 10) }));
	assert.equal(huge.status, 413);
});

// ---- the regional book: POST /api/sync regionBook, /api/config regionBook

const regionRows = [
	{ order_id: 1, type_id: 35, price: 100, is_buy_order: false, volume_remain: 5, volume_total: 10, issued: '2026-11-20T10:00:00Z', duration: 90, range: 'region', location_id: 60008494, system_id: 30002187, min_volume: 1 },
	{ order_id: 2, type_id: 36, price: 90, is_buy_order: true, volume_remain: 5, volume_total: 10, issued: '2026-11-20T10:00:00Z', duration: 90, range: 'region', location_id: 60008494, system_id: 30002187, min_volume: 1 },
];

test('GET /api/config says whether the hourly regional book job is on and scheduled, and GET /api/sync how the last run ended', async (t) => {
	const off = await startApp(t);
	assert.deepEqual((await off.get('/api/config')).json.regionBook, { enabled: false, scheduled: false, nextRunAt: null, lastRun: null });
	assert.deepEqual(off.timers.pending(), [], 'no flag, no timer');
	assert.deepEqual(off.startup, ['info: region book schedule: off (EFLIP_REGION_BOOK=1 takes the destination book once an hour)']);
	assert.equal((await off.get('/api/sync')).json.regionBook.enabled, false);
	assert.equal((await off.get('/api/sync')).json.regionBook.status, null);
	const on = await startApp(t, { env: { EFLIP_REGION_BOOK: '1' } });
	assert.deepEqual((await on.get('/api/config')).json.regionBook, { enabled: true, scheduled: true, nextRunAt: new Date(on.clock() + 60 * 1000).toISOString(), lastRun: null });
	assert.deepEqual(on.timers.pending().map(({ kind, ms, unrefed }) => [kind, ms, unrefed]), [['timeout', 60 * 1000, true]]);
	assert.equal((await on.get('/api/sync')).json.regionBook.enabled, true);
	const odd = await startApp(t, { env: { EFLIP_REGION_BOOK: 'yes' } });
	assert.deepEqual((await odd.get('/api/config')).json.regionBook, { enabled: false, scheduled: false, nextRunAt: null, lastRun: null }, 'only 1 turns it on');
	const bare = await startApp(t, { configured: false, env: { EFLIP_REGION_BOOK: '1' } });
	assert.equal((await bare.get('/api/config')).json.regionBook.enabled, true, 'beside the other flags, without credentials');
	assert.equal(on.app.locals.regionBookScheduler.status().scheduled, true, 'the scheduler is on app.locals');
});

test('with EFLIP_REGION_BOOK=1 the server takes the hourly snapshot by itself: the first run a minute after the mount, then every hour, and /api/config reports it', async (t) => {
	const ctx = await startApp(t, { env: { EFLIP_REGION_BOOK: '1' } });
	fillIvan(ctx.fake);
	ctx.fake.market.regionOrders.set('10000043', regionRows);
	const regionCalls = () => ctx.fake.callsTo(/^\/markets\/\d+\/orders$/).filter(call => call.query.order_type !== undefined);
	assert.deepEqual(ctx.startup, ['info: region book schedule: on, first snapshot in 60 s, then every 60 min']);
	assert.equal(regionCalls().length, 0, 'nothing runs at mount');

	// the region is the one Ivan lists in: his orders must be synced first (the scheduled run reads it from the ledger)
	await ctx.post('/api/sync', { market: false });
	ctx.clock.advance(60 * 1000);
	const first = ctx.timers.fire('timeout');
	await first;
	assert.equal(regionCalls().length, 1);
	const after = (await ctx.get('/api/config')).json.regionBook;
	assert.deepEqual(after, { enabled: true, scheduled: true, nextRunAt: new Date(ctx.clock() + HOUR).toISOString(), lastRun: { at: new Date(ctx.clock()).toISOString(), status: 'ok' } });
	assert.ok(ctx.log.lines.some(line => /^info: region book schedule: ok, 1\/1 pages, 2 tokens, \d+\.\d s$/.test(line)), ctx.log.lines.join('\n'));
	assert.ok(fs.existsSync(path.join(ctx.dataDir, 'ledger', 'market', '10000043', '35.json.gz')));

	// the next hourly tick: the job's own 55-minute rule decides, here it is due
	ctx.clock.advance(HOUR);
	await ctx.timers.fire('interval');
	assert.equal(regionCalls().length, 2, 'one more snapshot an hour later');
	assert.equal((await ctx.get('/api/sync')).json.regionBook.status, 'ok');

	// a tick inside the hour skips itself: no call, and the schedule reports it
	ctx.clock.advance(10 * 60 * 1000);
	await ctx.timers.fire('interval');
	assert.equal(regionCalls().length, 2);
	assert.equal(ctx.log.lines.at(-1), 'info: region book schedule: skipped - a snapshot was folded within the last hour');
	assert.equal((await ctx.get('/api/config')).json.regionBook.lastRun.status, 'skipped');

	ctx.app.locals.regionBookScheduler.stop();
	assert.deepEqual((await ctx.get('/api/config')).json.regionBook.scheduled, false);
	assert.deepEqual(ctx.timers.pending(), []);
});

test('POST /api/sync regionBook: true takes the destination region now, false never does, absent follows EFLIP_REGION_BOOK; anything else is a 400', async (t) => {
	const ctx = await startApp(t);
	fillIvan(ctx.fake);
	ctx.fake.market.regionOrders.set('10000043', regionRows);
	for (const body of [{ regionBook: 'yes' }, { regionBook: 1 }, { regionBook: null }]) {
		assert.equal((await ctx.post('/api/sync', body)).status, 400, JSON.stringify(body));
	}
	const regionCalls = () => ctx.fake.callsTo(/^\/markets\/\d+\/orders$/).filter(call => call.query.order_type !== undefined);

	const plain = await ctx.post('/api/sync', { market: false });
	assert.equal(plain.json.regionBook, null, 'off unless asked for');
	assert.equal(regionCalls().length, 0);

	// on request, with the market deferred: the region is where Ivan lists, once his orders are synced
	ctx.clock.advance(10 * 60 * 1000);
	const asked = await ctx.post('/api/sync', { market: false, regionBook: true });
	assert.equal(asked.status, 200);
	assert.equal(asked.json.market, null);
	assert.equal(asked.json.regionBook.status, 'ok', JSON.stringify(asked.json.regionBook));
	assert.equal(asked.json.regionBook.regionId, 10000043);
	assert.equal(asked.json.regionBook.pages, 1);
	assert.equal(asked.json.regionBook.typesFolded, 2);
	assert.equal(asked.json.regionBook.tokensUsed, 2);
	assert.equal(regionCalls().length, 1);
	assert.ok(fs.existsSync(path.join(ctx.dataDir, 'ledger', 'market', '10000043', '36.json.gz')), 'the buy order counts: every type, both sides');
	const status = (await ctx.get('/api/sync')).json.regionBook;
	assert.equal(status.status, 'ok');
	assert.equal(status.syncedAt, asked.json.regionBook.syncedAt);
	assert.equal(status.regionId, 10000043);

	// a named region goes through regionIds
	ctx.fake.market.regionOrders.set('10000002', regionRows.slice(0, 1));
	ctx.clock.advance(10 * 60 * 1000);
	const named = await ctx.post('/api/sync', { market: false, regionBook: true, regionIds: [10000002] });
	assert.equal(named.json.regionBook.regionId, 10000002);
});

test('with EFLIP_REGION_BOOK=1 a sync takes the region book after the market, a deferred market defers it, and regionBook: false skips it', async (t) => {
	const ctx = await startApp(t, { env: { EFLIP_REGION_BOOK: '1' } });
	fillIvan(ctx.fake);
	ctx.fake.market.regionOrders.set('10000043', regionRows);
	const regionCalls = () => ctx.fake.callsTo(/^\/markets\/\d+\/orders$/).filter(call => call.query.order_type !== undefined);

	const deferred = await ctx.post('/api/sync', { market: false });
	assert.equal(deferred.json.regionBook.status, 'deferred');
	assert.equal(regionCalls().length, 0);

	const skipped = await ctx.post('/api/sync', { regionBook: false });
	assert.equal(skipped.json.regionBook, null);
	assert.equal(skipped.json.market.status, 'ok');
	assert.equal(regionCalls().length, 0);

	ctx.clock.advance(10 * 60 * 1000);
	const full = await ctx.post('/api/sync', { force: true });
	assert.equal(full.json.market.status, 'ok');
	assert.equal(full.json.regionBook.status, 'ok', JSON.stringify(full.json.regionBook));
	assert.equal(regionCalls().length, 1);
});

test('GET /api/config says where the data is and whether EFLIP_DATA_DIR and ESI_USER_AGENT are set, and nothing secret', async (t) => {
	const bare = await startApp(t);
	const res = await bare.get('/api/config');
	assert.equal(res.status, 200);
	assert.deepEqual(res.json.env, { dataDir: bare.dataDir, dataDirFromEnv: false, userAgentFromEnv: true, dataDirError: null });
	assert.equal(res.json.configured, true);

	const set = await startApp(t, { env: { EFLIP_DATA_DIR: '/somewhere/shared' } });
	assert.equal((await set.get('/api/config')).json.env.dataDirFromEnv, true);

	// not configured for SSO: still answers, still no secret; no user agent set
	const off = await startApp(t, { configured: false });
	const offRes = await off.get('/api/config');
	assert.equal(offRes.status, 200);
	assert.equal(offRes.json.configured, false);
	assert.deepEqual(offRes.json.env, { dataDir: off.dataDir, dataDirFromEnv: false, userAgentFromEnv: false, dataDirError: null });
	const loud = await startApp(t, { env: { EVE_CLIENT_SECRET: 'client-secret-xyz', EFLIP_DATA_DIR: '/x', ESI_USER_AGENT: 'me@example.com' } });
	const loudRes = await loud.get('/api/config');
	assert.ok(!loudRes.text.includes('client-secret-xyz') && !loudRes.text.includes('me@example.com'), 'flags only, never the values');
	assert.deepEqual(Object.keys(loudRes.json.env), ['dataDir', 'dataDirFromEnv', 'userAgentFromEnv', 'dataDirError']);
});

test('GET /api/config reports the storage budget, the shares and each kind\'s bytes now; POST /api/sync storage: true runs the step once; anything else is a 400', async (t) => {
	const bare = await startApp(t);
	assert.deepEqual((await bare.get('/api/config')).json.storage, {
		budget: null, shares: { regionPages: 40, bookLogs: 45, typeBooks: 10, runContexts: 5 },
		usage: { regionPages: 0, bookLogs: 0, typeBooks: 0, runContexts: 0 }, total: 0, measuredAt: '2026-11-20T12:00:00.000Z', lastTrimAt: null, unmet: 0,
	});
	const unconfigured = await startApp(t, { configured: false, env: { EFLIP_STORAGE_BUDGET: '1GB' } });
	assert.equal((await unconfigured.get('/api/config')).json.storage.budget, 1e9, 'beside the other flags, without credentials');

	const ctx = await startApp(t, { env: { EFLIP_STORAGE_BUDGET: '1GB', EFLIP_STORAGE_SHARES: 'regionPages:50,bookLogs:30,typeBooks:15,runContexts:5' } });
	fillIvan(ctx.fake);
	ctx.fake.market.regionOrders.set('10000043', regionRows);
	for (const body of [{ storage: 'yes' }, { storage: 1 }, { storage: null }]) {
		assert.equal((await ctx.post('/api/sync', body)).status, 400, JSON.stringify(body));
	}
	const asked = await ctx.post('/api/sync', { market: false, regionBook: true, storage: true });
	assert.equal(asked.status, 200);
	assert.equal(asked.json.regionBook.status, 'ok', JSON.stringify(asked.json.regionBook));
	assert.equal(asked.json.regionBook.storage.reason, 'regionBook', 'the region book ran the step itself, with a budget set');
	assert.equal(asked.json.storage.status, 'ok');
	assert.equal(asked.json.storage.reason, 'manual', 'and storage: true ran it once more at the end');
	assert.equal(asked.json.storage.budgetBytes, 1e9);
	assert.ok(asked.json.storage.usage.regionPages > 0 && asked.json.storage.usage.bookLogs > 0);

	const config = (await ctx.get('/api/config')).json.storage;
	assert.deepEqual(Object.keys(config), ['budget', 'shares', 'usage', 'total', 'measuredAt', 'lastTrimAt', 'unmet']);
	assert.equal(config.budget, 1e9);
	assert.deepEqual(config.shares, { regionPages: 50, bookLogs: 30, typeBooks: 15, runContexts: 5 });
	assert.deepEqual(config.usage, asked.json.storage.usage, 'measured afresh: nothing changed since');
	assert.equal(config.total, Object.values(config.usage).reduce((a, b) => a + b, 0));
	assert.equal(config.lastTrimAt, null, 'nothing over 1 GB to trim');
	assert.equal(config.unmet, 0);

	// without a budget the step only measures
	const noBudget = await startApp(t);
	fillIvan(noBudget.fake);
	const measured = await noBudget.post('/api/sync', { market: false, storage: true });
	assert.equal(measured.json.storage.status, 'no-budget');
	assert.equal(measured.json.storage.budgetBytes, null);
});
