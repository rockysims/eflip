// results-shared.js: what the results page (results.html) and the insights page (insights.html) have in
// common, so neither carries a copy: the ISK and date formatting, the guarded localStorage, the server
// calls, the window bar (run or since-date, route, "count hauler bonuses"), and the loader that reads the
// linked characters' ledgers, runs, snapshots, destination prices and item names, then works the results
// out with results-calc.js. It also fills a page's `#envNotice` container, when it has one, with the
// notice for an unset EFLIP_DATA_DIR or ESI_USER_AGENT (GET /api/config's `env`). Plain script, one
// global (`resultsShared`), no build step.
//
// Usage (after util.js and results-calc.js, before the page's own script):
//   const shared = resultsShared.create({ render, renderStatus, typesChanged, reloaded });
//   const { state } = shared;   // the loader's state; a page adds its own fields to it
//   shared.renderWindowBar(); await shared.reloadData();
// The hooks are the page's own drawing: render() everything, renderStatus() the note beside the window
// bar, typesChanged() when item names arrived, reloaded() after the characters, runs and ledgers were
// read (the results page notes its sync state there). create() reads the window bar's elements by id
// (#windowBar, #windowSel, #dateWrap, #sinceDate, #routeWrap, #routeFixed, #startStation, #endStation,
// #countBonuses) and wires their events; the page's HTML carries the markup and its own CSS.
const resultsShared = (() => {
	if (typeof document === 'undefined') return null;

	//--- constants

	const { constants: C } = util;
	// Duplicates export.js's STATIONS for now (unify later into one shared table).
	const STATIONS = {
		Jita: { regionId: C.JITA_REGION_ID, stationId: C.JITA_STATION_ID },
		Amarr: { regionId: C.AMARR_REGION_ID, stationId: C.AMARR_STATION_ID },
		Dodixie: { regionId: C.DODIXIE_REGION_ID, stationId: C.DODIXIE_STATION_ID },
		Rens: { regionId: C.RENS_REGION_ID, stationId: C.RENS_STATION_ID },
		Stacmon: { regionId: C.STACMON_REGION_ID, stationId: C.STACMON_STATION_ID }
	};
	const DAY_MS = 24 * 60 * 60 * 1000;
	const SNAPSHOT_MARGIN_DAYS = 7; // snapshots are read from this long before the window starts
	const MARKET_CHUNK = 400;       // /api/market takes at most 500 type ids
	const DASH = '—';
	const MINUS = '−';
	const ARROW = '→';

	//--- localStorage (guarded)

	const storage = (prefix) => ({
		get: (key, fallback) => {
			try {
				const raw = localStorage.getItem(prefix + key);
				return raw === null ? fallback : JSON.parse(raw);
			} catch (e) { return fallback; }
		},
		set: (key, val) => {
			try { localStorage.setItem(prefix + key, JSON.stringify(val)); } catch (e) { /* ignore */ }
		}
	});
	// The window, route and bonus choices live under one prefix, so the two pages share them.
	const ls = storage('eflip.results.');
	const lsGet = ls.get;
	const lsSet = ls.set;

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

	// The next wider window, or null when there is none.
	const widenNext = (sel) => {
		if (sel.kind === 'days' && sel.days === 7) return { sel: { kind: 'days', days: 30 }, label: 'the last 30 days' };
		if (sel.kind === 'days' && sel.days === 30) return { sel: { kind: 'days', days: 90 }, label: 'the last 90 days' };
		if (sel.kind === 'run' || sel.kind === 'unplanned') return { sel: { kind: 'days', days: 30 }, label: 'the last 30 days' };
		if (sel.kind === 'days' || sel.kind === 'date') return { sel: { kind: 'all' }, label: 'all synced history' };
		return null;
	};

	//--- the session: state, the window choices and the loader

	const create = (hooks = {}) => {
		const noop = () => {};
		const hook = {
			render: hooks.render || noop,
			renderStatus: hooks.renderStatus || noop,
			typesChanged: hooks.typesChanged || noop,
			reloaded: hooks.reloaded || noop
		};
		const $ = (sel) => document.querySelector(sel);

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
			view: null,               // the last computed view: {view, result, rows, totals, isRun, isUnplanned, batches, crossCheck}
			computeError: null,
			loadError: null,          // a refresh that failed while earlier data stays on screen
			busy: '',                 // "Loading ..." text beside the window bar
			typeProgress: null,       // {done, total} of item names and volumes being looked up
			hasLoaded: false
		};

		//--- user choices (persisted)

		let winSel = lsGet('window', null); // {kind: 'run', runId} | 'unplanned' | 'days' {days} | 'date' {date} | 'all'
		let routeSel = lsGet('route', null); // {start, end}
		let countBonuses = lsGet('countBonuses', true) !== false;

		//--- the window bar's elements

		const windowBarEl = $('#windowBar');
		const windowSel = $('#windowSel');
		const dateWrap = $('#dateWrap');
		const sinceDate = $('#sinceDate');
		const routeWrap = $('#routeWrap');
		const routeFixed = $('#routeFixed');
		const startSel = $('#startStation');
		const endSel = $('#endStation');
		const bonusChk = $('#countBonuses');

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
			hook.renderStatus();
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
				hook.reloaded();
			} catch (e) {
				if (gen !== reloadGen) return;
				state.busy = '';
				if (state.view) state.loadError = `Could not refresh the data (${e.message}); the figures below are from the last load.`;
				else loadFatal(e);
				hook.render();
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
				hook.typesChanged();
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
				hook.render();
				return;
			}
			const view = resolveView();
			state.busy = state.view ? 'working out results…' : 'loading trade data…';
			hook.renderStatus();
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
				hook.render();

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
					hook.render();
				}
				lookUpTypes();
			} catch (e) {
				if (gen !== applyGen) return;
				state.busy = '';
				state.computeError = e && e.message ? e.message : String(e);
				hook.render();
			}
		};

		// Names for the rows on screen, and volumes for the haul split; new volumes redo the sums.
		const lookUpTypes = () => {
			loadTypes(state.view ? state.view.rows.map(r => r.typeId) : []);
			loadTypes(volumeTypeIds());
		};

		//--- the window bar

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
			bonusChk.checked = countBonuses;
		};

		//--- window bar events

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

		bonusChk.addEventListener('change', () => {
			countBonuses = bonusChk.checked;
			lsSet('countBonuses', countBonuses);
			apply();
		});

		return {
			state,
			countBonuses: () => countBonuses,
			charName, nameOf, runProfit,
			resolveSelection, chooseWindow, renderWindowBar,
			reloadData, apply, loadFatal, buildInput
		};
	};

	//--- the environment notice (results, insights and orders pages; the export page prints the same lines)

	// GET /api/config says whether the two optional settings that matter are in the environment. A bar under
	// the page's top, in the page's `#envNotice` container, says so for as long as either is unset: not a
	// dialog, not dismissible. The wording is the plan's (docs/order-monitor-plan.md, UI 2); the export page
	// prints the same two sentences. `env` is `config.env`: {dataDir, dataDirFromEnv, userAgentFromEnv}.
	const envNoticeLines = (env) => {
		const lines = [];
		if (!env || typeof env !== 'object') return lines;
		if (env.dataDirFromEnv === false && typeof env.dataDir === 'string') {
			lines.push(`Synced data is in <code>${esc(env.dataDir)}</code> because EFLIP_DATA_DIR is not set. Add <code>EFLIP_DATA_DIR=/path</code> to .env so every checkout shares one store.`);
		}
		if (env.userAgentFromEnv === false) lines.push('ESI_USER_AGENT is not set; CCP asks for a contact in it.');
		return lines;
	};
	const renderEnvNotice = (env, el = document.getElementById('envNotice')) => {
		if (!el) return;
		const html = envNoticeLines(env)
			.map(line => `<div class="envNote"><span class="sev"><span aria-hidden="true">⚠</span> Note:</span><span>${line}</span></div>`).join('');
		setHtml(el, html);
	};
	const initEnvNotice = async () => {
		const el = document.getElementById('envNotice');
		if (!el) return;
		try {
			const cfg = await api('/api/config');
			renderEnvNotice(cfg && cfg.env, el);
		} catch (e) { /* the page's own load reports an unreachable server */ }
	};
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initEnvNotice);
	else initEnvNotice();

	return { constants: { STATIONS, DAY_MS, DASH, MINUS, ARROW, SNAPSHOT_MARGIN_DAYS }, storage, ls, fmt: { nf, nf2, isNum, esc, fmtIsk, fmtExact, fmtQty, fmtPct, fmtPct0, fmtDays, fmtRate, ago, clock, stamp, ymd, toMs }, setHtml, setText, api, widenNext, create, renderEnvNotice };
})();
