const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createEsiClient, slugFor, urlFor, groupFor, parseRateLimit } = require('../lib/esi');
const { TokenError } = require('../lib/tokens');
const { makeClock, tmpDataDir, makeTokens } = require('../test-support/esi-fake');

// A scripted fetch: `answers` is a list of (url, init) => Response, used in order; calls are kept.
const scripted = (answers) => {
	const calls = [];
	const fn = async (url, init = {}) => {
		const call = { url: String(url), headers: { ...init.headers }, hasSignal: Boolean(init.signal) };
		calls.push(call);
		const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
		return answer(call.url, init);
	};
	fn.calls = calls;
	return fn;
};
const respond = (status, body, headers = {}) => () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers });

const setup = (t, answers, options = {}) => {
	const dataDir = tmpDataDir(t);
	const clock = makeClock();
	const fetch = scripted(answers);
	const tokens = makeTokens();
	const client = createEsiClient({ dataDir, fetch, now: clock, tokens, userAgent: 'eflip-test/1.0', ...options });
	return { dataDir, clock, fetch, tokens, client };
};

const expiresIn = (clock, seconds) => new Date(clock() + seconds * 1000).toUTCString();
const rawDir = (dataDir, owner, slug) => path.join(dataDir, 'raw', String(owner), slug);
const names = (dir) => {
	try {
		return fs.readdirSync(dir).sort();
	} catch (e) {
		return [];
	}
};
const mode = (file) => fs.statSync(file).mode & 0o777;
const CHAR = 90000001;
const JOURNAL = `/characters/${CHAR}/wallet/journal`;

test('slugs name routes the way the raw directories are named', () => {
	assert.equal(slugFor(`/characters/${CHAR}/wallet`), 'wallet');
	assert.equal(slugFor(`/characters/${CHAR}/wallet/journal`, { page: 1 }), 'wallet-journal');
	assert.equal(slugFor(`/characters/${CHAR}/wallet/journal`, { page: 2 }), 'wallet-journal-page-2');
	assert.equal(slugFor(`/characters/${CHAR}/wallet/transactions`, { from_id: 6919559472 }), 'wallet-transactions-from-id-6919559472');
	assert.equal(slugFor(`/characters/${CHAR}/contracts/237910844/items`), 'contracts-237910844-items');
	assert.equal(slugFor(`/characters/${CHAR}/orders/history`, { page: 3 }), 'orders-history-page-3');
	assert.equal(slugFor('/universe/structures/1028858195912'), 'universe-structures-1028858195912');
	assert.equal(slugFor('/markets/10000043/orders', { type_id: 34 }), 'markets-10000043-orders-type-id-34');
	assert.equal(slugFor('/markets/10000043/orders', { type_id: 34, page: 2 }), 'markets-10000043-orders-page-2-type-id-34');
	assert.throws(() => slugFor('/'), /empty route slug/);
});

test('urls have no /latest/, no datasource, no trailing slash, and page 1 is implicit', () => {
	assert.equal(urlFor(JOURNAL, {}), `https://esi.evetech.net${JOURNAL}`);
	assert.equal(urlFor(JOURNAL, { page: 1 }), `https://esi.evetech.net${JOURNAL}`);
	assert.equal(urlFor(JOURNAL, { page: 2 }), `https://esi.evetech.net${JOURNAL}?page=2`);
	assert.equal(urlFor('/markets/10000043/orders', { type_id: 34, page: 2 }), 'https://esi.evetech.net/markets/10000043/orders?page=2&type_id=34');
});

test('rate-limit groups follow the routes, and header limits parse', () => {
	assert.equal(groupFor(`/characters/${CHAR}/wallet`), 'char-wallet');
	assert.equal(groupFor(`/characters/${CHAR}/wallet/journal`), 'char-wallet');
	assert.equal(groupFor(`/characters/${CHAR}/wallet/transactions`), 'char-wallet');
	assert.equal(groupFor(`/characters/${CHAR}/contracts`), 'char-contract');
	assert.equal(groupFor(`/characters/${CHAR}/contracts/1/items`), 'char-contract');
	assert.equal(groupFor(`/characters/${CHAR}/assets`), 'char-asset');
	assert.equal(groupFor(`/characters/${CHAR}/skills`), 'char-detail');
	assert.equal(groupFor(`/characters/${CHAR}/standings`), 'char-social');
	assert.equal(groupFor('/markets/10000043/orders'), 'market-order');
	for (const legacy of [`/characters/${CHAR}/orders`, `/characters/${CHAR}/orders/history`, '/universe/structures/1', '/markets/10000043/history']) assert.equal(groupFor(legacy), null, legacy);
	assert.deepEqual(parseRateLimit('150/15m'), { limit: 150, windowMs: 15 * 60 * 1000 });
	assert.deepEqual(parseRateLimit('600/1h'), { limit: 600, windowMs: 60 * 60 * 1000 });
	assert.equal(parseRateLimit('whatever').limit, null);
});

test('a 200 is stored verbatim with all its headers, privately, and the next call waits for Expires', async (t) => {
	const clock0 = makeClock();
	const body = [{ id: 1 }, { id: 2 }];
	const headers = { etag: '"e1"', expires: expiresIn(clock0, 3600), 'x-pages': '1', 'x-ratelimit-group': 'char-wallet', 'x-ratelimit-limit': '150/15m', 'x-ratelimit-remaining': '148', 'x-custom': 'kept' };
	const { dataDir, client, fetch, tokens, clock } = setup(t, [respond(200, body, headers)]);

	const first = await client.get({ owner: CHAR, path: JOURNAL });
	assert.equal(first.outcome, 'ok');
	assert.equal(first.stored, true);
	assert.deepEqual(first.body, body);
	assert.deepEqual(first.rate, { group: 'char-wallet', limit: 150, remaining: 148 });

	const sent = fetch.calls[0];
	assert.equal(sent.url, `https://esi.evetech.net${JOURNAL}`);
	assert.equal(sent.headers.Authorization, `Bearer token-${CHAR}`);
	assert.equal(sent.headers['User-Agent'], 'eflip-test/1.0');
	assert.equal(sent.headers['X-Compatibility-Date'], '2026-08-18');
	assert.equal(sent.headers.Accept, 'application/json');
	assert.equal(sent.headers['If-None-Match'], undefined);
	assert.ok(sent.hasSignal, 'every request has a timeout');

	const dir = rawDir(dataDir, CHAR, 'wallet-journal');
	assert.deepEqual(names(dir), ['2026-11-20T12-00-00-000Z.json']);
	const stored = JSON.parse(fs.readFileSync(path.join(dir, names(dir)[0]), 'utf8'));
	assert.deepEqual(Object.keys(stored), ['fetchedAt', 'url', 'status', 'headers', 'body']);
	assert.equal(stored.fetchedAt, '2026-11-20T12:00:00.000Z');
	assert.equal(stored.status, 200);
	assert.deepEqual(stored.body, body);
	for (const [name, value] of Object.entries(headers)) assert.equal(stored.headers[name], value, name);
	assert.equal(mode(dir), 0o700);
	assert.equal(mode(path.join(dir, names(dir)[0])), 0o600);
	assert.equal(mode(path.join(dataDir, 'esi-cache', String(CHAR), 'wallet-journal.json')), 0o600);
	assert.ok(!fs.readFileSync(path.join(dir, names(dir)[0]), 'utf8').includes('token-'), 'no token in a raw file');

	// before Expires: no call
	clock.advance(30 * 60 * 1000);
	const second = await client.get({ owner: CHAR, path: JOURNAL });
	assert.equal(second.outcome, 'not-due');
	assert.equal(fetch.calls.length, 1);
	assert.equal(tokens.forgotten.length, 0);
});

test('after Expires the call carries If-None-Match; a 304 stores nothing and moves Expires on', async (t) => {
	const clock0 = makeClock();
	const { dataDir, client, fetch, clock } = setup(t, [
		respond(200, [1], { etag: '"e1"', expires: expiresIn(clock0, 3600), 'x-pages': '4' }),
		respond(304, undefined, { etag: '"e1"', expires: expiresIn(clock0, 7200) }),
	]);
	await client.get({ owner: CHAR, path: JOURNAL });
	clock.advance(3600 * 1000 + 1);
	const result = await client.get({ owner: CHAR, path: JOURNAL });
	assert.equal(result.outcome, 'not-modified');
	assert.equal(result.pages, 4, 'the page count survives a 304 (which may omit X-Pages)');
	assert.equal(fetch.calls[1].headers['If-None-Match'], '"e1"');
	assert.equal(names(rawDir(dataDir, CHAR, 'wallet-journal')).length, 1);
	const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'esi-cache', String(CHAR), 'wallet-journal.json'), 'utf8'));
	assert.equal(state.expires, new Date(clock0() + 7200 * 1000).toISOString());
	assert.equal(state.etag, '"e1"');

	// still inside the new Expires
	clock.advance(30 * 60 * 1000);
	assert.equal((await client.get({ owner: CHAR, path: JOURNAL })).outcome, 'not-due');
	assert.equal(fetch.calls.length, 2);
});

test('a 200 whose body equals the last stored one is not stored again, but Expires still moves on', async (t) => {
	const clock0 = makeClock();
	const { dataDir, client, clock } = setup(t, [
		respond(200, { a: 1 }, { expires: expiresIn(clock0, 100) }),
		respond(200, { a: 1 }, { expires: expiresIn(clock0, 5000) }),
		respond(200, { a: 2 }, { expires: expiresIn(clock0, 9000) }),
		respond(200, { a: 1 }, { expires: expiresIn(clock0, 9500) }),
	]);
	const dir = rawDir(dataDir, CHAR, 'skills');
	const get = () => client.get({ owner: CHAR, path: `/characters/${CHAR}/skills` });
	assert.equal((await get()).stored, true);
	clock.advance(200 * 1000);
	const same = await get();
	assert.equal(same.outcome, 'ok');
	assert.equal(same.stored, false);
	assert.equal(names(dir).length, 1);
	assert.equal(client.peek({ owner: CHAR, path: `/characters/${CHAR}/skills` }).outcome, 'not-due', 'the second answer scheduled the next fetch');

	clock.advance(6000 * 1000);
	assert.equal((await get()).stored, true, 'a changed body is stored');
	clock.advance(10000 * 1000);
	assert.equal((await get()).stored, true, 'a body that went back is compared with the last stored one, so it is stored again');
	assert.equal(names(dir).length, 3);
});

test('fetchedAt keeps rising when the clock stands still, so no raw file is overwritten', async (t) => {
	// no Expires header: every call is due at once, three changed bodies in the same millisecond
	const { dataDir, client } = setup(t, [respond(200, [1]), respond(200, [2]), respond(200, [3])]);
	for (let i = 0; i < 3; i++) assert.equal((await client.get({ owner: CHAR, path: JOURNAL })).stored, true);
	const files = names(rawDir(dataDir, CHAR, 'wallet-journal'));
	assert.deepEqual(files, ['2026-11-20T12-00-00-000Z.json', '2026-11-20T12-00-00-001Z.json', '2026-11-20T12-00-00-002Z.json']);
	const bodies = files.map(file => JSON.parse(fs.readFileSync(path.join(rawDir(dataDir, CHAR, 'wallet-journal'), file), 'utf8')).body);
	assert.deepEqual(bodies, [[1], [2], [3]]);
});

test('a 401 drops the cached token, is never retried, and says so', async (t) => {
	const { client, fetch, tokens } = setup(t, [respond(401, { error: 'token is expired' })]);
	const result = await client.get({ owner: CHAR, path: JOURNAL });
	assert.equal(result.outcome, 'auth');
	assert.equal(result.code, 'unauthorized');
	assert.equal(fetch.calls.length, 1);
	assert.deepEqual(tokens.forgotten, [CHAR]);
});

test('a token the manager refuses (relink) means no request at all', async (t) => {
	const { client, fetch, tokens } = setup(t, [respond(200, [])]);
	tokens.failWith = new TokenError('character needs re-linking', 'relink');
	const result = await client.get({ owner: CHAR, path: JOURNAL });
	assert.deepEqual({ outcome: result.outcome, code: result.code }, { outcome: 'auth', code: 'relink' });
	assert.equal(fetch.calls.length, 0);
	tokens.failWith = new Error('connect ECONNRESET');
	const other = await client.get({ owner: CHAR, path: JOURNAL });
	assert.equal(other.outcome, 'error');
	assert.equal(other.kind, 'token');
	assert.equal(fetch.calls.length, 0);
});

test('a 403 or 404 is remembered only when the caller says so, and a 403 is asked again after a month', async (t) => {
	const structure = '/universe/structures/1028858195912';
	const { client, fetch, clock } = setup(t, [respond(403, { error: 'Forbidden' }), respond(403, { error: 'Forbidden' }), respond(404, { error: 'not found' }), respond(403, { error: 'Forbidden' }), respond(403, { error: 'Forbidden' })]);
	const plain = await client.get({ owner: CHAR, path: structure });
	assert.equal(plain.outcome, 'forbidden');
	assert.equal(plain.message, 'Forbidden');
	assert.equal((await client.get({ owner: CHAR, path: structure })).outcome, 'forbidden');
	assert.equal(fetch.calls.length, 2, 'not remembered: asked again');

	const missing = { owner: CHAR, path: '/universe/structures/2', rememberForbidden: true, rememberNotFound: true };
	assert.equal((await client.get(missing)).outcome, 'not-found');
	const again = await client.get(missing);
	assert.deepEqual({ outcome: again.outcome, cached: again.cached }, { outcome: 'not-found', cached: true });
	assert.equal(fetch.calls.length, 3, 'a remembered 404 is not asked again');

	const denied = { owner: CHAR, path: '/universe/structures/3', rememberForbidden: true };
	assert.equal((await client.get(denied)).outcome, 'forbidden');
	const cached = await client.get(denied);
	assert.deepEqual({ outcome: cached.outcome, cached: cached.cached }, { outcome: 'forbidden', cached: true });
	assert.equal(fetch.calls.length, 4);
	clock.advance(31 * 24 * 60 * 60 * 1000);
	assert.equal((await client.get(denied)).cached, undefined, 'a month on, it is asked again');
	assert.equal(fetch.calls.length, 5);
});

test('the legacy error limit under 20 pauses every call until its reset, and 420/429 until Retry-After', async (t) => {
	const clock0 = makeClock();
	const { client, fetch, clock } = setup(t, [
		respond(200, [1], { 'x-esi-error-limit-remain': '19', 'x-esi-error-limit-reset': '40', expires: expiresIn(clock0, 1) }),
		respond(200, [1], { 'x-esi-error-limit-remain': '100', 'x-esi-error-limit-reset': '60' }),
		respond(429, { error: 'slow' }, { 'retry-after': '120' }),
		respond(200, [1]),
	]);
	const orders = `/characters/${CHAR}/orders`;
	assert.equal((await client.get({ owner: CHAR, path: orders })).outcome, 'ok');
	const paused = await client.get({ owner: CHAR, path: `/characters/${CHAR}/orders/history` });
	assert.deepEqual({ outcome: paused.outcome, reason: paused.reason }, { outcome: 'paused', reason: 'error-limit' });
	assert.equal(fetch.calls.length, 1);

	clock.advance(41 * 1000);
	assert.equal((await client.get({ owner: CHAR, path: `/characters/${CHAR}/orders/history` })).outcome, 'ok');
	const limited = await client.get({ owner: CHAR, path: orders });
	assert.equal(limited.outcome, 'rate-limited');
	assert.equal(limited.retryAfter, 120);
	clock.advance(60 * 1000);
	assert.equal((await client.get({ owner: CHAR, path: '/universe/structures/9' })).outcome, 'paused');
	clock.advance(61 * 1000);
	assert.equal((await client.get({ owner: CHAR, path: '/universe/structures/9' })).outcome, 'ok');
});

test('a group under 20 percent pauses that group only, and the pause survives a restart', async (t) => {
	const { dataDir, client, fetch, clock, tokens } = setup(t, [
		respond(200, 5, { 'x-ratelimit-group': 'char-wallet', 'x-ratelimit-limit': '150/15m', 'x-ratelimit-remaining': '29' }),
		respond(200, [], { 'x-ratelimit-group': 'char-asset', 'x-ratelimit-limit': '1800/15m', 'x-ratelimit-remaining': '1700' }),
	]);
	assert.equal((await client.get({ owner: CHAR, path: `/characters/${CHAR}/wallet` })).outcome, 'ok');
	const wallet = await client.get({ owner: CHAR, path: JOURNAL });
	assert.deepEqual({ outcome: wallet.outcome, group: wallet.group, reason: wallet.reason }, { outcome: 'paused', group: 'char-wallet', reason: 'group' });
	assert.equal((await client.get({ owner: CHAR, path: `/characters/${CHAR}/assets` })).outcome, 'ok', 'another group is unaffected');
	assert.equal((await client.get({ owner: 90000002, path: `/characters/90000002/wallet` })).outcome, 'ok', 'and another character has its own bucket');

	client.flushLimits();
	const restarted = createEsiClient({ dataDir, fetch, now: clock, tokens });
	assert.equal(restarted.peek({ owner: CHAR, path: JOURNAL }), null, 'unaware until it loads the stored limits');
	restarted.loadLimits();
	assert.equal(restarted.peek({ owner: CHAR, path: JOURNAL }).outcome, 'paused');
	clock.advance(15 * 60 * 1000 + 1);
	assert.equal(restarted.peek({ owner: CHAR, path: JOURNAL }), null, 'the window has passed');
});

test('a flush keeps a pause another process stored after this one loaded, though this one saw the group later', async (t) => {
	const dataDir = tmpDataDir(t);
	const clock = makeClock();
	const group = { 'x-ratelimit-group': 'market-order', 'x-ratelimit-limit': '12000/15m' };
	const a = createEsiClient({ dataDir, now: clock, fetch: scripted([respond(200, [], { ...group, 'x-ratelimit-remaining': '9000' })]) }); // the server, mid-run
	const b = createEsiClient({ dataDir, now: clock, fetch: scripted([respond(429, { error: 'rate limited' }, { ...group, 'x-ratelimit-remaining': '0', 'retry-after': '600' })]) }); // the script
	const book = (typeId) => ({ owner: 'public', path: '/markets/10000043/orders', query: { type_id: typeId } });
	const stored = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'esi-cache', '_limits.json'), 'utf8')).groups['public|market-order'].pausedUntil;
	a.loadLimits();

	clock.advance(1000);
	const limited = await b.get(book(35));
	assert.equal(limited.outcome, 'rate-limited');
	b.flushLimits();
	assert.equal(stored(), limited.until);

	clock.advance(1000);
	assert.equal((await a.get(book(36))).outcome, 'ok');
	a.flushLimits();
	assert.equal(stored(), limited.until, 'the 429\'s pause is still in the file');
	a.loadLimits();
	assert.deepEqual(a.peek(book(37)), { slug: 'markets-10000043-orders-type-id-37', outcome: 'paused', reason: 'group', group: 'market-order', until: limited.until });
});

test('a flush keeps an error-limit pause another process stored, though this one saw a later reset', async (t) => {
	const dataDir = tmpDataDir(t);
	const clock = makeClock();
	const a = createEsiClient({ dataDir, now: clock, tokens: makeTokens(), fetch: scripted([respond(200, 5, { 'x-esi-error-limit-remain': '100', 'x-esi-error-limit-reset': '60' })]) });
	const b = createEsiClient({ dataDir, now: clock, tokens: makeTokens(), fetch: scripted([respond(420, { error: 'error limited' }, { 'retry-after': '30' })]) });
	const stored = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'esi-cache', '_limits.json'), 'utf8')).errorLimit;
	a.loadLimits();

	clock.advance(1000);
	const limited = await b.get({ owner: CHAR, path: `/characters/${CHAR}/wallet` });
	assert.equal(limited.outcome, 'rate-limited');
	b.flushLimits();

	clock.advance(1000);
	assert.equal((await a.get({ owner: CHAR, path: `/characters/${CHAR}/wallet` })).outcome, 'ok');
	a.flushLimits();
	assert.deepEqual(stored(), { remain: 100, resetAt: clock() + 60 * 1000, pausedUntil: limited.until }, 'the newer reset, and the 420\'s pause');
	a.loadLimits();
	assert.equal(a.peek({ owner: CHAR, path: `/characters/${CHAR}/assets` }).reason, 'error-limit');
});

test('network errors and unusable answers are reported, not thrown, and store nothing', async (t) => {
	const { dataDir, client } = setup(t, [
		() => { throw new TypeError('fetch failed'); },
		respond(500, { error: 'boom' }),
		() => new Response('<html>oops', { status: 200 }),
		respond(400, { error: 'bad request' }),
	]);
	const get = () => client.get({ owner: CHAR, path: JOURNAL });
	const network = await get();
	assert.deepEqual({ outcome: network.outcome, kind: network.kind }, { outcome: 'error', kind: 'network' });
	const server = await get();
	assert.deepEqual({ outcome: server.outcome, kind: server.kind, status: server.status }, { outcome: 'error', kind: 'server', status: 500 });
	const parse = await get();
	assert.deepEqual({ outcome: parse.outcome, kind: parse.kind }, { outcome: 'error', kind: 'parse' });
	const client4 = await get();
	assert.deepEqual({ outcome: client4.outcome, kind: client4.kind }, { outcome: 'error', kind: 'client' });
	assert.deepEqual(names(rawDir(dataDir, CHAR, 'wallet-journal')), []);
});

test('public routes go out without Authorization and land under raw/public', async (t) => {
	const { dataDir, client, fetch } = setup(t, [respond(200, [{ order_id: 1 }], { 'x-ratelimit-group': 'market-order', 'x-ratelimit-limit': '12000/15m', 'x-ratelimit-remaining': '11998' })]);
	const result = await client.get({ owner: 'public', path: '/markets/10000043/orders', query: { type_id: 34 } });
	assert.equal(result.outcome, 'ok');
	assert.equal(fetch.calls[0].url, 'https://esi.evetech.net/markets/10000043/orders?type_id=34');
	assert.equal(fetch.calls[0].headers.Authorization, undefined);
	assert.equal(names(rawDir(dataDir, 'public', 'markets-10000043-orders-type-id-34')).length, 1);
});

test('a public market answer is stored gzipped, and the next 200 is compared with it: the same body is not stored again', async (t) => {
	const clock0 = makeClock();
	const { dataDir, client, clock } = setup(t, [
		respond(200, [{ order_id: 1, price: 10 }], { expires: expiresIn(clock0, 100) }),
		respond(200, [{ order_id: 1, price: 10 }], { expires: expiresIn(clock0, 5000) }),
		respond(200, [{ order_id: 1, price: 9 }], { expires: expiresIn(clock0, 9000) }),
	]);
	const dir = rawDir(dataDir, 'public', 'markets-10000043-orders-type-id-34');
	const get = () => client.get({ owner: 'public', path: '/markets/10000043/orders', query: { type_id: 34 } });
	assert.equal((await get()).stored, true);
	assert.deepEqual(names(dir), ['2026-11-20T12-00-00-000Z.json.gz']);
	assert.equal(mode(path.join(dir, names(dir)[0])), 0o600);
	clock.advance(200 * 1000);
	assert.equal((await get()).stored, false, 'read back from the gzipped file and found equal');
	clock.advance(6000 * 1000);
	assert.equal((await get()).stored, true);
	assert.equal(names(dir).length, 2);
	assert.ok(names(dir).every(name => name.endsWith('.json.gz')));
});
