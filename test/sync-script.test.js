const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { main, parseArgs, formatSummary, formatWatch, formatRegionBook, formatRegionBookReport, formatStorage, hasFailure, watchFailed, UsageError } = require('../scripts/sync');
const { acquireLock, createRawStore } = require('../lib/dataFiles');
const { createTokenStore } = require('../lib/tokenStore');
const {
	ALL_SCOPES, makeClock, tmpDataDir, makeTokens, createFakeEsi,
	tx, journalRow, order, asset, contract, contractItem,
} = require('../test-support/esi-fake');

// scripts/sync.js run without the server: the same modules and data directory, a stubbed ESI.

const IVAN = 90000001;
const HOUR = 60 * 60 * 1000;
const ENV = { EVE_CLIENT_ID: 'client-id', EVE_CLIENT_SECRET: 'client-secret', ESI_USER_AGENT: 'eflip-test/1.0' };

const setup = (t, { link = true } = {}) => {
	const dataDir = tmpDataDir(t);
	const clock = makeClock();
	const fake = createFakeEsi({ now: clock });
	if (link) {
		createTokenStore({ dataDir }).upsert({ characterId: IVAN, name: 'Ivan Tester', ownerHash: 'o', scopes: ALL_SCOPES, refreshToken: 'secret-refresh', status: 'ok' });
		fake.character(IVAN, {
			transactions: [tx(6001), tx(6002, { is_buy: false })],
			journal: [journalRow(7001)],
			orders: [order(8001, { type_id: 35 })],
			assets: [asset(1, { type_id: 34 })],
			contracts: [contract(9001, { type: 'courier' })],
			contractItems: { 9001: [contractItem(1, 34, 3)] },
		});
	}
	const lines = [];
	const errors = [];
	const run = (argv, { env = ENV, tokens = makeTokens() } = {}) => main(argv, {
		env, dataDir, fetch: fake.fetch, now: clock, tokens, out: (text) => lines.push(text), err: (text) => errors.push(text),
	});
	return { dataDir, clock, fake, run, lines, errors };
};

test('arguments: characters and regions repeat, flags combine, mistakes are usage errors', () => {
	assert.deepEqual(parseArgs([]), { characterIds: null, regionIds: null, market: true, marketOnly: false, rebuild: false, rebuildBookLogs: false, watch: false, regionBook: false, regionBookReport: false, storage: false, storageReport: false, help: false, maxTypes: undefined });
	const full = parseArgs(['--character', '1', '--character', '2', '--region', '10000043', '--no-market', '--max-types', '50']);
	assert.deepEqual([full.characterIds, full.regionIds, full.market, full.maxTypes], [[1, 2], [10000043], false, 50]);
	assert.equal(parseArgs(['--market-only']).marketOnly, true);
	assert.equal(parseArgs(['--rebuild']).rebuild, true);
	assert.deepEqual([parseArgs(['--rebuild-book-logs']).rebuild, parseArgs(['--rebuild-book-logs']).rebuildBookLogs], [false, true]);
	assert.deepEqual([parseArgs(['--rebuild', '--rebuild-book-logs']).rebuild, parseArgs(['--rebuild', '--rebuild-book-logs']).rebuildBookLogs], [true, true]);
	for (const bad of [['--watch', '--rebuild-book-logs'], ['--region-book', '--rebuild-book-logs'], ['--storage', '--rebuild-book-logs'], ['--region-book-report', '--rebuild-book-logs']]) {
		assert.throws(() => parseArgs(bad), UsageError, bad.join(' '));
	}
	const watch = parseArgs(['--watch', '--character', '1', '--region', '10000043']);
	assert.deepEqual([watch.watch, watch.characterIds, watch.regionIds], [true, [1], [10000043]], '--watch goes with --character and --region');
	for (const bad of [['--bogus'], ['--character'], ['--character', 'abc'], ['--character', '0'], ['--market-only', '--no-market'], ['--region', '-3'], ['--watch', '--rebuild'], ['--watch', '--market-only'], ['--watch', '--no-market'], ['--watch', '--max-types', '5']]) {
		assert.throws(() => parseArgs(bad), UsageError, bad.join(' '));
	}
});

test('a run syncs every linked character and prints calls, 304s, rows added and tokens left', async (t) => {
	const ctx = setup(t);
	const code = await ctx.run([]);
	assert.equal(code, 0, ctx.errors.join('\n'));
	const text = ctx.lines.join('\n');
	assert.match(text, /^Ivan Tester \(90000001\): ok, synced 2026-11-20T12:00:00\.000Z, \d+ calls, 0 not modified, \d+ stored/);
	assert.match(text, /route\s+calls\s+304\s+not due\s+stored\s+new rows\s+tokens left/);
	assert.match(text, /transactions\s+1\s+0\s+0\s+1\s+2\s+char-wallet 148\/150/);
	assert.match(text, /journal\s+1\s+0\s+0\s+1\s+1\s+char-wallet 146\/150/);
	assert.match(text, /contractItems\s+1\s+0\s+0\s+1\s+1\s+char-contract/);
	assert.match(text, /orders\s+1\s+0\s+0\s+1\s+0\s+error limit 100/);
	assert.match(text, /snapshot: written/);
	assert.match(text, /market \(region 10000043\): ok/);
	assert.match(text, /marketOrders\s+\d+\s+0\s+0\s+\d+\s+0\s+market-order/);
	assert.ok(!text.includes('secret-refresh') && !text.includes('token-'));
	assert.deepEqual(ctx.errors, []);
});

test('a second run inside the cache windows makes no call and still exits 0', async (t) => {
	const ctx = setup(t);
	await ctx.run([]);
	const calls = ctx.fake.calls.length;
	ctx.lines.length = 0;
	ctx.clock.advance(30 * 1000);
	assert.equal(await ctx.run([]), 0);
	assert.equal(ctx.fake.calls.length, calls);
	assert.match(ctx.lines.join('\n'), /Ivan Tester \(90000001\): ok, synced .*, 0 calls, 0 not modified, 0 stored/);

	// after Expires: 304s
	ctx.lines.length = 0;
	ctx.clock.advance(2 * HOUR);
	assert.equal(await ctx.run(['--no-market']), 0);
	assert.match(ctx.lines.join('\n'), /, 7 calls, 7 not modified, 0 stored/);
});

test('--no-market, --market-only and --character pick what runs', async (t) => {
	const ctx = setup(t);
	assert.equal(await ctx.run(['--no-market']), 0);
	assert.equal(ctx.fake.callsTo(/markets/).length, 0);
	assert.ok(!ctx.lines.join('\n').includes('market ('));
	ctx.fake.reset();
	ctx.lines.length = 0;
	assert.equal(await ctx.run(['--market-only']), 0);
	assert.ok(ctx.fake.calls.every(call => call.path.startsWith('/markets/')));
	assert.ok(!ctx.lines.join('\n').includes('Ivan Tester'));
	ctx.fake.reset();
	assert.equal(await ctx.run(['--character', String(IVAN), '--no-market']), 0);
	assert.equal(await ctx.run(['--character', '4242']), 2);
	assert.match(ctx.errors.join('\n'), /not linked: 4242/);
});

test('a failed sync exits non-zero and says why', async (t) => {
	const ctx = setup(t);
	ctx.fake.character(IVAN).rejectToken = true;
	assert.equal(await ctx.run([]), 1);
	assert.match(ctx.lines.join('\n'), /Ivan Tester \(90000001\): failed/);
	assert.match(ctx.lines.join('\n'), /stopped: unauthorized/);

	// a rate-limit stop is a partial sync: non-zero too
	const limited = setup(t);
	limited.fake.errorLimitRemain = 5;
	assert.equal(await limited.run(['--no-market']), 1);
	assert.match(limited.lines.join('\n'), /partial/);
	assert.match(limited.lines.join('\n'), /stopped: error-limit/);
});

test('a character that needs re-linking is reported and exits non-zero', async (t) => {
	const ctx = setup(t);
	createTokenStore({ dataDir: ctx.dataDir }).setStatus(IVAN, 'relink', 'invalid_grant');
	assert.equal(await ctx.run([]), 1);
	assert.match(ctx.lines.join('\n'), /Ivan Tester \(90000001\): relink - invalid_grant/);
	assert.equal(ctx.fake.calls.length, 0);
});

test('configuration problems exit 2 before any ESI call', async (t) => {
	const ctx = setup(t);
	assert.equal(await ctx.run([], { env: {} }), 2);
	assert.match(ctx.errors.join('\n'), /not configured/);
	const empty = setup(t, { link: false });
	assert.equal(await empty.run([]), 2);
	assert.match(empty.errors.join('\n'), /no linked characters/);
	assert.equal(await empty.run(['--bogus']), 2);
	assert.match(empty.errors.join('\n'), /unknown argument/);
	assert.equal(await empty.run(['--help']), 0);
	assert.match(empty.lines.join('\n'), /usage: node scripts\/sync\.js/);
	assert.equal(ctx.fake.calls.length + empty.fake.calls.length, 0);
});

test('--rebuild re-derives the ledger from raw with no credentials and no ESI call', async (t) => {
	const ctx = setup(t);
	await ctx.run(['--no-market']);
	const ledgerFile = path.join(ctx.dataDir, 'ledger', String(IVAN), 'transactions.json');
	const before = fs.readFileSync(ledgerFile, 'utf8');
	fs.rmSync(path.join(ctx.dataDir, 'ledger'), { recursive: true });
	ctx.fake.reset();
	ctx.lines.length = 0;
	assert.equal(await ctx.run(['--rebuild'], { env: {} }), 0);
	assert.equal(ctx.fake.calls.length, 0);
	assert.equal(fs.readFileSync(ledgerFile, 'utf8'), before);
	assert.match(ctx.lines.join('\n'), /90000001: 2 transactions, 1 journal rows/);
});

// ---- --watch

const REGION = 10000043;
const bookOrder = (id, typeId, price) => ({ order_id: id, type_id: typeId, price, is_buy_order: false, volume_remain: 5, volume_total: 10, issued: '2026-11-18T10:00:00Z', duration: 90, range: 'region', location_id: 60008494, system_id: 30002187, min_volume: 1 });

test('--watch runs one tick, prints each character and each type, and a second run inside the cache windows makes no call', async (t) => {
	const ctx = setup(t);
	ctx.fake.market.orders.set(`${REGION}:35`, [bookOrder(8001, 35, 1000)]);
	const code = await ctx.run(['--watch', '--region', String(REGION)]);
	assert.equal(code, 0, ctx.errors.join('\n'));
	const text = ctx.lines.join('\n');
	assert.match(text, /^watch tick 2026-11-20T12:00:00\.000Z/);
	assert.match(text, /Ivan Tester \(90000001\): ok, orders stored, 1 open sell orders/);
	assert.match(text, /market \(region 10000043\): ok, 1 types, 2 calls/);
	assert.match(text, /type 35: book stored, history stored/);
	assert.deepEqual(ctx.fake.calls.map(call => call.path), [`/characters/${IVAN}/orders`, `/markets/${REGION}/orders`, `/markets/${REGION}/history`], 'no wallet, no journal, no assets: just the watch');
	assert.ok(!text.includes('secret-refresh') && !text.includes('token-'));
	assert.deepEqual(ctx.errors, []);
	assert.ok(fs.existsSync(path.join(ctx.dataDir, 'ledger', String(IVAN), 'order-log.json')));
	assert.ok(fs.existsSync(path.join(ctx.dataDir, 'ledger', 'market', String(REGION), '35.json.gz')));
	assert.ok(fs.existsSync(path.join(ctx.dataDir, 'esi-cache', 'public', '_watch.json')));

	ctx.fake.reset();
	ctx.lines.length = 0;
	ctx.clock.advance(60 * 1000);
	assert.equal(await ctx.run(['--watch', '--region', String(REGION)]), 0);
	assert.equal(ctx.fake.calls.length, 0);
	assert.match(ctx.lines.join('\n'), /orders not-due/);
	assert.match(ctx.lines.join('\n'), /type 35: book not-due, history not-due/);

	// the hourly sync that follows is unaffected
	ctx.fake.reset();
	assert.equal(await ctx.run(['--no-market']), 0);
	assert.match(ctx.lines.join('\n'), /snapshot: written/);
});

test('--watch takes --character, and knows what it cannot do', async (t) => {
	const ctx = setup(t);
	assert.equal(await ctx.run(['--watch', '--character', '4242']), 2);
	assert.match(ctx.errors.join('\n'), /not linked: 4242/);
	assert.equal(await ctx.run(['--watch', '--rebuild']), 2);
	assert.match(ctx.errors.join('\n'), /--watch and --rebuild contradict each other/);
	assert.equal(await ctx.run(['--watch', '--no-market']), 2);
	assert.equal(ctx.fake.calls.length, 0);
	assert.equal(await ctx.run(['--watch', '--character', String(IVAN)]), 0, 'no destination region yet is a skipped market step, not a failure');
	assert.match(ctx.lines.join('\n'), /market: skipped - no destination region/);
	assert.equal(await ctx.run(['--watch'], { env: {} }), 2);
	assert.match(ctx.errors.join('\n'), /not configured/);
});

test('--watch exits 1 when a character failed or a stop ended it, and 0 when the market lock is merely busy', async (t) => {
	const failing = setup(t);
	failing.fake.character(IVAN).rejectToken = true;
	assert.equal(await failing.run(['--watch', '--region', String(REGION)]), 1);
	assert.match(failing.lines.join('\n'), /Ivan Tester \(90000001\): failed - .*, orders auth/);
	assert.equal(failing.fake.calls.length, 1, 'a 401 is not retried');

	const limited = setup(t);
	limited.fake.errorLimitRemain = 5;
	assert.equal(await limited.run(['--watch', '--region', String(REGION)]), 1, 'the error limit stops the tick');
	assert.match(limited.lines.join('\n'), /stopped: error-limit/);

	const busy = setup(t);
	busy.fake.market.orders.set(`${REGION}:35`, [bookOrder(8001, 35, 1000)]);
	const release = acquireLock(busy.dataDir, 'market');
	assert.equal(await busy.run(['--watch', '--region', String(REGION)]), 0);
	release();
	assert.match(busy.lines.join('\n'), /market: busy - another market sync is running/);
	assert.equal(busy.fake.callsTo(/markets/).length, 0);
});

test('formatWatch and watchFailed read a tick', () => {
	const tick = {
		tickedAt: 'T',
		characters: { 1: { name: 'A', status: 'ok', orders: 'not-modified', openSellOrders: 3 }, 2: { name: 'B', status: 'busy', reason: 'another sync is running for this character' }, 3: { status: 'skipped', reason: 'the tick stopped (error-limit)' } },
		market: { status: 'partial', regionIds: [10000043], calls: 3, truncated: 1, types: [{ typeId: 35, outcome: 'stored', pages: 3, history: 'stored' }, { typeId: 36, outcome: 'paused', pages: 1, history: null }], errors: [{ route: 'marketOrders', status: 500, message: 'boom' }] },
		stop: { reason: 'paused', until: 5, group: 'market-order' },
	};
	const text = formatWatch(tick);
	assert.match(text, /A \(1\): ok, orders not-modified, 3 open sell orders/);
	assert.match(text, /B \(2\): busy - another sync is running/);
	assert.match(text, /character \(3\): skipped - the tick stopped/);
	assert.match(text, /market \(region 10000043\): partial, 2 types, 3 calls, 1 long books cut short/);
	assert.match(text, /type 35: book stored \(3 pages\), history stored/);
	assert.match(text, /type 36: book paused, history not asked/);
	assert.match(text, /error: marketOrders 500 boom/);
	assert.match(text, /stopped: paused/);
	assert.equal(watchFailed(tick), true);
	assert.equal(watchFailed({ characters: { 1: { status: 'ok' } }, market: { status: 'busy' }, stop: null }), false);
	assert.equal(watchFailed({ characters: { 1: { status: 'ok' } }, market: { status: 'skipped' }, stop: null }), false);
	assert.equal(watchFailed({ characters: { 1: { status: 'ok' } }, market: { status: 'partial' }, stop: null }), true);
});

test('--rebuild also rebuilds the order log and the book logs, and lists what the order log warns about', async (t) => {
	const ctx = setup(t);
	ctx.fake.market.orders.set(`${REGION}:35`, [bookOrder(8001, 35, 1000)]);
	await ctx.run(['--watch', '--region', String(REGION)]);
	const orderLog = path.join(ctx.dataDir, 'ledger', String(IVAN), 'order-log.json');
	const bookLog = path.join(ctx.dataDir, 'ledger', 'market', String(REGION), '35.json.gz');
	const texts = () => [fs.readFileSync(orderLog, 'utf8'), zlib.gunzipSync(fs.readFileSync(bookLog)).toString('utf8')];
	const before = texts();
	fs.rmSync(path.join(ctx.dataDir, 'ledger'), { recursive: true });
	ctx.lines.length = 0;
	assert.equal(await ctx.run(['--rebuild', '--rebuild-book-logs'], { env: {} }), 0);
	assert.deepEqual(texts(), before, 'both logs, byte for byte (the book log\'s text inside its gzip)');
	assert.match(ctx.lines.join('\n'), /90000001: .*, 1 logged orders/);
	assert.match(ctx.lines.join('\n'), /^book logs: 1$/m);
	assert.ok(!/warning:/.test(ctx.lines.join('\n')));

	// a plain --rebuild leaves the book log alone and says how far back its raw reaches
	fs.rmSync(path.dirname(bookLog), { recursive: true });
	ctx.lines.length = 0;
	assert.equal(await ctx.run(['--rebuild'], { env: {} }), 0);
	assert.ok(!fs.existsSync(bookLog), 'not rebuilt');
	assert.match(ctx.lines.join('\n'), /90000001: .*, 1 logged orders/);
	assert.match(ctx.lines.join('\n'), /^book logs left as they are: raw reaches back to 2026-11-20 12:00 UTC \(the oldest per-type book\); pass --rebuild-book-logs to rebuild them from raw and lose what is older$/m);
	assert.ok(!/^book logs: /m.test(ctx.lines.join('\n')));

	// a raw answer in which an order's volume rose: recorded, and reported
	createRawStore({ dataDir: ctx.dataDir }).write(IVAN, 'orders', { fetchedAt: '2026-11-20T15:00:00.000Z', url: 'x', status: 200, headers: {}, body: [order(8001, { type_id: 35, volume_remain: 9 })] });
	ctx.lines.length = 0;
	assert.equal(await ctx.run(['--rebuild'], { env: {} }), 0);
	assert.match(ctx.lines.join('\n'), /warning: order 8001 volume-rise at 2026-11-20T15:00:00\.000Z \(5 -> 9\)/);
});

test('formatSummary handles skipped, busy and error cases', () => {
	const text = formatSummary({
		characters: [
			{ characterId: 1, name: 'A', status: 'skipped', reason: 'synced within the last hour' },
			{ characterId: 2, name: 'B', status: 'busy', reason: 'another sync is running for this character' },
			{ characterId: 3, name: 'C', status: 'partial', syncedAt: 'T', calls: 2, notModified: 1, stored: 1, routes: { journal: { calls: 2, notModified: 1, notDue: 0, stored: 1, rowsAdded: 4, rate: { group: 'char-wallet', limit: 150, remaining: 10 } } }, snapshot: 'skipped', stop: { reason: 'rate-limited', retryAfter: 90, message: 'orders: 429' }, errors: [{ route: 'assets', status: 500, message: 'boom' }], missingScopes: ['esi-skills.read_skills.v1'], pausedGroups: { 'char-wallet': 0 }, structuresForbidden: 2, itemsPending: 5 },
		],
		market: { status: 'skipped', reason: 'no destination region known yet' },
	});
	assert.match(text, /A \(1\): skipped - synced within the last hour/);
	assert.match(text, /B \(2\): busy/);
	assert.match(text, /stopped: rate-limited \(orders: 429\), retry after 90 s/);
	assert.match(text, /error: assets 500 boom/);
	assert.match(text, /missing scopes \(re-link to grant\): esi-skills/);
	assert.match(text, /structures without docking access: 2/);
	assert.match(text, /contract items left for the next sync: 5/);
	assert.match(text, /market: skipped - no destination region known yet/);
});

test('run as a script it needs neither the server nor the network to say what is wrong', (t) => {
	const dataDir = tmpDataDir(t);
	const script = path.join(__dirname, '..', 'scripts', 'sync.js');
	// empty EVE_* values stay as they are: dotenv does not override a variable that is set
	const env = { ...process.env, EFLIP_DATA_DIR: dataDir, EVE_CLIENT_ID: '', EVE_CLIENT_SECRET: '' };
	const help = spawnSync(process.execPath, [script, '--help'], { env, encoding: 'utf8' });
	assert.equal(help.status, 0);
	assert.match(help.stdout, /usage: node scripts\/sync\.js/);
	const bare = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
	assert.equal(bare.status, 2);
	assert.match(bare.stderr, /not configured/);
	assert.ok(!fs.existsSync(path.join(dataDir, 'raw')), 'nothing was written');
});

// ---- --region-book and --region-book-report

const MINUTE = 60 * 1000;

test('arguments: --region-book takes one --region and nothing else, --region-book-report nothing', () => {
	const run = parseArgs(['--region-book', '--region', '10000043']);
	assert.deepEqual([run.regionBook, run.regionBookReport, run.regionIds], [true, false, [10000043]]);
	assert.equal(parseArgs(['--region-book']).regionIds, null);
	assert.equal(parseArgs(['--region-book-report']).regionBookReport, true);
	for (const bad of [
		['--region-book', '--region-book-report'], ['--region-book', '--rebuild'], ['--region-book', '--watch'], ['--region-book', '--market-only'], ['--region-book', '--no-market'],
		['--region-book', '--max-types', '5'], ['--region-book', '--character', '1'], ['--region-book', '--region', '1', '--region', '2'],
		['--region-book-report', '--region', '1'], ['--region-book-report', '--character', '1'], ['--region-book-report', '--rebuild'], ['--region-book-report', '--no-market'],
	]) {
		assert.throws(() => parseArgs(bad), UsageError, bad.join(' '));
	}
});

const regionBookRows = (typeIds, price = 100) => typeIds.map((typeId, i) => ({ order_id: typeId * 10 + i, type_id: typeId, price, is_buy_order: i % 2 === 1, volume_remain: 5, volume_total: 10, issued: '2026-11-18T10:00:00Z', duration: 90, range: 'region', location_id: 60008494, system_id: 30002187, min_volume: 1 }));

test('--region-book takes one snapshot of the whole region without the flag, prints what it cost, and a second run inside the cache folds nothing more', async (t) => {
	const ctx = setup(t);
	ctx.fake.pageSize = 2;
	ctx.fake.market.regionOrders.set(String(REGION), regionBookRows([34, 35, 36, 37, 38]));
	const code = await ctx.run(['--region-book', '--region', String(REGION)]);
	assert.equal(code, 0, ctx.errors.join('\n'));
	const text = ctx.lines.join('\n');
	assert.match(text, /^region book \(region 10000043\): ok, 3 of 3 pages, 3 calls \(0 not modified, 0 not due\), 6 tokens, 0\.0 MB of orders \(0\.0 MB written to raw\)$/m);
	assert.match(text, /^  snapshot 2026-11-20T12:00:00\.000Z: 5 orders, 5 types, 5 logs folded \(5 new, 0 with no orders left\), logs 0\.0 MB -> 0\.0 MB \(\+0\.0 MB\), 0\.0 s$/m);
	assert.match(text, /^  tokens left: market-order 11994\/12000$/m);
	assert.deepEqual(ctx.fake.calls.map(call => call.path), Array(3).fill(`/markets/${REGION}/orders`), 'nothing but the region pages: no character, no market');
	assert.ok(ctx.fake.calls.every(call => call.query.order_type === 'all'));
	assert.ok(fs.existsSync(path.join(ctx.dataDir, 'ledger', 'market', String(REGION), '38.json.gz')));
	assert.ok(!text.includes('secret-refresh') && !text.includes('token-'));
	assert.deepEqual(ctx.errors, []);

	ctx.fake.reset();
	ctx.lines.length = 0;
	ctx.clock.advance(MINUTE);
	assert.equal(await ctx.run(['--region-book', '--region', String(REGION)]), 0, 'a skip is not a failure');
	assert.equal(ctx.fake.calls.length, 0);
	assert.equal(ctx.lines.join('\n'), 'region book: skipped - this snapshot was folded already');
});

test('--region-book runs with no linked character when --region is given, exits 1 on a partial snapshot, and skips when there is nothing to snapshot', async (t) => {
	const ctx = setup(t, { link: false });
	ctx.fake.market.regionOrders.set(String(REGION), regionBookRows([34, 35]));
	assert.equal(await ctx.run(['--region-book']), 2, 'no linked characters and no region named');
	assert.match(ctx.errors.join('\n'), /no linked characters/);
	assert.equal(await ctx.run(['--region-book', '--region', String(REGION)]), 0, ctx.errors.join('\n'));
	assert.match(ctx.lines.join('\n'), /region book \(region 10000043\): ok/);

	const partial = setup(t);
	partial.fake.pageSize = 1;
	partial.fake.market.regionOrders.set(String(REGION), regionBookRows([34, 35]));
	partial.fake.respondWith = (call) => (call.query.page === '2' ? new Response('{}', { status: 500 }) : null);
	assert.equal(await partial.run(['--region-book', '--region', String(REGION)]), 1);
	assert.match(partial.lines.join('\n'), /region book \(region 10000043\): partial, 1 of 2 pages/);
	assert.match(partial.lines.join('\n'), /nothing folded/);
	assert.match(partial.lines.join('\n'), /stopped: page 2/);
	assert.match(partial.lines.join('\n'), /error: marketOrders 500 page 2/);

	const noRegion = setup(t);
	assert.equal(await noRegion.run(['--region-book']), 0, 'nothing known to snapshot is a skip');
	assert.match(noRegion.lines.join('\n'), /region book: skipped - no destination region known yet/);
});

test('the hourly sync of the script takes the region book after the market only with EFLIP_REGION_BOOK=1', async (t) => {
	const off = setup(t);
	off.fake.market.regionOrders.set(String(REGION), regionBookRows([35]));
	assert.equal(await off.run([]), 0, off.errors.join('\n'));
	assert.ok(!off.lines.join('\n').includes('region book'));
	assert.ok(off.fake.callsTo(/orders/).every(call => call.query.order_type === undefined));

	const on = setup(t);
	on.fake.market.regionOrders.set(String(REGION), regionBookRows([35]));
	assert.equal(await on.run([], { env: { ...ENV, EFLIP_REGION_BOOK: '1' } }), 0, on.errors.join('\n'));
	const text = on.lines.join('\n');
	assert.match(text, /market \(region 10000043\): ok/);
	assert.match(text, /region book \(region 10000043\): ok, 1 of 1 pages/);
	assert.ok(text.indexOf('market (region') < text.indexOf('region book ('), 'after the market');
});

test('formatRegionBook and hasFailure read the answers of a run', () => {
	assert.equal(formatRegionBook({ status: 'busy', reason: 'another market sync is running' }), 'region book: busy - another market sync is running');
	assert.equal(formatRegionBook({ status: 'deferred', reason: 'an export run is in progress' }), 'region book: deferred - an export run is in progress');
	const paused = formatRegionBook({ status: 'paused', reason: 'the market-order bucket is under 20 % left until X', regionId: 1, pagesRead: 1, pages: 194, calls: 1, notModified: 0, notDue: 0, tokensUsed: 2, rawBytes: 238000, rawBytesStored: 239000, typesFolded: 0, foldErrors: 0, elapsedMs: 1500, errors: [], limits: { groups: { 'public|market-order': { group: 'market-order', limit: 12000, remaining: 2000 } } } });
	assert.match(paused, /region book \(region 1\): paused, 1 of 194 pages, 1 calls \(0 not modified, 0 not due\), 2 tokens, 0\.2 MB of orders \(0\.2 MB written to raw\)/);
	assert.match(paused, /nothing folded, 1\.5 s/);
	assert.match(paused, /tokens left: market-order 2000\/12000/);
	assert.match(paused, /stopped: the market-order bucket is under 20 %/);
	const failed = (status) => hasFailure({ characters: [], market: null, regionBook: { status } });
	assert.deepEqual(['ok', 'skipped', 'deferred'].map(failed), [false, false, false]);
	assert.deepEqual(['partial', 'paused', 'busy', 'failed'].map(failed), [true, true, true, true]);
	assert.equal(hasFailure({ characters: [], market: null, regionBook: null }), false);
	assert.match(formatSummary({ characters: [], market: null, regionBook: { status: 'deferred', reason: 'an export run is in progress' } }), /region book: deferred/);
});

// A fixture public sync log: three snapshots inside the window, a partial one, one older than 24 hours and entries
// that are not the region book's.
const writeRegionBookFixture = (dataDir) => {
	const raw = createRawStore({ dataDir });
	const entry = (syncedAt, o) => ({ syncedAt, finishedAt: syncedAt, kind: 'regionBook', regionId: REGION, status: 'ok', partial: false, pages: 194, tokensUsed: 388, rawBytes: 46200000, rawBytesStored: 46500000, typesInSnapshot: 15012, typesFolded: 15012, logBytesBefore: 20000000, logBytesAfter: 21800000, elapsedMs: 71000, ...o });
	raw.writeSyncLog('public', entry('2026-11-19T11:00:00.000Z', { rawBytes: 99000000 })); // 25 hours before the report: outside the window
	raw.writeSyncLog('public', entry('2026-11-19T13:00:03.000Z', { logBytesBefore: 0, logBytesAfter: 21800000, elapsedMs: 94000 }));
	raw.writeSyncLog('public', { syncedAt: '2026-11-19T13:30:00.000Z', finishedAt: '2026-11-19T13:30:10.000Z', source: 'market', regionIds: [REGION], typeIds: [34], books: [] });
	raw.writeSyncLog('public', entry('2026-11-19T14:00:02.000Z', { logBytesBefore: 21800000, logBytesAfter: 23700000, elapsedMs: 71000 }));
	raw.writeSyncLog('public', entry('2026-11-19T15:00:01.000Z', { status: 'partial', partial: true, pagesRead: 100, tokensUsed: 200, rawBytes: 23800000, rawBytesStored: 24000000, typesInSnapshot: 0, typesFolded: 0, logBytesBefore: 23700000, logBytesAfter: 23700000, elapsedMs: 40000 }));
	raw.writeSyncLog('public', { syncedAt: '2026-11-19T16:00:00.000Z', finishedAt: '2026-11-19T16:00:10.000Z', source: 'watch', regionIds: [REGION], typeIds: [34], books: [] });
};

test('--region-book-report prints the last 24 hours of snapshots as a table with totals and hourly averages, with no credentials and no ESI call', async (t) => {
	const ctx = setup(t, { link: false });
	ctx.clock.set(Date.UTC(2026, 10, 20, 12, 0, 0));
	writeRegionBookFixture(ctx.dataDir);
	const code = await ctx.run(['--region-book-report'], { env: {} });
	assert.equal(code, 0, ctx.errors.join('\n'));
	assert.equal(ctx.fake.calls.length, 0);
	assert.equal(ctx.lines.join('\n'), [
		'region book, the last 24 hours up to 2026-11-20 12:00:00 UTC: 3 snapshots, 1 partial (region 10000043)',
		'  time (UTC)           status   pages  tokens  raw MB  types  log growth MB  elapsed',
		'  2026-11-19 13:00:03  ok         194     388    46.2  15012          +21.8     94 s',
		'  2026-11-19 14:00:02  ok         194     388    46.2  15012           +1.9     71 s',
		'  2026-11-19 15:00:01  partial    100     200    23.8      0           +0.0     40 s',
		'  total                           488     976   116.2                 +23.7    205 s',
		'  per hour (3.0 h)                163     325    38.7                  +7.9     68 s',
		'  written to raw (files, headers included): 117.0 MB, 39.0 MB per hour',
	].join('\n'));
	assert.deepEqual(ctx.errors, []);
	assert.ok(!fs.existsSync(path.join(ctx.dataDir, 'locks')), 'a read only: no lock taken');

	// a window with nothing in it says how to start
	ctx.lines.length = 0;
	ctx.clock.set(Date.UTC(2026, 10, 25, 12, 0, 0));
	assert.equal(await ctx.run(['--region-book-report'], { env: {} }), 0);
	assert.match(ctx.lines.join('\n'), /^region book, the last 24 hours up to 2026-11-25 12:00:00 UTC: no snapshots \(EFLIP_REGION_BOOK=1 takes one with each hourly sync; node scripts\/sync\.js --region-book takes one now\)$/);

	// no data directory at all
	const bare = setup(t, { link: false });
	assert.equal(await bare.run(['--region-book-report'], { env: {} }), 0);
	assert.match(bare.lines.join('\n'), /no snapshots/);
});

test('formatRegionBookReport averages over the hours the snapshots span, and copes with one snapshot', () => {
	const entry = (syncedAt, o = {}) => ({ syncedAt, kind: 'regionBook', regionId: 1, status: 'ok', partial: false, pages: 10, tokensUsed: 20, rawBytes: 2000000, typesInSnapshot: 100, logBytesBefore: 0, logBytesAfter: 1000000, elapsedMs: 5000, ...o });
	const one = formatRegionBookReport([entry('2026-11-20T10:00:00.000Z')], { now: Date.UTC(2026, 10, 20, 11, 0, 0) });
	assert.match(one, /: 1 snapshot \(region 1\)/);
	assert.match(one, /per hour \(1\.0 h\)\s+10\s+20\s+2\.0\s+\+1\.0\s+5 s/);
	assert.ok(!/written to raw/.test(one), 'only when the entries say it');
	// two snapshots ten hours apart: eleven hours of the window, a rate of a tenth less than one an hour
	const two = formatRegionBookReport([entry('2026-11-20T00:00:00.000Z'), entry('2026-11-20T10:00:00.000Z')], { now: Date.UTC(2026, 10, 20, 11, 0, 0) });
	assert.match(two, /total\s+20\s+40\s+4\.0\s+\+2\.0\s+10 s/);
	assert.match(two, /per hour \(11\.0 h\)\s+2\s+4\s+0\.4\s+\+0\.2\s+1 s/);
	// a log that shrank shows its sign
	assert.match(formatRegionBookReport([entry('2026-11-20T10:00:00.000Z', { logBytesBefore: 3000000, logBytesAfter: 1000000 })], { now: Date.UTC(2026, 10, 20, 11, 0, 0) }), /-2\.0/);
});

// ---- --storage and --storage-report

test('arguments: --storage and --storage-report take no other flag', () => {
	assert.equal(parseArgs(['--storage']).storage, true);
	assert.equal(parseArgs(['--storage-report']).storageReport, true);
	for (const bad of [
		['--storage', '--storage-report'], ['--storage', '--rebuild'], ['--storage', '--watch'], ['--storage', '--region-book'], ['--storage', '--region', '1'],
		['--storage', '--character', '1'], ['--storage', '--no-market'], ['--storage-report', '--market-only'], ['--storage-report', '--max-types', '3'], ['--storage-report', '--region-book-report'],
	]) {
		assert.throws(() => parseArgs(bad), UsageError, bad.join(' '));
	}
});

test('--storage runs the budget once with no credentials and no ESI call, printing each kind against its share and the last trim; --storage-report prints the last run without running', async (t) => {
	const ctx = setup(t);
	ctx.fake.pageSize = 2;
	ctx.fake.market.regionOrders.set(String(REGION), regionBookRows([34, 35, 36]));
	assert.equal(await ctx.run(['--region-book', '--region', String(REGION)]), 0, ctx.errors.join('\n'));
	ctx.clock.advance(HOUR);
	ctx.fake.market.regionOrders.set(String(REGION), regionBookRows([34, 35, 36], 99));
	assert.equal(await ctx.run(['--region-book', '--region', String(REGION)]), 0, ctx.errors.join('\n'));
	ctx.fake.reset();

	// nothing has run yet
	ctx.lines.length = 0;
	assert.equal(await ctx.run(['--storage-report'], { env: {} }), 0);
	assert.match(ctx.lines.join('\n'), /^storage \(last run\): no storage run yet/);

	// no budget: it measures and says so
	ctx.lines.length = 0;
	assert.equal(await ctx.run(['--storage'], { env: {} }), 0, ctx.errors.join('\n'));
	const bare = ctx.lines.join('\n');
	assert.match(bare, /^storage: no budget \(EFLIP_STORAGE_BUDGET is not set\), so nothing is trimmed$/m);
	assert.match(bare, /^  kind +on disk$/m);
	assert.match(bare, /^  regionPages +\d+(\.\d+)? (bytes|KB)$/m);
	assert.match(bare, /^  total +\d/m);

	// a budget the first snapshot's pages put over
	ctx.lines.length = 0;
	assert.equal(await ctx.run(['--storage'], { env: { EFLIP_STORAGE_BUDGET: '1' } }), 0, ctx.errors.join('\n'));
	const text = ctx.lines.join('\n');
	assert.match(text, /^storage: \d+ % of the 1 bytes budget used, measured 2026-11-20 13:00:00 UTC \(after a request\)$/m);
	assert.match(text, /^  kind +on disk +share +share of budget$/m);
	assert.match(text, /^  regionPages +\S+ (bytes|KB) +40 % +0 bytes$/m);
	assert.match(text, /^  bookLogs +\S+ (bytes|KB) +45 % +0 bytes$/m);
	assert.match(text, /^  trimmed \S+ (bytes|KB) to \S+ (bytes|KB)$/m);
	assert.match(text, /^  last trim 2026-11-20 13:00:00 UTC: regionPages 1 snapshot, \S+ (bytes|KB)$/m);
	assert.match(text, /^  over budget by \S+ (bytes|KB): nothing left to trim above the floors$/m);
	assert.equal(ctx.fake.calls.length, 0, 'no ESI call');

	// the report reads the last run back, and a run with nothing left to trim keeps the last trim
	ctx.clock.advance(MINUTE);
	ctx.lines.length = 0;
	assert.equal(await ctx.run(['--storage'], { env: { EFLIP_STORAGE_BUDGET: '1' } }), 0);
	assert.ok(!/^  trimmed /m.test(ctx.lines.join('\n')), 'nothing trimmed this time');
	assert.match(ctx.lines.join('\n'), /^  last trim 2026-11-20 13:00:00 UTC: regionPages 1 snapshot/m);
	ctx.lines.length = 0;
	assert.equal(await ctx.run(['--storage-report'], { env: {} }), 0);
	const report = ctx.lines.join('\n');
	assert.match(report, /^storage \(last run\): \d+ % of the 1 bytes budget used, measured 2026-11-20 13:01:00 UTC \(after a request\)$/m);
	assert.match(report, /^  last trim 2026-11-20 13:00:00 UTC: regionPages 1 snapshot/m);

	// the market lock held: busy, exit 1
	const release = acquireLock(ctx.dataDir, 'market');
	ctx.lines.length = 0;
	assert.equal(await ctx.run(['--storage'], { env: { EFLIP_STORAGE_BUDGET: '1' } }), 1);
	assert.equal(ctx.lines.join('\n'), 'storage: busy - another market sync is running');
	release();

	// a plain --rebuild leaves the book logs as they are and names the oldest raw behind them
	const logDir = path.join(ctx.dataDir, 'ledger', 'market', String(REGION));
	const logsBefore = fs.readdirSync(logDir).map(name => fs.readFileSync(path.join(logDir, name)).toString('base64'));
	ctx.lines.length = 0;
	assert.equal(await ctx.run(['--rebuild'], { env: {} }), 0);
	assert.deepEqual(ctx.lines, [
		'structures: none in raw',
		'book logs left as they are: raw reaches back to 2026-11-20 13:00 UTC (the oldest regional snapshot); pass --rebuild-book-logs to rebuild them from raw and lose what is older',
	]);
	assert.deepEqual(fs.readdirSync(logDir).map(name => fs.readFileSync(path.join(logDir, name)).toString('base64')), logsBefore);

	// --rebuild-book-logs rebuilds them, and says what it could not replay
	ctx.lines.length = 0;
	assert.equal(await ctx.run(['--rebuild-book-logs'], { env: {} }), 0);
	assert.deepEqual(ctx.lines, ['book logs: 3 (1 regional snapshot replayed)', '1 regional snapshot not replayed: pages trimmed'], 'the book logs alone: no character line');
});

test('formatStorage reads a run: the table against the shares, the trim per kind, unmet; formatSummary carries it', () => {
	const run = {
		status: 'ok', syncedAt: '2026-11-25T12:00:00.000Z', reason: 'regionBook', budgetBytes: 1e9,
		shares: { regionPages: 40, bookLogs: 45, typeBooks: 10, runContexts: 5 },
		usage: { regionPages: 380e6, bookLogs: 200e6, typeBooks: 30e6, runContexts: 10e6 },
		totalBefore: 640e6, totalAfter: 620e6, unmet: 0,
		trims: {
			regionPages: { pieces: 2, snapshots: 2, strayFiles: 0, files: 388, bytesFreed: 15.4e6 },
			bookLogs: { pieces: 120, cutoffAt: '2026-11-20T00:00:00.000Z', logs: 120, samplesDropped: 240, entriesDropped: 1000, ordersDropped: 30, bytesFreed: 4.6e6 },
			typeBooks: { pieces: 0, files: 0, bytesFreed: 0 },
			runContexts: { pieces: 1, runs: 1, bytesFreed: 2e5 },
		},
	};
	run.lastTrim = { at: run.syncedAt, trims: run.trims };
	assert.equal(formatStorage(run), [
		'storage: 62 % of the 1 GB budget used, measured 2026-11-25 12:00:00 UTC (after the region book)',
		'  kind         on disk  share  share of budget',
		'  regionPages   380 MB   40 %           400 MB',
		'  bookLogs      200 MB   45 %           450 MB',
		'  typeBooks      30 MB   10 %           100 MB',
		'  runContexts    10 MB    5 %            50 MB',
		'  total         620 MB',
		'  trimmed 640 MB to 620 MB',
		'  last trim 2026-11-25 12:00:00 UTC: regionPages 2 snapshots, 15.4 MB; bookLogs 120 logs cut before 2026-11-20 00:00:00 UTC (240 samples, 1000 path entries, 30 orders dropped), 4.6 MB; runContexts 1 run, 200 KB',
	].join('\n'));
	const over = formatStorage({ ...run, trims: {}, unmet: 25e6, lastTrim: null, reason: 'market' });
	assert.match(over, /\(after the market snapshot\)$/m);
	assert.match(over, /^  last trim: none yet$/m);
	assert.match(over, /^  over budget by 25 MB: nothing left to trim above the floors$/m);
	assert.equal(formatStorage({ status: 'failed', reason: 'disk on fire' }), 'storage: failed - disk on fire');
	assert.match(formatStorage({ status: 'no-budget', budgetBytes: null, error: 'storage shares: they add up to 110 %, more than 100', usage: run.usage }), /^storage: no budget \(EFLIP_STORAGE_BUDGET or EFLIP_STORAGE_SHARES did not parse: storage shares: they add up to 110 %, more than 100\), so nothing is trimmed/);
	assert.match(formatSummary({ characters: [], market: null, storage: run }), /^storage: 62 % of the 1 GB budget used/m);
	assert.equal(hasFailure({ characters: [], market: null, storage: run }), false);
	assert.equal(hasFailure({ characters: [], market: null, storage: { status: 'failed', reason: 'x' } }), true, 'a storage step that failed fails the run');
});
