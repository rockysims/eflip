#!/usr/bin/env node
// scripts/sync.js: one sync from the command line, without the server. It runs the same lib/sync.js
// against the same data directory and token store the server uses (a lock per character keeps the
// two from syncing the same character at once, and the token store re-reads its file on every
// call, so a refresh token rotated by either is seen by the other). Suitable for a launchd job.
//
//   node scripts/sync.js                    every linked character, then the destination market
//   node scripts/sync.js --character 123    only that character (repeatable)
//   node scripts/sync.js --no-market        skip the market snapshot
//   node scripts/sync.js --market-only      only the market snapshot
//   node scripts/sync.js --region 10000043  snapshot that region's market (repeatable)
//   node scripts/sync.js --rebuild          rebuild data/ledger/ from data/raw/; no ESI, no credentials
//
// Always syncs (the page's "more than an hour ago" test is the server's business), but every route
// still honours its Expires, so a run inside the cache windows makes no call.
// Reads the same .env as the server (EVE_CLIENT_ID, EVE_CLIENT_SECRET, EVE_CALLBACK_URL,
// ESI_USER_AGENT, ESI_COMPAT_DATE, EFLIP_DATA_DIR).
// Prints one block per character and one for the market: calls made, 304s, rows added, tokens left.
// Exit code: 0 everything synced (or nothing was due), 1 a sync failed or stopped early, 2 usage or
// configuration error.
const path = require('path');
const { createSso } = require('../lib/sso');
const { createTokenStore, DEFAULT_DATA_DIR } = require('../lib/tokenStore');
const { createTokenManager } = require('../lib/tokens');
const { createSyncService } = require('../lib/sync');
const derive = require('../lib/derive');

const DEFAULT_CALLBACK_URL = 'http://localhost:5001/sso/callback';
const DEFAULT_USER_AGENT = 'eflip (local)';

const USAGE = `usage: node scripts/sync.js [--character <id>]... [--region <id>]... [--no-market | --market-only] [--max-types <n>] [--rebuild]`;

class UsageError extends Error {}

const positiveId = (text, flag) => {
	if (!/^\d{1,15}$/.test(text || '') || Number(text) <= 0) throw new UsageError(`${flag} needs a positive id, got ${JSON.stringify(text)}`);
	return Number(text);
};

const parseArgs = (argv) => {
	const options = { characterIds: null, regionIds: null, market: true, marketOnly: false, rebuild: false, help: false, maxTypes: undefined };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--help' || arg === '-h') options.help = true;
		else if (arg === '--rebuild') options.rebuild = true;
		else if (arg === '--no-market') options.market = false;
		else if (arg === '--market-only') options.marketOnly = true;
		else if (arg === '--character') (options.characterIds = options.characterIds || []).push(positiveId(argv[++i], arg));
		else if (arg === '--region') (options.regionIds = options.regionIds || []).push(positiveId(argv[++i], arg));
		else if (arg === '--max-types') options.maxTypes = positiveId(argv[++i], arg);
		else throw new UsageError(`unknown argument ${JSON.stringify(arg)}`);
	}
	if (options.marketOnly && !options.market) throw new UsageError('--market-only and --no-market contradict each other');
	return options;
};

const pad = (value, width) => String(value).padStart(width);

const rateText = (rate) => {
	if (!rate) return '-';
	if (rate.group && Number.isFinite(rate.remaining)) return `${rate.group} ${rate.remaining}${rate.limit ? `/${rate.limit}` : ''}`;
	if (Number.isFinite(rate.errorLimitRemain)) return `error limit ${rate.errorLimitRemain}`;
	return rate.group || '-';
};

const routeTable = (routes) => {
	const names = Object.keys(routes);
	if (names.length === 0) return ['  (nothing to do)'];
	const width = Math.max(5, ...names.map(name => name.length));
	const lines = [`  ${'route'.padEnd(width)}  calls  304  not due  stored  new rows  tokens left`];
	for (const name of names) {
		const t = routes[name];
		lines.push(`  ${name.padEnd(width)}  ${pad(t.calls, 5)}  ${pad(t.notModified, 3)}  ${pad(t.notDue, 7)}  ${pad(t.stored, 6)}  ${pad(t.rowsAdded || 0, 8)}  ${rateText(t.rate)}`);
	}
	return lines;
};

const stopText = (stop) => {
	if (!stop) return null;
	const retry = stop.retryAfter ? `, retry after ${stop.retryAfter} s` : '';
	return `stopped: ${stop.reason}${stop.message ? ` (${stop.message})` : ''}${retry}`;
};

// The text a run prints; also what the tests read.
const formatSummary = (result) => {
	const lines = [];
	for (const c of result.characters || []) {
		const who = `${c.name || 'character'} (${c.characterId})`;
		if (c.status === 'skipped' || c.status === 'busy' || c.status === 'relink' || (c.status === 'failed' && !c.routes)) {
			lines.push(`${who}: ${c.status}${c.reason ? ` - ${c.reason}` : ''}`);
			continue;
		}
		lines.push(`${who}: ${c.status}, synced ${c.syncedAt}, ${c.calls} calls, ${c.notModified} not modified, ${c.stored} stored`);
		lines.push(...routeTable(c.routes));
		lines.push(`  snapshot: ${c.snapshot}`);
		const stop = stopText(c.stop);
		if (stop) lines.push(`  ${stop}`);
		if (c.missingScopes && c.missingScopes.length > 0) lines.push(`  missing scopes (re-link to grant): ${c.missingScopes.join(', ')}`);
		if (c.structuresForbidden) lines.push(`  structures without docking access: ${c.structuresForbidden}`);
		if (c.itemsPending) lines.push(`  contract items left for the next sync: ${c.itemsPending}`);
		for (const [group, until] of Object.entries(c.pausedGroups || {})) lines.push(`  paused: ${group} until ${new Date(until).toISOString()}`);
		for (const e of c.errors || []) lines.push(`  error: ${e.route}${e.status ? ` ${e.status}` : ''} ${e.message}`.trimEnd());
	}
	const m = result.market;
	if (m) {
		if (m.status === 'skipped' || m.status === 'busy') {
			lines.push(`market: ${m.status}${m.reason ? ` - ${m.reason}` : ''}`);
		} else {
			lines.push(`market (region ${m.regionIds.join(', ')}): ${m.status}, ${m.types} of ${m.candidates} types${m.capped ? ' (capped)' : ''}${m.truncated ? `, ${m.truncated} long books cut short` : ''}, ${m.calls} calls, ${m.notModified} not modified, ${m.stored} stored`);
			lines.push(...routeTable(m.routes));
			const stop = stopText(m.stop);
			if (stop) lines.push(`  ${stop}`);
			for (const e of m.errors || []) lines.push(`  error: ${e.route}${e.status ? ` ${e.status}` : ''} ${e.message}`.trimEnd());
		}
	}
	return lines.join('\n');
};

// Did anything fail or stop early? ('skipped' is not a failure: nothing was asked of it.)
const hasFailure = (result) => {
	const bad = (status) => status === 'failed' || status === 'partial' || status === 'busy' || status === 'relink';
	return (result.characters || []).some(c => bad(c.status)) || Boolean(result.market && bad(result.market.status));
};

// deps (all optional, for tests): env, fetch, now, out, err, dataDir, tokens (replaces the token
// manager, so a test needs no SSO round trip).
const main = async (argv, deps = {}) => {
	const {
		env = process.env,
		fetch = globalThis.fetch,
		now = () => Date.now(),
		out = (text) => console.log(text),
		err = (text) => console.error(text),
	} = deps;

	let options;
	try {
		options = parseArgs(argv);
	} catch (e) {
		if (!(e instanceof UsageError)) throw e;
		err(`${e.message}\n${USAGE}`);
		return 2;
	}
	if (options.help) {
		out(USAGE);
		return 0;
	}
	const dataDir = path.resolve(deps.dataDir || env.EFLIP_DATA_DIR || DEFAULT_DATA_DIR);
	const log = { info: () => {}, warn: (line) => err(line) };

	if (options.rebuild) {
		try {
			const result = derive.rebuildAll({ dataDir, log });
			for (const [id, counts] of Object.entries(result.characters)) {
				out(counts.skipped ? `${id}: skipped (${counts.skipped})` : `${id}: ${counts.transactions} transactions, ${counts.journal} journal rows, ${counts.ordersHistory} orders, ${counts.contracts} contracts, ${counts.contractItems} contract item lists, ${counts.snapshots} snapshots`);
			}
			out(`structures: ${result.structures === null ? 'none in raw' : result.structures}`);
			return 0;
		} catch (e) {
			err(`rebuild failed: ${e.message}`);
			return 1;
		}
	}

	const clientId = env.EVE_CLIENT_ID || '';
	const clientSecret = env.EVE_CLIENT_SECRET || '';
	if (!clientId || !clientSecret) {
		err('not configured: set EVE_CLIENT_ID and EVE_CLIENT_SECRET in .env (see .env.example)');
		return 2;
	}
	const userAgent = env.ESI_USER_AGENT || DEFAULT_USER_AGENT;
	const store = createTokenStore({ dataDir });
	const sso = createSso({ clientId, clientSecret, callbackUrl: env.EVE_CALLBACK_URL || DEFAULT_CALLBACK_URL, userAgent, fetch, now });
	const tokens = deps.tokens || createTokenManager({ sso, store, now });
	const service = createSyncService({ dataDir, fetch, now, log, userAgent, compatDate: env.ESI_COMPAT_DATE || undefined, tokenStore: store, tokens });

	let linked;
	try {
		linked = store.list();
	} catch (e) {
		err(`token store unreadable: ${e.message}`);
		return 1;
	}
	if (linked.length === 0 && options.characterIds === null) {
		err('no linked characters: link one at /sso/login first');
		return 2;
	}
	const unknown = (options.characterIds || []).filter(id => !linked.some(record => record.characterId === id));
	if (unknown.length > 0) {
		err(`not linked: ${unknown.join(', ')}`);
		return 2;
	}

	let result;
	try {
		result = await service.syncAll({
			characterIds: options.marketOnly ? [] : options.characterIds,
			force: true,
			market: options.market,
			regionIds: options.regionIds,
			maxTypes: options.maxTypes,
		});
	} catch (e) {
		err(`sync failed: ${e.message}`);
		return 1;
	}
	out(formatSummary(result));
	return hasFailure(result) ? 1 : 0;
};

if (require.main === module) {
	require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(e) => {
			console.error(`sync failed: ${e && e.message}`);
			process.exit(1);
		},
	);
}

module.exports = { main, parseArgs, formatSummary, hasFailure, UsageError };
