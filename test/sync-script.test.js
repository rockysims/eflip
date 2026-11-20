const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { main, parseArgs, formatSummary, UsageError } = require('../scripts/sync');
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
	assert.deepEqual(parseArgs([]), { characterIds: null, regionIds: null, market: true, marketOnly: false, rebuild: false, help: false, maxTypes: undefined });
	const full = parseArgs(['--character', '1', '--character', '2', '--region', '10000043', '--no-market', '--max-types', '50']);
	assert.deepEqual([full.characterIds, full.regionIds, full.market, full.maxTypes], [[1, 2], [10000043], false, 50]);
	assert.equal(parseArgs(['--market-only']).marketOnly, true);
	assert.equal(parseArgs(['--rebuild']).rebuild, true);
	for (const bad of [['--bogus'], ['--character'], ['--character', 'abc'], ['--character', '0'], ['--market-only', '--no-market'], ['--region', '-3']]) {
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
