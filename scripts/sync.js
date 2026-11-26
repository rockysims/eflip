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
//   node scripts/sync.js --rebuild          rebuild the character ledgers (and structure names) from
//                                           data/raw/; no ESI, no credentials. The book logs are left
//                                           as they are: once the storage budget has trimmed raw, the
//                                           live logs hold history raw no longer does, and a rebuild
//                                           would lose it. It says how far back their raw reaches.
//   node scripts/sync.js --rebuild-book-logs   rebuild the book logs from raw too (alone, or with
//                                           --rebuild): per-type checks and regional snapshots replayed
//                                           in time order; history older than the raw left is lost.
//   node scripts/sync.js --watch            one watch refresh: our open orders, then the book and history
//                                           of each type we have listed (what the orders page does every
//                                           five minutes; optional here, for a launchd job while the game
//                                           is open on a machine where the page is not). Takes --character
//                                           and --region; contradicts --rebuild, --market-only,
//                                           --no-market and --max-types. With EFLIP_REGION_BOOK=1 the
//                                           tick is followed by the hourly destination book: the
//                                           snapshot is taken on the first tick that finds the last
//                                           one 55 minutes old (the job's own rule), so a launchd job
//                                           that runs --watch every five minutes keeps it hourly.
//                                           One line says whether it is on.
//   node scripts/sync.js --region-book      one snapshot of the destination region's whole order book
//                                           (every type, buy and sell), folded into the per-type book
//                                           logs, and what it cost: pages, market-order tokens, raw
//                                           bytes, log growth, time. Takes --region (one); no other
//                                           flag. The server runs the same job hourly while it is up
//                                           when EFLIP_REGION_BOOK=1 (and with each full sync).
//   node scripts/sync.js --region-book-report   the regionBook entries of the last 24 hours from the
//                                           public sync log as a table, with totals and per-hour
//                                           averages (the measurement behind the retention rule). No
//                                           ESI, no credentials, no other flag.
//   node scripts/sync.js --storage          one run of the storage budget (EFLIP_STORAGE_BUDGET,
//                                           EFLIP_STORAGE_SHARES; lib/storage.js): trims what is over,
//                                           then prints the budget, each kind's bytes against its share,
//                                           the share of the budget used and the last trim. Without a
//                                           budget it only measures. No ESI, no credentials, no other flag.
//   node scripts/sync.js --storage-report   the same from the last storage run, without running one.
//
// Always syncs (the page's "more than an hour ago" test is the server's business), but every route
// still honours its Expires, so a run inside the cache windows makes no call.
// Reads the same .env as the server (EVE_CLIENT_ID, EVE_CLIENT_SECRET, EVE_CALLBACK_URL,
// ESI_USER_AGENT, ESI_COMPAT_DATE, EFLIP_DATA_DIR).
// Prints one block per character and one for the market: calls made, 304s, rows added, tokens left
// (--watch: one line per character and per type, and what each answered), and the storage block when
// the budget ran. --rebuild also rebuilds each character's order log and lists any warning it raised;
// --rebuild-book-logs rebuilds the book logs (replaying the regional snapshots whose pages raw still
// holds, and saying how many it could not).
// Exit code: 0 everything synced (or nothing was due), 1 a sync (or the storage step) failed or stopped early, 2 usage or
// configuration error. A watch tick exits 1 when a character failed, needs re-linking or was busy, a
// stop ended it or the market step came back partial; a busy or skipped market step is not a failure.
// A --region-book run exits 1 when it came back partial, paused, busy or failed (a skip is not).
// --storage exits 1 when the market lock was busy or the run failed; --storage-report never does.
const path = require('path');
const { createSso } = require('../lib/sso');
const { createTokenStore, DEFAULT_DATA_DIR } = require('../lib/tokenStore');
const { createTokenManager } = require('../lib/tokens');
const { createSyncService, regionBookEnabled } = require('../lib/sync');
const { createRawStore } = require('../lib/dataFiles');
const derive = require('../lib/derive');
const { KINDS } = require('../lib/storage-budget');
const { readState: readStorageState } = require('../lib/storage');
const { sizeText } = require('../public/storage-notice');

const DEFAULT_CALLBACK_URL = 'http://localhost:5001/sso/callback';
const DEFAULT_USER_AGENT = 'eflip (local)';

const USAGE = `usage: node scripts/sync.js [--character <id>]... [--region <id>]... [--no-market | --market-only] [--max-types <n>] [--rebuild [--rebuild-book-logs] | --rebuild-book-logs | --watch]
       node scripts/sync.js --region-book [--region <id>]
       node scripts/sync.js --region-book-report
       node scripts/sync.js --storage | --storage-report`;

class UsageError extends Error {}

const positiveId = (text, flag) => {
	if (!/^\d{1,15}$/.test(text || '') || Number(text) <= 0) throw new UsageError(`${flag} needs a positive id, got ${JSON.stringify(text)}`);
	return Number(text);
};

const parseArgs = (argv) => {
	const options = { characterIds: null, regionIds: null, market: true, marketOnly: false, rebuild: false, rebuildBookLogs: false, watch: false, regionBook: false, regionBookReport: false, storage: false, storageReport: false, help: false, maxTypes: undefined };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--help' || arg === '-h') options.help = true;
		else if (arg === '--rebuild') options.rebuild = true;
		else if (arg === '--rebuild-book-logs') options.rebuildBookLogs = true;
		else if (arg === '--watch') options.watch = true;
		else if (arg === '--region-book') options.regionBook = true;
		else if (arg === '--region-book-report') options.regionBookReport = true;
		else if (arg === '--storage') options.storage = true;
		else if (arg === '--storage-report') options.storageReport = true;
		else if (arg === '--no-market') options.market = false;
		else if (arg === '--market-only') options.marketOnly = true;
		else if (arg === '--character') (options.characterIds = options.characterIds || []).push(positiveId(argv[++i], arg));
		else if (arg === '--region') (options.regionIds = options.regionIds || []).push(positiveId(argv[++i], arg));
		else if (arg === '--max-types') options.maxTypes = positiveId(argv[++i], arg);
		else throw new UsageError(`unknown argument ${JSON.stringify(arg)}`);
	}
	if (options.marketOnly && !options.market) throw new UsageError('--market-only and --no-market contradict each other');
	if (options.watch && (options.rebuild || options.rebuildBookLogs)) throw new UsageError(`--watch and ${options.rebuild ? '--rebuild' : '--rebuild-book-logs'} contradict each other`);
	if (options.watch && (options.marketOnly || !options.market || options.maxTypes !== undefined)) throw new UsageError('--watch takes only --character and --region');
	if (options.regionBook && options.regionBookReport) throw new UsageError('--region-book and --region-book-report contradict each other');
	if ((options.regionBook || options.regionBookReport) && (options.rebuild || options.rebuildBookLogs || options.watch || options.marketOnly || !options.market || options.maxTypes !== undefined || options.characterIds !== null)) {
		throw new UsageError(`${options.regionBook ? '--region-book' : '--region-book-report'} takes ${options.regionBook ? 'only --region' : 'no other flag'}`);
	}
	if (options.regionBookReport && options.regionIds !== null) throw new UsageError('--region-book-report takes no other flag');
	if (options.regionBook && options.regionIds !== null && options.regionIds.length > 1) throw new UsageError('--region-book takes one --region');
	if (options.storage || options.storageReport) {
		const flag = options.storage ? '--storage' : '--storage-report';
		if (options.storage && options.storageReport) throw new UsageError('--storage and --storage-report contradict each other');
		if (options.rebuild || options.rebuildBookLogs || options.watch || options.regionBook || options.regionBookReport || options.marketOnly || !options.market || options.maxTypes !== undefined || options.characterIds !== null || options.regionIds !== null) {
			throw new UsageError(`${flag} takes no other flag`);
		}
	}
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
	if (result.regionBook) lines.push(formatRegionBook(result.regionBook));
	if (result.storage) lines.push(formatStorage(result.storage));
	return lines.join('\n');
};

// ---- the storage budget

const utc = (stamp) => `${String(stamp).slice(0, 19).replace('T', ' ')} UTC`;

// The line a plain --rebuild prints for the book logs it left alone: how far back the raw behind them
// reaches (derive.bookLogRawReach), which is what a --rebuild-book-logs would keep.
const bookLogsLeftText = (reach) => {
	const minute = (stamp) => `${String(stamp).slice(0, 16).replace('T', ' ')} UTC`;
	const from = [];
	if (reach && reach.regionSnapshotAt) from.push(`${minute(reach.regionSnapshotAt)} (the oldest regional snapshot)`);
	if (reach && reach.typeBookAt) from.push(`${minute(reach.typeBookAt)} (the oldest per-type book)`);
	if (from.length === 0) return 'book logs left as they are: no raw behind them (no regional snapshot or per-type book); pass --rebuild-book-logs to rebuild them from raw';
	return `book logs left as they are: raw reaches back to ${from.join(' and ')}; pass --rebuild-book-logs to rebuild them from raw and lose what is older`;
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What one trim removed, per kind: "regionPages 2 snapshots, 15.4 MB; bookLogs ..."; kinds that gave
// nothing up are left out.
const trimText = (trims) => {
	const parts = [];
	const t = trims || {};
	const r = t.regionPages;
	if (r && r.pieces > 0) parts.push(`regionPages ${[r.snapshots > 0 ? plural(r.snapshots, 'snapshot') : null, r.strayFiles > 0 ? plural(r.strayFiles, 'stray page') : null].filter(Boolean).join(' and ')}, ${sizeText(r.bytesFreed)}`);
	const b = t.bookLogs;
	if (b && b.pieces > 0) parts.push(`bookLogs ${plural(b.logs, 'log')} cut before ${utc(b.cutoffAt)} (${plural(b.samplesDropped, 'sample')}, ${plural(b.entriesDropped, 'path entry', 'path entries')}, ${plural(b.ordersDropped, 'order')} dropped), ${sizeText(b.bytesFreed)}`);
	const y = t.typeBooks;
	if (y && y.pieces > 0) parts.push(`typeBooks ${plural(y.files, 'file')} cut before ${utc(y.cutoffAt)}, ${sizeText(y.bytesFreed)}`);
	const c = t.runContexts;
	if (c && c.pieces > 0) parts.push(`runContexts ${plural(c.runs, 'run')}, ${sizeText(c.bytesFreed)}`);
	return parts.length === 0 ? 'nothing' : parts.join('; ');
};

// The text of one storage run (service.runStorage's answer, or the last run's state for
// --storage-report); also what the tests read. `heading` names where it came from.
const formatStorage = (r, { heading = 'storage' } = {}) => {
	if (!r) return `${heading}: no storage run yet (EFLIP_STORAGE_BUDGET sets a budget; node scripts/sync.js --storage runs one now)`;
	if (r.status === 'busy' || r.status === 'failed') return `${heading}: ${r.status}${r.reason ? ` - ${r.reason}` : ''}`;
	const usage = r.usage || {};
	const total = KINDS.reduce((sum, kind) => sum + (usage[kind] || 0), 0);
	const budget = r.budgetBytes === undefined ? null : r.budgetBytes;
	const shares = r.shares || {};
	const rows = budget === null ? [['kind', 'on disk']] : [['kind', 'on disk', 'share', 'share of budget']];
	for (const kind of KINDS) {
		const share = shares[kind] || 0;
		rows.push(budget === null ? [kind, sizeText(usage[kind] || 0)] : [kind, sizeText(usage[kind] || 0), `${share} %`, sizeText((share / 100) * budget)]);
	}
	rows.push(budget === null ? ['total', sizeText(total)] : ['total', sizeText(total), '', '']);
	const widths = rows[0].map((_, column) => Math.max(...rows.map(row => String(row[column]).length)));
	const table = rows.map(row => `  ${row.map((cell, column) => (column === 0 ? String(cell).padEnd(widths[column]) : String(cell).padStart(widths[column]))).join('  ')}`.trimEnd());
	if (budget === null) {
		const why = r.error ? `EFLIP_STORAGE_BUDGET or EFLIP_STORAGE_SHARES did not parse: ${r.error}` : 'EFLIP_STORAGE_BUDGET is not set';
		return [`${heading}: no budget (${why}), so nothing is trimmed`, ...table].join('\n');
	}
	const lines = [`${heading}: ${Math.round((total / budget) * 100)} % of the ${sizeText(budget)} budget used${r.syncedAt ? `, measured ${utc(r.syncedAt)}` : ''}${r.reason ? ` (after ${r.reason === 'regionBook' ? 'the region book' : r.reason === 'market' ? 'the market snapshot' : 'a request'})` : ''}`, ...table];
	if (trimText(r.trims) !== 'nothing' && r.totalBefore !== undefined) lines.push(`  trimmed ${sizeText(r.totalBefore)} to ${sizeText(total)}`);
	const last = r.lastTrim || null;
	lines.push(last ? `  last trim ${utc(last.at)}: ${trimText(last.trims)}` : '  last trim: none yet');
	if (r.unmet > 0) lines.push(`  over budget by ${sizeText(r.unmet)}: nothing left to trim above the floors`);
	return lines.join('\n');
};

const mb = (bytes) => (bytes / 1e6).toFixed(1);

// The text one regional book run prints; also what the tests read. `result` is what
// service.syncRegionBook answers.
const formatRegionBook = (r) => {
	if (r.status === 'skipped' || r.status === 'busy' || r.status === 'deferred' || r.status === 'failed') {
		return `region book: ${r.status}${r.reason ? ` - ${r.reason}` : ''}`;
	}
	const lines = [`region book (region ${r.regionId}): ${r.status}, ${r.pagesRead} of ${r.pages} pages, ${r.calls} calls (${r.notModified} not modified, ${r.notDue} not due), ${r.tokensUsed} tokens, ${mb(r.rawBytes)} MB of orders (${mb(r.rawBytesStored)} MB written to raw)`];
	if (r.typesFolded > 0 || r.foldErrors > 0) {
		const growth = r.logBytesAfter - r.logBytesBefore;
		lines.push(`  snapshot ${r.fetchedAt}: ${r.orders} orders, ${r.typesInSnapshot} types, ${r.typesFolded} logs folded (${r.logsCreated} new, ${r.typesEnded} with no orders left), logs ${mb(r.logBytesBefore)} MB -> ${mb(r.logBytesAfter)} MB (${growth < 0 ? '-' : '+'}${mb(Math.abs(growth))} MB), ${(r.elapsedMs / 1000).toFixed(1)} s`);
	} else {
		lines.push(`  nothing folded, ${(r.elapsedMs / 1000).toFixed(1)} s`);
	}
	const bucket = Object.values((r.limits && r.limits.groups) || {}).find(entry => entry.group === 'market-order');
	if (bucket && Number.isFinite(bucket.remaining)) lines.push(`  tokens left: market-order ${bucket.remaining}${bucket.limit ? `/${bucket.limit}` : ''}`);
	if (r.reason) lines.push(`  stopped: ${r.reason}`);
	if (r.foldErrors > 0) lines.push(`  ${r.foldErrors} logs did not fold`);
	for (const e of r.errors || []) lines.push(`  error: ${e.route}${e.status ? ` ${e.status}` : ''} ${e.message}`.trimEnd());
	return lines.join('\n');
};

const HOUR_MS = 60 * 60 * 1000;
const REPORT_WINDOW_MS = 24 * HOUR_MS;

// The regionBook entries of the public sync log written at or after `sinceMs`, oldest first. The log
// files are named by their time, so only the ones inside the window are read.
const readRegionBookEntries = (dataDir, sinceMs) => {
	const raw = createRawStore({ dataDir });
	const since = new Date(sinceMs).toISOString();
	const entries = [];
	for (const stamp of raw.syncLogStamps('public')) {
		if (stamp < since) continue;
		const entry = raw.readSyncLog('public', stamp);
		if (entry && entry.kind === 'regionBook') entries.push(entry);
	}
	return entries;
};

// The table `--region-book-report` prints: one row per snapshot, then the totals and the averages
// per hour over the hours the snapshots span (at least one). `entries` are regionBook sync log
// entries, oldest first; `now` is only for the heading.
const formatRegionBookReport = (entries, { now }) => {
	const heading = `region book, the last 24 hours up to ${new Date(now).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
	if (entries.length === 0) {
		return `${heading}: no snapshots (EFLIP_REGION_BOOK=1 takes one with each hourly sync; node scripts/sync.js --region-book takes one now)`;
	}
	const regions = [...new Set(entries.map(entry => entry.regionId))];
	const growthOf = (entry) => (entry.logBytesAfter || 0) - (entry.logBytesBefore || 0);
	const signed = (bytes) => `${bytes < 0 ? '-' : '+'}${mb(Math.abs(bytes))}`;
	const seconds = (ms) => `${Math.round(ms / 1000)} s`;
	const span = Math.max(1, (Date.parse(entries[entries.length - 1].syncedAt) - Date.parse(entries[0].syncedAt)) / HOUR_MS + 1);
	const sum = (field) => entries.reduce((total, entry) => total + (entry[field] || 0), 0);
	// pages actually read (a partial run read fewer than the snapshot has)
	const pagesOf = (entry) => (entry.pagesRead !== undefined ? entry.pagesRead : entry.pages) || 0;
	const total = { pages: entries.reduce((t, entry) => t + pagesOf(entry), 0), tokens: sum('tokensUsed'), raw: sum('rawBytes'), growth: entries.reduce((t, entry) => t + growthOf(entry), 0), elapsed: sum('elapsedMs') };
	const partial = entries.filter(entry => entry.partial).length;

	const rows = [['time (UTC)', 'status', 'pages', 'tokens', 'raw MB', 'types', 'log growth MB', 'elapsed']];
	for (const entry of entries) {
		rows.push([entry.syncedAt.slice(0, 19).replace('T', ' '), entry.status || (entry.partial ? 'partial' : 'ok'), pagesOf(entry), entry.tokensUsed, mb(entry.rawBytes || 0), entry.typesInSnapshot, signed(growthOf(entry)), seconds(entry.elapsedMs || 0)]);
	}
	rows.push(['total', '', total.pages, total.tokens, mb(total.raw), '', signed(total.growth), seconds(total.elapsed)]);
	rows.push([`per hour (${span.toFixed(1)} h)`, '', Math.round(total.pages / span), Math.round(total.tokens / span), mb(total.raw / span), '', signed(total.growth / span), seconds(total.elapsed / span)]);
	const widths = rows[0].map((_, column) => Math.max(...rows.map(row => String(row[column]).length)));
	const textual = new Set([0, 1]);
	const lines = rows.map(row => `  ${row.map((cell, column) => (textual.has(column) ? String(cell).padEnd(widths[column]) : String(cell).padStart(widths[column]))).join('  ')}`.trimEnd());
	const out = [`${heading}: ${entries.length} snapshot${entries.length === 1 ? '' : 's'}${partial > 0 ? `, ${partial} partial` : ''} (region ${regions.join(', ')})`, ...lines];
	const stored = entries.some(entry => entry.rawBytesStored !== undefined) ? sum('rawBytesStored') : null;
	if (stored !== null) out.push(`  written to raw (files, headers included): ${mb(stored)} MB, ${mb(stored / span)} MB per hour`);
	return out.join('\n');
};

// The text a watch tick prints; also what the tests read.
const formatWatch = (result) => {
	const lines = [`watch tick ${result.tickedAt}`];
	for (const [id, c] of Object.entries(result.characters || {})) {
		const who = `${c.name || 'character'} (${id})`;
		if (c.status === 'ok') lines.push(`${who}: ok, orders ${c.orders}, ${c.openSellOrders} open sell orders`);
		else lines.push(`${who}: ${c.status}${c.reason ? ` - ${c.reason}` : ''}${c.orders ? `, orders ${c.orders}` : ''}`);
	}
	const m = result.market;
	if (m) {
		if (m.status === 'skipped' || m.status === 'busy' || m.status === 'failed') {
			lines.push(`market: ${m.status}${m.reason ? ` - ${m.reason}` : ''}`);
		} else {
			lines.push(`market (region ${m.regionIds.join(', ')}): ${m.status}, ${m.types.length} types, ${m.calls} calls${m.truncated ? `, ${m.truncated} long books cut short` : ''}`);
			for (const t of m.types) lines.push(`  type ${t.typeId}: book ${t.outcome}${t.pages > 1 ? ` (${t.pages} pages)` : ''}, history ${t.history === null ? 'not asked' : t.history}`);
			for (const e of m.errors || []) lines.push(`  error: ${e.route}${e.status ? ` ${e.status}` : ''} ${e.message}`.trimEnd());
		}
	}
	const stop = stopText(result.stop);
	if (stop) lines.push(stop);
	return lines.join('\n');
};

// A watch tick fails when a character failed, needs re-linking or was busy, something stopped it, or
// the market step came back partial or failed. A busy or skipped market step does not count.
const watchFailed = (result) => {
	const bad = (status) => status === 'failed' || status === 'relink' || status === 'busy' || status === 'paused' || status === 'rate-limited';
	return Object.values(result.characters || {}).some(c => bad(c.status)) || Boolean(result.stop) || Boolean(result.market && (result.market.status === 'partial' || result.market.status === 'failed'));
};

// Did anything fail or stop early? ('skipped' is not a failure: nothing was asked of it.) A storage
// step that failed counts: unattended, the disk would go on growing.
const hasFailure = (result) => {
	const bad = (status) => status === 'failed' || status === 'partial' || status === 'busy' || status === 'relink';
	return (result.characters || []).some(c => bad(c.status)) || Boolean(result.market && bad(result.market.status)) || Boolean(result.regionBook && regionBookFailed(result.regionBook)) || Boolean(result.storage && result.storage.status === 'failed');
};

// The line --watch prints about the hourly destination book (EFLIP_REGION_BOOK=1), always one of these.
// A tick that took a snapshot follows the line with what --region-book prints; one that found the
// last snapshot recent says so on the same line.
const WATCH_BOOK_ON = 'hourly region book: on';
const WATCH_BOOK_OFF = 'hourly region book: off (EFLIP_REGION_BOOK=1 turns it on)';

// A regional book run fails when it came back partial, paused, busy or failed; skipped and deferred are not failures.
const regionBookFailed = (result) => ['partial', 'paused', 'busy', 'failed'].includes(result.status);

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

	if (options.rebuild || options.rebuildBookLogs) {
		try {
			const bookLines = (books) => {
				out(`book logs: ${books.bookLogs}${books.regionSnapshots > 0 ? ` (${plural(books.regionSnapshots, 'regional snapshot')} replayed)` : ''}`);
				if (books.regionSnapshotsSkipped > 0) out(`${plural(books.regionSnapshotsSkipped, 'regional snapshot')} not replayed: pages trimmed`);
				if (books.bookChecksSkipped > 0) out(`${plural(books.bookChecksSkipped, 'per-type book check')} not replayed: raw trimmed`);
			};
			if (!options.rebuild) {
				const books = derive.rebuildBookLogs({ dataDir });
				bookLines({ bookLogs: books.logs, regionSnapshots: books.regionSnapshots, regionSnapshotsSkipped: books.regionSnapshotsSkipped, bookChecksSkipped: books.checksSkipped });
				return 0;
			}
			const result = derive.rebuildAll({ dataDir, log, bookLogs: options.rebuildBookLogs });
			for (const [id, counts] of Object.entries(result.characters)) {
				out(counts.skipped ? `${id}: skipped (${counts.skipped})` : `${id}: ${counts.transactions} transactions, ${counts.journal} journal rows, ${counts.ordersHistory} orders, ${counts.contracts} contracts, ${counts.contractItems} contract item lists, ${counts.snapshots} snapshots, ${counts.orderLog} logged orders`);
				for (const w of counts.orderLogWarnings || []) out(`  warning: order ${w.orderId} ${w.kind} at ${w.at}${w.kind === 'volume-rise' ? ` (${w.from} -> ${w.to})` : ''}`);
			}
			out(`structures: ${result.structures === null ? 'none in raw' : result.structures}`);
			if (result.bookLogsRebuilt) bookLines(result);
			else out(bookLogsLeftText(result.bookLogRawFrom));
			return 0;
		} catch (e) {
			err(`rebuild failed: ${e.message}`);
			return 1;
		}
	}

	if (options.regionBookReport) {
		try {
			out(formatRegionBookReport(readRegionBookEntries(dataDir, now() - REPORT_WINDOW_MS), { now: now() }));
			return 0;
		} catch (e) {
			err(`report failed: ${e.message}`);
			return 1;
		}
	}

	if (options.storageReport) {
		try {
			out(formatStorage(readStorageState(dataDir), { heading: 'storage (last run)' }));
			return 0;
		} catch (e) {
			err(`report failed: ${e.message}`);
			return 1;
		}
	}

	if (options.storage) {
		// local files only: the service is built without the token manager, and no ESI call is made
		const service = createSyncService({
			dataDir, fetch, now, log, env,
			userAgent: env.ESI_USER_AGENT || DEFAULT_USER_AGENT,
			tokenStore: createTokenStore({ dataDir }),
			tokens: { accessTokenFor: async () => { throw new Error('the storage run makes no ESI call'); }, forget: () => {} },
		});
		let result;
		try {
			result = await service.runStorage({ reason: 'manual' });
		} catch (e) {
			err(`storage failed: ${e.message}`);
			return 1;
		}
		out(formatStorage(result));
		return result.status === 'busy' || result.status === 'failed' ? 1 : 0;
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
	const service = createSyncService({ dataDir, fetch, now, log, userAgent, compatDate: env.ESI_COMPAT_DATE || undefined, env, tokenStore: store, tokens });

	let linked;
	try {
		linked = store.list();
	} catch (e) {
		err(`token store unreadable: ${e.message}`);
		return 1;
	}
	if (linked.length === 0 && options.characterIds === null && !(options.regionBook && options.regionIds !== null)) {
		err('no linked characters: link one at /sso/login first');
		return 2;
	}
	const unknown = (options.characterIds || []).filter(id => !linked.some(record => record.characterId === id));
	if (unknown.length > 0) {
		err(`not linked: ${unknown.join(', ')}`);
		return 2;
	}

	if (options.regionBook) {
		let result;
		try {
			result = await service.syncRegionBook({ regionId: options.regionIds ? options.regionIds[0] : null, force: true });
		} catch (e) {
			err(`region book failed: ${e.message}`);
			return 1;
		}
		out(formatRegionBook(result));
		return regionBookFailed(result) ? 1 : 0;
	}

	if (options.watch) {
		let tick;
		try {
			tick = await service.syncWatch({ characterIds: options.characterIds, regionIds: options.regionIds });
		} catch (e) {
			err(`watch failed: ${e.message}`);
			return 1;
		}
		out(formatWatch(tick));
		let failed = watchFailed(tick);
		// The hourly destination book. A script is started deliberately and ticks from launchd, so there is
		// no timer here: the snapshot runs on the tick that finds the last fold 55 minutes old (an unforced
		// run skips otherwise), the first one right away, and the market lock keeps it off a server's run.
		if (!regionBookEnabled(env)) {
			out(WATCH_BOOK_OFF);
		} else {
			let book;
			try {
				book = await service.syncRegionBook({ regionId: options.regionIds ? options.regionIds[0] : null });
			} catch (e) {
				out(WATCH_BOOK_ON);
				err(`region book failed: ${e.message}`);
				return 1;
			}
			if (book.status === 'skipped') {
				out(`${WATCH_BOOK_ON}, skipped - ${book.reason}`);
			} else {
				out(WATCH_BOOK_ON);
				out(formatRegionBook(book));
				// a busy lock (the server's own hourly run) is not a failure here, as for the tick's market step
				if (regionBookFailed(book) && book.status !== 'busy') failed = true;
			}
		}
		return failed ? 1 : 0;
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

module.exports = { main, parseArgs, WATCH_BOOK_ON, WATCH_BOOK_OFF, formatSummary, formatWatch, formatRegionBook, formatRegionBookReport, formatStorage, readRegionBookEntries, hasFailure, watchFailed, UsageError };
