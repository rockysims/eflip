// results.js: the trade results page (results.html). Phase 6 of docs/trade-results-plan.md ("UI").
//
// What it shows: what the export runs really did (bought, hauled, sold, fees, what is left), from the
// linked characters' synced ledgers, worked out by results-calc.js. Every figure is the user's own
// ESI data via the server's /api routes (no token ever reaches this page); item names and packaged
// volumes are the public type lookups of util.js; "at market" prices come from the destination market
// snapshot the last sync stored (GET /api/market), so nothing shown is missing from disk.
//
// Flow: config -> characters, sync status, runs, ledger -> (snapshots for the window) -> compute()
// on the main thread -> render. A sync that finishes (this page started it, or another page or the
// script did) reloads the data; the last result stays on screen meanwhile.
(() => {
	if (typeof document === 'undefined') return;

	const $ = (sel) => document.querySelector(sel);

	//--- constants

	const { constants: C } = util;
	// Duplicates export.js's STATIONS for now; Phase 7 unifies them into one shared table.
	const STATIONS = {
		Jita: { regionId: C.JITA_REGION_ID, stationId: C.JITA_STATION_ID },
		Amarr: { regionId: C.AMARR_REGION_ID, stationId: C.AMARR_STATION_ID },
		Dodixie: { regionId: C.DODIXIE_REGION_ID, stationId: C.DODIXIE_STATION_ID },
		Rens: { regionId: C.RENS_REGION_ID, stationId: C.RENS_STATION_ID },
		Stacmon: { regionId: C.STACMON_REGION_ID, stationId: C.STACMON_STATION_ID }
	};
	const DAY_MS = 24 * 60 * 60 * 1000;
	const POLL_MS = 3000;           // GET /api/sync while a sync runs
	const STALE_WARN_DAYS = 25;     // ESI keeps about 30 days of wallet rows and contracts
	const SNAPSHOT_MARGIN_DAYS = 7; // snapshots are read from this long before the window starts
	const MARKET_CHUNK = 400;       // /api/market takes at most 500 type ids
	const LOGIN_URL = '/sso/login?return=/results.html';
	const DASH = '—';
	const MINUS = '−';
	const ARROW = '→';

	//--- localStorage (guarded)

	const PREFIX = 'eflip.results.';
	const lsGet = (key, fallback) => {
		try {
			const raw = localStorage.getItem(PREFIX + key);
			return raw === null ? fallback : JSON.parse(raw);
		} catch (e) { return fallback; }
	};
	const lsSet = (key, val) => {
		try { localStorage.setItem(PREFIX + key, JSON.stringify(val)); } catch (e) { /* ignore */ }
	};

	//--- formatting

	const nf = new Intl.NumberFormat('en-US');
	const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
	const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
	const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

	// ISK for a cell: 12.3k, 4.56M, 1.23B. The exact figure goes in the tooltip (fmtExact).
	const fmtIsk = (v, signed = false) => {
		if (!isNum(v)) return DASH;
		const a = Math.abs(v);
		let body;
		if (a >= 1e9) body = (a / 1e9).toFixed(a >= 1e10 ? 1 : 2) + 'B';
		else if (a >= 1e6) body = (a / 1e6).toFixed(a >= 1e8 ? 1 : 2) + 'M';
		else if (a >= 1e3) body = (a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'k';
		else body = nf2.format(a);
		if (body === '0') return '0';
		return (v < 0 ? MINUS : signed ? '+' : '') + body;
	};
	const fmtExact = (v) => (isNum(v) ? `${v < 0 ? MINUS : ''}${nf2.format(Math.abs(v))} ISK` : DASH);
	const fmtQty = (v) => (isNum(v) ? nf.format(Math.round(v)) : DASH);
	const fmtPct = (v) => (isNum(v) ? `${(v * 100).toFixed(1)}%` : DASH);
	const fmtPct0 = (v) => (isNum(v) ? `${Math.round(v * 100)}%` : DASH);
	const fmtDays = (v) => (isNum(v) ? (Math.abs(v) < 10 ? v.toFixed(1) : String(Math.round(v))) : DASH);
	const fmtRate = (v) => (isNum(v) ? (Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(1)) : DASH);

	const hasMoment = () => typeof moment === 'function';
	const toMs = (t) => (typeof t === 'number' ? t : Date.parse(t));
	const ago = (t) => {
		const ms = toMs(t);
		if (!Number.isFinite(ms)) return 'never';
		return hasMoment() ? moment(ms).fromNow() : new Date(ms).toLocaleString();
	};
	const clock = (t) => {
		const ms = toMs(t);
		if (!Number.isFinite(ms)) return DASH;
		return hasMoment() ? moment(ms).format('HH:mm') : new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	};
	const stamp = (t) => {
		const ms = toMs(t);
		if (!Number.isFinite(ms)) return DASH;
		return hasMoment() ? moment(ms).format('MMM D, HH:mm') : new Date(ms).toLocaleString();
	};
	const ymd = (ms) => {
		const d = new Date(ms);
		const p = (n) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
	};

	//--- state

	const state = {
		cfg: null,
		fatal: null,              // {title, html, retry}: replaces the table (unconfigured, server unreachable)
		characters: null,         // GET /api/characters
		sync: null,               // GET /api/sync
		runs: [],                 // GET /api/runs
		ledgers: null,            // GET /api/ledger .characters
		snapshots: {},            // characterId -> retained snapshots, oldest first
		snapshotSince: undefined, // ms the loaded snapshots reach back to; null: all; undefined: none loaded
		names: {},                // typeId -> name
		m3: {},                   // typeId -> packaged volume
		market: new Map(),        // `${regionId}:${typeId}` -> best destination sell price, or null
		marketSyncedAt: null,
		view: null,               // the last computed view: {sel, run, route, result, rows, totals, isRun}
		computeError: null,
		loadError: null,          // a refresh that failed while earlier data stays on screen
		busy: '',                 // "Loading ..." text beside the window bar
		typeProgress: null,       // {done, total} of item names and volumes being looked up
		notices: [],              // dismissible one-off messages {kind, text}
		removing: null,           // characterId whose remove confirmation is open
		removingSince: 0,
		chipBusy: new Set(),      // characterIds being removed
		chipMsg: {},              // characterId -> outcome text shown on the chip
		pendingSyncs: 0,
		pendingIds: new Map(),    // characterId -> POST /api/sync calls in flight naming it
		pendingStart: new Map(),  // characterId -> when the oldest of those calls was sent
		syncNote: null,           // {kind, text}: how the last sync ended
		batchesOpen: null,        // whether the batches list is open (null: default for the mode)
		hasLoaded: false
	};

	//--- user choices (persisted)

	let winSel = lsGet('window', null); // {kind: 'run', runId} | 'unplanned' | 'days' {days} | 'date' {date} | 'all'
	let routeSel = lsGet('route', null); // {start, end}
	let showSoldOut = lsGet('showSoldOut', false) === true;
	let countBonuses = lsGet('countBonuses', true) !== false;
	let sort = lsGet('sort', { key: 'realizedProfit', dir: 'desc' });
	let query = '';

	//--- elements

	const bannersEl = $('#banners');
	const charactersEl = $('#characters');
	const chipsEl = $('#chips');
	const syncAllBtn = $('#syncAll');
	const syncNoteEl = $('#syncNote');
	const marketNoteEl = $('#marketNote');
	const syncProgressEl = $('#syncProgress');
	const windowBarEl = $('#windowBar');
	const windowSel = $('#windowSel');
	const dateWrap = $('#dateWrap');
	const sinceDate = $('#sinceDate');
	const routeWrap = $('#routeWrap');
	const routeFixed = $('#routeFixed');
	const startSel = $('#startStation');
	const endSel = $('#endStation');
	const searchInput = $('#search');
	const soldOutChk = $('#showSoldOut');
	const bonusChk = $('#countBonuses');
	const tableNote = $('#tableNote');
	const runInfoEl = $('#runInfo');
	const stateBoxEl = $('#stateBox');
	const totalsEl = $('#totals');
	const tableEl = $('#table');
	const sortRowEl = $('#sortRow');
	const tbodyEl = $('#table tbody');

	// Sets an element's HTML only when it changed, and puts focus back on the control that had it
	// (a poll re-renders the chips every few seconds and must not steal a focused button).
	const setHtml = (el, html) => {
		if (el._html === html) return false;
		const active = document.activeElement;
		const fk = active && el.contains(active) && active.dataset ? active.dataset.fk : null;
		el.innerHTML = html;
		el._html = html;
		if (fk) {
			const again = el.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
			if (again) again.focus();
		}
		return true;
	};
	const setText = (el, text) => {
		if (el.textContent !== text) el.textContent = text;
	};

	//--- server calls

	const api = async (url, options) => {
		const res = await fetch(url, options);
		let body = null;
		try { body = await res.json(); } catch (e) { /* not JSON */ }
		if (!res.ok) {
			const error = new Error(body && body.error ? body.error : `HTTP ${res.status}`);
			error.status = res.status;
			throw error;
		}
		return body;
	};

	//--- characters, runs, names

	const charName = (id) => {
		const c = (state.characters || []).find(x => x.characterId === Number(id));
		return c && c.name ? c.name : `character ${id}`;
	};
	const nameOf = (typeId) => state.names[typeId] || `type ${typeId}`;

	// The export page's own names and packaged volumes come with every saved run: free lookups.
	const seedFromRuns = () => {
		for (const run of state.runs) {
			for (const row of run.rows || []) {
				if (typeof row.name === 'string' && state.names[row.typeId] === undefined) state.names[row.typeId] = row.name;
				if (isNum(row.m3) && row.m3 > 0 && state.m3[row.typeId] === undefined) state.m3[row.typeId] = row.m3;
			}
		}
	};

	const runProfit = (run) => (run.totals && isNum(run.totals.profitMil) ? run.totals.profitMil * 1e6 : null);

	//--- the window: which run or dates, and which route

	const routeOfNames = (start, end) => ({
		start, end,
		startStationId: STATIONS[start].stationId, endStationId: STATIONS[end].stationId,
		startRegionId: STATIONS[start].regionId, endRegionId: STATIONS[end].regionId
	});

	const defaultRouteNames = () => {
		const r = state.runs[0] && state.runs[0].route;
		if (r && STATIONS[r.start] && STATIONS[r.end] && r.start !== r.end) return { start: r.start, end: r.end };
		return { start: 'Jita', end: 'Amarr' };
	};
	const currentRouteNames = () => {
		const r = routeSel;
		if (r && STATIONS[r.start] && STATIONS[r.end] && r.start !== r.end) return r;
		return defaultRouteNames();
	};

	const defaultWindow = () => (state.runs.length > 0 ? { kind: 'run', runId: state.runs[0].id } : { kind: 'days', days: 30 });

	// The selection in effect: a saved run that no longer exists falls back to the default.
	const resolveSelection = () => {
		let sel = winSel;
		const valid = sel && typeof sel === 'object' && (
			(sel.kind === 'run' && state.runs.some(r => r.id === sel.runId))
			|| sel.kind === 'unplanned' || sel.kind === 'all'
			|| (sel.kind === 'days' && [7, 30, 90].includes(sel.days))
			|| (sel.kind === 'date' && typeof sel.date === 'string' && Number.isFinite(Date.parse(`${sel.date}T00:00:00`)))
		);
		if (!valid) sel = defaultWindow();
		return sel;
	};

	const resolveView = () => {
		const now = Date.now();
		const sel = resolveSelection();
		let run = null;
		let route;
		let since = null;
		if (sel.kind === 'run') {
			run = state.runs.find(r => r.id === sel.runId);
			const r = run.route;
			route = { start: r.start, end: r.end, startStationId: r.startStationId, endStationId: r.endStationId, startRegionId: r.startRegionId, endRegionId: r.endRegionId };
			since = Date.parse(run.copiedAt);
		} else {
			const names = currentRouteNames();
			route = routeOfNames(names.start, names.end);
			if (sel.kind === 'days') since = now - sel.days * DAY_MS;
			else if (sel.kind === 'date') since = Date.parse(`${sel.date}T00:00:00`);
		}
		return {
			sel, run, route, now,
			windowInput: sel.kind === 'run' ? { runId: run.id } : { since: since === null ? null : new Date(since).toISOString() },
			snapshotSince: since === null || !Number.isFinite(since) ? null : since - SNAPSHOT_MARGIN_DAYS * DAY_MS
		};
	};

	//--- loading the data

	let reloadGen = 0;
	let applyGen = 0;

	const loadFatal = (e) => {
		const reached = e && e.status !== undefined;
		state.fatal = {
			title: reached ? 'Could not load the trade data' : 'Could not reach the eFlip server',
			html: reached
				? `<p>The server answered \u201c${esc(e.message)}\u201d. Check the server\u2019s console for the cause, then try again.</p>`
				: `<p>${esc(e.message)}. This page reads everything through the eFlip server on this computer: start it with <code>npm start</code>, then try again.</p>`,
			retry: true
		};
	};

	// Everything the server holds that the page needs; the last result stays on screen while it loads.
	const reloadData = async () => {
		const gen = ++reloadGen;
		state.busy = state.hasLoaded ? 'refreshing data…' : 'loading trade data…';
		renderStatusBits();
		try {
			const [characters, sync, runs, ledger] = await Promise.all([
				api('/api/characters'), api('/api/sync'), api('/api/runs'), api('/api/ledger')
			]);
			if (gen !== reloadGen) return;
			state.characters = characters;
			state.sync = sync;
			state.runs = Array.isArray(runs) ? runs : [];
			state.ledgers = ledger.characters || {};
			state.snapshotSince = undefined;
			state.market.clear();
			state.marketSyncedAt = null;
			state.loadError = null;
			state.fatal = null;
			seedFromRuns();
			noteSyncState();
		} catch (e) {
			if (gen !== reloadGen) return;
			state.busy = '';
			if (state.view) state.loadError = `Could not refresh the data (${e.message}); the figures below are from the last load.`;
			else loadFatal(e);
			render();
			return;
		}
		state.hasLoaded = true;
		await apply();
	};

	// Retained snapshots: `since` when the window allows, plus the newest one of any character the
	// cut would leave without one (stock and listings are read from the newest).
	const ensureSnapshots = async (view) => {
		const need = view.snapshotSince;
		const have = state.snapshotSince;
		if (have !== undefined && (have === null || (need !== null && need >= have))) return;
		const res = await api(`/api/snapshots${need === null ? '' : `?since=${encodeURIComponent(new Date(need).toISOString())}`}`);
		const snapshots = res.characters || {};
		if (need !== null) {
			const bare = (state.characters || []).map(c => c.characterId).filter(id => (snapshots[id] || []).length === 0);
			if (bare.length > 0) {
				const more = await api(`/api/snapshots?characterIds=${bare.join(',')}`);
				for (const id of bare) {
					const list = (more.characters || {})[id] || [];
					snapshots[id] = list.length > 0 ? [list[list.length - 1]] : [];
				}
			}
		}
		state.snapshots = snapshots;
		state.snapshotSince = need;
	};

	// Best destination sell price per type: the lowest sell order at the destination station.
	const bestSell = (rows, stationId) => {
		let best = null;
		for (const o of rows || []) {
			if (o.is_buy_order === true || o.location_id !== stationId || !isNum(o.price)) continue;
			if (best === null || o.price < best) best = o.price;
		}
		return best;
	};
	const marketKey = (regionId, typeId) => `${regionId}:${typeId}`;
	const ensureMarket = async (typeIds, route) => {
		const todo = typeIds.filter(id => !state.market.has(marketKey(route.endRegionId, id)));
		for (let i = 0; i < todo.length; i += MARKET_CHUNK) {
			const chunk = todo.slice(i, i + MARKET_CHUNK);
			const res = await api(`/api/market?typeIds=${chunk.join(',')}&regionIds=${route.endRegionId}`);
			for (const typeId of chunk) {
				const entry = res.types && res.types[typeId] && res.types[typeId][route.endRegionId];
				const rows = entry && entry.orders ? entry.orders.rows : null;
				state.market.set(marketKey(route.endRegionId, typeId), rows ? bestSell(rows, route.endStationId) : null);
			}
			if (res.syncedAt) state.marketSyncedAt = res.syncedAt;
		}
	};

	//--- item names and packaged volumes (public lookups, util.js)

	const typeLoads = new Map(); // typeId -> promise
	let m3Learned = false;       // a volume arrived that the last sums did not have
	const loadTypes = (typeIds) => {
		const todo = [...new Set(typeIds)].filter(id => !typeLoads.has(id) && (state.names[id] === undefined || state.m3[id] === undefined));
		if (todo.length === 0) return;
		const progress = state.typeProgress || { done: 0, total: 0 };
		progress.total += todo.length;
		state.typeProgress = progress;
		for (const id of todo) {
			// both read the same public type record: util shares the one request
			typeLoads.set(id, Promise.allSettled([util.getTypeName(id), util.getTypeM3(id)]).then(([name, m3]) => {
				if (name.status === 'fulfilled' && typeof name.value === 'string') state.names[id] = name.value;
				if (m3.status === 'fulfilled' && isNum(m3.value) && m3.value > 0 && state.m3[id] === undefined) {
					state.m3[id] = m3.value;
					m3Learned = true;
				}
			}).finally(() => {
				progress.done++;
				if (progress.done >= progress.total) {
					if (state.typeProgress === progress) state.typeProgress = null;
					// new volumes change the haul split: work the results out again
					if (m3Learned) {
						m3Learned = false;
						apply();
					}
				}
				scheduleStatusRender();
			}));
		}
	};

	let statusTimer = null;
	const scheduleStatusRender = () => {
		if (statusTimer !== null) return;
		statusTimer = setTimeout(() => {
			statusTimer = null;
			renderStatusBits();
			renderTable();
		}, 300);
	};

	// Types whose packaged volume the haul split reads: what the contracts carry (a saved run brings
	// its own rows' volumes). A courier matched without a hand-off splits by units and says est.
	const volumeTypeIds = () => {
		const ids = new Set();
		for (const led of Object.values(state.ledgers || {})) {
			for (const list of Object.values(led.contractItems || {})) for (const it of list || []) if (it.is_included !== false) ids.add(it.type_id);
		}
		return [...ids];
	};

	//--- the results

	const buildInput = (view) => {
		const characterIds = [];
		const ledgers = {};
		for (const c of state.characters || []) {
			const entry = state.ledgers && state.ledgers[c.characterId];
			if (!entry) continue;
			const snaps = state.snapshots[c.characterId] || [];
			const newest = snaps.length > 0 ? snaps[snaps.length - 1] : null;
			characterIds.push(c.characterId);
			ledgers[c.characterId] = { ...entry, orders: newest ? newest.orders || [] : [], snapshots: snaps };
		}
		const market = {};
		for (const [key, best] of state.market) {
			const [regionId, typeId] = key.split(':');
			if (best !== null && Number(regionId) === Number(view.route.endRegionId)) market[typeId] = best;
		}
		return {
			characterIds,
			ledgers,
			route: {
				startStationId: view.route.startStationId, endStationId: view.route.endStationId,
				startRegionId: view.route.startRegionId, endRegionId: view.route.endRegionId
			},
			runs: state.runs,
			m3: state.m3,
			market,
			window: view.sel.kind === 'unplanned' ? { since: null } : view.windowInput,
			options: { countHaulerBonuses: countBonuses },
			now: view.now
		};
	};

	// The "unplanned batches" view: hand-offs no export run claimed. compute() has no window for them,
	// so this sums the all-time fact table (sells and lots of those batches) per type, the same fields
	// the per-type rows carry, minus the days-to-clear comparison. (Plan item: a dropdown entry of
	// their own; reported as a deviation.)
	const unplannedView = (result, now) => {
		const batchIds = new Set(result.batches.filter(b => b.runId === null).map(b => b.batchId));
		const lots = result.facts.lots.filter(l => l.batchId !== null && batchIds.has(l.batchId));
		const sells = result.facts.sells.filter(s => s.batchId !== null && batchIds.has(s.batchId));
		const allTime = new Map(result.types.map(t => [t.typeId, t]));
		const acc = new Map();
		const get = (typeId) => {
			if (!acc.has(typeId)) {
				acc.set(typeId, {
					typeId, boughtQty: 0, boughtCost: 0, landed: 0, remainingQty: 0, atCost: 0,
					soldQty: 0, gross: 0, tax: 0, broker: 0, haul: 0, buyFee: 0, buyCost: 0,
					arrivals: [], lastSoldMs: null, flags: new Set(['unplanned'])
				});
			}
			return acc.get(typeId);
		};
		for (const l of lots) {
			const a = get(l.typeId);
			const per = l.unitPrice + l.haulPerUnit + l.buyFeePerUnit;
			a.boughtQty += l.qty;
			a.boughtCost += l.qty * l.unitPrice;
			a.landed += l.qty * per;
			a.remainingQty += l.remainingQty;
			a.atCost += l.remainingQty * per;
			if (l.arrivedAt) a.arrivals.push(Date.parse(l.arrivedAt));
			if (l.est) a.flags.add('est');
		}
		for (const s of sells) {
			const a = get(s.typeId);
			a.soldQty += s.qty;
			a.gross += s.gross;
			a.tax += s.tax;
			a.broker += s.brokerShare + s.relistShare;
			a.haul += s.haulShare;
			a.buyFee += s.buyFeeShare;
			a.buyCost += s.buyCost;
			a.lastSoldMs = Math.max(a.lastSoldMs === null ? 0 : a.lastSoldMs, Date.parse(s.date));
			if (s.unarrived) a.flags.add('unarrived');
			if (s.taxEst) a.flags.add('est');
		}
		for (const b of result.batches) {
			if (b.runId !== null) continue;
			for (const it of b.items) if (it.unsourcedQty > 0 && acc.has(it.typeId)) acc.get(it.typeId).flags.add('unsourced');
		}
		const rows = [...acc.values()].map(a => {
			const base = allTime.get(a.typeId);
			const cogs = a.buyCost + a.haul + a.buyFee;
			const realized = a.gross - a.tax - a.broker - cogs;
			const marketNet = base ? base.remaining.marketNetPerUnit : null;
			const soldOut = a.soldQty > 0 && a.remainingQty === 0;
			const listedMs = a.arrivals.length > 0 ? Math.min(...a.arrivals) : null;
			const endMs = soldOut ? a.lastSoldMs : now;
			const daysOnMarket = listedMs === null || endMs === null ? null : Math.max(0, (endMs - listedMs) / DAY_MS);
			if (base && base.flags.includes('mismatch')) a.flags.add('mismatch');
			return {
				typeId: a.typeId,
				flags: [...a.flags].sort(),
				boughtQty: a.boughtQty, boughtCost: a.boughtCost, boughtAvg: a.boughtQty > 0 ? a.boughtCost / a.boughtQty : null,
				landedCostPerItem: a.boughtQty > 0 ? a.landed / a.boughtQty : null,
				soldQty: a.soldQty, gross: a.gross, avgSellPrice: a.soldQty > 0 ? a.gross / a.soldQty : null,
				tax: a.tax, broker: a.broker, brokerListing: null, brokerRelist: null, brokerEst: null, brokerBuyUnfilled: null,
				haul: a.haul, buyFee: a.buyFee, buyCost: a.buyCost, cogs, realizedProfit: realized,
				marginPct: a.gross > 0 ? realized / a.gross : null,
				netPerItem: a.soldQty > 0 ? (a.gross - a.tax - a.broker) / a.soldQty : null,
				uncoveredQty: 0, uncoveredGross: 0, unarrivedQty: 0,
				remaining: {
					qty: a.remainingQty, atCost: a.atCost, marketNetPerUnit: marketNet,
					atMarket: marketNet === null ? null : marketNet * a.remainingQty,
					physical: base ? base.remaining.physical : { known: false },
					mismatch: base ? base.remaining.mismatch : false,
					accountingTotal: base ? base.remaining.accountingTotal : null,
					unbatchedQty: base ? base.remaining.unbatchedQty : 0
				},
				unrealizedAtCost: a.atCost,
				unrealizedAtMarket: marketNet === null ? null : marketNet * a.remainingQty,
				soldOut, daysOnMarket,
				sellRate: daysOnMarket === null ? null : a.soldQty / Math.max(daysOnMarket, 1),
				soldFraction: null, projectedDaysToClear: null
			};
		});
		const sum = (f) => rows.reduce((acc2, r) => acc2 + f(r), 0);
		const priced = rows.filter(r => r.unrealizedAtMarket !== null);
		const totals = {
			spent: sum(r => r.boughtCost), buyFees: null, boughtQty: sum(r => r.boughtQty), soldQty: sum(r => r.soldQty),
			gross: sum(r => r.gross), tax: sum(r => r.tax), broker: sum(r => r.broker), brokerEst: null,
			haul: sum(r => r.haul), haulPaid: null, cogs: sum(r => r.cogs), realizedProfit: sum(r => r.realizedProfit),
			unrealizedAtCost: sum(r => r.unrealizedAtCost),
			unrealizedAtMarket: priced.reduce((acc2, r) => acc2 + r.unrealizedAtMarket, 0),
			unpricedTypes: rows.filter(r => r.remaining.qty > 0 && r.unrealizedAtMarket === null).length,
			uncoveredQty: 0, unbatchedLots: null, unsourcedUnits: result.batches.filter(b => b.runId === null).reduce((acc2, b) => acc2 + b.unsourcedQty, 0),
			otherDonations: null, otherDonationsAmount: null, otherSells: null
		};
		totals.roi = totals.cogs > 0 ? totals.realizedProfit / totals.cogs : null;
		return { rows, totals, batches: result.batches.filter(b => b.runId === null) };
	};

	const computeView = (view) => {
		const result = resultsCalc.compute(buildInput(view));
		const isRun = view.sel.kind === 'run';
		if (view.sel.kind === 'unplanned') {
			const u = unplannedView(result, view.now);
			return { view, result, rows: u.rows, totals: u.totals, isRun: false, isUnplanned: true, batches: u.batches, crossCheck: null };
		}
		const since = result.window.start === null ? -Infinity : Date.parse(result.window.start);
		const batches = isRun
			? result.batches.filter(b => b.runId === view.run.id)
			: result.batches.filter(b => Date.parse(b.dateIssued) >= since);
		return { view, result, rows: result.types, totals: result.totals, isRun, isUnplanned: false, batches, crossCheck: result.crossCheck };
	};

	// Reads the data for the current window, works out the results, and fills in what the first
	// pass lacked (prices for unsold stock, item volumes) with a second.
	const apply = async () => {
		const gen = ++applyGen;
		if (!state.characters || state.characters.length === 0 || !state.ledgers) {
			state.busy = '';
			state.view = null;
			render();
			return;
		}
		const view = resolveView();
		state.busy = state.view ? 'working out results…' : 'loading trade data…';
		renderStatusBits();
		try {
			try {
				await ensureSnapshots(view);
			} catch (e) {
				state.snapshots = state.snapshots || {};
				state.loadError = `Could not load the order and stock snapshots (${e.message}); remaining stock and listing times may be missing.`;
			}
			if (gen !== applyGen) return;
			state.computeError = null;
			state.view = computeView(view);
			state.busy = '';
			render();

			const needMarket = state.view.rows.filter(r => r.remaining.qty > 0).map(r => r.typeId)
				.filter(id => !state.market.has(marketKey(view.route.endRegionId, id)));
			if (needMarket.length > 0) {
				try {
					await ensureMarket(needMarket, view.route);
				} catch (e) {
					for (const id of needMarket) state.market.set(marketKey(view.route.endRegionId, id), null);
					state.loadError = `Could not read the market snapshot (${e.message}); unsold stock is shown at cost only.`;
				}
				if (gen !== applyGen) return;
				state.view = computeView(view);
				render();
			}
			lookUpTypes();
		} catch (e) {
			if (gen !== applyGen) return;
			state.busy = '';
			state.computeError = e && e.message ? e.message : String(e);
			render();
		}
	};

	// Names for the rows on screen, and volumes for the haul split; new volumes redo the sums.
	const lookUpTypes = () => {
		loadTypes(state.view ? state.view.rows.map(r => r.typeId) : []);
		loadTypes(volumeTypeIds());
	};

	//--- syncing

	let pollTimer = null;
	let pollBusy = false;
	let dataDirty = false;
	const retryTimers = new Map(); // `${characterId}:${until}` -> timer

	const syncOf = (id) => (state.sync && state.sync.characters && state.sync.characters[id]) || null;
	const anyRunning = () => {
		const s = state.sync;
		return !!s && (Object.values(s.characters || {}).some(c => c && c.running) || !!(s.market && s.market.running));
	};
	// POST /api/sync works through the characters one after another: one the call has finished with
	// (its status moved on since the call was sent) is no longer waiting, even while the call runs on.
	const isSyncing = (id) => {
		const st = syncOf(id);
		if (st && st.running) return true;
		if ((state.pendingIds.get(id) || 0) === 0) return false;
		const sent = state.pendingStart.get(id);
		return !(st && sent !== undefined && Date.parse(st.checkedAt) >= sent);
	};
	const ensurePolling = () => {
		if (pollTimer === null) pollTimer = setInterval(pollTick, POLL_MS);
	};
	const stopPolling = () => {
		if (pollTimer !== null) clearInterval(pollTimer);
		pollTimer = null;
	};

	// Notes what a fresh /api/sync answer means: keep polling while anything runs, and plan a retry
	// for a rate limit that lifts while this page stays open.
	const noteSyncState = () => {
		if (anyRunning()) {
			dataDirty = true;
			ensurePolling();
		}
		const now = Date.now();
		for (const c of state.characters || []) {
			const st = syncOf(c.characterId);
			const stop = st && st.stop;
			if (!stop || (stop.reason !== 'rate-limited' && stop.reason !== 'error-limit') || !isNum(stop.until) || stop.until <= now) continue;
			const key = `${c.characterId}:${stop.until}`;
			if (retryTimers.has(key)) continue;
			retryTimers.set(key, setTimeout(() => {
				if (!state.characters || !state.characters.some(x => x.characterId === c.characterId)) return;
				startSync({ characterIds: [c.characterId], force: true, market: false });
			}, stop.until - now + 2000));
		}
	};

	const refreshSyncStatus = async () => {
		state.sync = await api('/api/sync');
		noteSyncState();
		renderCharacters();
		renderBanners();
	};

	const pollTick = async () => {
		if (pollBusy) return;
		pollBusy = true;
		try {
			await refreshSyncStatus();
			if (state.pendingSyncs === 0 && !anyRunning()) {
				stopPolling();
				if (dataDirty) {
					dataDirty = false;
					await reloadData();
				}
			}
		} catch (e) {
			// status unreadable: try again on the next tick
		} finally {
			pollBusy = false;
		}
	};

	const SYNC_WORDS = {
		ok: 'synced', partial: 'partly synced', failed: 'failed', relink: 'needs re-linking',
		skipped: 'already up to date', busy: 'being synced elsewhere'
	};
	const summarizeSync = (result) => {
		const parts = (result.characters || []).map(c => {
			const word = SYNC_WORDS[c.status] || c.status;
			return `${charName(c.characterId)} ${word}${c.status === 'failed' && c.reason ? ` (${c.reason})` : ''}`;
		});
		if (result.market && (result.market.status === 'failed' || result.market.status === 'partial')) parts.push(`market snapshot ${SYNC_WORDS[result.market.status] || result.market.status}`);
		const bad = (result.characters || []).some(c => c.status === 'failed' || c.status === 'relink');
		return { kind: bad ? 'err' : 'ok', text: `${parts.join(' · ') || 'nothing to sync'} · ${clock(Date.now())}` };
	};

	// POST /api/sync answers when the sync is done, so the status poll runs meanwhile.
	const startSync = async ({ characterIds = null, force = false, market = true }) => {
		const ids = characterIds || (state.characters || []).map(c => c.characterId);
		const body = { force, market };
		if (characterIds) body.characterIds = characterIds;
		state.pendingSyncs++;
		for (const id of ids) {
			if (!state.pendingIds.has(id)) state.pendingStart.set(id, Date.now());
			state.pendingIds.set(id, (state.pendingIds.get(id) || 0) + 1);
		}
		for (const id of ids) delete state.chipMsg[id];
		state.syncNote = null;
		dataDirty = true;
		ensurePolling();
		renderCharacters();
		try {
			const result = await api('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
			state.syncNote = summarizeSync(result);
		} catch (e) {
			state.syncNote = { kind: 'err', text: `Sync failed: ${e.message}. Try Sync all again in a moment.` };
		} finally {
			state.pendingSyncs--;
			for (const id of ids) {
				const n = (state.pendingIds.get(id) || 1) - 1;
				if (n <= 0) {
					state.pendingIds.delete(id);
					state.pendingStart.delete(id);
				} else state.pendingIds.set(id, n);
			}
		}
		renderCharacters();
		await pollTick();
	};

	const maybeSyncOnLoad = () => {
		if (!state.characters || state.characters.length === 0 || anyRunning()) return;
		if (exportPersist.syncIsStale(state.sync, Date.now())) startSync({ market: true });
	};

	//--- removing a character

	const removeCharacter = async (id, purge) => {
		const name = charName(id);
		state.chipBusy.add(id);
		delete state.chipMsg[id];
		renderCharacters();
		try {
			await api(`/api/characters/${id}${purge ? '?purge=1' : ''}`, { method: 'DELETE' });
			state.removing = null;
			state.chipBusy.delete(id);
			state.notices.push({ kind: 'info', text: `Removed ${name}${purge ? ' and its synced data' : '; its synced history stays on this computer'}.` });
			await reloadData();
			const next = $('#addCharacter');
			if (next && !charactersEl.hidden) next.focus();
			return;
		} catch (e) {
			state.chipBusy.delete(id);
			state.chipMsg[id] = e.status === 409
				? `${name} is syncing right now; try Remove again in a moment.`
				: `Could not remove ${name}: ${e.message}.`;
		}
		renderCharacters();
	};

	//--- rendering: banners, characters, window bar

	const SCOPE_SHORT = (scope) => String(scope).replace(/^esi-/, '').replace(/\.v\d+$/, '');
	const ROUTE_LABELS = {
		transactions: 'transactions', journal: 'journal', orders: 'open orders', ordersHistory: 'order history', assets: 'assets',
		wallet: 'balance', contracts: 'contracts', contractItems: 'contract items', skills: 'skills', standings: 'standings', structures: 'structure names'
	};
	const progressText = (st) => {
		const p = st.progress;
		if (!p) return 'starting';
		const label = ROUTE_LABELS[p.route] || p.route;
		return p.pages ? `${label} ${p.page}/${p.pages}` : `${label} ${p.page}`;
	};

	const errorLines = (st) => (st && st.errors ? st.errors : []).map(e => `${e.route}: ${e.status || e.outcome}${e.message ? ` ${e.message}` : ''}`);

	const chipInfo = (c) => {
		const st = syncOf(c.characterId);
		const now = Date.now();
		const stop = st && st.stop;
		const limited = stop && (stop.reason === 'rate-limited' || stop.reason === 'error-limit') && isNum(stop.until) && stop.until > now;
		if (state.chipBusy.has(c.characterId)) return { text: 'removing…', problem: false };
		if (st && st.running) return { text: `syncing: ${progressText(st)}`, problem: false };
		if (isSyncing(c.characterId)) return { text: 'waiting to sync…', problem: false };
		if (c.status === 'relink' || (st && st.status === 'relink')) {
			return { text: 're-link needed', problem: true, relink: true, relinkOnly: true, title: c.lastError || (st && st.reason) || 'EVE no longer accepts this character’s saved sign-in.' };
		}
		if (st && st.missingScopes && st.missingScopes.length > 0) {
			return { text: `missing scope: ${st.missingScopes.map(SCOPE_SHORT).join(', ')}`, problem: true, relink: true, title: 'Re-link to grant the missing permission.' };
		}
		if (limited) return { text: `rate-limited, retrying at ${clock(stop.until)}`, problem: true, title: errorLines(st).join('\n') };
		if (st && st.status === 'failed') {
			const why = st.reason || (st.errors && st.errors[0] && st.errors[0].message) || 'unknown error';
			return { text: `sync failed: ${why}`, problem: true, retry: true, title: errorLines(st).join('\n') };
		}
		if (!st || !st.syncedAt) return { text: 'not synced yet', problem: false };
		const age = `synced ${ago(st.syncedAt)}`;
		if (st.status === 'partial') return { text: `${age}, some data missing`, problem: false, title: errorLines(st).join('\n') || 'a rate limit paused part of the sync' };
		return { text: `ok · ${age}`, problem: false, title: new Date(st.syncedAt).toLocaleString() };
	};

	const chipHtml = (c) => {
		const id = c.characterId;
		const name = esc(c.name || `character ${id}`);
		const info = chipInfo(c);
		const syncing = isSyncing(id);
		const busy = state.chipBusy.has(id);
		const msg = state.chipMsg[id];
		let actions;
		if (state.removing === id && !busy) {
			actions = `<div class="chipConfirm" role="group" aria-label="Remove ${name}">
				<span>Remove ${name}? Its sign-in is revoked at EVE. Synced history stays on this computer unless you tick:</span>
				<label><input type="checkbox" class="purge" data-fk="purge-${id}"> also delete synced data</label>
				<button type="button" class="danger" data-act="confirmRemove" data-id="${id}" data-fk="confirm-${id}">Remove ${name}</button>
				<button type="button" data-act="cancelRemove" data-id="${id}" data-fk="cancel-${id}">Cancel</button>
			</div>`;
		} else {
			const syncLabel = info.retry ? 'Retry sync' : 'Sync';
			const relinkLink = info.relink ? `<a class="btn" href="${LOGIN_URL}" data-fk="relink-${id}">Re-link ${name}</a>` : '';
			const syncBtn = info.relinkOnly
				? relinkLink
				: `${relinkLink}<button type="button" class="sync" data-act="sync" data-id="${id}" data-fk="sync-${id}" ${syncing || busy ? 'disabled' : ''}>${syncing ? 'Syncing…' : syncLabel}</button>`;
			actions = `<div class="chipActions">${syncBtn}<button type="button" data-act="remove" data-id="${id}" data-fk="remove-${id}" ${busy ? 'disabled' : ''}>${busy ? 'Removing…' : 'Remove'}</button></div>`;
		}
		return `<div class="chip${info.problem ? ' problem' : ''}" data-id="${id}">
			<img class="portrait" src="https://images.evetech.net/characters/${id}/portrait?size=32" width="32" height="32" alt="" loading="lazy">
			<div class="chipBody">
				<div class="chipName">${name}</div>
				<div class="chipStatus${info.problem ? ' bad' : ''}"${info.title ? ` title="${esc(info.title)}"` : ''}>${esc(info.text)}</div>
				${msg ? `<div class="chipStatus bad" role="status">${esc(msg)}</div>` : ''}
			</div>
			${actions}
		</div>`;
	};

	const renderCharacters = () => {
		const chars = state.characters || [];
		// Nothing to show until there is a character: the empty state carries its own "+ Add character".
		charactersEl.hidden = !(state.cfg && state.cfg.configured && chars.length > 0);
		if (charactersEl.hidden) return;
		setHtml(chipsEl, chars.map(chipHtml).join(''));
		const syncingAny = state.pendingSyncs > 0 || anyRunning();
		syncAllBtn.hidden = chars.length === 0;
		syncAllBtn.disabled = syncingAny;
		setText(syncAllBtn, syncingAny ? 'Syncing…' : 'Sync all');
		if (state.syncNote) {
			setText(syncNoteEl, state.syncNote.text);
			syncNoteEl.className = state.syncNote.kind === 'err' ? 'chipStatus bad' : 'muted';
		} else {
			setText(syncNoteEl, '');
		}
		const market = state.sync && state.sync.market;
		if (chars.length === 0) setText(marketNoteEl, '');
		else if (market && market.running) setText(marketNoteEl, 'market snapshot: syncing…');
		else if (market && market.syncedAt) setText(marketNoteEl, `market snapshot synced ${ago(market.syncedAt)}`);
		else setText(marketNoteEl, 'no market snapshot yet: unsold stock is valued at cost only');
		// Per-character progress while a sync runs.
		const lines = [];
		for (const c of chars) {
			const st = syncOf(c.characterId);
			if (st && st.running) lines.push(`${c.name}: ${progressText(st)}`);
			else if (isSyncing(c.characterId)) lines.push(`${c.name}: waiting`);
		}
		if (market && market.running) lines.push('market snapshot');
		setText(syncProgressEl, lines.length > 0 ? `Syncing — ${lines.join(' · ')}. Earlier data stays on screen until it finishes.` : '');
	};

	const bannerHtml = (b) => `<div class="banner ${b.kind}"><span class="sev">${b.kind === 'err' ? 'Error:' : b.kind === 'warn' ? 'Warning:' : 'Note:'}</span><span>${esc(b.text)}</span>${b.action || ''}</div>`;

	const renderBanners = () => {
		const list = [];
		state.notices.forEach((n, i) => list.push({ kind: n.kind, text: n.text, action: `<button type="button" class="linkish" data-act="dismiss" data-i="${i}" data-fk="dismiss-${i}">Dismiss</button>` }));
		if (state.loadError) list.push({ kind: 'warn', text: state.loadError });
		const now = Date.now();
		let oldest = null;
		for (const c of state.characters || []) {
			const st = syncOf(c.characterId);
			const name = c.name || `character ${c.characterId}`;
			if (st && st.syncedAt && (oldest === null || Date.parse(st.syncedAt) < oldest.ms)) oldest = { ms: Date.parse(st.syncedAt), name };
			if (c.status === 'relink' || (st && st.status === 'relink')) {
				list.push({ kind: 'err', text: `${name} needs re-linking: EVE no longer accepts its saved sign-in, so new trades of ${name} are missing from the figures.`, action: `<a class="btn" href="${LOGIN_URL}">Re-link ${esc(name)}</a>` });
				continue;
			}
			if (st && st.missingScopes && st.missingScopes.length > 0) {
				list.push({ kind: 'warn', text: `${name} was linked without permission for ${st.missingScopes.map(SCOPE_SHORT).join(', ')}, so some data is missing.`, action: `<a class="btn" href="${LOGIN_URL}">Re-link ${esc(name)}</a>` });
			}
			const stop = st && st.stop;
			if (stop && (stop.reason === 'rate-limited' || stop.reason === 'error-limit') && isNum(stop.until) && stop.until > now) {
				list.push({ kind: 'warn', text: `ESI is rate-limiting ${name}: retrying at ${clock(stop.until)} while this page stays open.` });
			}
			const serverError = st && (st.errors || []).find(e => isNum(e.status) && e.status >= 500);
			if (serverError) {
				list.push({ kind: 'warn', text: `ESI had a server error while syncing ${name} (HTTP ${serverError.status} on ${serverError.route}), so its data may be stale since ${st.syncedAt ? ago(st.syncedAt) : 'the last good sync'}.` });
			}
		}
		if (oldest !== null && now - oldest.ms > STALE_WARN_DAYS * DAY_MS) {
			list.push({ kind: 'warn', text: `${oldest.name} was last synced ${Math.floor((now - oldest.ms) / DAY_MS)} days ago: older trades and contracts may be lost (ESI keeps 30 days). Sync soon.`, action: '<button type="button" class="sync" data-act="syncAll" data-fk="stale-sync">Sync all</button>' });
		}
		setHtml(bannersEl, list.map(bannerHtml).join(''));
	};

	const runLabel = (run) => {
		const info = state.view && state.view.result && state.view.result.runs.find(r => r.runId === run.id);
		const mark = info && info.hasUnsourced ? '⚠ ' : '';
		const waiting = info && info.waiting ? ' · waiting for hand-off' : '';
		const profit = runProfit(run);
		return `${mark}${stamp(run.copiedAt)} · ${run.route.start}${ARROW}${run.route.end} · ${(run.rows || []).length} types · predicted ${fmtIsk(profit)}${waiting}`;
	};

	const renderWindowBar = () => {
		windowBarEl.hidden = !(state.cfg && state.cfg.configured && state.characters && state.characters.length > 0);
		const sel = resolveSelection();
		const hasUnplanned = !!(state.view && state.view.result.batches.some(b => b.runId === null)) || sel.kind === 'unplanned';
		let html = '';
		if (state.runs.length > 0 || hasUnplanned) {
			html += '<optgroup label="Export runs">';
			for (const run of state.runs) html += `<option value="run:${esc(run.id)}">${esc(runLabel(run))}</option>`;
			if (hasUnplanned) html += '<option value="unplanned">Unplanned batches (hand-offs with no run)</option>';
			html += '</optgroup>';
		}
		html += '<optgroup label="Since"><option value="days:7">Last 7 days</option><option value="days:30">Last 30 days</option><option value="days:90">Last 90 days</option><option value="date">Since a date…</option><option value="all">All synced history</option></optgroup>';
		const value = sel.kind === 'run' ? `run:${sel.runId}` : sel.kind === 'days' ? `days:${sel.days}` : sel.kind;
		if (windowSel._html !== html) {
			windowSel.innerHTML = html;
			windowSel._html = html;
		}
		windowSel.value = value;
		dateWrap.hidden = sel.kind !== 'date';
		if (sel.kind === 'date' && sinceDate.value !== sel.date) sinceDate.value = sel.date;
		const isRun = sel.kind === 'run';
		routeWrap.hidden = isRun;
		routeFixed.hidden = !isRun;
		if (isRun) {
			const run = state.runs.find(r => r.id === sel.runId);
			setText(routeFixed, `${run.route.start} ${ARROW} ${run.route.end} (the run's route)`);
		} else {
			const names = currentRouteNames();
			startSel.value = names.start;
			endSel.value = names.end;
		}
		soldOutChk.checked = showSoldOut;
		bonusChk.checked = countBonuses;
	};

	//--- rendering: run info (batches and warnings)

	const COURIER_WORDS = { finished: 'delivered', in_progress: 'in transit', outstanding: 'waiting for a hauler', failed: 'failed', deleted: 'deleted', rejected: 'rejected', cancelled: 'cancelled', reversed: 'reversed' };

	const renderRunInfo = () => {
		const v = state.view;
		if (!v) { setHtml(runInfoEl, ''); return; }
		const { result, batches } = v;
		let html = '';
		if (v.isRun) {
			const run = v.view.run;
			const info = result.runs.find(r => r.runId === run.id);
			const copies = run.copyCount > 1 ? ` (copied ${run.copyCount} times, last ${ago(run.lastCopiedAt)})` : '';
			html += `<div><strong>Run copied ${esc(stamp(run.copiedAt))}</strong>${esc(copies)} · ${esc(run.route.start)} ${ARROW} ${esc(run.route.end)} · ${(run.rows || []).length} types · plan: cost ${esc(fmtIsk(run.totals.costMil * 1e6))}, profit ${esc(fmtIsk(runProfit(run)))} over ${run.horizonDays} days</div>`;
			if (info && info.waiting) html += '<div class="warnLine"><strong>Waiting for the hand-off contract.</strong> No hand-off from this run has been issued or synced yet, so the table shows the plan only.</div>';
		} else if (v.isUnplanned) {
			html += '<div class="muted">Unplanned batches: hand-offs with no export run copied in the 7 days before them. Summed from the per-sale records, so cross-check figures and days-to-clear comparisons are not shown.</div>';
		}
		const names = (id) => esc(charName(id));
		const open = state.batchesOpen === null ? v.isRun || v.isUnplanned : state.batchesOpen;
		const batchIds = new Set(batches.map(b => b.batchId));
		const warns = (result.warnings || []).filter(w => (w.kind === 'unsourced' && batchIds.has(w.batchId)) || w.kind === 'failedCourier');
		const warnText = (w) => (w.kind === 'failedCourier'
			? `Courier contract ${w.courierId} failed; what it carried is a loss the page does not count.`
			: `${fmtQty(w.qty)} \u00d7 ${nameOf(w.typeId)} in contract ${w.batchId} has no matching purchase (synced history starts ${w.historyFrom ? stamp(w.historyFrom) : DASH}).`);
		const warnLine = (w) => `<div class="warnLine"><span class="mark">\u26a0</span> ${esc(warnText(w))}</div>`;
		// With the batch list open, a batch's warnings sit right under it; with it folded they stay in view below.
		const shown = new Set();
		const items = batches.map(b => {
			const k = b.courierId !== null ? result.couriers.find(c => c.courierId === b.courierId) : null;
			const courier = k
				? `courier contract ${k.courierId} (${esc(COURIER_WORDS[k.status] || k.status)}, reward ${esc(fmtIsk(k.reward))}${k.bonus ? `, bonuses ${esc(fmtIsk(k.bonus))}` : ''})`
				: 'no courier matched yet';
			const plan = v.isRun || b.runId !== null ? '' : ' \u00b7 <span class="mark">unplanned</span> (no run in the 7 days before it)';
			let under = '';
			if (open) {
				for (const w of warns.filter(x => x.kind === 'unsourced' && x.batchId === b.batchId)) {
					under += warnLine(w);
					shown.add(w);
				}
			}
			return `<li>Hand-off (item exchange) contract ${b.batchId}, issued ${esc(stamp(b.dateIssued))}, ${names(b.issuerId)} ${ARROW} ${names(b.receiverId)}, ${b.items.length} types${isNum(b.volume) ? `, ${esc(fmtQty(b.volume))} m\u00b3` : ''} \u00b7 ${courier}${plan}${under}</li>`;
		});
		if (items.length > 0) {
			html += `<details id="batches"${open ? ' open' : ''}><summary>${items.length} batch${items.length === 1 ? '' : 'es'} in this ${v.isRun ? 'run' : 'window'}</summary><ul>${items.join('')}</ul></details>`;
		}
		const rest = warns.filter(w => !shown.has(w));
		html += rest.map(warnLine).join('');
		if (warns.some(w => w.kind === 'unsourced')) {
			html += '<div class="dim">Usual causes of a hand-off item with no matching purchase: a buy older than the synced history, a buy by a character that is not linked, or stock that was never bought on the market.</div>';
		}
		setHtml(runInfoEl, html);
	};

	//--- rendering: totals

	const renderTotals = () => {
		const v = state.view;
		if (!v) { totalsEl.hidden = true; return; }
		const t = v.totals;
		const items = [];
		const add = (label, text, title, cls = '') => items.push(`<span class="tot ${cls}"${title ? ` title="${esc(title)}"` : ''}><span class="dim">${esc(label)}</span> <b${/^−/.test(text) && cls.includes('main') ? ' class="neg"' : ''}>${text}</b></span>`);
		add('spent', esc(fmtIsk(t.spent)), `${fmtExact(t.spent)} for ${fmtQty(t.boughtQty)} units bought${t.buyFees ? `, plus ${fmtExact(t.buyFees)} of buy-order fees` : ''}`);
		add('gross sales', esc(fmtIsk(t.gross)), `${fmtExact(t.gross)} for ${fmtQty(t.soldQty)} units sold at the destination`);
		add('tax', esc(fmtIsk(t.tax)), `${fmtExact(t.tax)} sales tax (${fmtPct(t.gross > 0 ? t.tax / t.gross : null)} of gross)`);
		add('broker', esc(fmtIsk(t.broker)), `${fmtExact(t.broker)} listing and relist fees${isNum(t.brokerEst) && t.brokerEst > 0 ? `; ${fmtExact(t.brokerEst)} of it is an estimate (fees that matched no order, spread by sales value)` : ''}`);
		const haulShown = isNum(t.haulPaid) ? t.haulPaid : t.haul;
		add(countBonuses && isNum(t.haulPaid) ? 'haul + bonuses' : 'haul', esc(fmtIsk(haulShown)), `${isNum(t.haulPaid) ? `${fmtExact(t.haulPaid)} paid for hand-offs and couriers${countBonuses ? ', hauler bonuses included' : ', hauler bonuses not counted'}; ` : ''}${fmtExact(t.haul)} of it sits in the cost of units already sold`);
		const profitText = esc(fmtIsk(t.realizedProfit, true));
		add('realized profit', `${profitText}${isNum(t.roi) ? ` <span class="dim">ROI ${fmtPct(t.roi)}</span>` : ''}`, `${fmtExact(t.realizedProfit)} = gross sales − tax − broker − cost of the units sold`, 'main');
		add('unrealized', `${esc(fmtIsk(t.unrealizedAtCost))} <span class="dim">at cost</span> · ${esc(fmtIsk(t.unrealizedAtMarket))} <span class="dim">at market</span>${t.unpricedTypes > 0 ? ` <span class="dim">(${t.unpricedTypes} unpriced)</span>` : ''}`, `unsold stock: ${fmtExact(t.unrealizedAtCost)} at cost; ${fmtExact(t.unrealizedAtMarket)} at the destination's cheapest sell order minus 0.01, after tax and broker. ${t.unpricedTypes > 0 ? `${t.unpricedTypes} types have no market snapshot and are left out of the market figure.` : ''}`);
		if (v.isRun && isNum(t.predictedProfit)) add('predicted profit', esc(fmtIsk(t.predictedProfit)), `${fmtExact(t.predictedProfit)}: the export page's prediction for the whole run`);
		if (v.crossCheck) {
			const cc = v.crossCheck;
			add('unattributed', esc(fmtIsk(cc.unattributed, true)), `journal flows in the window (market, tax, broker, contract, donation) minus what the rules attributed: ${fmtExact(cc.journalTotal)} − ${fmtExact(cc.attributedTotal)}`);
		}
		if (isNum(t.unbatchedLots)) add('unbatched lots', fmtQty(t.unbatchedLots), 'purchases in the window that no hand-off took: they stay out of this view, but what they sold is still counted in the sales');
		if (isNum(t.unsourcedUnits)) add('unsourced units', fmtQty(t.unsourcedUnits), 'units in a hand-off contract with no matching purchase in the synced history');
		if (isNum(t.otherDonations)) add('other donations', `${fmtQty(t.otherDonations)}${t.otherDonations > 0 ? ` <span class="dim">(${esc(fmtIsk(t.otherDonationsAmount))})</span>` : ''}`, 'donations to people who are not a courier\u2019s hauler: listed, never counted as cost');
		if (isNum(t.uncoveredQty) && t.uncoveredQty > 0) add('uncovered units', `${fmtQty(t.uncoveredQty)}${isNum(t.uncoveredGross) && t.uncoveredGross > 0 ? ` <span class="dim">(${esc(fmtIsk(t.uncoveredGross))} gross)</span>` : ''}`, `units sold with no purchase left to match (bought before the synced history began, or by a character that is not linked): ${fmtExact(t.uncoveredGross)} of sales that stay out of gross, tax and realized profit`);
		totalsEl.hidden = false;
		setHtml(totalsEl, items.join(''));
	};

	//--- rendering: table

	const FLAG_HELP = {
		unplanned: 'in a hand-off but not in the run’s plan (or the hand-off has no run)',
		unsourced: 'a hand-off holds units with no matching purchase in the synced history',
		unarrived: 'some units sold before their courier had delivered them (the books say they were not there yet)',
		est: 'partly estimated: a tax rate, fee or haul split that no journal row pinned down',
		uncovered: 'units were sold with no purchase left to match; they stay out of realized profit',
		mismatch: 'what the books say is left differs from the last snapshot: stock from before the sync, stock used elsewhere, or a missed sync'
	};
	const FLAG_ORDER = ['unplanned', 'unsourced', 'unarrived', 'est', 'uncovered', 'mismatch'];

	const blank = { t: `<span class="dim">${DASH}</span>`, title: '' };
	const iskCell = (v, tip, extra = {}) => ({ t: esc(fmtIsk(v, extra.signed)), title: tip === undefined ? (isNum(v) ? fmtExact(v) : '') : tip, cls: extra.cls || '' });

	const physicalTip = (r) => {
		const p = r.remaining.physical;
		const books = `By the books: ${fmtQty(r.remaining.qty)} left (cost ${fmtExact(r.unrealizedAtCost)}).`;
		if (!p || !p.known) return `${books}\nNo stock snapshot yet to compare with.`;
		const lines = [books, `Physically (last snapshot): at the source ${fmtQty(p.atSource)}, in transit ${fmtQty(p.inTransit)}, in the destination hangar ${fmtQty(p.atDest)}, listed ${fmtQty(p.listed)} = ${fmtQty(p.total)}.`];
		if (r.remaining.mismatch) lines.push(`The two disagree (the books count every lot, exported or not: ${fmtQty(r.remaining.accountingTotal)}).`);
		if (r.remaining.unbatchedQty > 0) lines.push(`${fmtQty(r.remaining.unbatchedQty)} of the books' units are in lots no hand-off took.`);
		return lines.join('\n');
	};

	const deltaClass = (d, goodWhenUp, eps) => (Math.abs(d) <= eps ? '' : (d > 0) === goodWhenUp ? 'better' : 'worse');
	const planOf = (r) => r.predicted || null;
	const planKnown = (r) => !!(r.predicted && r.predicted.listed);

	// Columns. `val` sorts (numbers or strings; null sorts last), `cell` draws. `run` columns show
	// only in run mode; `plan` ones are tinted, they hold the export page's prediction.
	const COLUMNS = [
		{ key: 'name', label: 'name', text: true, val: (r) => nameOf(r.typeId).toLowerCase(),
			help: 'item name and type id; flags are explained when you hover them' },
		{ key: 'boughtQty', label: 'bought', val: (r) => r.boughtQty,
			help: 'units bought that went out in a hand-off contract (run mode: the run’s own batches; since mode: bought in the window)',
			cell: (r) => ({ t: fmtQty(r.boughtQty), title: r.boughtQty > 0 ? `${fmtQty(r.boughtQty)} units for ${fmtExact(r.boughtCost)}; landed cost ${fmtExact(r.landedCostPerItem)} per item (buy + haul + buy-order fees)` : '' }) },
		{ key: 'boughtAvg', label: 'avg buy', val: (r) => r.boughtAvg,
			help: 'average buy price per unit, before haul',
			cell: (r) => iskCell(r.boughtAvg, isNum(r.boughtAvg) ? `${fmtExact(r.boughtAvg)} per unit; landed ${fmtExact(r.landedCostPerItem)}` : '') },
		{ key: 'soldQty', label: 'sold', val: (r) => r.soldQty,
			help: 'units sold at the destination station, matched oldest purchase first (FIFO) across the linked characters',
			cell: (r) => ({ t: fmtQty(r.soldQty), title: r.uncoveredQty > 0 ? `${fmtQty(r.uncoveredQty)} more units sold with no purchase left to match (${fmtExact(r.uncoveredGross)}); left out of realized profit` : '' }) },
		{ key: 'avgSellPrice', label: 'avg sell', val: (r) => r.avgSellPrice,
			help: 'average gross sell price per unit',
			cell: (r) => iskCell(r.avgSellPrice, isNum(r.avgSellPrice) ? `${fmtExact(r.avgSellPrice)} per unit; gross ${fmtExact(r.gross)}` : '') },
		{ key: 'tax', label: 'tax', val: (r) => r.tax,
			help: 'sales tax paid on the sold units, from the wallet journal',
			cell: (r) => iskCell(r.tax, `${fmtExact(r.tax)}${r.gross > 0 ? ` = ${fmtPct(r.tax / r.gross)} of gross` : ''}`) },
		{ key: 'broker', label: 'broker', val: (r) => r.broker,
			help: 'broker (listing and relist) fees on this item’s sell orders, from the wallet journal',
			cell: (r) => {
				const parts = [];
				if (isNum(r.brokerListing)) parts.push(`listing ${fmtExact(r.brokerListing)}`);
				if (isNum(r.brokerRelist)) parts.push(`relists ${fmtExact(r.brokerRelist)}`);
				if (isNum(r.brokerEst) && r.brokerEst) parts.push(`estimated share of unmatched fees ${fmtExact(r.brokerEst)}`);
				if (isNum(r.brokerBuyUnfilled) && r.brokerBuyUnfilled) parts.push(`buy orders never filled ${fmtExact(r.brokerBuyUnfilled)}`);
				return iskCell(r.broker, `${fmtExact(r.broker)}${parts.length ? `: ${parts.join(', ')}` : ''}`);
			} },
		{ key: 'haul', label: 'haul', val: (r) => r.haul,
			help: 'courier, hand-off and (if counted) hauler-bonus cost carried by the units already sold',
			cell: (r) => iskCell(r.haul) },
		{ key: 'cogs', label: 'COGS', val: (r) => r.cogs,
			help: 'cost of goods sold: what the sold units cost to buy, haul and (for buy orders) list',
			cell: (r) => iskCell(r.cogs, `${fmtExact(r.cogs)} = buy ${fmtExact(r.buyCost)} + haul ${fmtExact(r.haul)} + buy-order fees ${fmtExact(r.buyFee)}`) },
		{ key: 'realizedProfit', label: 'realized profit', val: (r) => r.realizedProfit,
			help: 'gross sales − tax − broker − COGS, on units already sold',
			cell: (r) => iskCell(r.realizedProfit, `${fmtExact(r.realizedProfit)} = gross ${fmtExact(r.gross)} − tax ${fmtExact(r.tax)} − broker ${fmtExact(r.broker)} − COGS ${fmtExact(r.cogs)}`, { signed: true, cls: r.realizedProfit < 0 ? 'neg' : '' }) },
		{ key: 'marginPct', label: 'margin', val: (r) => r.marginPct,
			help: 'realized profit ÷ gross sales',
			cell: (r) => ({ t: fmtPct(r.marginPct), title: '', cls: isNum(r.marginPct) && r.marginPct < 0 ? 'neg' : '' }) },
		{ key: 'left', label: 'left', val: (r) => r.remaining.qty,
			help: 'units not yet sold, by the books; hover for where they are (source, in transit, destination hangar, listed)',
			cell: (r) => ({ t: fmtQty(r.remaining.qty), title: physicalTip(r), cls: r.remaining.mismatch ? 'mark' : '' }) },
		{ key: 'unrealizedAtCost', label: 'unsold at cost', val: (r) => r.unrealizedAtCost,
			help: 'what the unsold units cost to buy and haul',
			cell: (r) => iskCell(r.unrealizedAtCost) },
		{ key: 'unrealizedAtMarket', label: 'unsold at market', val: (r) => r.unrealizedAtMarket,
			help: 'unsold units at the destination’s cheapest sell order minus 0.01, after tax and broker, from the last market snapshot',
			cell: (r) => {
				if (r.remaining.qty === 0) return { t: '0', title: '' };
				if (r.unrealizedAtMarket === null) return { t: `<span class="dim">${DASH}</span>`, title: 'no market snapshot for this item at the destination yet; the next sync takes one' };
				return iskCell(r.unrealizedAtMarket, `${fmtExact(r.unrealizedAtMarket)} = ${fmtQty(r.remaining.qty)} × ${fmtExact(r.remaining.marketNetPerUnit)} net per unit`);
			} },
		{ key: 'daysOnMarket', label: 'days on market', val: (r) => r.daysOnMarket,
			help: 'days from the first unit’s arrival (or first sale) to the last sale, or to now while stock remains. Run mode adds a projection for unsold items',
			cell: (r, c) => {
				if (r.daysOnMarket === null) return blank;
				const proj = c.isRun && !r.soldOut && isNum(r.projectedDaysToClear) ? ` <span class="dim">proj. ${esc(fmtDays(r.projectedDaysToClear))}</span>` : '';
				return { t: `${esc(fmtDays(r.daysOnMarket))}${proj}`, title: r.soldOut ? 'sold out' : isNum(r.soldFraction) ? `${fmtPct0(r.soldFraction)} sold so far` : '' };
			} },
		{ key: 'sellRate', label: 'sells/day', val: (r) => r.sellRate,
			help: 'units sold per day on the market (at least one day)',
			cell: (r) => ({ t: fmtRate(r.sellRate), title: '' }) },
		// run mode: the plan beside what happened
		{ key: 'planQty', label: 'plan qty', run: true, plan: true, val: (r) => (planKnown(r) ? r.predicted.qty : null),
			help: 'quantity the run copied',
			cell: (r) => (planKnown(r) ? { t: fmtQty(r.predicted.qty), title: '' } : blank) },
		{ key: 'fill', label: 'batched (fill)', run: true, val: (r) => (planKnown(r) ? r.predicted.fillPct : null),
			help: 'units that went out in the hand-off, and as a share of the units planned (not coloured: more is not better by itself)',
			cell: (r) => {
				const p = planOf(r);
				if (!p) return blank;
				if (!p.listed) return { t: p.batchedQty > 0 ? `${esc(fmtQty(p.batchedQty))} <span class="dim">unplanned</span>` : blank.t, title: 'not in the run\u2019s plan' };
				return { t: `${esc(fmtQty(p.batchedQty))} <span class="dim">(${esc(fmtPct0(p.fillPct))})</span>`, title: `${fmtQty(p.batchedQty)} batched of ${fmtQty(p.qty)} planned` };
			} },
		{ key: 'planNet', label: 'plan net/item', run: true, plan: true, val: (r) => (planKnown(r) ? r.predicted.revenuePerItem : null),
			help: 'the prediction’s revenue per item, net of sales tax and broker',
			cell: (r) => (planKnown(r) ? iskCell(r.predicted.revenuePerItem) : blank) },
		{ key: 'netPerItem', label: 'net/item', run: true, val: (r) => r.netPerItem,
			help: 'actual (gross − tax − broker) ÷ units sold',
			cell: (r) => iskCell(r.netPerItem) },
		{ key: 'netDelta', label: 'net Δ', run: true,
			val: (r) => (planKnown(r) && isNum(r.netPerItem) ? r.netPerItem - r.predicted.revenuePerItem : null),
			help: 'net per item, actual minus plan: + is better than predicted, − is worse',
			cell: (r) => {
				if (!planKnown(r) || !isNum(r.netPerItem)) return blank;
				const d = r.netPerItem - r.predicted.revenuePerItem;
				const cls = deltaClass(d, true, 0.5);
				return { t: esc(fmtIsk(d, true)), cls, title: `${fmtExact(r.netPerItem)} actual vs ${fmtExact(r.predicted.revenuePerItem)} planned: ${cls === 'better' ? 'better' : cls === 'worse' ? 'worse' : 'on plan'}` };
			} },
		{ key: 'planDays', label: 'plan days', run: true, plan: true, val: (r) => (planKnown(r) ? r.predicted.daysToClear : null),
			help: 'days to clear the prediction expected',
			cell: (r) => (planKnown(r) && isNum(r.predicted.daysToClear) ? { t: fmtDays(r.predicted.daysToClear), title: '' } : blank) },
		{ key: 'daysDelta', label: 'days Δ', run: true,
			val: (r) => (planKnown(r) ? daysDeltaOf(r) : null),
			help: 'days on market (projected while unsold, marked ~) minus the plan’s days to clear: fewer days is better',
			cell: (r) => {
				const d = planKnown(r) ? daysDeltaOf(r) : null;
				if (d === null) return blank;
				const projected = !r.soldOut;
				const cls = deltaClass(d, false, 0.05);
				const word = Math.abs(d) <= 0.05 ? 'on plan' : `${fmtDays(Math.abs(d))} d ${d > 0 ? 'slower' : 'faster'}`;
				return { t: `${projected ? '~' : ''}${esc(word)}`, cls, title: `${projected ? 'projected: ' : ''}${fmtDays(r.soldOut ? r.daysOnMarket : r.projectedDaysToClear)} days vs ${fmtDays(r.predicted.daysToClear)} planned: ${cls === 'better' ? 'better' : cls === 'worse' ? 'worse' : 'on plan'}` };
			} },
		{ key: 'planProfit', label: 'plan profit', run: true, plan: true, val: (r) => (planKnown(r) ? r.predicted.profit : null),
			help: 'the prediction’s profit per item × units bought',
			cell: (r) => (planKnown(r) ? iskCell(r.predicted.profit, undefined, { signed: true }) : blank) },
		{ key: 'actualProfit', label: 'profit now', run: true, val: (r) => (r.predicted ? r.predicted.actualProfit : null),
			help: 'realized profit plus the unsold units at market value',
			cell: (r) => {
				const a = r.predicted ? r.predicted.actualProfit : null;
				return a === null || a === undefined ? { t: `<span class="dim">${DASH}</span>`, title: 'needs a market price for the unsold units' } : iskCell(a, `${fmtExact(a)} = realized ${fmtExact(r.realizedProfit)} + unsold at market ${fmtExact(r.unrealizedAtMarket)}`, { signed: true, cls: a < 0 ? 'neg' : '' });
			} },
		{ key: 'profitDelta', label: 'profit Δ', run: true,
			val: (r) => (planKnown(r) && isNum(r.predicted.actualProfit) && isNum(r.predicted.profit) ? r.predicted.actualProfit - r.predicted.profit : null),
			help: 'profit now minus plan profit: + is better than predicted, − is worse',
			cell: (r) => {
				if (!planKnown(r) || !isNum(r.predicted.actualProfit) || !isNum(r.predicted.profit)) return blank;
				const d = r.predicted.actualProfit - r.predicted.profit;
				const cls = deltaClass(d, true, 0.5);
				return { t: esc(fmtIsk(d, true)), cls, title: `${fmtExact(r.predicted.actualProfit)} now vs ${fmtExact(r.predicted.profit)} planned: ${cls === 'better' ? 'better' : cls === 'worse' ? 'worse' : 'on plan'}` };
			} }
	];

	function daysDeltaOf(r) {
		const actual = r.soldOut ? r.daysOnMarket : r.projectedDaysToClear;
		if (!isNum(actual) || !isNum(r.predicted.daysToClear)) return null;
		return actual - r.predicted.daysToClear;
	}

	const visibleColumns = () => COLUMNS.filter(c => !c.run || (state.view && state.view.isRun));

	const rowMatches = (r) => {
		if (query === '') return true;
		const q = query.toLowerCase();
		return nameOf(r.typeId).toLowerCase().includes(q) || String(r.typeId).includes(q);
	};

	// The rows to draw, sorted; and what was left out and why.
	const selectRows = () => {
		const v = state.view;
		if (!v) return { rows: [], total: 0, soldOutHidden: 0, searchHidden: 0 };
		const cols = visibleColumns();
		const col = cols.find(c => c.key === sort.key) || cols.find(c => c.key === 'realizedProfit');
		const dir = sort.dir === 'asc' ? 1 : -1;
		let rows = v.rows;
		let soldOutHidden = 0;
		if (!showSoldOut) {
			soldOutHidden = rows.filter(r => r.soldOut && rowMatches(r)).length;
			rows = rows.filter(r => !r.soldOut);
		}
		const beforeSearch = rows.length;
		rows = rows.filter(rowMatches);
		const sorted = rows.slice().sort((a, b) => {
			const x = col.val(a);
			const y = col.val(b);
			const xn = x === null || x === undefined || (typeof x === 'number' && Number.isNaN(x));
			const yn = y === null || y === undefined || (typeof y === 'number' && Number.isNaN(y));
			if (xn || yn) return xn === yn ? a.typeId - b.typeId : xn ? 1 : -1;
			if (x < y) return -dir;
			if (x > y) return dir;
			return a.typeId - b.typeId;
		});
		return { rows: sorted, total: v.rows.length, soldOutHidden, searchHidden: beforeSearch - rows.length, col };
	};

	const nameCell = (r) => {
		const flags = FLAG_ORDER.filter(f => r.flags.includes(f))
			.map(f => `<span class="flag" title="${esc(FLAG_HELP[f])}">${f}</span>`).join('');
		return `<td class="text nameCell"><span class="name" title="${esc(nameOf(r.typeId))}">${esc(nameOf(r.typeId))}</span> <span class="dim">${r.typeId}</span>${flags}</td>`;
	};

	const renderTable = () => {
		const v = state.view;
		const sel = selectRows();
		const hasRows = !!v && sel.rows.length > 0;
		tableEl.hidden = !hasRows;
		if (!hasRows) {
			setHtml(tbodyEl, '');
			return;
		}
		const cols = visibleColumns();
		const ctx = { isRun: v.isRun };
		const head = cols.map(col => {
			const active = sel.col && sel.col.key === col.key;
			const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
			const cls = `${col.text ? 'text' : 'numeric'}${active ? ' sorted' : ''}${col.plan ? ' planCol' : ''}`;
			return `<th class="${cls}" data-key="${col.key}" data-fk="th-${col.key}" tabindex="0" aria-sort="${active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}" title="${esc(col.help)}">${esc(col.label)}${arrow}</th>`;
		}).join('');
		setHtml(sortRowEl, head);
		const body = sel.rows.map(r => `<tr data-type-id="${r.typeId}">${cols.map(col => {
			if (col.key === 'name') return nameCell(r);
			const cell = col.cell(r, ctx);
			const zero = cell.t === '0' ? ' dim' : ''; // nothing there: keep the eye on the figures
			return `<td class="numeric${col.plan ? ' planCell' : ''}${cell.cls ? ` ${cell.cls}` : ''}${zero}"${cell.title ? ` title="${esc(cell.title)}"` : ''}>${cell.t}</td>`;
		}).join('')}</tr>`).join('');
		setHtml(tbodyEl, body);
	};

	//--- rendering: state box, status bits

	const card = (title, html) => `<div class="card"><h2>${esc(title)}</h2>${html}</div>`;

	const setupHtml = () => {
		const cfg = state.cfg;
		return card('Set up EVE sign-in', `<p>This page reads your own wallet, orders, assets and contracts through EVE’s login. It needs a developer application, once:</p>
			<ol>
				<li>Open <a href="https://developers.eveonline.com/applications" target="_blank" rel="noopener">developers.eveonline.com/applications</a> and create an application named “eFlip (local)”.</li>
				<li>Tick these scopes: ${(cfg.scopes || []).map(s => `<code>${esc(s)}</code>`).join(' ')}</li>
				<li>Set its callback URL to <code>${esc(cfg.callbackUrl)}</code>.</li>
				<li>Copy its Client ID and Secret into the <code>.env</code> file next to <code>server.js</code> as <code>EVE_CLIENT_ID</code> and <code>EVE_CLIENT_SECRET</code>.</li>
				<li>Restart the server, then check again.</li>
			</ol>
			<button type="button" data-act="retryLoad" data-fk="check-again">Check again</button>`);
	};

	// The next wider window, or null when there is none.
	const widenNext = (sel) => {
		if (sel.kind === 'days' && sel.days === 7) return { sel: { kind: 'days', days: 30 }, label: 'the last 30 days' };
		if (sel.kind === 'days' && sel.days === 30) return { sel: { kind: 'days', days: 90 }, label: 'the last 90 days' };
		if (sel.kind === 'run' || sel.kind === 'unplanned') return { sel: { kind: 'days', days: 30 }, label: 'the last 30 days' };
		if (sel.kind === 'days' || sel.kind === 'date') return { sel: { kind: 'all' }, label: 'all synced history' };
		return null;
	};

	const stateBoxHtml = () => {
		if (state.fatal) return card(state.fatal.title, `${state.fatal.html}${state.fatal.retry ? '<button type="button" data-act="retryLoad" data-fk="retry">Try again</button>' : ''}`);
		if (!state.cfg) return card('Loading…', '<p class="muted">Contacting the server.</p>');
		if (!state.cfg.configured) return setupHtml();
		if (!state.characters) return card('Loading…', '<p class="muted">Reading the linked characters.</p>');
		if (state.characters.length === 0) {
			return card('Link the characters that buy and sell', `<p>Results are worked out from the wallet, orders, assets and contracts of the characters you link: the one that buys at the source and the one that sells at the destination (they may be the same).</p>
				<a class="btn" href="${LOGIN_URL}">+ Add character</a>`);
		}
		const v = state.view;
		if (!v) {
			if (state.computeError) return card('Could not work out the results', `<p>${esc(state.computeError)}</p><button type="button" data-act="retryLoad" data-fk="retry">Try again</button>`);
			return card('Loading…', `<p class="muted">${esc(state.busy || 'Loading trade data…')}</p>`);
		}
		if (state.computeError) return card('Could not work out the results', `<p>${esc(state.computeError)}</p><button type="button" data-act="retryLoad" data-fk="retry">Try again</button>`);
		const sel = selectRows();
		if (sel.rows.length > 0) return '';
		if (v.rows.length === 0) {
			const kind = v.view.sel.kind;
			if (kind === 'unplanned') return card('No unplanned batches', '<p>Every hand-off in the synced history belongs to an export run.</p>');
			const where = `${v.view.route.start} ${ARROW} ${v.view.route.end}`;
			const next = widenNext(v.view.sel);
			return card('No trades in this window', `<p>No purchases, sales or stock for ${esc(where)} ${kind === 'run' ? 'in this run' : 'in the selected window'}.${next ? '' : ' Try another route.'}</p>
				${next ? `<button type="button" data-act="widen" data-fk="widen">Widen to ${esc(next.label)}</button>` : ''}`);
		}
		if (sel.soldOutHidden > 0) {
			const all = sel.soldOutHidden === v.rows.length;
			return card('Everything here is sold out', `<p>${all ? `All ${nf.format(sel.soldOutHidden)} items` : `${nf.format(sel.soldOutHidden)} matching items`} in this window are sold out and hidden.</p><button type="button" data-act="showSoldOut" data-fk="show-sold">Show sold out</button>`);
		}
		return card('No items match', `<p>None of the ${nf.format(v.rows.length)} items match \u201c${esc(query)}\u201d.</p><button type="button" data-act="clearSearch" data-fk="clear-search">Clear search</button>`);
	};

	const renderStateBox = () => setHtml(stateBoxEl, stateBoxHtml());

	// The note beside the window bar: how many rows, what is hidden, what is still loading.
	const renderStatusBits = () => {
		const parts = [];
		const v = state.view;
		if (v) {
			const sel = selectRows();
			parts.push(`${nf.format(sel.rows.length)} of ${nf.format(v.rows.length)} items`);
			if (sel.soldOutHidden > 0) parts.push(`${nf.format(sel.soldOutHidden)} sold out hidden`);
		}
		if (state.busy) parts.push(state.busy);
		if (state.typeProgress && state.typeProgress.total > 0) parts.push(`looking up item names and volumes ${state.typeProgress.done}/${state.typeProgress.total}`);
		setText(tableNote, parts.join(' · '));
	};

	const render = () => {
		renderBanners();
		renderCharacters();
		renderWindowBar();
		renderRunInfo();
		renderStateBox();
		renderTotals();
		renderTable();
		renderStatusBits();
		updateStickyOffset();
	};

	//--- sticky header: the totals strip pins to the top, the table header just below it

	const updateStickyOffset = () => {
		document.documentElement.style.setProperty('--sticky-offset', (totalsEl.hidden ? 0 : totalsEl.offsetHeight) + 'px');
	};
	if (typeof ResizeObserver !== 'undefined') new ResizeObserver(updateStickyOffset).observe(totalsEl);

	//--- events

	const chooseWindow = (sel) => {
		winSel = sel;
		lsSet('window', sel);
		renderWindowBar();
		apply();
	};

	windowSel.addEventListener('change', () => {
		const v = windowSel.value;
		if (v.startsWith('run:')) chooseWindow({ kind: 'run', runId: v.slice(4) });
		else if (v === 'unplanned') chooseWindow({ kind: 'unplanned' });
		else if (v.startsWith('days:')) chooseWindow({ kind: 'days', days: Number(v.slice(5)) });
		else if (v === 'all') chooseWindow({ kind: 'all' });
		else if (v === 'date') {
			const prev = winSel && winSel.kind === 'date' ? winSel.date : ymd(Date.now() - 30 * DAY_MS);
			chooseWindow({ kind: 'date', date: prev });
		}
	});
	sinceDate.addEventListener('change', () => {
		if (Number.isFinite(Date.parse(`${sinceDate.value}T00:00:00`))) chooseWindow({ kind: 'date', date: sinceDate.value });
	});
	const routeChanged = (changed) => {
		let start = startSel.value;
		let end = endSel.value;
		if (start === end) {
			// the other end moves to a different station rather than leaving a route to itself
			const other = Object.keys(STATIONS).find(n => n !== changed);
			if (changed === 'start') end = other === start ? Object.keys(STATIONS).find(n => n !== start) : other;
			else start = other === end ? Object.keys(STATIONS).find(n => n !== end) : other;
		}
		routeSel = { start, end };
		lsSet('route', routeSel);
		renderWindowBar();
		apply();
	};
	startSel.addEventListener('change', () => routeChanged('start'));
	endSel.addEventListener('change', () => routeChanged('end'));
	for (const name of Object.keys(STATIONS)) {
		startSel.add(new Option(name, name));
		endSel.add(new Option(name, name));
	}
	searchInput.addEventListener('input', () => {
		query = searchInput.value.trim();
		renderStateBox();
		renderTable();
		renderStatusBits();
	});
	soldOutChk.addEventListener('change', () => {
		showSoldOut = soldOutChk.checked;
		lsSet('showSoldOut', showSoldOut);
		renderStateBox();
		renderTable();
		renderStatusBits();
	});
	bonusChk.addEventListener('change', () => {
		countBonuses = bonusChk.checked;
		lsSet('countBonuses', countBonuses);
		apply();
	});

	const sortBy = (key) => {
		sort = sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' };
		lsSet('sort', sort);
		renderTable();
	};
	sortRowEl.addEventListener('click', (e) => {
		const th = e.target.closest('th[data-key]');
		if (th) sortBy(th.dataset.key);
	});
	sortRowEl.addEventListener('keydown', (e) => {
		if (e.key !== 'Enter' && e.key !== ' ') return;
		const th = e.target.closest('th[data-key]');
		if (!th) return;
		e.preventDefault();
		sortBy(th.dataset.key);
	});
	runInfoEl.addEventListener('toggle', (e) => {
		if (e.target.id === 'batches') state.batchesOpen = e.target.open;
	}, true);

	const retryLoad = async () => {
		state.fatal = null;
		state.cfg = null;
		render();
		await init();
	};

	const act = {
		sync: (btn) => startSync({ characterIds: [Number(btn.dataset.id)], force: true, market: false }),
		syncAll: () => startSync({ force: true, market: true }),
		remove: (btn) => {
			state.removing = Number(btn.dataset.id);
			state.removingSince = Date.now();
			renderCharacters();
			const confirm = chipsEl.querySelector(`[data-fk="confirm-${state.removing}"]`);
			if (confirm) confirm.focus();
		},
		cancelRemove: (btn) => {
			state.removing = null;
			renderCharacters();
			const again = chipsEl.querySelector(`[data-fk="remove-${btn.dataset.id}"]`);
			if (again) again.focus();
		},
		confirmRemove: (btn) => {
			if (Date.now() - state.removingSince < 400) return; // a double-click on Remove must not confirm
			const chip = btn.closest('.chip');
			const purge = !!(chip && chip.querySelector('input.purge') && chip.querySelector('input.purge').checked);
			removeCharacter(Number(btn.dataset.id), purge);
		},
		dismiss: (btn) => {
			state.notices.splice(Number(btn.dataset.i), 1);
			renderBanners();
		},
		widen: () => {
			const next = widenNext(resolveSelection());
			if (next) chooseWindow(next.sel);
			windowSel.focus(); // the button that was pressed is gone
		},
		clearSearch: () => {
			searchInput.value = '';
			query = '';
			renderStateBox();
			renderTable();
			renderStatusBits();
			searchInput.focus();
		},
		showSoldOut: () => {
			showSoldOut = true;
			lsSet('showSoldOut', true);
			soldOutChk.checked = true;
			renderStateBox();
			renderTable();
			renderStatusBits();
			soldOutChk.focus(); // the button that was pressed is gone
		},
		retryLoad: () => retryLoad()
	};
	document.addEventListener('click', (e) => {
		const btn = e.target.closest('button[data-act]');
		if (!btn || btn.disabled) return;
		const handler = act[btn.dataset.act];
		if (handler) handler(btn);
	});
	chipsEl.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && state.removing !== null) {
			const id = state.removing;
			state.removing = null;
			renderCharacters();
			const again = chipsEl.querySelector(`[data-fk="remove-${id}"]`);
			if (again) again.focus();
		}
	});
	// Portraits come from another host; a failed one just leaves the grey square.
	chipsEl.addEventListener('error', (e) => {
		if (e.target && e.target.classList && e.target.classList.contains('portrait')) e.target.classList.add('noimg');
	}, true);

	//--- init

	// Where a sign-in came back from: ?linked=<id> or ?ssoError=<code>. The query is dropped so a
	// reload does not repeat the message.
	const SSO_ERRORS = {
		state: 'The sign-in took too long or came from another tab. Try “+ Add character” again.',
		exchange: 'EVE did not accept the sign-in. Try “+ Add character” again.',
		jwt: 'EVE’s answer could not be verified. Try “+ Add character” again.',
		store: 'The character could not be saved on this computer. Check that the data folder is writable, then try again.',
		access_denied: 'The sign-in was cancelled at EVE. Nothing was linked.'
	};
	let linkedId = null;
	const readUrlNotices = () => {
		let params;
		try { params = new URLSearchParams(location.search); } catch (e) { return; }
		const code = params.get('ssoError');
		const linked = params.get('linked');
		if (code) state.notices.push({ kind: 'err', text: SSO_ERRORS[code] || `EVE sign-in failed (${code}). Try “+ Add character” again.` });
		if (linked && /^\d+$/.test(linked)) linkedId = Number(linked);
		if (code || linked) {
			try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
		}
	};

	const init = async () => {
		try {
			state.cfg = await api('/api/config');
		} catch (e) {
			loadFatal(e);
			render();
			return;
		}
		if (!state.cfg.configured) {
			render();
			return;
		}
		await reloadData();
		if (state.fatal) return;
		if (linkedId !== null) {
			state.notices.push({ kind: 'info', text: `Linked ${charName(linkedId)}. Its history is being synced now.` });
			linkedId = null;
			renderBanners();
		}
		maybeSyncOnLoad();
	};

	// The first paint: whatever the last visit chose, then the server's answers.
	renderWindowBar();
	readUrlNotices();
	soldOutChk.checked = showSoldOut;
	bonusChk.checked = countBonuses;
	render();
	init();

	// Chip ages ("synced 12 minutes ago") move on without a poll.
	setInterval(() => {
		renderCharacters();
		renderBanners();
	}, 30000);
})();
