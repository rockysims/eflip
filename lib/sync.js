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
const fs = require('fs');
const path = require('path');
const { createEsiClient, slugFor, DEFAULT_USER_AGENT, DEFAULT_COMPAT_DATE } = require('./esi');
const { createLedger } = require('./ledger');
const derive = require('./derive');
const { acquireLock, readJsonFile, writeFileAtomic } = require('./dataFiles');

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

const marketOrdersPath = (regionId) => `/markets/${regionId}/orders`;
const marketHistoryPath = (regionId) => `/markets/${regionId}/history`;

// ---- the service

// options: {dataDir, tokens: {accessTokenFor(id), forget(id)}, tokenStore, fetch, now, log,
// userAgent, compatDate}. Nothing touches the disk until a sync or a read.
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
}) => {
	const dir = path.resolve(dataDir);
	const esi = createEsiClient({ dataDir: dir, fetch, now, tokens, userAgent, compatDate, timeoutMs });
	const raw = esi.raw;
	const ledger = createLedger({ dataDir: dir });

	const running = new Map(); // characterId -> Promise<result>
	const progress = new Map(); // characterId -> {route, page, pages}
	let marketRunning = null;

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
			await walkPages('ordersHistory', `/characters/${id}/orders/history`, rows => addRows('ordersHistory', 'orders-history', rows));
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
		let made = 0;
		for (const structureId of wanted) {
			if (made >= MAX_STRUCTURE_CALLS) break;
			const result = await call('structures', { path: `/universe/structures/${structureId}`, rememberForbidden: true, rememberNotFound: true });
			if (result.outcome === 'ok') {
				made++;
				if (result.stored) {
					names[String(structureId)] = derive.structureEntry({ body: result.body, fetchedAt: result.fetchedAt }, id);
					ledger.writeStructures(names);
					ctx.rowsAdded.structures++;
					ctx.routes.structures.rowsAdded++;
				}
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

	// Deletes everything synced for a character: ledger, raw and the ESI bookkeeping. Raw has to go
	// too: a ledger deleted alone is rebuilt from raw by the next sync, as it should be (the ledger
	// is only a view). The shared structure names stay. Throws while a sync of the character runs.
	const purgeCharacter = (characterId) => {
		const id = Number(characterId);
		if (running.has(id)) throw new Error(`character ${id} is being synced`);
		const release = acquireLock(dir, `character-${id}`);
		if (!release) throw new Error(`character ${id} is being synced`);
		try {
			for (const target of ['ledger', 'raw', 'esi-cache']) fs.rmSync(path.join(dir, target, String(id)), { recursive: true, force: true });
		} finally {
			release();
		}
	};

	// ---- the destination market

	const doSyncMarket = async ({ regionIds = null, characterIds = null, maxTypes = MARKET_MAX_TYPES, concurrency = MARKET_CONCURRENCY, force = false } = {}) => {
		const startedAt = now();
		const syncedAt = iso(startedAt);
		const previous = loadSyncState('public');
		if (!force && previous.syncedAt && startedAt - Date.parse(previous.syncedAt) < MIN_SYNC_INTERVAL_MS) {
			return { status: 'skipped', reason: 'synced within the last hour', syncedAt: previous.syncedAt };
		}
		const release = acquireLock(dir, 'market');
		if (!release) return { status: 'busy', reason: 'another market sync is running' };
		const routes = { marketOrders: newTally(), marketHistory: newTally() };
		const errors = [];
		const shared = { calls: 0, stop: null, failures: 0 };
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
				const pairs = [];
				let capped = false;
				for (const regionId of regions) {
					const ordered = [...priorities.entries()]
						.map(([typeId, priority]) => ({ typeId, priority, checked: lastChecked(regionId, typeId) }))
						.sort((a, b) => a.priority - b.priority || (a.checked < b.checked ? -1 : a.checked > b.checked ? 1 : 0) || a.typeId - b.typeId);
					if (ordered.length > perRegion) capped = true;
					for (const entry of ordered.slice(0, perRegion)) pairs.push({ regionId, typeId: entry.typeId });
				}

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
				let truncated = 0;
				let next = 0;
				const worker = async () => {
					while (shared.stop === null && next < pairs.length) {
						const { regionId, typeId } = pairs[next++];
						let pages = 1;
						for (let page = 1; page <= Math.min(pages, MARKET_MAX_PAGES) && shared.stop === null; page++) {
							if (routes.marketOrders.calls >= orderCallBudget) {
								shared.stop = { reason: 'budget', message: `${orderCallBudget} order calls` };
								break;
							}
							const outcome = tally('marketOrders', await esi.get({ owner: 'public', path: marketOrdersPath(regionId), query: page > 1 ? { type_id: typeId, page } : { type_id: typeId } }));
							pages = outcome.pages || 1;
							if (page === MARKET_MAX_PAGES && pages > page) truncated++;
							if (!isCurrent(outcome)) break;
						}
						if (shared.stop === null) tally('marketHistory', await esi.get({ owner: 'public', path: marketHistoryPath(regionId), query: { type_id: typeId } }));
					}
				};
				await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

				let status = 'ok';
				if (shared.stop || errors.length > 0) status = 'partial';
				result = {
					status,
					syncedAt,
					regionIds: regions,
					types: pairs.length,
					candidates: priorities.size,
					capped,
					truncated,
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
						syncedAt,
						finishedAt: iso(now()),
						regionIds: regions,
						typeIds: [...new Set(pairs.map(pair => pair.typeId))].sort((a, b) => a - b),
						status,
						calls: shared.calls,
						errors,
						stop: shared.stop,
						limits: esi.limitsSnapshot(),
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

	// ---- all of it

	// options: {characterIds?, force?, market? (default true), regionIds?}. Characters one after
	// another (the legacy error limit is shared), then the market snapshot.
	const syncAll = async ({ characterIds = null, force = false, market = true, regionIds = null, maxTypes } = {}) => {
		const startedAt = iso(now());
		const linked = tokenStore.list().map(record => record.characterId);
		const ids = characterIds === null ? linked : characterIds;
		const characters = [];
		for (const id of ids) characters.push(await syncCharacter(id, { force }));
		let marketResult = null;
		if (market !== false) {
			marketResult = await syncMarket({ force, regionIds, characterIds: linked, ...(maxTypes ? { maxTypes } : {}) });
		}
		return { startedAt, finishedAt: iso(now()), characters, market: marketResult };
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

	const status = () => {
		const characters = {};
		for (const record of tokenStore.list()) characters[record.characterId] = characterStatus(record.characterId);
		const market = loadSyncState('public');
		return {
			characters,
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
	const readMarket = ({ typeIds, regionIds = null }) => {
		let regions = regionIds;
		if (regions === null) {
			const stamps = raw.syncLogStamps('public');
			const entry = stamps.length === 0 ? null : raw.readSyncLog('public', stamps[stamps.length - 1]);
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
				};
			}
		}
		const state = loadSyncState('public');
		return { regionIds: regions, syncedAt: state.syncedAt || null, types };
	};

	return { esi, raw, ledger, syncCharacter, syncMarket, syncAll, purgeCharacter, status, characterStatus, readMarket };
};

module.exports = {
	createSyncService,
	marketTypes,
	marketRegions,
	SCOPES,
	MIN_SYNC_INTERVAL_MS,
	TRANSACTIONS_PAGE_SIZE,
	MARKET_MAX_TYPES,
	MARKET_MAX_TYPE_IDS,
};
