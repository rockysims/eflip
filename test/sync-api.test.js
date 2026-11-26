const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { mountApi } = require('../lib/api');
const {
	ALL_SCOPES, makeClock, tmpDataDir, makeLog, makeTokens, createFakeEsi,
	tx, journalRow, order, asset, contract, contractItem,
} = require('../test-support/esi-fake');

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
	mountApi(app, { env, dataDir, fetch: fake.fetch, now: clock, log });
	app.locals.tokens = configured ? makeTokens() : null;
	for (const id of characters) {
		app.locals.tokenStore.upsert({ characterId: id, name: id === IVAN ? 'Ivan Tester' : 'Grant Tester', ownerHash: `owner-${id}`, scopes: ALL_SCOPES, refreshToken: `secret-refresh-${id}`, status: 'ok' });
		fake.character(id);
	}
	return {
		app, port, dataDir, clock, fake, log,
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
	for (const [method, p] of [['GET', '/api/sync'], ['POST', '/api/sync'], ['GET', '/api/ledger'], ['GET', '/api/snapshots'], ['GET', '/api/market?typeIds=34'], ['GET', '/api/watch'], ['POST', '/api/watch'], ['GET', '/api/order-log']]) {
		const res = await request(off.port, method, p, method === 'POST' ? { body: {} } : {});
		assert.equal(res.status, 503, `${method} ${p}`);
		assert.deepEqual(res.json, { error: 'not configured' });
	}
	const on = await startApp(t);
	for (const [method, p] of [['GET', '/api/ledger'], ['GET', '/api/snapshots'], ['GET', '/api/sync'], ['POST', '/api/sync'], ['GET', '/api/market?typeIds=34'], ['GET', '/api/watch'], ['POST', '/api/watch'], ['GET', '/api/order-log'], ['GET', '/api/config']]) {
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
