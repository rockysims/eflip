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

const startApp = async (t, { configured = true, characters = [IVAN] } = {}) => {
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
	for (const [method, p] of [['GET', '/api/sync'], ['POST', '/api/sync'], ['GET', '/api/ledger'], ['GET', '/api/snapshots'], ['GET', '/api/market?typeIds=34']]) {
		const res = await request(off.port, method, p, method === 'POST' ? { body: {} } : {});
		assert.equal(res.status, 503, `${method} ${p}`);
		assert.deepEqual(res.json, { error: 'not configured' });
	}
	const on = await startApp(t);
	for (const [method, p] of [['GET', '/api/ledger'], ['GET', '/api/snapshots'], ['GET', '/api/sync'], ['POST', '/api/sync'], ['GET', '/api/market?typeIds=34']]) {
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
