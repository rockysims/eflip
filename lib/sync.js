// sync.js: one sync per character (and one destination-market snapshot): fetch through esi.js
// (raw first), merge into the ledger, derive the snapshot and profile, record what happened.
// Used by the /api/sync route and by scripts/sync.js, with the same code and the same data
// directory; a lock per character keeps the two from syncing the same character at once.
//
// A character sync, in order (every route honours its Expires, so a second sync inside the cache
// windows makes no call at all):
//   transactions  `from_id` walk, 2500 rows a call, until fewer come back (or, once a walk has
//                 completed before, until a batch holds nothing new)
//   journal, orders history, assets, contracts   every page up to X-Pages
//   open orders, wallet balance                  one call each
//   contract items   once per courier / item-exchange contract, never again
//   skills, standings   at most once a day
//   structure names   once per structure id; a 403 (no docking access) is asked once, not each sync
// then a snapshot {syncedAt, orders, assets, balance} (skipped when unchanged), the profile, a
// sync log naming the raw files behind the snapshot, and the bookkeeping in
// data/esi-cache/<id>/_sync.json (syncedAt, status, errors, walk completeness).
//
// Stops: a 401 or a relink-needed token stops that character; a 420/429, or the legacy error
// limit dropping under 20, stops the sync and records Retry-After; a rate-limit group under 20 %
// of its bucket only skips that group's routes; three failures in a row end the sync.
// `syncedAt` only moves when a call went out, so a sync that found nothing due leaves the
// "more than an hour ago" test to the next page load.
//
// The market snapshot (Sync steps 4-5): for each type held, listed, in transit or sold in the
// last 90 days (at most 300 type/region pairs, least recently checked first within a priority),
// the destination region's orders and daily history, stored raw under data/raw/public/. Orders
// draw on the IP-keyed `market-order` bucket the export page shares, so callers can defer this
// step (`market: false`) while an export run is going, and it pauses itself under 20 % left.
//
// The watch refresh (syncWatch, the orders page's five-minute tick): our open orders, then the book
// and daily history of every type with an open sell order in the watched regions, nothing else. It
// takes the same locks (the character's, then `market`; a held lock skips that step, not the tick),
// honours the same Expires and pause rules, never retries a 401, and leaves the hourly sync alone:
// it writes no _sync.json and no character sync log, so the next hourly sync still runs, finds its
// `orders` call not due (which isCurrent accepts) and snapshots from the tick's raw file. What a
// tick did is data/esi-cache/public/_watch.json.
//
// The regional book (syncRegionBook, off unless EFLIP_REGION_BOOK=1 or asked for): the whole
// destination region's order book, every type and both sides, `GET /markets/<region>/orders?
// order_type=all` page by page (about 194 pages and 388 market-order tokens for Domain), stored raw
// under data/raw/public/ and folded into the per-type book logs, one sample per type that has orders
// (and an empty one for a type with a log whose orders all ended). It takes the `market` lock,
// ends with status `paused` under 20 % of the market-order bucket, and is never folded half done:
// a page that fails makes the run `partial` and nothing is folded. Each run that called ESI or
// folded writes one entry to the public sync log, `kind: 'regionBook'`, with what it cost (pages,
// tokens, raw bytes, log growth, elapsed) so the retention rule can be set from measurement.
// Nothing in the service itself repeats it: createRegionBookScheduler (below) is the hourly timer,
// started by the server (lib/api.js) when EFLIP_REGION_BOOK=1; scripts/sync.js --watch takes the
// snapshot on the first tick that finds the last one 55 minutes old.
//
// The storage budget (EFLIP_STORAGE_BUDGET, e.g. `1GB`; EFLIP_STORAGE_SHARES; lib/storage.js and
// lib/storage-budget.js): when a budget is set, the end of each regional book run that called ESI or
// folded, and the end of each market step, measure the bulky public raw, the book logs and the run
// contexts, and trim the kind furthest over its share, oldest first, until the total fits (runStorage,
// under the `market` lock they already hold). Each such run writes a `kind: 'storage'` entry to the
// public sync log and data/esi-cache/public/_storage.json. Without a budget nothing is trimmed. A
// setting that does not parse is logged once and counts as no budget.
//
// Two derived logs are folded here as answers arrive, by the functions derive.js rebuilds them
// with (derive.js has the why): the order log in every step that stores an `orders` or
// `orders-history` record, and the book log in every book check of the market snapshot and the
// watch, which also record their per-type check times in the public sync log (`books`).
const fs = require('fs');
const path = require('path');
const { createEsiClient, slugFor, DEFAULT_USER_AGENT, DEFAULT_COMPAT_DATE } = require('./esi');
const { createLedger } = require('./ledger');
const derive = require('./derive');
const { acquireLock, readJsonFile, writeFileAtomic } = require('./dataFiles');
const { createRunStore } = require('./runs');
const { DEFAULT_SHARES, parseBudget, parseShares, planTrim } = require('./storage-budget');
const storage = require('./storage');

const MIN_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const PROFILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TRANSACTIONS_PAGE_SIZE = 2500;
const MAX_TRANSACTION_CALLS = 40;
const MAX_PAGES = 100;
const MAX_ITEM_CALLS = 60;
const MAX_STRUCTURE_CALLS = 25;
const MAX_FAILURES = 3;
const MAX_ERRORS_KEPT = 20;
const STRUCTURE_ID_MIN = 1e12;
const SOLD_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const MARKET_MAX_TYPES = 300;
const MARKET_MAX_PAGES = 5;
const MARKET_CONCURRENCY = 4;
const MARKET_MAX_TYPE_IDS = 500;
const WATCH_STATE_FILE = '_watch.json';
const REGION_BOOK_STATE_FILE = '_region-book.json';
// An unforced run skips when the last one folded less than this long ago: a little under the hour
// so an hourly job that starts a few seconds early is not skipped.
const REGION_BOOK_INTERVAL_MS = 55 * 60 * 1000;
// Domain is 194 pages; a region over this many is not what the plan budgeted (about 400 tokens).
const REGION_BOOK_MAX_PAGES = 400;
const REGION_BOOK_YIELD_EVERY = 100;
// How long GET /api/config may answer the storage usage it measured before (a stat of every public
// market file and book log: about 85 ms at Domain scale); a storage run measures afresh.
const STORAGE_USAGE_CACHE_MS = 60 * 1000;

const SCOPES = Object.freeze({
	wallet: 'esi-wallet.read_character_wallet.v1',
	orders: 'esi-markets.read_character_orders.v1',
	assets: 'esi-assets.read_assets.v1',
	contracts: 'esi-contracts.read_character_contracts.v1',
	skills: 'esi-skills.read_skills.v1',
	standings: 'esi-characters.read_standings.v1',
	structures: 'esi-universe.read_structures.v1',
});

// Ends a sync from deep inside a step.
class Stop extends Error {
	constructor(reason, details = {}) {
		super(reason);
		this.reason = reason;
		Object.assign(this, details);
	}
}

const isCurrent = (result) => result.outcome === 'ok' || result.outcome === 'not-modified' || result.outcome === 'not-due';
const iso = (ms) => new Date(ms).toISOString();
const newTally = () => ({ calls: 0, notModified: 0, notDue: 0, paused: 0, stored: 0, rowsAdded: 0, rowsChanged: 0, rate: null });

// ---- the destination market: which types, and where

// Type ids in play for a set of characters, each with its best (lowest) priority: 0 listed (an open
// sell order), 1 in transit (items of an unfinished courier), 2 held (assets), 3 sold in the last
// 90 days. Read from the ledgers, so it costs no ESI call.
const marketTypes = ({ ledger, characterIds, now }) => {
	const priorities = new Map();
	const note = (typeId, priority) => {
		const id = Number(typeId);
		if (!Number.isSafeInteger(id) || id <= 0) return;
		if (!priorities.has(id) || priorities.get(id) > priority) priorities.set(id, priority);
	};
	for (const characterId of characterIds) {
		const snapshot = ledger.latestSnapshot(characterId);
		if (snapshot) {
			for (const order of snapshot.orders) if (!order.is_buy_order) note(order.type_id, 0);
			for (const asset of snapshot.assets) note(asset.type_id, 2);
		}
		const items = ledger.readContractItems(characterId);
		for (const contract of ledger.readRows(characterId, 'contracts')) {
			if (contract.type !== 'courier' || (contract.status !== 'outstanding' && contract.status !== 'in_progress')) continue;
			for (const item of items[String(contract.contract_id)] || []) if (item.is_included !== false) note(item.type_id, 1);
		}
		for (const tx of ledger.readRows(characterId, 'transactions')) {
			if (!tx.is_buy && Date.parse(tx.date) >= now - SOLD_WINDOW_MS) note(tx.type_id, 3);
		}
	}
	return priorities;
};

// The region(s) whose market to snapshot when the caller names none: the end region of the newest
// persisted export run (data/runs/, Phase 5), else the region the characters list their sell orders
// in most (open orders, and history from the last 90 days).
const marketRegions = ({ dataDir, ledger, characterIds, now }) => {
	let newest = null;
	const runsDir = path.join(path.resolve(dataDir), 'runs');
	let names = [];
	try {
		names = fs.readdirSync(runsDir).filter(name => name.endsWith('.json'));
	} catch (e) {
		// no runs yet
	}
	for (const name of names) {
		let run = null;
		try {
			run = readJsonFile(path.join(runsDir, name));
		} catch (e) {
			continue;
		}
		const region = run && run.route ? Number(run.route.endRegionId) : NaN;
		const copiedAt = run ? Date.parse(run.lastCopiedAt || run.copiedAt) : NaN;
		if (Number.isSafeInteger(region) && region > 0 && Number.isFinite(copiedAt) && (newest === null || copiedAt > newest.copiedAt)) newest = { region, copiedAt };
	}
	if (newest) return [newest.region];

	const counts = new Map();
	const count = (order) => {
		const region = Number(order.region_id);
		if (!order.is_buy_order && Number.isSafeInteger(region) && region > 0) counts.set(region, (counts.get(region) || 0) + 1);
	};
	for (const characterId of characterIds) {
		const snapshot = ledger.latestSnapshot(characterId);
		if (snapshot) snapshot.orders.forEach(count);
		for (const order of ledger.readRows(characterId, 'orders-history')) {
			if (Date.parse(order.issued) >= now - SOLD_WINDOW_MS) count(order);
		}
	}
	const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
	return ranked.length === 0 ? [] : [ranked[0][0]];
};

// 'stored' (a new raw file), 'not-modified' (answered, nothing new), or the failure's own outcome.
const outcomeName = (result) => (result.outcome === 'ok' ? (result.stored ? 'stored' : 'not-modified') : result.outcome);

const marketOrdersPath = (regionId) => `/markets/${regionId}/orders`;
const marketHistoryPath = (regionId) => `/markets/${regionId}/history`;
// Why a regional book run stopped, in words.
const regionBookStopText = (stop) => {
	switch (stop.reason) {
		case 'paused': return `the ${stop.group || 'market-order'} bucket is under 20 % left until ${iso(stop.until)}`;
		case 'error-limit': return `the ESI error limit is low until ${iso(stop.until)}`;
		case 'rate-limited': return `ESI asked to wait ${stop.retryAfter} s`;
		default: return stop.message || stop.reason;
	}
};
// One page of a region's whole book; esi.js names the raw directory `markets-<region>-orders-
// order-type-all` (page 1) and `...-order-type-all-page-<n>`.
const regionBookQuery = (page) => (page > 1 ? { order_type: 'all', page } : { order_type: 'all' });

// Whether the hourly sync also takes the regional book: EFLIP_REGION_BOOK=1.
const regionBookEnabled = (env = process.env) => Boolean(env) && env.EFLIP_REGION_BOOK === '1';

// The storage budget the environment sets: {budgetBytes (null: none), shares, error (the message
// when a setting does not parse; the budget is then null)}.
const storageSettings = (env = process.env) => {
	const vars = env || {};
	try {
		return { budgetBytes: parseBudget(vars.EFLIP_STORAGE_BUDGET), shares: parseShares(vars.EFLIP_STORAGE_SHARES), error: null };
	} catch (e) {
		let shares = { ...DEFAULT_SHARES };
		try {
			shares = parseShares(vars.EFLIP_STORAGE_SHARES);
		} catch (ignored) {
			// the defaults, for the report
		}
		return { budgetBytes: null, shares, error: e.message };
	}
};

// ---- the hourly schedule of the regional book

const REGION_BOOK_FIRST_DELAY_MS = 60 * 1000;
const REGION_BOOK_SCHEDULE_MS = 60 * 60 * 1000;
const REGION_BOOK_SCHEDULE_LABEL = 'region book schedule';

// A timer that must not keep the process alive; a test's stand-in without unref() is fine too.
const unrefTimer = (timer) => {
	if (timer && typeof timer.unref === 'function') timer.unref();
	return timer;
};
const durationText = (ms) => (ms < 120 * 1000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`);

// Takes the destination region's whole order book once an hour, for as long as it is started and
// EFLIP_REGION_BOOK=1 (read from `env` at start()). The server starts one (lib/api.js mountApi). It
// calls sync.syncRegionBook() unforced, which is single-flight and skips when the last snapshot was
// folded under 55 minutes ago, so a second process (scripts/sync.js --watch, a manual run) does not
// double the snapshots. The first run comes `firstDelayMs` after start() so the server is up and the
// rate-limit state is loaded; every timer is unref'd, so the schedule never keeps the process alive.
//
// Deliberately no deferral for an export run in progress, unlike the market snapshot's `market:
// false` caller: the server does not know about export runs (the page keeps them in the browser),
// a snapshot costs 388 of the market-order bucket's 12,000 tokens, and the run still pauses itself
// under 20 % left, which is the guard that matters.
//
// Runs never overlap: a tick that finds the previous run still pending is skipped and logged. A run
// that throws is logged and the schedule goes on. `nextRunAt` (ISO) and `lastRun` ({at: when it
// ended, status}) are what GET /api/config reports. options: {sync (needs syncRegionBook), env, log,
// now, setInterval, clearInterval, setTimeout, clearTimeout (injected by tests), firstDelayMs,
// intervalMs}.
const createRegionBookScheduler = ({
	sync,
	env = process.env,
	log = console,
	now = () => Date.now(),
	setInterval = globalThis.setInterval,
	clearInterval = globalThis.clearInterval,
	setTimeout = globalThis.setTimeout,
	clearTimeout = globalThis.clearTimeout,
	firstDelayMs = REGION_BOOK_FIRST_DELAY_MS,
	intervalMs = REGION_BOOK_SCHEDULE_MS,
}) => {
	const label = REGION_BOOK_SCHEDULE_LABEL;
	let started = false;
	let firstTimer = null;
	let repeatTimer = null;
	let pending = null;
	let nextAt = null;
	let lastRun = null;

	const ended = (status) => {
		lastRun = { at: iso(now()), status };
	};

	// Never rejects: everything a run can throw is logged here.
	const run = async () => {
		const startedAt = now();
		try {
			const result = await sync.syncRegionBook();
			const status = (result && result.status) || 'unknown';
			let line = `${label}: ${status}`;
			if (status === 'ok' || status === 'partial') {
				const elapsedMs = Number.isFinite(result.elapsedMs) ? result.elapsedMs : now() - startedAt;
				const pages = Number.isFinite(result.pagesRead) ? result.pagesRead : result.pages;
				line += `, ${pages}/${result.pages} pages, ${result.tokensUsed} tokens, ${(elapsedMs / 1000).toFixed(1)} s`;
			}
			if (result && result.reason) line += ` - ${result.reason}`;
			ended(status);
			(status === 'partial' || status === 'failed' ? log.warn : log.info).call(log, line);
		} catch (e) {
			ended('failed');
			log.warn(`${label}: failed - ${(e && e.message) || e}`);
		}
	};

	const tick = () => {
		if (pending) {
			log.info(`${label}: tick skipped, the previous run is still going`);
			return pending;
		}
		pending = run().finally(() => {
			pending = null;
		});
		return pending;
	};

	const onFirst = () => {
		firstTimer = null;
		repeatTimer = unrefTimer(setInterval(onRepeat, intervalMs));
		nextAt = now() + intervalMs;
		return tick();
	};
	const onRepeat = () => {
		nextAt = now() + intervalMs;
		return tick();
	};

	const start = () => {
		if (!regionBookEnabled(env)) {
			log.info(`${label}: off (EFLIP_REGION_BOOK=1 takes the destination book once an hour)`);
			return;
		}
		if (started) return;
		started = true;
		nextAt = now() + firstDelayMs;
		firstTimer = unrefTimer(setTimeout(onFirst, firstDelayMs));
		log.info(`${label}: on, first snapshot in ${durationText(firstDelayMs)}, then every ${durationText(intervalMs)}`);
	};

	// Clears the timers; a run already going is left to finish.
	const stop = () => {
		if (firstTimer !== null) clearTimeout(firstTimer);
		if (repeatTimer !== null) clearInterval(repeatTimer);
		firstTimer = null;
		repeatTimer = null;
		nextAt = null;
		started = false;
	};

	const status = () => ({ scheduled: started, running: pending !== null, nextRunAt: nextAt === null ? null : iso(nextAt), lastRun });

	return {
		start,
		stop,
		status,
		get running() {
			return pending !== null;
		},
	};
};

// ---- the service

// options: {dataDir, tokens: {accessTokenFor(id), forget(id)}, tokenStore, fetch, now, log,
// userAgent, compatDate, env}. Nothing touches the disk until a sync or a read.
const createSyncService = ({
	dataDir,
	tokens,
	tokenStore,
	fetch = globalThis.fetch,
	now = () => Date.now(),
	log = console,
	userAgent = DEFAULT_USER_AGENT,
	compatDate = DEFAULT_COMPAT_DATE,
	timeoutMs,
	transactionsPageSize = TRANSACTIONS_PAGE_SIZE, // ESI's own page size; only tests change it
	env = process.env, // read at each use, so a test can set EFLIP_REGION_BOOK after creating the service
}) => {
	const dir = path.resolve(dataDir);
	const esi = createEsiClient({ dataDir: dir, fetch, now, tokens, userAgent, compatDate, timeoutMs });
	const raw = esi.raw;
	const ledger = createLedger({ dataDir: dir });
	const runs = createRunStore({ dataDir: dir, log });

	const running = new Map(); // characterId -> Promise<result>
	const progress = new Map(); // characterId -> {route, page, pages}
	let marketRunning = null;
	let watchRunning = null;
	let regionBookRunning = null;
	let storageRunning = null;

	const stateFile = (owner) => path.join(dir, 'esi-cache', String(owner), '_sync.json');
	const loadSyncState = (owner) => {
		try {
			return readJsonFile(stateFile(owner)) || {};
		} catch (e) {
			return {};
		}
	};
	const saveSyncState = (owner, state) => {
		writeFileAtomic(stateFile(owner), JSON.stringify(state, null, '\t') + '\n');
	};

	// ---- one character

	const doSyncCharacter = async (id, { force = false } = {}) => {
		let record = null;
		try {
			record = tokenStore.get(id);
		} catch (e) {
			return { characterId: id, status: 'failed', reason: 'token store unreadable' };
		}
		if (!record) return { characterId: id, status: 'failed', reason: 'not linked' };
		const base = { characterId: id, name: record.name };
		if (record.status === 'relink') return { ...base, status: 'relink', reason: record.lastError || 'needs re-linking' };

		const startedAt = now();
		const previous = loadSyncState(id);
		if (!force && previous.syncedAt && startedAt - Date.parse(previous.syncedAt) < MIN_SYNC_INTERVAL_MS) {
			return { ...base, status: 'skipped', reason: 'synced within the last hour', syncedAt: previous.syncedAt };
		}
		const release = acquireLock(dir, `character-${id}`);
		if (!release) return { ...base, status: 'busy', reason: 'another sync is running for this character' };

		const syncedAt = iso(startedAt);
		const ctx = {
			routes: {},
			calls: 0,
			stored: [],
			errors: [],
			failures: 0,
			missingScopes: new Set(),
			pausedGroups: {},
			rowsAdded: { transactions: 0, journal: 0, ordersHistory: 0, contracts: 0, contractItems: 0, structures: 0 },
			components: { orders: false, wallet: false, assets: null },
			structuresForbidden: 0,
			itemsPending: 0,
			stop: null,
		};
		const state = { ...previous };
		let failure = null;

		try {
			esi.loadLimits();
			// A ledger that is gone while its raw is not (a purge) is rebuilt first: the walks below
			// would only see 304s and never refill it.
			if (!ledger.exists(id) && raw.slugs(id).length > 0) derive.rebuildCharacterLocked({ dataDir: dir, characterId: id });
			// ... and an order log that predates the watch is built from the raw `orders` records first
			derive.ensureOrderLog({ raw, ledger, characterId: id });
			await runSteps(id, record, ctx, state, syncedAt, { force });
		} catch (e) {
			if (e instanceof Stop) ctx.stop = { reason: e.reason, retryAfter: e.retryAfter, until: e.until, message: e.message };
			else failure = e;
		}

		try {
			const result = finish(id, base, ctx, state, previous, syncedAt, failure);
			return result;
		} finally {
			try {
				esi.flushLimits();
			} finally {
				release();
				progress.delete(id);
			}
		}
	};

	// The order log of a character: the `orders` answers stored since the last fold, and whatever
	// the ledger's orders-history now holds. The character's lock is held.
	const foldOrderLog = (id, records) => {
		const { warnings } = derive.updateOrderLog({ ledger, characterId: id, records });
		for (const w of warnings) log.warn(`order log ${id}: order ${w.orderId} ${w.kind} at ${w.at}`);
	};

	const addError = (ctx, route, result) => {
		if (ctx.errors.length < MAX_ERRORS_KEPT) {
			ctx.errors.push({ route, outcome: result.outcome, status: result.status || null, message: result.message || '' });
		}
	};

	// One ESI call for a route of this character, with the sync's bookkeeping. Throws Stop when the
	// sync must end here.
	const makeCall = (id, ctx) => async (route, request) => {
		const tally = (ctx.routes[route] = ctx.routes[route] || newTally());
		const result = await esi.get({ owner: id, ...request });
		switch (result.outcome) {
			case 'ok':
				ctx.calls++;
				tally.calls++;
				tally.rate = result.rate;
				if (result.stored) {
					tally.stored++;
					ctx.stored.push({ route, slug: result.slug, fetchedAt: result.fetchedAt });
				}
				ctx.failures = 0;
				break;
			case 'not-modified':
				ctx.calls++;
				tally.calls++;
				tally.notModified++;
				tally.rate = result.rate;
				ctx.failures = 0;
				break;
			case 'not-due':
				tally.notDue++;
				break;
			case 'paused':
				tally.paused++;
				if (result.reason === 'error-limit') throw new Stop('error-limit', { until: result.until });
				ctx.pausedGroups[result.group] = result.until;
				break;
			case 'rate-limited':
				ctx.calls++;
				tally.calls++;
				throw new Stop('rate-limited', { retryAfter: result.retryAfter, until: result.until, message: `${route}: ${result.status}` });
			case 'auth':
				if (result.code === 'relink' || result.code === 'not-linked') throw new Stop('relink', { message: result.message });
				ctx.calls++;
				tally.calls++;
				throw new Stop('unauthorized', { message: `${route}: ${result.message}` });
			case 'forbidden':
			case 'not-found':
				if (!result.cached) {
					ctx.calls++;
					tally.calls++;
				}
				break;
			default:
				if (result.status) {
					ctx.calls++;
					tally.calls++;
				}
				addError(ctx, route, result);
				if (++ctx.failures >= MAX_FAILURES) throw new Stop('errors', { message: `${route}: ${result.message || result.kind}` });
		}
		if ((result.outcome === 'forbidden' || result.outcome === 'not-found') && !result.cached && route !== 'structures' && route !== 'contractItems') {
			addError(ctx, route, result);
		}
		return result;
	};

	const runSteps = async (id, record, ctx, state, syncedAt, { force }) => {
		const call = makeCall(id, ctx);
		const owns = (key) => {
			if (Array.isArray(record.scopes) && record.scopes.includes(SCOPES[key])) return true;
			ctx.missingScopes.add(SCOPES[key]);
			return false;
		};
		const note = (route, page, pages) => progress.set(id, { route, page, pages });
		const addRows = (route, ledgerName, rows) => {
			const { added, changed } = ledger.mergeInto(id, ledgerName, rows);
			ctx.routes[route].rowsAdded += added;
			ctx.routes[route].rowsChanged += changed;
			return added;
		};

		// Every page of a paged route; `onPage(rows)` sees the pages that came back changed.
		const walkPages = async (route, apiPath, onPage) => {
			let pages = 1;
			for (let page = 1; page <= Math.min(pages, MAX_PAGES); page++) {
				const result = await call(route, { path: apiPath, query: page > 1 ? { page } : {} });
				pages = result.pages || pages;
				note(route, page, pages);
				if (result.outcome === 'ok') {
					if (result.stored) onPage(result.body);
				} else if (result.outcome !== 'not-modified' && result.outcome !== 'not-due') {
					return { pages, complete: false };
				}
			}
			return { pages, complete: true };
		};

		// 1. transactions
		if (owns('wallet')) {
			const apiPath = `/characters/${id}/wallet/transactions`;
			const known = new Set(ledger.readRows(id, 'transactions').map(row => String(row.transaction_id)));
			// `transactionsComplete` says the ledger holds everything ESI still serves. While it is true a
			// page with nothing new ends the walk; while it is not (a first walk, or one that stopped
			// half way) the walk goes on to the end, reading the pages it already holds from raw.
			const wasComplete = state.transactionsComplete === true;
			let fromId = null;
			for (let i = 0; i < MAX_TRANSACTION_CALLS; i++) {
				const result = await call('transactions', { path: apiPath, query: fromId === null ? {} : { from_id: fromId } });
				note('transactions', i + 1, null);
				let rows;
				let fresh = 0;
				if (result.outcome === 'ok') {
					rows = Array.isArray(result.body) ? result.body : [];
					fresh = rows.filter(row => !known.has(String(row.transaction_id))).length;
					if (result.stored) {
						addRows('transactions', 'transactions', rows);
						rows.forEach(row => known.add(String(row.transaction_id)));
					}
				} else if (result.outcome === 'not-modified' || result.outcome === 'not-due') {
					if (wasComplete) {
						if (i > 0) state.transactionsComplete = true;
						break;
					}
					const held = raw.latest(id, result.slug);
					rows = held && Array.isArray(held.body) ? held.body : [];
				} else {
					if (i > 0) state.transactionsComplete = false;
					break;
				}
				if (rows.length < transactionsPageSize || (wasComplete && result.outcome === 'ok' && fresh === 0)) {
					state.transactionsComplete = true;
					break;
				}
				const oldest = Math.min(...rows.map(row => Number(row.transaction_id)));
				state.transactionsComplete = false;
				if (!Number.isFinite(oldest) || (fromId !== null && oldest >= fromId)) break;
				fromId = oldest;
			}

			// 2. journal
			await walkPages('journal', `/characters/${id}/wallet/journal`, rows => addRows('journal', 'journal', rows));
		}

		// 3. open orders, orders history, assets, wallet balance
		if (owns('orders')) {
			const open = await call('orders', { path: `/characters/${id}/orders` });
			if (isCurrent(open)) ctx.components.orders = true;
			const records = open.outcome === 'ok' && open.stored ? [{ fetchedAt: open.fetchedAt, body: open.body }] : [];
			let historyChanged = false;
			try {
				await walkPages('ordersHistory', `/characters/${id}/orders/history`, rows => {
					historyChanged = true;
					addRows('ordersHistory', 'orders-history', rows);
				});
			} finally {
				// also when the walk stops half way: the rows merged so far and the stored answer count
				if (records.length > 0 || historyChanged) foldOrderLog(id, records);
			}
		}
		if (owns('assets')) {
			const walk = await walkPages('assets', `/characters/${id}/assets`, () => {});
			if (walk.complete) ctx.components.assets = walk.pages;
		}
		if (owns('wallet')) {
			const balance = await call('wallet', { path: `/characters/${id}/wallet` });
			if (isCurrent(balance)) ctx.components.wallet = true;
		}

		// contracts, then the items of each new courier or item-exchange contract
		if (owns('contracts')) {
			await walkPages('contracts', `/characters/${id}/contracts`, rows => addRows('contracts', 'contracts', rows));
			const wanted = ledger.readRows(id, 'contracts')
				.filter(contract => (contract.type === 'courier' || contract.type === 'item_exchange') && !ledger.hasContractItems(id, contract.contract_id))
				.sort((a, b) => b.contract_id - a.contract_id);
			let made = 0;
			for (const contract of wanted) {
				if (made >= MAX_ITEM_CALLS) {
					ctx.itemsPending = wanted.length - made;
					break;
				}
				const result = await call('contractItems', {
					path: `/characters/${id}/contracts/${contract.contract_id}/items`,
					rememberNotFound: true,
				});
				if (result.outcome === 'ok') {
					made++;
					ledger.writeContractItems(id, contract.contract_id, result.body);
					ctx.routes.contractItems.rowsAdded++;
				} else if (result.outcome === 'not-modified' || result.outcome === 'not-due') {
					// the raw copy is there but the ledger file is not (a hand-deleted ledger)
					const stored = raw.latest(id, result.slug);
					if (stored && Array.isArray(stored.body)) ledger.writeContractItems(id, contract.contract_id, stored.body);
				} else if (!result.cached) {
					made++;
				}
			}
		}

		// 4. skills and standings, at most once a day
		const wantSkills = owns('skills');
		const wantStandings = owns('standings');
		const profileDue = !state.profileCheckedAt || Date.parse(state.profileCheckedAt) + PROFILE_INTERVAL_MS <= Date.parse(syncedAt);
		if (profileDue && (wantSkills || wantStandings)) {
			const skills = wantSkills ? await call('skills', { path: `/characters/${id}/skills` }) : null;
			const standings = wantStandings ? await call('standings', { path: `/characters/${id}/standings` }) : null;
			if ((skills === null || isCurrent(skills)) && (standings === null || isCurrent(standings))) state.profileCheckedAt = syncedAt;
		}
		if (ctx.routes.skills || ctx.routes.standings || !ledger.readProfile(id)) {
			const profile = derive.profileFromRaw(raw, id);
			if (profile) ledger.writeProfile(id, profile);
		}

		// structure names for the locations the ledger mentions, once per structure id
		if (owns('structures')) await structureNames(id, ctx, call);
	};

	const structureNames = async (id, ctx, call) => {
		const found = new Set();
		const consider = (value) => {
			const n = Number(value);
			if (Number.isSafeInteger(n) && n >= STRUCTURE_ID_MIN) found.add(n);
		};
		for (const row of ledger.readRows(id, 'transactions')) consider(row.location_id);
		for (const row of ledger.readRows(id, 'orders-history')) consider(row.location_id);
		for (const row of ledger.readRows(id, 'contracts')) {
			consider(row.start_location_id);
			consider(row.end_location_id);
		}
		const open = raw.latest(id, 'orders');
		if (open && Array.isArray(open.body)) open.body.forEach(row => consider(row.location_id));
		for (let page = 1; page <= (ctx.components.assets || 0); page++) {
			const assets = raw.latest(id, derive.assetSlug(page));
			if (assets && Array.isArray(assets.body)) assets.body.filter(row => row.location_type === 'other').forEach(row => consider(row.location_id));
		}
		const names = ledger.readStructures();
		const wanted = [...found].filter(structureId => !Object.hasOwn(names, String(structureId))).sort((a, b) => a - b);
		// structures.json is shared by every character and another sync may write it while this one
		// waits on ESI, so each write re-reads the file and sets only its own key (nothing awaits in
		// between). `onlyIfMissing` leaves a name another sync wrote meanwhile as it is.
		const putName = (structureId, entry, { onlyIfMissing = false } = {}) => {
			const current = ledger.readStructures();
			if (onlyIfMissing && Object.hasOwn(current, String(structureId))) return false;
			current[String(structureId)] = entry;
			ledger.writeStructures(current);
			ctx.rowsAdded.structures++;
			ctx.routes.structures.rowsAdded++;
			return true;
		};
		let made = 0;
		for (const structureId of wanted) {
			if (made >= MAX_STRUCTURE_CALLS) break;
			const result = await call('structures', { path: `/universe/structures/${structureId}`, rememberForbidden: true, rememberNotFound: true });
			if (result.outcome === 'ok') made++;
			if (result.outcome === 'ok' && result.stored) {
				putName(structureId, derive.structureEntry({ body: result.body, fetchedAt: result.fetchedAt }, id));
			} else if (result.outcome === 'ok' || result.outcome === 'not-modified' || result.outcome === 'not-due') {
				// Answered, with nothing new to store, for a name the file does not hold (lost to an older
				// concurrent write, or the file was replaced): restored from this character's newest raw
				// answer, and counted as a row added, since it is one the file gains.
				const held = raw.latest(id, result.slug);
				if (held && held.body && typeof held.body === 'object') putName(structureId, derive.structureEntry(held, id), { onlyIfMissing: true });
			} else if (!result.cached && (result.outcome === 'forbidden' || result.outcome === 'not-found')) {
				made++;
				ctx.structuresForbidden++;
			}
		}
	};

	// 6. snapshot, sync log, bookkeeping; builds the answer.
	const finish = (id, base, ctx, state, previous, syncedAt, failure) => {
		const finishedAt = iso(now());
		const tallies = Object.values(ctx.routes);
		const sum = (field) => tallies.reduce((total, tally) => total + tally[field], 0);
		for (const name of Object.keys(ctx.rowsAdded)) {
			if (ctx.routes[name]) ctx.rowsAdded[name] = ctx.routes[name].rowsAdded;
		}

		let snapshot = null;
		let snapshotState = 'skipped';
		let refs = null;
		if (failure === null && ctx.calls > 0 && ctx.components.orders && ctx.components.wallet && ctx.components.assets) {
			const orders = raw.latestStamp(id, 'orders');
			const wallet = raw.latestStamp(id, 'wallet');
			const assets = [];
			for (let page = 1; page <= ctx.components.assets; page++) assets.push(raw.latestStamp(id, derive.assetSlug(page)));
			if (orders && wallet && assets.every(stamp => stamp !== null)) {
				refs = { orders, wallet, assets };
				snapshot = derive.snapshotFromRefs(raw, id, syncedAt, refs);
			}
		}
		if (snapshot) snapshotState = ledger.writeSnapshot(id, snapshot) ? 'written' : 'unchanged';

		let status = 'ok';
		if (failure !== null) status = 'failed';
		else if (ctx.stop && ctx.stop.reason === 'relink') status = 'relink';
		else if (ctx.stop && ctx.stop.reason === 'unauthorized') status = 'failed';
		else if (ctx.stop || ctx.errors.length > 0 || Object.keys(ctx.pausedGroups).length > 0) status = 'partial';

		const rate = {};
		for (const [route, tally] of Object.entries(ctx.routes)) if (tally.rate) rate[route] = tally.rate;
		const summary = {
			...base,
			status,
			syncedAt,
			finishedAt,
			calls: ctx.calls,
			notModified: sum('notModified'),
			notDue: sum('notDue'),
			stored: sum('stored'),
			routes: ctx.routes,
			rowsAdded: ctx.rowsAdded,
			snapshot: snapshotState,
			errors: ctx.errors,
			stop: ctx.stop,
			missingScopes: [...ctx.missingScopes],
			pausedGroups: ctx.pausedGroups,
			structuresForbidden: ctx.structuresForbidden,
			itemsPending: ctx.itemsPending,
		};
		if (failure !== null) {
			summary.reason = failure.message;
			summary.errors = [...summary.errors, { route: 'sync', outcome: 'error', status: null, message: String(failure.message).slice(0, 200) }];
			log.warn(`sync ${id}: ${failure.message}`);
		}
		if (ctx.stop && ctx.stop.reason === 'relink') summary.reason = ctx.stop.message;
		if (ctx.stop && ctx.stop.reason === 'unauthorized') summary.reason = ctx.stop.message;

		if (ctx.calls > 0) {
			raw.writeSyncLog(id, {
				syncedAt,
				finishedAt,
				characterId: id,
				status,
				calls: ctx.calls,
				stored: ctx.stored,
				snapshot: refs,
				errors: ctx.errors,
				stop: ctx.stop,
				rate,
				limits: esi.limitsSnapshot(),
			});
		}
		saveSyncState(id, {
			...state,
			syncedAt: ctx.calls > 0 ? syncedAt : previous.syncedAt || null,
			checkedAt: syncedAt,
			finishedAt,
			status,
			reason: summary.reason || null,
			errors: summary.errors,
			stop: ctx.stop,
			missingScopes: summary.missingScopes,
			pausedGroups: ctx.pausedGroups,
			calls: ctx.calls,
		});
		if (ctx.calls > 0) {
			log.info(`sync ${id}: ${status}, ${ctx.calls} calls, ${summary.notModified} not modified, ${summary.stored} stored`);
		}
		return summary;
	};

	const syncCharacter = (characterId, options = {}) => {
		const id = Number(characterId);
		if (running.has(id)) return running.get(id);
		const promise = doSyncCharacter(id, options).finally(() => running.delete(id));
		running.set(id, promise);
		return promise;
	};

	// Deletes everything synced for a character: the ESI bookkeeping, ledger and raw. Raw has to go
	// too: a ledger deleted alone is rebuilt from raw by the next sync, as it should be (the ledger
	// is only a view). The bookkeeping goes first, so a failure half way never leaves etags and
	// _sync.json behind with no raw to rebuild from. The shared structure names stay. `unlink`, when
	// given, runs under the character's lock before anything is deleted, so a watch tick or a sync
	// that starts once the lock is free finds the character gone instead of writing its files again.
	// Throws an error with code 'busy' while a sync of the character runs.
	const purgeCharacter = (characterId, { unlink } = {}) => {
		const id = Number(characterId);
		const busy = () => Object.assign(new Error(`character ${id} is being synced`), { code: 'busy' });
		if (running.has(id)) throw busy();
		const release = acquireLock(dir, `character-${id}`);
		if (!release) throw busy();
		try {
			if (unlink) unlink();
			for (const target of ['esi-cache', 'ledger', 'raw']) fs.rmSync(path.join(dir, target, String(id)), { recursive: true, force: true });
		} finally {
			release();
		}
	};

	// ---- the destination market

	// A time stamp for a public sync log that no earlier log of the owner has (the logs are named by
	// it, and a clock that has not moved, or two entries in one millisecond, must not overwrite).
	const freshLogTime = (startedAt) => {
		const taken = new Set(raw.syncLogStamps('public'));
		let t = startedAt;
		while (taken.has(iso(t))) t++;
		return iso(t);
	};

	// The book (pages up to MARKET_MAX_PAGES) and the daily history of each region/type pair, one
	// call per route and page at most, honouring Expires. Every book check is folded into the book
	// log: a stored page, or an answer that changed nothing, is a sample; a type not yet due is not.
	// Shared by the market snapshot and the watch refresh. Answers the tallies, the errors, the
	// stop (or null) and one `books` entry per pair, the form the public sync log keeps:
	// {regionId, typeId, outcome, at, pages, stamps: {page: raw stamp of the files this check stored}, history}.
	const fetchPairs = async (pairs, { concurrency }) => {
		const routes = { marketOrders: newTally(), marketHistory: newTally() };
		const errors = [];
		const shared = { calls: 0, stop: null, failures: 0 };
		const tally = (route, outcome) => {
			const t = routes[route];
			if (outcome.outcome === 'ok') {
				shared.calls++;
				t.calls++;
				t.rate = outcome.rate;
				if (outcome.stored) t.stored++;
				shared.failures = 0;
			} else if (outcome.outcome === 'not-modified') {
				shared.calls++;
				t.calls++;
				t.notModified++;
				t.rate = outcome.rate;
			} else if (outcome.outcome === 'not-due') {
				t.notDue++;
			} else if (outcome.outcome === 'not-found' || outcome.outcome === 'forbidden') {
				// No market for this type (404 on history): asked once, then remembered. Neither an
				// error nor a failure, so it never turns a run partial.
				if (!outcome.cached && outcome.status) {
					shared.calls++;
					t.calls++;
				}
			} else if (outcome.outcome === 'paused') {
				t.paused++;
				if (shared.stop === null) shared.stop = { reason: outcome.reason === 'group' ? 'paused' : 'error-limit', until: outcome.until, group: outcome.group || null };
			} else if (outcome.outcome === 'rate-limited') {
				shared.calls++;
				t.calls++;
				shared.stop = { reason: 'rate-limited', retryAfter: outcome.retryAfter, until: outcome.until };
			} else {
				if (outcome.status) {
					shared.calls++;
					t.calls++;
				}
				if (errors.length < MAX_ERRORS_KEPT) errors.push({ route, outcome: outcome.outcome, status: outcome.status || null, message: outcome.message || '' });
				if (++shared.failures >= MAX_FAILURES) shared.stop = { reason: 'errors', message: outcome.message || outcome.kind || '' };
			}
			return outcome;
		};

		// One order call per type is the plan's budget; a book of more than one page costs more, up
		// to twice that, and past MARKET_MAX_PAGES pages it is cut short and counted.
		const orderCallBudget = pairs.length * 2;
		const books = [];
		let truncated = 0;
		let next = 0;
		let index = null; // the public sync logs, read once and only when a book log has to be built
		// The book log is derived and rebuildable; a log that will not fold is reported, not fatal.
		const guarded = (what, fn) => {
			try {
				return fn();
			} catch (e) {
				log.warn(`${what}: ${e.message}`);
				if (errors.length < MAX_ERRORS_KEPT) errors.push({ route: 'bookLog', outcome: 'error', status: null, message: `${what}: ${String(e.message).slice(0, 150)}` });
				return false;
			}
		};
		const worker = async () => {
			while (shared.stop === null && next < pairs.length) {
				const { regionId, typeId } = pairs[next++];
				guarded(`book log ${regionId}/${typeId}`, () => {
					if (!ledger.hasBookLog(regionId, typeId)) derive.ensureBookLog({ raw, ledger, regionId, typeId, index: index || (index = derive.indexPublic(raw)) });
				});
				const check = { regionId, typeId, outcome: 'not-due', at: iso(now()), pages: 1, stamps: {}, history: null };
				let pages = 1;
				let sampledAt = null;
				let failure = null;
				for (let page = 1; page <= Math.min(pages, MARKET_MAX_PAGES) && shared.stop === null; page++) {
					if (routes.marketOrders.calls >= orderCallBudget) {
						shared.stop = { reason: 'budget', message: `${orderCallBudget} order calls` };
						if (failure === null) failure = 'budget';
						break;
					}
					const query = page > 1 ? { type_id: typeId, page } : { type_id: typeId };
					const outcome = tally('marketOrders', await esi.get({ owner: 'public', path: marketOrdersPath(regionId), query }));
					pages = outcome.pages || 1;
					if (page === MARKET_MAX_PAGES && pages > page) truncated++;
					if (outcome.outcome === 'ok' || outcome.outcome === 'not-modified') {
						// the time of this check: the first answer's (a 304 has no fetchedAt; its state does)
						if (sampledAt === null) sampledAt = outcome.outcome === 'ok' ? outcome.fetchedAt : (esi.stateOf('public', marketOrdersPath(regionId), query) || {}).checkedAt || iso(now());
						if (outcome.stored) check.stamps[page] = outcome.fetchedAt;
					}
					if (!isCurrent(outcome)) {
						if (failure === null) failure = outcome.outcome;
						break;
					}
				}
				check.pages = Math.min(pages, MARKET_MAX_PAGES);
				if (Object.keys(check.stamps).length > 0) check.outcome = 'stored';
				else if (failure !== null) check.outcome = failure;
				else if (sampledAt !== null) check.outcome = 'not-modified';
				if (sampledAt !== null) check.at = sampledAt;
				guarded(`book log ${regionId}/${typeId}`, () => derive.updateBookLog({ raw, ledger, regionId, typeId, check }));
				if (shared.stop === null) {
					const history = tally('marketHistory', await esi.get({ owner: 'public', path: marketHistoryPath(regionId), query: { type_id: typeId }, rememberNotFound: true }));
					check.history = outcomeName(history);
				}
				books.push(check);
			}
		};
		await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
		books.sort((a, b) => a.regionId - b.regionId || a.typeId - b.typeId);
		return { routes, errors, shared, truncated, books };
	};

	const doSyncMarket = async ({ regionIds = null, characterIds = null, maxTypes = MARKET_MAX_TYPES, concurrency = MARKET_CONCURRENCY, force = false } = {}) => {
		const startedAt = now();
		const syncedAt = iso(startedAt);
		const previous = loadSyncState('public');
		if (!force && previous.syncedAt && startedAt - Date.parse(previous.syncedAt) < MIN_SYNC_INTERVAL_MS) {
			return { status: 'skipped', reason: 'synced within the last hour', syncedAt: previous.syncedAt };
		}
		const release = acquireLock(dir, 'market');
		if (!release) return { status: 'busy', reason: 'another market sync is running' };
		let errors = [];
		let result;
		try {
			esi.loadLimits();
			const ids = characterIds || tokenStore.list().map(record => record.characterId);
			const regions = regionIds && regionIds.length > 0 ? regionIds : marketRegions({ dataDir: dir, ledger, characterIds: ids, now: startedAt });
			const priorities = marketTypes({ ledger, characterIds: ids, now: startedAt });
			if (regions.length === 0) {
				result = { status: 'skipped', reason: 'no destination region known yet', syncedAt };
			} else if (priorities.size === 0) {
				result = { status: 'skipped', reason: 'no types held, listed, in transit or sold', syncedAt, regionIds: regions };
			} else {
				const perRegion = Math.max(1, Math.floor(maxTypes / regions.length));
				const lastChecked = (regionId, typeId) => {
					const entry = esi.stateOf('public', marketOrdersPath(regionId), { type_id: typeId });
					return entry && entry.checkedAt ? entry.checkedAt : '';
				};
				// A type with no market (a non-tradeable asset) answers 404 on history; that is remembered
				// (rememberNotFound below) and the type no longer takes one of the capped slots.
				const historyMissing = (regionId, typeId) => {
					const entry = esi.stateOf('public', marketHistoryPath(regionId), { type_id: typeId });
					return Boolean(entry && entry.notFound);
				};
				const pairs = [];
				let capped = false;
				for (const regionId of regions) {
					const ordered = [...priorities.entries()]
						.filter(([typeId]) => !historyMissing(regionId, typeId))
						.map(([typeId, priority]) => ({ typeId, priority, checked: lastChecked(regionId, typeId) }))
						.sort((a, b) => a.priority - b.priority || (a.checked < b.checked ? -1 : a.checked > b.checked ? 1 : 0) || a.typeId - b.typeId);
					if (ordered.length > perRegion) capped = true;
					for (const entry of ordered.slice(0, perRegion)) pairs.push({ regionId, typeId: entry.typeId });
				}

				const fetched = await fetchPairs(pairs, { concurrency });
				const { routes, shared } = fetched;
				errors = fetched.errors;
				let status = 'ok';
				if (shared.stop || errors.length > 0) status = 'partial';
				result = {
					status,
					syncedAt,
					regionIds: regions,
					types: pairs.length,
					candidates: priorities.size,
					capped,
					truncated: fetched.truncated,
					calls: shared.calls,
					notModified: routes.marketOrders.notModified + routes.marketHistory.notModified,
					notDue: routes.marketOrders.notDue + routes.marketHistory.notDue,
					stored: routes.marketOrders.stored + routes.marketHistory.stored,
					routes,
					errors,
					stop: shared.stop,
				};
				if (shared.calls > 0) {
					raw.writeSyncLog('public', {
						syncedAt: freshLogTime(startedAt),
						finishedAt: iso(now()),
						source: 'market',
						regionIds: regions,
						typeIds: [...new Set(pairs.map(pair => pair.typeId))].sort((a, b) => a - b),
						status,
						calls: shared.calls,
						errors,
						stop: shared.stop,
						limits: esi.limitsSnapshot(),
						books: fetched.books,
					});
				}
			}
			saveSyncState('public', {
				syncedAt: result.calls > 0 ? syncedAt : previous.syncedAt || null,
				checkedAt: syncedAt,
				status: result.status,
				reason: result.reason || null,
				errors,
				stop: result.stop || null,
				regionIds: result.regionIds || null,
			});
			// the storage budget, while the lock is held anyway
			if (budgetSet()) result.storage = await storageStep({ reason: 'market' });
		} finally {
			try {
				esi.flushLimits();
			} finally {
				release();
			}
		}
		return result;
	};

	const syncMarket = (options = {}) => {
		if (marketRunning) return marketRunning;
		marketRunning = doSyncMarket(options).finally(() => {
			marketRunning = null;
		});
		return marketRunning;
	};

	// ---- the regional book

	const regionBookStateFile = path.join(dir, 'esi-cache', 'public', REGION_BOOK_STATE_FILE);
	const loadRegionBookState = () => {
		try {
			return readJsonFile(regionBookStateFile) || {};
		} catch (e) {
			return {};
		}
	};
	// The bytes a public raw file takes on disk (compressed when gzipped); 0 when it is not there.
	const rawFileBytes = (slug, stamp) => {
		try {
			return raw.bytes('public', slug, stamp) || 0;
		} catch (e) {
			return 0;
		}
	};
	const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));

	// The run itself, under the `market` lock with the limits loaded (doSyncRegionBook below).
	const runRegionBook = async ({ regionId, force, startedAt }) => {
		const ids = tokenStore.list().map(record => record.characterId);
		const region = regionId !== null ? Number(regionId) : (marketRegions({ dataDir: dir, ledger, characterIds: ids, now: startedAt })[0] || null);
		if (region === null) return { status: 'skipped', reason: 'no destination region known yet' };
		const previous = loadRegionBookState();
		const same = previous.regionId === region;
		if (!force && same && previous.syncedAt && startedAt - Date.parse(previous.syncedAt) < REGION_BOOK_INTERVAL_MS) {
			return { status: 'skipped', reason: 'a snapshot was folded within the last hour', regionId: region, syncedAt: previous.syncedAt };
		}

		const apiPath = marketOrdersPath(region);
		const count = { calls: 0, notModified: 0, notDue: 0, tokensUsed: 0, rawBytes: 0, rawBytesStored: 0, orders: 0 };
		const errors = [];
		const byType = new Map(); // type id -> that type's orders, from every page
		const pageStamps = []; // the raw file each page of this snapshot was read from, page 1 first
		let pages = 1;
		let pagesRead = 0;
		let fetchedAt = null; // the snapshot's time: page 1's answer, or this run's start (below)
		let stop = null;
		let status = 'ok';
		let alreadyFolded = false;

		// Every page of the region's whole book; one that does not come ends the run, nothing folded.
		for (let page = 1; page <= pages; page++) {
			const query = regionBookQuery(page);
			const result = await esi.get({ owner: 'public', path: apiPath, query });
			let body = null;
			let stamp = null;
			let at = null;
			let failure = null;
			switch (result.outcome) {
				case 'ok':
					count.calls++;
					count.tokensUsed += 2;
					count.rawBytes += JSON.stringify(result.body).length;
					body = result.body;
					at = result.fetchedAt;
					if (result.stored) {
						stamp = result.fetchedAt;
						count.rawBytesStored += rawFileBytes(result.slug, stamp);
					} else {
						stamp = raw.latestStamp('public', result.slug); // same body as the newest file: nothing stored
					}
					break;
				case 'not-modified':
				case 'not-due': {
					if (result.outcome === 'not-modified') {
						count.calls++;
						count.tokensUsed += 1;
						count.notModified++;
					} else {
						count.notDue++;
					}
					const held = raw.latest('public', result.slug);
					if (held) {
						body = held.body;
						stamp = held.fetchedAt;
					}
					const checked = esi.stateOf('public', apiPath, query);
					at = (checked && checked.checkedAt) || (held && held.fetchedAt) || null;
					if (body === null) failure = { route: 'marketOrders', outcome: 'error', status: null, message: `page ${page}: the stored page is missing` };
					break;
				}
				case 'paused':
					status = 'paused';
					stop = { reason: result.reason === 'group' ? 'paused' : 'error-limit', until: result.until, group: result.group || null };
					break;
				case 'rate-limited':
					count.calls++;
					status = 'partial';
					stop = { reason: 'rate-limited', retryAfter: result.retryAfter, until: result.until };
					break;
				default:
					if (result.status) count.calls++;
					failure = { route: 'marketOrders', outcome: result.outcome, status: result.status || null, message: `page ${page}: ${result.message || result.kind || result.outcome}` };
			}
			if (failure === null && stop === null && !Array.isArray(body)) failure = { route: 'marketOrders', outcome: 'error', status: null, message: `page ${page}: the answer was not a list` };
			if (failure !== null) {
				status = 'partial';
				if (errors.length < MAX_ERRORS_KEPT) errors.push(failure);
				stop = { reason: 'errors', message: failure.message };
			}
			if (stop !== null) break;

			pagesRead++;
			pageStamps.push(stamp);
			if (page === 1) {
				fetchedAt = at;
				pages = result.pages || 1;
				// Inside the page's own Expires, with that snapshot folded already: nothing new to take.
				if (result.outcome === 'not-due' && same && previous.foldedAt && at <= previous.foldedAt) {
					alreadyFolded = true;
					break;
				}
				// A page 1 still cached from a run that did not fold (a later page failed) dates the
				// snapshot by this run: per-type checks may have been folded since that run, all before
				// the `market` lock was taken at startedAt, and inside the 5-minute cache page 1 is what
				// ESI would serve now (as a hash-equal 200 is dated by its own new stamp). The sync log
				// entry carries this time, so the rebuild replays the snapshot at the same place.
				if (result.outcome === 'not-due') fetchedAt = iso(startedAt);
				if (pages > REGION_BOOK_MAX_PAGES) {
					status = 'partial';
					stop = { reason: 'too-many-pages', message: `${pages} pages; the cap is ${REGION_BOOK_MAX_PAGES}` };
					break;
				}
			}
			for (const row of body) {
				if (row === null || typeof row !== 'object') continue;
				const typeId = Number(row.type_id);
				if (!Number.isSafeInteger(typeId) || typeId <= 0) continue;
				count.orders++;
				const rows = byType.get(typeId);
				if (rows === undefined) byType.set(typeId, [row]);
				else rows.push(row);
			}
		}
		if (alreadyFolded) return { status: 'skipped', reason: 'this snapshot was folded already', regionId: region, fetchedAt };

		// The fold, only of a whole snapshot. A type with orders is one sample of its book; a type that
		// has a log but no orders now is a sample with none (its orders ended).
		const fold = { typesFolded: 0, typesEnded: 0, logsCreated: 0, foldErrors: 0, logBytesBefore: 0, logBytesAfter: 0 };
		if (stop === null) {
			const existing = new Set(ledger.listBookLogs(region));
			const held = derive.bookPages(raw); // per-type raw books, so a log is built from them before its first regional sample
			let index = null;
			const typeIds = [...byType.keys()].sort((a, b) => a - b);
			const ended = [...existing].filter(typeId => !byType.has(typeId));
			let done = 0;
			const foldType = (typeId, rows) => {
				try {
					const before = ledger.bookLogBytes(region, typeId);
					if (!existing.has(typeId) && held.has(`${region}:${typeId}`)) derive.ensureBookLog({ raw, ledger, regionId: region, typeId, index: index || (index = derive.indexPublic(raw)) });
					const after = derive.updateBookLogWithRows({ ledger, regionId: region, typeId, at: fetchedAt, rows });
					fold.typesFolded++;
					fold.logBytesBefore += before;
					fold.logBytesAfter += after;
					if (!existing.has(typeId)) fold.logsCreated++;
					return true;
				} catch (e) {
					fold.foldErrors++;
					log.warn(`book log ${region}/${typeId}: ${e.message}`);
					if (errors.length < MAX_ERRORS_KEPT) errors.push({ route: 'bookLog', outcome: 'error', status: null, message: `book log ${region}/${typeId}: ${String(e.message).slice(0, 150)}` });
					return false;
				}
			};
			for (const typeId of typeIds) {
				foldType(typeId, byType.get(typeId));
				if (++done % REGION_BOOK_YIELD_EVERY === 0) await yieldToLoop(); // a synchronous loop of thousands of files must not starve the server
			}
			for (const typeId of ended) {
				if (foldType(typeId, [])) fold.typesEnded++;
				if (++done % REGION_BOOK_YIELD_EVERY === 0) await yieldToLoop();
			}
			if (fold.foldErrors > 0) status = 'partial';
		}
		const typesInSnapshot = byType.size;
		byType.clear();

		const folded = stop === null;
		const finishedAt = now();
		const measurement = {
			kind: 'regionBook',
			regionId: region,
			fetchedAt,
			pages,
			pagesRead,
			calls: count.calls,
			notModified: count.notModified,
			notDue: count.notDue,
			tokensUsed: count.tokensUsed,
			rawBytes: count.rawBytes,
			rawBytesStored: count.rawBytesStored,
			orders: count.orders,
			typesInSnapshot: folded ? typesInSnapshot : 0,
			typesFolded: fold.typesFolded,
			typesEnded: fold.typesEnded,
			logsCreated: fold.logsCreated,
			foldErrors: fold.foldErrors,
			logBytesBefore: fold.logBytesBefore,
			logBytesAfter: fold.logBytesAfter,
			elapsedMs: finishedAt - startedAt,
			partial: status !== 'ok',
			limits: esi.limitsSnapshot(),
		};
		const logTime = freshLogTime(startedAt);
		if (count.calls > 0 || folded) {
			// `books: []` because no per-type check is recorded here (derive.indexPublic reads the field);
			// `pageStamps` names the raw page files the snapshot was cut from, for a rebuild to replay.
			raw.writeSyncLog('public', { syncedAt: logTime, finishedAt: iso(finishedAt), status, errors, stop, books: [], pageStamps, ...measurement });
		}
		writeFileAtomic(regionBookStateFile, JSON.stringify({
			regionId: region,
			syncedAt: folded ? logTime : (same ? previous.syncedAt || null : null),
			foldedAt: folded ? fetchedAt : (same ? previous.foldedAt || null : null),
			checkedAt: logTime,
			status,
			reason: stop ? stop.reason : null,
			pages,
			tokensUsed: count.tokensUsed,
		}, null, '\t') + '\n');
		log.info(`region book ${region}: ${status}, ${pagesRead}/${pages} pages, ${count.tokensUsed} tokens, ${fold.typesFolded} logs folded (${fold.logsCreated} new)`);
		// the storage budget after a run that wrote raw or folded (the lock is held)
		const storageResult = (count.calls > 0 || folded) && budgetSet() ? await storageStep({ reason: 'regionBook' }) : null;
		return { status, syncedAt: logTime, ...(stop ? { reason: regionBookStopText(stop) } : {}), ...measurement, errors, stop, ...(storageResult ? { storage: storageResult } : {}) };
	};

	// One snapshot of a region's whole order book, folded into the per-type book logs. options:
	// {regionId? (default: the destination region, as the market snapshot chooses it), force?
	// (an unforced run skips when one folded within the hour), defer? (the caller says an export run
	// is going: the run draws on the market-order bucket the page shares, so it waits)}.
	const doSyncRegionBook = async ({ regionId = null, force = false, defer = false } = {}) => {
		if (defer) return { status: 'deferred', reason: 'an export run is in progress' };
		const startedAt = now();
		const release = acquireLock(dir, 'market');
		if (!release) return { status: 'busy', reason: 'another market sync is running' };
		try {
			esi.loadLimits();
			return await runRegionBook({ regionId, force, startedAt });
		} finally {
			try {
				esi.flushLimits();
			} finally {
				release();
			}
		}
	};

	const syncRegionBook = (options = {}) => {
		if (regionBookRunning) return regionBookRunning;
		regionBookRunning = doSyncRegionBook(options).finally(() => {
			regionBookRunning = null;
		});
		return regionBookRunning;
	};

	// ---- the storage budget

	// The settings, read from the environment at each use; a setting that does not parse is logged
	// once (per message) and counts as no budget.
	const storageWarned = new Set();
	const storageConfig = () => {
		const settings = storageSettings(env);
		if (settings.error !== null && !storageWarned.has(settings.error)) {
			storageWarned.add(settings.error);
			log.warn(`${settings.error}: no storage budget is applied`);
		}
		return settings;
	};
	const budgetSet = () => storageConfig().budgetBytes !== null;
	const usageNow = () => storage.measureUsage({ raw, ledger, runs });
	// storageStatus's measurement, kept STORAGE_USAGE_CACHE_MS; {usage, at (ms)}, or null
	let usageCache = null;
	const cachedUsage = () => {
		const t = now();
		if (usageCache === null || t - usageCache.at >= STORAGE_USAGE_CACHE_MS || t < usageCache.at) usageCache = { usage: usageNow(), at: t };
		return usageCache;
	};

	// One storage run; the caller holds the `market` lock. Measures each kind (file sizes), and only
	// when the total is over the budget reads the book logs, plans the trim and applies it. Answers
	// {status: 'ok', ...the entry, lastTrimAt}, or {status: 'no-budget', usage} without a budget (no
	// entry, nothing changed), or {status: 'failed', reason}: a failure is this step's own.
	const storageStep = async ({ reason }) => {
		usageCache = null; // what the step trims, the next status measures afresh
		try {
			const config = storageConfig();
			if (config.budgetBytes === null) {
				const usage = usageNow();
				return { status: 'no-budget', reason, budgetBytes: null, shares: config.shares, usage, total: storage.totalOf(usage), ...(config.error ? { error: config.error } : {}) };
			}
			const startedAt = now();
			const before = usageNow();
			const totalBefore = storage.totalOf(before);
			let plan = null;
			let removed = storage.emptyRemoved();
			if (totalBefore > config.budgetBytes) {
				const kinds = await storage.measureKinds({ raw, ledger, runs, now: startedAt, log });
				plan = planTrim({ budgetBytes: config.budgetBytes, shares: config.shares, kinds });
				removed = await storage.applyTrims({ raw, ledger, runs, plan, kinds, log, now: startedAt });
			}
			const trimmed = storage.trimmedAnything(removed);
			const usage = trimmed ? usageNow() : before;
			const totalAfter = storage.totalOf(usage);
			const syncedAt = freshLogTime(startedAt);
			const entry = {
				kind: 'storage',
				syncedAt,
				finishedAt: iso(now()),
				reason,
				budgetBytes: config.budgetBytes,
				shares: config.shares,
				usage,
				totalBefore,
				totalAfter,
				// over the budget with nothing left to trim above the floors: what is still over, on disk
				// (the planner's own figure leans on the book logs' estimate)
				unmet: plan && plan.unmet > 0 ? Math.max(0, totalAfter - config.budgetBytes) : 0,
				trims: removed,
				elapsedMs: now() - startedAt,
			};
			raw.writeSyncLog('public', entry);
			const previous = storage.readState(dir) || {};
			const lastTrim = trimmed ? { at: syncedAt, trims: removed } : previous.lastTrim || null;
			storage.writeState(dir, { ...entry, lastTrim });
			if (trimmed) log.info(`storage: ${storage.totalOf(before)} -> ${entry.totalAfter} bytes of a ${config.budgetBytes} byte budget`);
			return { status: 'ok', ...entry, lastTrim, lastTrimAt: lastTrim ? lastTrim.at : null };
		} catch (e) {
			log.warn(`storage: ${e.message}`);
			return { status: 'failed', reason: String(e.message).slice(0, 200) };
		}
	};

	// One storage run on request (scripts/sync.js --storage, POST /api/sync {storage: true}), with or
	// without a budget: without one it only measures. Takes the `market` lock; busy while another
	// market job holds it. A run already going answers every caller.
	const runStorage = ({ reason = 'manual' } = {}) => {
		if (storageRunning) return storageRunning;
		storageRunning = (async () => {
			const release = acquireLock(dir, 'market');
			if (!release) return { status: 'busy', reason: 'another market sync is running' };
			try {
				return await storageStep({ reason });
			} finally {
				release();
			}
		})().finally(() => {
			storageRunning = null;
		});
		return storageRunning;
	};

	// The budget, the shares, each kind's bytes (measured at most once a minute, and afresh after a
	// storage run; `measuredAt` says when) and how the last run ended, for GET /api/config. `unmet` is
	// the last run's, while the budget is the one it ran under.
	const storageStatus = () => {
		const config = storageConfig();
		const { usage, at } = cachedUsage();
		const last = storage.readState(dir);
		const sameBudget = Boolean(last) && config.budgetBytes !== null && last.budgetBytes === config.budgetBytes;
		return {
			budget: config.budgetBytes,
			shares: config.shares,
			usage,
			total: storage.totalOf(usage),
			measuredAt: iso(at),
			lastTrimAt: last && last.lastTrim ? last.lastTrim.at : null,
			unmet: sameBudget ? last.unmet || 0 : 0,
			error: config.error,
			last: last || null,
		};
	};

	// ---- the watch refresh

	// One character's step of a tick, under its lock: the open orders when due, folded into the order
	// log. `tick.stop` is set when the whole tick has to end (the legacy error limit, a 420/429).
	const watchCharacter = async (id, tick) => {
		let record = null;
		try {
			record = tokenStore.get(id);
		} catch (e) {
			return { status: 'failed', reason: 'token store unreadable' };
		}
		if (!record) return { status: 'failed', reason: 'not linked' };
		const base = { name: record.name };
		if (record.status === 'relink') return { ...base, status: 'relink', reason: record.lastError || 'needs re-linking' };
		if (!Array.isArray(record.scopes) || !record.scopes.includes(SCOPES.orders)) return { ...base, status: 'skipped', reason: `missing scope ${SCOPES.orders}` };
		const release = acquireLock(dir, `character-${id}`);
		if (!release) return { ...base, status: 'busy', reason: 'another sync is running for this character' };
		try {
			derive.ensureOrderLog({ raw, ledger, characterId: id });
			const ordersPath = `/characters/${id}/orders`;
			const result = await esi.get({ owner: id, path: ordersPath });
			const out = { ...base, status: 'ok', orders: outcomeName(result), checkedAt: null, expires: null, openSellOrders: 0 };
			switch (result.outcome) {
				case 'ok':
					if (result.stored) foldOrderLog(id, [{ fetchedAt: result.fetchedAt, body: result.body }]);
					break;
				case 'not-modified':
				case 'not-due':
					break;
				case 'paused':
					out.status = 'paused';
					out.reason = 'the error limit is low';
					tick.stop = { reason: 'error-limit', until: result.until };
					break;
				case 'rate-limited':
					out.status = 'rate-limited';
					out.reason = `${result.status}`;
					tick.stop = { reason: 'rate-limited', retryAfter: result.retryAfter, until: result.until, message: `orders: ${result.status}` };
					break;
				case 'auth':
					// never retried: esi.get already dropped the cached access token, so the next call refreshes
					out.status = result.code === 'relink' || result.code === 'not-linked' ? 'relink' : 'failed';
					out.reason = result.message;
					break;
				default:
					out.status = 'failed';
					out.reason = result.message || result.kind || result.outcome;
			}
			const checked = esi.stateOf(id, ordersPath);
			if (checked) {
				out.checkedAt = checked.checkedAt || null;
				out.expires = checked.expires || null;
			}
			out.openSellOrders = Object.values(ledger.readOrderLog(id)).filter(entry => entry.end === null && !entry.isBuy).length;
			return out;
		} finally {
			release();
		}
	};

	// The market step of a tick, under the `market` lock: book and history of every type the
	// characters have an open sell order of, in the watched regions.
	const watchMarket = async ({ ids, regionIds, startedAt }) => {
		const regions = regionIds && regionIds.length > 0 ? regionIds : marketRegions({ dataDir: dir, ledger, characterIds: ids, now: startedAt });
		if (regions.length === 0) return { status: 'skipped', reason: 'no destination region known yet', regionIds: [], types: [] };
		const wanted = new Map();
		for (const id of ids) {
			for (const entry of Object.values(ledger.readOrderLog(id))) {
				if (entry.end === null && !entry.isBuy && regions.includes(entry.regionId)) wanted.set(`${entry.regionId}:${entry.typeId}`, { regionId: entry.regionId, typeId: entry.typeId });
			}
		}
		const pairs = [...wanted.values()].sort((a, b) => a.regionId - b.regionId || a.typeId - b.typeId);
		if (pairs.length === 0) return { status: 'skipped', reason: 'no open sell orders in the watched regions', regionIds: regions, types: [] };
		const release = acquireLock(dir, 'market');
		if (!release) return { status: 'busy', reason: 'another market sync is running', regionIds: regions, types: [] };
		try {
			const fetched = await fetchPairs(pairs, { concurrency: MARKET_CONCURRENCY });
			const { shared } = fetched;
			if (shared.calls > 0) {
				raw.writeSyncLog('public', {
					syncedAt: freshLogTime(startedAt),
					finishedAt: iso(now()),
					source: 'watch',
					regionIds: regions,
					typeIds: [...new Set(pairs.map(pair => pair.typeId))].sort((a, b) => a - b),
					status: shared.stop || fetched.errors.length > 0 ? 'partial' : 'ok',
					calls: shared.calls,
					errors: fetched.errors,
					stop: shared.stop,
					limits: esi.limitsSnapshot(),
					books: fetched.books,
				});
			}
			return {
				status: shared.stop || fetched.errors.length > 0 ? 'partial' : 'ok',
				regionIds: regions,
				calls: shared.calls,
				truncated: fetched.truncated,
				types: fetched.books,
				errors: fetched.errors,
				stop: shared.stop,
			};
		} finally {
			release();
		}
	};

	const doWatch = async ({ characterIds = null, regionIds = null } = {}) => {
		const startedAt = now();
		const tickedAt = iso(startedAt);
		const tick = { stop: null };
		const characters = {};
		let market = null;
		esi.loadLimits();
		try {
			const ids = characterIds === null ? tokenStore.list().map(record => record.characterId) : characterIds;
			for (const id of ids) {
				if (tick.stop !== null) {
					characters[id] = { status: 'skipped', reason: `the tick stopped (${tick.stop.reason})` };
					continue;
				}
				try {
					characters[id] = await watchCharacter(id, tick);
				} catch (e) {
					log.warn(`watch ${id}: ${e.message}`);
					characters[id] = { status: 'failed', reason: String(e.message).slice(0, 200) };
				}
			}
			if (tick.stop !== null) {
				market = { status: 'skipped', reason: `the tick stopped (${tick.stop.reason})`, regionIds: [], types: [] };
			} else {
				try {
					market = await watchMarket({ ids, regionIds, startedAt });
				} catch (e) {
					log.warn(`watch market: ${e.message}`);
					market = { status: 'failed', reason: String(e.message).slice(0, 200), regionIds: [], types: [] };
				}
			}
		} finally {
			esi.flushLimits();
		}
		const result = { tickedAt, finishedAt: iso(now()), characters, market, stop: tick.stop || (market && market.stop) || null };
		writeFileAtomic(path.join(dir, 'esi-cache', 'public', WATCH_STATE_FILE), JSON.stringify(result, null, '\t') + '\n');
		return result;
	};

	// options: {characterIds? (default: every linked one), regionIds? (default: marketRegions)}.
	// A tick already running answers every caller.
	const syncWatch = (options = {}) => {
		if (watchRunning) return watchRunning;
		watchRunning = doWatch(options).finally(() => {
			watchRunning = null;
		});
		return watchRunning;
	};

	// The last tick as _watch.json holds it, and whether one is running now.
	const watchStatus = () => {
		let saved = null;
		try {
			saved = readJsonFile(path.join(dir, 'esi-cache', 'public', WATCH_STATE_FILE));
		} catch (e) {
			saved = null;
		}
		return { tickedAt: null, finishedAt: null, characters: {}, market: null, stop: null, ...(saved || {}), running: watchRunning !== null };
	};

	// ---- all of it

	// options: {characterIds?, force?, market? (default true), regionIds?, maxTypes?, regionBook?, storage?}.
	// Characters one after another (the legacy error limit is shared), then the market snapshot, then
	// the regional book. The regional book runs when `regionBook` is true, or when it is left out and
	// EFLIP_REGION_BOOK=1; `regionBook: false` never runs it. `market: false` is the caller deferring
	// work that draws on the market-order bucket (an export run is going), so a run that is only
	// enabled by the environment answers `deferred` then; `regionBook: true` is an explicit request
	// and goes ahead, ignoring the hour (the ESI cache windows still apply).
	const syncAll = async ({ characterIds = null, force = false, market = true, regionIds = null, maxTypes, regionBook, storage: storageWanted = false } = {}) => {
		const startedAt = iso(now());
		const linked = tokenStore.list().map(record => record.characterId);
		const ids = characterIds === null ? linked : characterIds;
		const characters = [];
		for (const id of ids) characters.push(await syncCharacter(id, { force }));
		let marketResult = null;
		if (market !== false) {
			marketResult = await syncMarket({ force, regionIds, characterIds: linked, ...(maxTypes ? { maxTypes } : {}) });
		}
		let regionBookResult = null;
		if (regionBook === true || (regionBook === undefined && regionBookEnabled(env))) {
			try {
				regionBookResult = await syncRegionBook({
					regionId: regionIds && regionIds.length > 0 ? regionIds[0] : null,
					force: force || regionBook === true,
					defer: market === false && regionBook !== true,
				});
			} catch (e) {
				// the characters and the market are done and kept; this step's failure is its own
				log.warn(`region book: ${e.message}`);
				regionBookResult = { status: 'failed', reason: String(e.message).slice(0, 200) };
			}
		}
		// `storage: true` runs the storage step once more at the end, with or without a budget; else the
		// answer carries the last one the market step or the region book ran
		let storageResult = null;
		if (storageWanted === true) storageResult = await runStorage({ reason: 'manual' });
		else storageResult = (regionBookResult && regionBookResult.storage) || (marketResult && marketResult.storage) || null;
		return { startedAt, finishedAt: iso(now()), characters, market: marketResult, regionBook: regionBookResult, storage: storageResult };
	};

	// ---- reads for the API

	const characterStatus = (characterId) => {
		const id = Number(characterId);
		const state = loadSyncState(id);
		return {
			syncedAt: state.syncedAt || null,
			checkedAt: state.checkedAt || null,
			status: state.status || null,
			reason: state.reason || null,
			errors: state.errors || [],
			stop: state.stop || null,
			missingScopes: state.missingScopes || [],
			pausedGroups: state.pausedGroups || {},
			running: running.has(id),
			progress: progress.get(id) || null,
		};
	};

	// Whether the hourly sync takes the regional book, and how the last run ended.
	const regionBookStatus = () => {
		const state = loadRegionBookState();
		return {
			enabled: regionBookEnabled(env),
			regionId: state.regionId || null,
			syncedAt: state.syncedAt || null,
			checkedAt: state.checkedAt || null,
			status: state.status || null,
			reason: state.reason || null,
			running: regionBookRunning !== null,
		};
	};

	const status = () => {
		const characters = {};
		for (const record of tokenStore.list()) characters[record.characterId] = characterStatus(record.characterId);
		const market = loadSyncState('public');
		return {
			characters,
			regionBook: regionBookStatus(),
			market: {
				syncedAt: market.syncedAt || null,
				checkedAt: market.checkedAt || null,
				status: market.status || null,
				reason: market.reason || null,
				stop: market.stop || null,
				running: marketRunning !== null,
			},
		};
	};

	// The latest stored orders and history for each type in each region, from raw. `regionIds`
	// defaults to the regions of the newest market sync.
	const readMarket = ({ typeIds, regionIds = null, log: withLog = false }) => {
		let regions = regionIds;
		if (regions === null) {
			// the newest market or watch entry: the regional book's and the storage runs' entries
			// (`kind`) name no regions here
			const stamps = raw.syncLogStamps('public');
			let entry = null;
			for (let i = stamps.length - 1; i >= 0 && entry === null; i--) {
				const candidate = raw.readSyncLog('public', stamps[i]);
				if (!candidate || candidate.kind === undefined) entry = candidate || {};
			}
			regions = entry && Array.isArray(entry.regionIds) ? entry.regionIds : [];
		}
		const types = {};
		for (const typeId of typeIds) {
			types[typeId] = {};
			for (const regionId of regions) {
				const ordersQuery = { type_id: typeId };
				const first = raw.latest('public', slugFor(marketOrdersPath(regionId), ordersQuery));
				let orders = null;
				if (first) {
					const checked = esi.stateOf('public', marketOrdersPath(regionId), ordersQuery);
					let rows = Array.isArray(first.body) ? first.body : [];
					const pages = checked && checked.pages ? Math.min(checked.pages, MARKET_MAX_PAGES) : 1;
					for (let page = 2; page <= pages; page++) {
						const more = raw.latest('public', slugFor(marketOrdersPath(regionId), { type_id: typeId, page }));
						if (more && Array.isArray(more.body)) rows = rows.concat(more.body);
					}
					orders = { fetchedAt: first.fetchedAt, checkedAt: checked ? checked.checkedAt : null, rows };
				}
				const historyQuery = { type_id: typeId };
				const history = raw.latest('public', slugFor(marketHistoryPath(regionId), historyQuery));
				const historyState = esi.stateOf('public', marketHistoryPath(regionId), historyQuery);
				types[typeId][regionId] = {
					orders,
					history: history ? { fetchedAt: history.fetchedAt, checkedAt: historyState ? historyState.checkedAt : null, rows: Array.isArray(history.body) ? history.body : [] } : null,
					...(withLog ? { log: ledger.hasBookLog(regionId, typeId) ? ledger.readBookLog(regionId, typeId) : null } : {}),
				};
			}
		}
		const state = loadSyncState('public');
		return { regionIds: regions, syncedAt: state.syncedAt || null, types };
	};

	return { esi, raw, ledger, runs, syncCharacter, syncMarket, syncRegionBook, syncWatch, syncAll, runStorage, storageStatus, purgeCharacter, status, watchStatus, characterStatus, regionBookStatus, readMarket };
};

module.exports = {
	createSyncService,
	marketTypes,
	marketRegions,
	regionBookEnabled,
	createRegionBookScheduler,
	storageSettings,
	SCOPES,
	MIN_SYNC_INTERVAL_MS,
	TRANSACTIONS_PAGE_SIZE,
	MARKET_MAX_TYPES,
	MARKET_MAX_TYPE_IDS,
};
