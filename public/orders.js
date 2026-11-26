// orders.js: the order monitor page (orders.html). Phases 3 and 5 of docs/order-monitor-plan.md ("UI", "Page
// contract").
//
// What it shows: the linked characters' open sell orders, each with where it stands in the queue, whether
// and since when it was undercut, how fast others undercut it, what updating it would earn, and a verdict;
// and what sold recently, as a timeline of sale clusters with a total per item and, per item row, lines for
// when we were listed and on top; and per order or sales row, the export run that planned it (a snapshot
// panel). Every figure is the user's own ESI data or ESI
// market data, read through the server's /api routes (no token ever reaches this page); the analysis is
// orders-calc.js (pure, tested), the FIFO costs behind it are results-calc.js, and this file only loads,
// asks, and draws.
//
// Flow: config -> results-shared's loader (characters, sync status, ledgers, retained snapshots, item
// names and volumes, as the results page reads them) -> this page's own reads (the order logs, the books,
// book logs and history of the listed items, every snapshot) -> resultsCalc over the WHOLE ledger for the
// facts (sells, lots, relists) -> ordersCalc -> render. "Refresh now", and every five minutes while the
// page is open, posts /api/watch (one watch refresh: our orders, then the listed items' books) and reads
// the same things again; the verdicts re-run at once when a threshold changes, with no reads.
//
// Colour follows the dataviz skill: the documented blue and red pair for profit and loss, the status-like
// verdict badges always with their word, and no mark or colour carries meaning alone (a loss is a square,
// a profit a circle; pending is hollow; every mark has a tooltip, a legend entry and a row in the table).
// Light theme only, like the other pages.
(() => {
	if (typeof document === 'undefined') return;

	const $ = (sel) => document.querySelector(sel);

	//--- shared with the results and insights pages (results-shared.js): formatting, storage, server calls, the loader

	const { DAY_MS, DASH, STATIONS } = resultsShared.constants;
	const { nf2, isNum, esc, fmtIsk, fmtExact, fmtQty, fmtPct, fmtRate, clock, stamp, toMs: msOf } = resultsShared.fmt;
	const { setHtml, setText, api } = resultsShared;
	const store = resultsShared.storage('eflip.orders.');
	const oc = ordersCalc;

	const MIN_MS = 60 * 1000;
	const HOUR_MS = 60 * MIN_MS;
	const REFRESH_MS = 5 * MIN_MS;          // the watch refresh while the page is open
	const ORDERS_STALE_MS = 25 * MIN_MS;    // the age that turns "orders as of" amber
	const BOOKS_STALE_MS = 10 * MIN_MS;     // and "books as of"
	const REDRAW_MS = MIN_MS;               // relative times and the timeline's right edge move on
	const MARKET_CHUNK = 100;               // items per /api/market call (each answer carries their book logs)
	const LOGIN_URL = '/sso/login?return=/orders.html';
	// every duration on the page is compact, with no space before the unit (decision 21): '24h', '2.6d', '35min'
	const WINDOWS = [
		{ key: '24h', label: '24h', ms: DAY_MS },
		{ key: '2d', label: '2d', ms: 2 * DAY_MS },
		{ key: '7d', label: '7d', ms: 7 * DAY_MS },
		{ key: '30d', label: '30d', ms: 30 * DAY_MS }
	];
	const REGION_NAMES = { Jita: 'The Forge', Amarr: 'Domain', Dodixie: 'Sinq Laison', Rens: 'Heimatar', Stacmon: 'Placid' };

	//--- palette (dataviz skill, references/palette.md): the blue and red pair, ink and grid tokens

	const INK2 = '#52514e';
	const SURFACE = '#fcfcfb';
	const GRID = '#e1e0d9';
	const STRIPE = '#f4f3ef';
	const AXIS = '#c3c2b7';
	const PROFIT = '#2a78d6';
	const LOSS = '#e34948';
	const PLOT_STYLE = { background: 'transparent', color: INK2, fontSize: '12px', overflow: 'visible' };

	//--- small formatting helpers

	const price = (v) => (isNum(v) ? nf2.format(v) : DASH); // an exact price: a tick of 0.01 or 10 ISK must stay visible
	// A duration the way the verdict reasons write it (decision 21): '<1min', '35min', '1.1h', '2.6d'; one decimal
	// under 10, no space. The module's fmtCompactDuration, so both read alike.
	const dur = (ms) => {
		if (!isNum(ms)) return DASH;
		return oc.fmtCompactDuration(Math.abs(ms));
	};
	const ageText = (ms, now) => (isNum(ms) ? `${dur(now - ms)} ago` : DASH);
	const hasMoment = () => typeof moment === 'function';
	const eveTime = (ms) => {
		if (!hasMoment()) return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
		const sameDay = moment(ms).format('YYYY-MM-DD') === moment.utc(ms).format('YYYY-MM-DD');
		return moment.utc(ms).format(sameDay ? 'HH:mm' : 'MMM D, HH:mm');
	};
	const whenText = (ms) => `${stamp(ms)} (EVE ${eveTime(ms)})`;
	const clockOrDate = (ms) => (hasMoment() && moment(ms).isSame(moment(), 'day') ? clock(ms) : stamp(ms));
	const short = (s, n = 26) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
	const plural = (n, one, many = `${one}s`) => `${nf2.format(n)} ${n === 1 ? one : many}`;
	const tot = (label, text, title, cls = '') => `<span class="tot ${cls}"${title ? ` title="${esc(title)}"` : ''}><span class="dim">${esc(label)}</span> <b>${text}</b></span>`;
	const money = (v, signed = false) => `<span${isNum(v) && v < 0 ? ' class="neg"' : ''}>${esc(fmtIsk(v, signed))}</span>`;

	//--- the loader (shared) and this page's own state

	const shared = resultsShared.create({
		render: () => render(),
		renderStatus: () => renderStatusLine(),
		typesChanged: () => redrawNames(),
		reloaded: () => { data.ledgerGen++; }
	});
	const { state, charName, nameOf } = shared;

	// What this page reads besides the loader's: the order logs, books and history, and what it worked out.
	const data = {
		loaded: false,         // the first read of the order logs and books is in
		error: null,           // a read that failed while earlier data stays on screen
		fatalMsg: null,        // the first read failed: nothing to show yet
		watch: null,           // GET /api/watch, or the answer of the last POST
		sync: null,            // GET /api/sync
		orderLogs: {},         // characterId -> order-log.json
		open: {},              // characterId -> {fetchedAt, orders}: ESI-shaped rows of the open orders
		books: {}, bookLogs: {}, history: {},
		soldHistory: new Map(), // typeId -> history rows of the route's destination region, for items sold but not listed
		soldHistoryAt: 0,
		soldHistoryTried: new Set(),
		facts: null, taxRate: null, factsKey: '',
		ledgerGen: 0,          // bumped each time the loader reads the ledgers again
		snapshotGen: 0,
		result: null,          // the last ordersCalc.compute
		now: 0,                // its `now`
		computeError: null,
		loadedAt: null
	};

	//--- user choices (persisted under eflip.orders.)

	const exportMinRoi = () => {
		const v = resultsShared.storage('eflip.export.').get('minRoi', null);
		return isNum(v) && v >= 1 ? v : null;
	};
	const savedThresholds = store.get('thresholds', {});
	const thresholds = {
		leaveHours: isNum(savedThresholds.leaveHours) && savedThresholds.leaveHours >= 0 ? savedThresholds.leaveHours : oc.defaultThresholds.leaveHours,
		undercutDays: isNum(savedThresholds.undercutDays) && savedThresholds.undercutDays >= 0 ? savedThresholds.undercutDays : oc.defaultThresholds.undercutDays,
		minRoi: isNum(savedThresholds.minRoi) && savedThresholds.minRoi >= 1 ? savedThresholds.minRoi : (exportMinRoi() || estimate.defaultConfig.MIN_ROI),
		scope: savedThresholds.scope === 'region' ? 'region' : 'station'
	};
	let winKey = WINDOWS.some(w => w.key === store.get('window', null)) ? store.get('window', null) : '7d';
	// the presence lines (decision 18), on by default; the Phase 3 `showEvents` key is ignored
	let showPresence = store.get('showPresence', true) !== false;
	let refreshOpen = store.get('refreshOpen', true) !== false;
	let sort = store.get('sort', { key: null, dir: 'desc' });
	if (!sort || typeof sort !== 'object') sort = { key: null, dir: 'desc' };

	//--- elements

	const bannersEl = $('#banners');
	const charactersEl = $('#characters');
	const chipsEl = $('#chips');
	const stateBoxEl = $('#stateBox');
	const liveEl = $('#live');
	const statusLineEl = $('#statusLine');
	const refreshBtn = $('#refreshNow');
	const refreshChk = $('#refreshOpen');
	const tickNoteEl = $('#tickNote');
	const thNoteEl = $('#thNote');
	const feeRatesEl = $('#feeRates');
	const openCountEl = $('#openCount');
	const openNoteEl = $('#openNote');
	const defaultOrderBtn = $('#defaultOrder');
	const ordersEl = $('#orders');
	const sortRowEl = $('#sortRow');
	const tbodyEl = $('#orders tbody');
	const notesEl = $('#notes');
	const winSegEl = $('#winSeg');
	const presenceChk = $('#showPresence');
	const soldTotalsEl = $('#soldTotals');
	const soldLegendEl = $('#soldLegend');
	const soldBodyEl = $('#soldBody');
	const soldFootEl = $('#soldFoot');
	const soldTableEl = $('#soldTable');
	const tipEl = $('#tip');
	const snapEl = $('#snap');

	//--- the route (the same choice as the results page: its saved route, else the newest run's, else Jita to Amarr)

	const currentRoute = () => {
		const valid = (r) => r && STATIONS[r.start] && STATIONS[r.end] && r.start !== r.end;
		let names = resultsShared.ls.get('route', null);
		if (!valid(names)) {
			const run = state.runs && state.runs[0] && state.runs[0].route;
			names = valid(run) ? { start: run.start, end: run.end } : { start: 'Jita', end: 'Amarr' };
		}
		const S = STATIONS[names.start];
		const E = STATIONS[names.end];
		return {
			start: names.start, end: names.end,
			startStationId: S.stationId, endStationId: E.stationId, startRegionId: S.regionId, endRegionId: E.regionId
		};
	};
	const regionWord = () => REGION_NAMES[currentRoute().end] || 'the region';
	const stationsInput = () => {
		const out = {};
		for (const [name, s] of Object.entries(STATIONS)) out[s.stationId] = { name, regionId: s.regionId };
		return out;
	};

	//--- reading the order logs, the books and the history

	const asArray = (v) => (Array.isArray(v) ? v : []);
	const iso = (ms) => new Date(ms).toISOString();
	const maxIso = (...list) => {
		const ms = list.filter(Boolean).map(Date.parse).filter(Number.isFinite);
		return ms.length > 0 ? iso(Math.max(...ms)) : null;
	};

	// ESI-shaped rows of one character's open orders from its order log (the fresher source: the retained
	// snapshots follow the hourly sync), else from its newest snapshot (a character the watch has not seen).
	const openRowsFromLog = (log) => {
		const rows = [];
		for (const [id, rec] of Object.entries(log || {})) {
			if (!rec || rec.end) continue;
			const last = asArray(rec.path)[asArray(rec.path).length - 1];
			if (!last) continue;
			rows.push({
				order_id: Number(id), type_id: rec.typeId, location_id: rec.locationId, region_id: rec.regionId,
				price: last.price, volume_remain: last.volumeRemain, volume_total: rec.volumeTotal, issued: last.issued, duration: rec.duration,
				...(rec.isBuy ? { is_buy_order: true } : {})
			});
		}
		return rows;
	};
	const ordersCheckedAt = (id) => {
		const w = data.watch && data.watch.characters && data.watch.characters[id];
		const s = data.sync && data.sync.characters && data.sync.characters[id];
		return maxIso(w && w.status === 'ok' ? w.checkedAt : null, s && (s.status === 'ok' || s.status === 'partial') ? s.checkedAt : null);
	};
	const buildOpen = () => {
		const open = {};
		for (const c of state.characters || []) {
			const log = data.orderLogs[c.characterId];
			let orders = openRowsFromLog(log);
			if (Object.keys(log || {}).length === 0) {
				const snaps = state.snapshots[c.characterId] || [];
				orders = snaps.length > 0 ? asArray(snaps[snaps.length - 1].orders) : [];
			}
			open[c.characterId] = { fetchedAt: ordersCheckedAt(c.characterId), orders };
		}
		return open;
	};

	// The books, book logs and history of the listed items (one call per chunk, with `log=1`).
	const loadMarket = async () => {
		const route = currentRoute();
		const types = new Set();
		const regions = new Set();
		const regionOfType = new Map();
		for (const list of Object.values(data.open)) {
			for (const o of list.orders) {
				if (o.is_buy_order === true || !isNum(o.type_id)) continue;
				types.add(o.type_id);
				if (isNum(o.region_id)) {
					regions.add(o.region_id);
					if (!regionOfType.has(o.type_id)) regionOfType.set(o.type_id, o.region_id);
				}
			}
		}
		const books = {};
		const bookLogs = {};
		const history = {};
		if (types.size > 0) {
			regions.add(route.endRegionId);
			const regionIds = [...regions].slice(0, 10);
			const ids = [...types];
			for (let i = 0; i < ids.length; i += MARKET_CHUNK) {
				const chunk = ids.slice(i, i + MARKET_CHUNK);
				const res = await api(`/api/market?typeIds=${chunk.join(',')}&regionIds=${regionIds.join(',')}&log=1`);
				for (const typeId of chunk) {
					const byRegion = (res.types && res.types[typeId]) || {};
					for (const regionId of regionIds) {
						const entry = byRegion[regionId];
						if (!entry) continue;
						// a 304 moves `checkedAt` while the stored body stays: the book is confirmed as of then
						if (entry.orders) (books[typeId] = books[typeId] || {})[regionId] = { fetchedAt: maxIso(entry.orders.fetchedAt, entry.orders.checkedAt), orders: asArray(entry.orders.rows) };
						if (entry.log) (bookLogs[typeId] = bookLogs[typeId] || {})[regionId] = entry.log;
					}
					const home = regionOfType.get(typeId) || route.endRegionId;
					const h = byRegion[home] && byRegion[home].history;
					if (h && Array.isArray(h.rows)) history[typeId] = h.rows;
				}
			}
		}
		data.books = books;
		data.bookLogs = bookLogs;
		data.history = history;
	};

	// Items sold in the window but not listed any more still need their history for the share column.
	const ensureSoldHistory = async () => {
		if (!data.result) return false;
		if (Date.now() - data.soldHistoryAt > HOUR_MS) {
			data.soldHistory.clear();
			data.soldHistoryTried.clear();
			data.soldHistoryAt = Date.now();
		}
		const need = [...new Set(data.result.sales.map(s => s.typeId))]
			.filter(id => data.history[id] === undefined && !data.soldHistory.has(id) && !data.soldHistoryTried.has(id));
		if (need.length === 0) return false;
		const route = currentRoute();
		for (const id of need) data.soldHistoryTried.add(id);
		try {
			for (let i = 0; i < need.length; i += MARKET_CHUNK) {
				const chunk = need.slice(i, i + MARKET_CHUNK);
				const res = await api(`/api/market?typeIds=${chunk.join(',')}&regionIds=${route.endRegionId}`);
				for (const typeId of chunk) {
					const h = res.types && res.types[typeId] && res.types[typeId][route.endRegionId] && res.types[typeId][route.endRegionId].history;
					if (h && Array.isArray(h.rows)) data.soldHistory.set(typeId, h.rows);
				}
			}
		} catch (e) {
			return false; // the share column stays empty for those items; the next window change tries again
		}
		return true;
	};

	let loadGen = 0;
	// Everything this page reads beyond the loader: the watch state, the order logs, every snapshot (the
	// facts want the whole ledger), the listed items' books. A ledger that was synced meanwhile (the results
	// page, the script) is read again first.
	const loadOrdersData = async ({ reloadLedger = false } = {}) => {
		if (!state.characters || state.characters.length === 0 || !state.ledgers) return;
		const gen = ++loadGen;
		try {
			const [watch, sync] = await Promise.all([api('/api/watch'), api('/api/sync')]);
			if (gen !== loadGen) return;
			const newer = Object.entries(sync.characters || {}).some(([id, c]) => {
				const old = state.sync && state.sync.characters && state.sync.characters[id];
				return c.syncedAt && (!old || !old.syncedAt || Date.parse(c.syncedAt) > Date.parse(old.syncedAt));
			});
			if ((newer || reloadLedger) && !Object.values(sync.characters).some(c => c.running)) {
				await shared.reloadData();
				if (gen !== loadGen || state.fatal) return;
			}
			const [logs, snaps] = await Promise.all([
				api('/api/order-log'),
				state.snapshotSince === null ? Promise.resolve(null) : api('/api/snapshots')
			]);
			if (gen !== loadGen) return;
			if (snaps) {
				state.snapshots = snaps.characters || {};
				state.snapshotSince = null;
				data.snapshotGen++;
			}
			data.watch = watch;
			data.sync = sync;
			data.orderLogs = logs.characters || {};
			data.open = buildOpen();
			await loadMarket();
			if (gen !== loadGen) return;
			data.loaded = true;
			data.error = null;
			data.fatalMsg = null;
			data.loadedAt = Date.now();
			recompute();
		} catch (e) {
			if (gen !== loadGen) return;
			if (data.loaded) data.error = `Could not read the orders and books (${e.message}); the figures below are from the last read.`;
			else data.fatalMsg = e.message;
		}
		render();
		afterRender();
	};

	//--- working it out

	// What the facts depend on: the ledgers and snapshots as read, the packaged volumes known (they split the
	// haul cost), and the route. A change in any of them means working the facts out again.
	const factsKeyNow = () => {
		const route = currentRoute();
		return [data.ledgerGen, data.snapshotGen, Object.keys(state.m3).length, route.start, route.end].join('|');
	};
	const ensureFacts = () => {
		const key = factsKeyNow();
		if (data.facts && key === data.factsKey) return;
		const route = currentRoute();
		// a window that covers everything: FIFO and the fee shares span the whole ledger, as on the results page
		const view = { route, sel: { kind: 'all' }, windowInput: { since: null }, now: Date.now() };
		const result = resultsCalc.compute(shared.buildInput(view));
		data.facts = result.facts;
		data.taxRate = result.observedTaxRate;
		data.factsKey = key;
	};

	const recompute = () => {
		if (!state.characters || state.characters.length === 0 || !data.loaded) return;
		try {
			ensureFacts();
			const now = Date.now();
			const windowMs = WINDOWS.find(w => w.key === winKey).ms;
			const history = { ...Object.fromEntries(data.soldHistory), ...data.history };
			data.result = oc.compute({
				characterIds: state.characters.map(c => c.characterId),
				openOrders: data.open,
				orderLogs: data.orderLogs,
				books: data.books,
				bookLogs: data.bookLogs,
				history,
				facts: data.facts,
				observedTaxRate: data.taxRate,
				stations: stationsInput(),
				thresholds: {
					leaveHours: thresholds.leaveHours,
					undercutDays: thresholds.undercutDays,
					minRoi: thresholds.minRoi,
					scope: thresholds.scope,
					halfLifeDays: estimate.defaultConfig.RECENCY_HALF_LIFE_DAYS,
					daysConsidered: estimate.defaultConfig.DAYS_CONSIDERED,
					clusterGapMs: Math.max(10 * MIN_MS, windowMs / 150),
					windowMs
				},
				now
			});
			data.now = now;
			data.computeError = null;
		} catch (e) {
			console.error(e);
			data.computeError = e && e.message ? e.message : String(e);
		}
	};

	// After a render: item names for what is on screen, and history for sold items that are not listed.
	const nameLoads = new Set();
	let namesTimer = null;
	const ensureNames = (ids) => {
		for (const id of ids) {
			if (!isNum(id) || state.names[id] !== undefined || nameLoads.has(id)) continue;
			nameLoads.add(id);
			util.getTypeName(id).then(n => { if (typeof n === 'string') state.names[id] = n; }).catch(() => { /* the row keeps "type <id>" */ })
				.finally(() => {
					if (namesTimer !== null) return;
					namesTimer = setTimeout(() => { namesTimer = null; redrawNames(); }, 250);
				});
		}
	};
	const afterRender = () => {
		if (!data.result) return;
		ensureNames([...data.result.rows.map(r => r.typeId), ...data.result.sales.map(s => s.typeId), ...data.result.pending.map(p => p.typeId)]);
		ensureSoldHistory().then((changed) => {
			if (!changed) return;
			recompute();
			renderOpen();
			renderSold();
		});
	};

	//--- the watch refresh

	let ticking = false;
	let syncing = false;  // the unforced sales sync is running
	let nextAt = null;
	let tickMsg = null; // {kind: 'ok' | 'err', text, title}
	let tickMsgTimer = null;

	// A live region repeats a message only when its text changes: clear first, then write.
	const say = (kind, text, title) => {
		tickMsg = { kind, text, title };
		tickNoteEl.textContent = '';
		tickNoteEl.className = kind === 'err' ? 'bad' : 'muted';
		clearTimeout(tickMsgTimer);
		tickMsgTimer = setTimeout(() => {
			tickNoteEl.textContent = text;
			if (title) tickNoteEl.title = title; else tickNoteEl.removeAttribute('title');
		}, 50);
	};
	const sayClear = () => {
		tickMsg = null;
		clearTimeout(tickMsgTimer);
		tickNoteEl.textContent = '';
		tickNoteEl.removeAttribute('title');
	};

	const STATUS_WORDS = { ok: 'ok', relink: 'needs re-linking', skipped: 'skipped', busy: 'busy with another sync', failed: 'failed', paused: 'paused', 'rate-limited': 'rate-limited' };
	const QUIET = new Set(['not-due', 'not-modified']); // a check that brought nothing newer
	const BOOK_CACHE_MS = 5 * MIN_MS;                   // ESI's cache of a regional book

	// The newest moment the page's books were confirmed by ESI (stored or a 304): ESI's cache gives a newer copy
	// at most five minutes after it.
	const newestBookCheck = () => {
		let best = null;
		for (const byRegion of Object.values(data.books || {})) {
			for (const b of Object.values(byRegion || {})) {
				const ms = b && b.fetchedAt ? Date.parse(b.fetchedAt) : NaN;
				if (Number.isFinite(ms) && (best === null || ms > best)) best = ms;
			}
		}
		return best;
	};

	// When ESI can give more after a refresh that found nothing newer (decision 16): the books five minutes
	// after their last check, each character's orders at the `expires` of its orders feed. No button can fetch
	// either sooner (ESI serves its cached copy to a forced call too), and the books already list our orders.
	const quietText = (result, at) => {
		const bookMs = newestBookCheck();
		const books = bookMs === null ? 'newer books within 5min' : `newer books from ${clock(Math.max(at, bookMs + BOOK_CACHE_MS))}`;
		const exp = Object.entries(result.characters || {})
			.map(([id, c]) => ({ name: (c.name || charName(id)).split(' ')[0], ms: c.expires ? Date.parse(c.expires) : NaN }))
			.filter(x => Number.isFinite(x.ms))
			.sort((a, b) => a.ms - b.ms);
		const clocks = [...new Set(exp.map(x => clock(Math.max(at, x.ms))))];
		const orders = exp.length === 0 ? 'newer orders within 20min'
			: clocks.length === 1 ? `newer orders from ${clocks[0]}`
			: `newer orders from ${exp.map(x => `${clock(Math.max(at, x.ms))} (${x.name})`).join(' and ')}`;
		return `Refreshed ${clock(at)}: ESI had nothing newer yet. It can give ${books} and ${orders}; the books already carry the current prices of our orders.`;
	};

	const summarizeTick = (result, at = Date.now()) => {
		const problems = [];
		const details = [];
		for (const [id, c] of Object.entries(result.characters || {})) {
			const name = c.name || charName(id);
			details.push(`${name}: orders ${c.orders || c.status}${c.openSellOrders !== undefined ? `, ${plural(c.openSellOrders, 'open sell order')}` : ''}`);
			if (c.status !== 'ok') problems.push(`${name} ${STATUS_WORDS[c.status] || c.status}${c.reason ? ` (${c.reason})` : ''}`);
		}
		const m = result.market;
		if (m) {
			const stored = asArray(m.types).filter(t => t.outcome === 'stored').length;
			details.push(`books: ${m.status}, ${plural(asArray(m.types).length, 'item')} checked, ${stored} stored, ${m.calls || 0} ESI calls`);
			if (m.status !== 'ok' && m.status !== 'busy') problems.push(`books ${m.status}${m.reason ? ` (${m.reason})` : ''}`);
		}
		const stop = result.stop;
		if (stop && isNum(stop.until) && stop.until > Date.now()) problems.push(`paused until ${clock(stop.until)}`);
		const title = details.join('\n');
		if (problems.length > 0) return { kind: 'err', text: `Refreshed ${clock(at)}, but ${problems.join('; ')}. The last good data stays on screen.`, title };
		// ESI answers are cached (orders for up to 20 minutes, books for 5): a refresh inside that window brings
		// nothing newer, whether it made no call (not due) or ESI answered "not modified"
		const quiet = Object.values(result.characters || {}).every(c => QUIET.has(c.orders))
			&& (!m || asArray(m.types).every(t => QUIET.has(t.outcome)));
		return { kind: 'ok', text: quiet ? quietText(result, at) : `Refreshed ${clock(at)}`, title };
	};

	const pausedUntil = () => {
		const stop = data.watch && data.watch.stop;
		return stop && isNum(stop.until) && stop.until > Date.now() ? stop.until : null;
	};
	const planNext = (from = Date.now()) => {
		nextAt = Math.max(from + REFRESH_MS, (pausedUntil() || 0) + 2000);
	};

	// The sales come from the wallet sync, which the watch refresh does not do. results.js starts one on load
	// when a character is stale; the same here after every tick: POST /api/sync unforced, without the market
	// snapshot. The server skips a character synced within the hour, so this costs nothing until one is due.
	// Answers {ran, text, kind}: `ran` when a sync stored something (the ledger is read again), text for failures.
	const syncSales = async () => {
		syncing = true;
		renderStatusLine();
		try {
			const result = await api('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ force: false, market: false }) });
			const list = asArray(result.characters);
			const ran = list.some(c => c.status === 'ok' || c.status === 'partial');
			const bad = list.filter(c => c.status === 'failed');
			if (bad.length > 0) {
				return { ran, kind: 'err', text: `The sales sync failed for ${bad.map(c => `${c.name || charName(c.characterId)}${c.reason ? ` (${c.reason})` : ''}`).join(', ')}; the sales shown are from the last good sync.` };
			}
			return { ran, kind: 'ok', text: ran ? `sales synced ${clock(Date.now())}` : '' };
		} catch (e) {
			return { ran: false, kind: 'err', text: `Could not sync the sales: the server answered \u201c${e.message}\u201d; the sales shown are from the last good sync.` };
		} finally {
			syncing = false;
		}
	};

	// One refresh: the watch tick (orders, then books), the data it changed, then the unforced sales sync and,
	// when that stored something, the ledger and everything computed from it again. `skipWatch` is the page
	// load that found a tick younger than five minutes; `nextFrom` dates the next refresh from that tick.
	const tick = async ({ skipWatch = false, nextFrom = null } = {}) => {
		if (ticking || !state.characters || state.characters.length === 0 || state.fatal) return;
		ticking = true;
		sayClear();
		renderRefresh();
		renderStatusLine();
		let watchNote = null;
		if (!skipWatch) {
			let result = null;
			let at = Date.now();
			try {
				result = await api('/api/watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
				at = Date.now();
				data.watch = { ...result, running: false };
			} catch (e) {
				watchNote = { kind: 'err', text: `Could not refresh: the server answered \u201c${e.message}\u201d. The figures below are from the last good read${refreshOpen ? `; the next try is at ${clock(Date.now() + REFRESH_MS)}` : '; press Refresh now to try again'}.` };
			}
			await loadOrdersData();
			// summed up once the books are read again: a quiet refresh names when the newest of them can be newer
			if (result) watchNote = summarizeTick(result, at);
		}
		const sales = await syncSales();
		if (sales.ran) await loadOrdersData({ reloadLedger: true });
		const parts = [watchNote && watchNote.text, sales.text].filter(Boolean);
		if (parts.length > 0) say(sales.kind === 'err' || (watchNote && watchNote.kind === 'err') ? 'err' : 'ok', parts.join(' \u00b7 '), watchNote ? watchNote.title : undefined);
		ticking = false;
		planNext(nextFrom === null ? Date.now() : nextFrom);
		renderRefresh();
		renderStatusLine();
	};

	//--- rendering: banners, characters

	// One-off banners, dismissible: where an EVE sign-in came back from (readSsoResult at boot, below) and
	// the "Linked ..." note. Everything else in the banner list is derived afresh on each draw.
	const notices = [];

	const bannerHtml = (b) => `<div class="banner ${b.kind}"><span class="sev">${b.kind === 'err' ? 'Error:' : b.kind === 'warn' ? 'Warning:' : 'Note:'}</span><span>${esc(b.text)}</span>${b.action || ''}</div>`;

	const renderBanners = () => {
		const list = [];
		notices.forEach((n, i) => list.push({ kind: n.kind, text: n.text, action: `<button type="button" class="linkish" data-act="dismiss" data-i="${i}" data-fk="dismiss-${i}">Dismiss</button>` }));
		if (state.loadError) list.push({ kind: 'warn', text: state.loadError });
		if (data.error) list.push({ kind: 'warn', text: data.error });
		for (const c of state.characters || []) {
			if (c.status === 'relink') {
				const name = c.name || `character ${c.characterId}`;
				list.push({ kind: 'err', text: `${name} needs re-linking: EVE no longer accepts its saved sign-in, so its orders and sales are out of date.`, action: `<a class="btn" href="${LOGIN_URL}">Re-link ${esc(name)}</a>` });
			}
		}
		setHtml(bannersEl, list.map(bannerHtml).join(''));
	};

	const chipInfo = (c) => {
		const id = c.characterId;
		const w = data.watch && data.watch.characters && data.watch.characters[id];
		const s = data.sync && data.sync.characters && data.sync.characters[id];
		if (c.status === 'relink' || (s && s.status === 'relink') || (w && w.status === 'relink')) return { text: 're-link needed', problem: true, relink: true };
		if (w && (w.status === 'failed' || w.status === 'rate-limited' || w.status === 'paused')) {
			return { text: `orders ${STATUS_WORDS[w.status]}${w.reason ? `: ${w.reason}` : ''}`, problem: true };
		}
		const n = data.result ? data.result.rows.filter(r => r.characterId === id).length : null;
		const checked = ordersCheckedAt(id);
		return {
			text: `${n === null ? '' : `${plural(n, 'open sell order')} · `}orders checked ${checked ? clock(Date.parse(checked)) : DASH}`,
			problem: false,
			title: checked ? new Date(checked).toLocaleString() : 'no orders read yet'
		};
	};
	const renderChips = () => {
		const chars = state.characters || [];
		charactersEl.hidden = !(state.cfg && state.cfg.configured && chars.length > 0 && !state.fatal);
		if (charactersEl.hidden) return;
		const html = chars.map(c => {
			const info = chipInfo(c);
			const name = esc(c.name || `character ${c.characterId}`);
			return `<div class="chip${info.problem ? ' problem' : ''}">
				<img class="portrait" src="https://images.evetech.net/characters/${c.characterId}/portrait?size=32" width="32" height="32" alt="" loading="lazy">
				<div class="chipBody"><div class="chipName">${name}</div><div class="chipStatus${info.problem ? ' bad' : ''}"${info.title ? ` title="${esc(info.title)}"` : ''}>${esc(info.text)}</div></div>
				${info.relink ? `<a class="btn" href="${LOGIN_URL}">Re-link ${name}</a>` : ''}
			</div>`;
		}).join('') + `<a class="btn" id="addCharacter" href="${LOGIN_URL}">+ Add character</a>`;
		setHtml(chipsEl, html);
	};

	//--- rendering: the refresh controls and the status line

	const renderRefresh = () => {
		refreshBtn.disabled = ticking;
		setText(refreshBtn, ticking ? 'Refreshing…' : 'Refresh now');
		refreshChk.checked = refreshOpen;
	};

	const fmtCountdown = (ms) => {
		const s = Math.max(0, Math.ceil(ms / 1000));
		return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	};
	// An age that has run past its limit turns amber, and says so in words.
	const asOfSpan = (label, iso, staleMs, title) => {
		const ms = iso ? Date.parse(iso) : null;
		if (!isNum(ms)) return `<span class="st" title="${esc(title)}">${esc(label)} ${DASH}</span>`;
		const age = Date.now() - ms;
		const stale = staleMs !== null && age > staleMs;
		return `<span class="st${stale ? ' stale' : ''}" title="${esc(title)}">${stale ? '<span aria-hidden="true">⚠</span> ' : ''}${esc(label)} as of ${esc(clockOrDate(ms))}${stale ? ` (${esc(dur(age))} old)` : ''}</span>`;
	};

	// When the sales were last synced (the newest `syncedAt` of the pooled characters); the newest sale itself is in the tooltip.
	const salesSyncedSpan = (lastSaleIso) => {
		const chars = data.sync && data.sync.characters ? data.sync.characters : {};
		const times = (state.characters || []).map(c => (chars[c.characterId] && chars[c.characterId].syncedAt ? Date.parse(chars[c.characterId].syncedAt) : NaN)).filter(Number.isFinite);
		const lastSale = lastSaleIso ? Date.parse(lastSaleIso) : null;
		const title = `${isNum(lastSale) ? `last sale ${stamp(lastSale)}` : 'no sale on record'} \u00b7 ESI holds transactions back up to an hour`;
		if (times.length === 0) return `<span class="st" title="${esc(title)}">sales ${DASH}, not synced yet</span>`;
		return `<span class="st" title="${esc(title)}">sales synced ${esc(clockOrDate(Math.max(...times)))}</span>`;
	};

	const renderStatusLine = () => {
		if (!data.result) { setHtml(statusLineEl, ''); return; }
		const a = data.result.asOf;
		const paused = pausedUntil();
		const stopNote = data.watch && data.watch.stop;
		let next;
		if (syncing) next = 'syncing sales…';
		else if (ticking || (data.watch && data.watch.running)) next = 'refreshing orders and books…';
		else if (paused) next = `<span class="st stale"><span aria-hidden="true">⚠</span> paused until ${esc(clock(paused))} (${esc(stopNote.reason === 'rate-limited' ? 'ESI rate limit' : stopNote.reason === 'error-limit' ? 'ESI error limit' : stopNote.reason)})</span>`;
		else if (!refreshOpen) next = 'refresh while open is off';
		else if (nextAt !== null) next = `next refresh in ${fmtCountdown(nextAt - Date.now())}`;
		else next = '';
		const parts = [
			asOfSpan('orders', a.orders, ORDERS_STALE_MS, 'when the open orders were last read from ESI (amber past 25 minutes)'),
			asOfSpan('books', a.books, BOOKS_STALE_MS, 'when the books of the listed items were last read from ESI (amber past 10 minutes)'),
			salesSyncedSpan(a.transactions)
		];
		// orders whose state the public book has newer than the orders feed (decision 16)
		const newer = data.result.rows.filter(r => r.stateFrom === 'book').length;
		const newerHtml = newer > 0
			? ` <span class="dim">&middot;</span> <span class="st" title="${esc(`The public book lists a newer price or fewer units left for ${newer === 1 ? 'this order' : 'these orders'} than the orders feed, which ESI caches for up to 20 minutes. Those figures are underlined dotted in the table; the tooltip says which source says what.`)}">${esc(plural(newer, 'order'))} newer per the books</span>`
			: '';
		setHtml(statusLineEl, `${parts[0]} <span class="dim">&middot;</span> ${parts[1]}${newerHtml} <span class="dim">&middot;</span> ${parts[2]} <span class="dim">(ESI holds sales back up to an hour)</span> <span class="dim">&middot;</span> <span>${next}</span>`);
	};

	//--- rendering: the state box

	const card = (title, html, cls = '') => `<div class="card ${cls}"><h2>${esc(title)}</h2>${html}</div>`;

	const setupHtml = () => card('Set up EVE sign-in', '<p>This page reads your own orders, wallet and assets through EVE’s login, which needs a developer application first. The results page has the setup steps.</p><a class="btn" href="results.html">Open results</a> <button type="button" data-act="retryLoad">Check again</button>');

	const stateBoxHtml = () => {
		if (state.fatal) return card(state.fatal.title, `${state.fatal.html}<button type="button" data-act="retryLoad">Try again</button>`, 'err');
		if (!state.cfg) return card('Loading…', '<p class="muted">Contacting the server.</p>');
		if (!state.cfg.configured) return setupHtml();
		if (!state.characters) return card('Loading…', '<p class="muted">Reading the linked characters.</p>');
		if (state.characters.length === 0) {
			return card('Link the character that sells', `<p>The order monitor reads the open sell orders and the sales of the characters you link. Link the one that sells at your destination.</p><a class="btn" href="${LOGIN_URL}">+ Add character</a>`);
		}
		if (data.fatalMsg) return card('Could not read the orders', `<p>The server answered “${esc(data.fatalMsg)}”. Check the server’s console for the cause, then try again.</p><button type="button" data-act="retryLoad">Try again</button>`, 'err');
		if (data.computeError) return card('Could not work out the orders', `<p>${esc(data.computeError)}</p><button type="button" data-act="retryLoad">Try again</button>`, 'err');
		if (!data.loaded || !data.result) return card('Loading…', `<p class="muted">${esc(state.busy || 'Reading the orders and books…')}</p>`);
		return '';
	};

	const isLive = () => !state.fatal && state.cfg && state.cfg.configured && state.characters && state.characters.length > 0 && data.loaded && !!data.result && !data.computeError;

	//--- rendering: the open orders table

	const VERDICT_RANK = { undercut: 0, maybe: 1, reconsider: 2, leave: 3, top: 4 };
	const VERDICT_HELP = {
		undercut: 'Far enough back in the queue that lowering the price is worth considering.',
		maybe: 'Between the limits: judge the numbers.',
		reconsider: 'Matching the best price would not clear the cost or the ROI floor, so undercutting loses money or earns too little.',
		leave: 'Priced above others, but the queue ahead clears on its own soon enough: a price change would cost a fee for little.',
		top: 'Nothing is priced below this order.'
	};
	const BADGES = {
		notInBook: { label: 'not in book', help: 'the newest book no longer lists this order: it was filled or cancelled (the orders feed confirms within 20 minutes). Its figures still rest on the orders feed' },
		priceWar: { label: 'price war', help: 'the order that undercut this one changed its price at least twice within 24 hours', cls: 'war' },
		nocost: { label: 'no cost', help: 'no lot of this item covers the unsold units, so margins and the ROI floor cannot be checked' },
		nofee: { label: 'no fee', help: 'no relist of yours is on record to take a relist-fee rate from, so no fee is estimated' },
		est: { label: 'est', help: 'time on top rests on fewer than three undercut episodes' },
		nobook: { label: 'no book', help: 'no book is stored for this item yet; the next refresh takes one' },
		nobooklog: { label: 'no book log', help: 'no book log for this item yet: when it was undercut and how fast others undercut are unknown' },
		nohistory: { label: 'no history', help: 'no regional daily history stored for this item: daily volume and days behind are unknown' },
		nolog: { label: 'no order log', help: 'no order log for this order yet: relists, the last fill and time on top are missing' }
	};
	const BADGE_ORDER = ['notInBook', 'priceWar', 'nocost', 'nofee', 'est', 'nobook', 'nobooklog', 'nohistory', 'nolog'];

	const stationOf = (r) => r.stationName || `station ${r.locationId}`;
	const scopeWord = () => (thresholds.scope === 'region' ? 'in the region' : 'at the station');
	const behindText = (days) => (isNum(days) ? (days === 0 ? '0' : dur(days * DAY_MS)) : DASH); // '2.6d', '1.1h', '35min'
	const firstName = (id) => charName(id).split(' ')[0];

	// The book-derived state of a row (decision 16; the module sets stateFrom, stateAt and feed). The book took
	// over the price when its `issued` is later than the feed's; at the same `issued` only the units left.
	const timeOf = (isoText) => (isoText && Number.isFinite(Date.parse(isoText)) ? clockOrDate(Date.parse(isoText)) : DASH);
	const fromBook = (r) => r.stateFrom === 'book';
	const priceFromBook = (r) => fromBook(r) && Date.parse(r.feed.issued) !== Date.parse(r.issued);
	const feedCacheText = (r) => {
		const w = data.watch && data.watch.characters && data.watch.characters[r.characterId];
		const ms = w && w.expires ? Date.parse(w.expires) : NaN;
		return Number.isFinite(ms) ? `cached by ESI until ${clockOrDate(ms)}` : 'cached by ESI for up to 20 minutes';
	};
	const roiOf = (r) => (isNum(r.roiIfMatch) ? 1 + r.roiIfMatch : null); // net revenue / cost, the export page's "x"
	const blank = (title = '') => ({ t: `<span class="dim">${DASH}</span>`, title });

	// The module's relist-fee rate (plan decision 15): a flat share of an order's remaining value, shown with three decimals.
	const pct3 = (rate) => `${(rate * 100).toFixed(3)} %`;
	const dayText = (ms) => (hasMoment() ? moment(ms).format('MMM D') : new Date(ms).toLocaleDateString());
	const FEW_RELISTS = 5; // fewer observations than this and the rate is flagged as thin
	const feeRateTip = (r) => {
		const value = isNum(r.feeEstimate) && isNum(r.feeRate) && r.feeRate > 0 ? r.feeEstimate / r.feeRate : null; // the value the fee was taken on
		const unit = value !== null && value > 0 && r.volumeRemain > 0 ? value / r.volumeRemain : r.price;
		const n = r.feeRateRows;
		const since = r.feeRateSince ? ` since ${dayText(Date.parse(r.feeRateSince))}` : '';
		const who = r.feeRateScope === 'character' ? `by ${charName(r.characterId)} at other stations` : `at ${stationOf(r)}`;
		const rows = isNum(n) ? plural(n, 'relist') : 'relists';
		return `${fmtExact(r.feeEstimate)}: ${pct3(r.feeRate)} of the remaining value (${price(unit)} × ${fmtQty(r.volumeRemain)}), the rate from ${rows} ${who}${since}${isNum(n) && n < FEW_RELISTS ? ' (few observations)' : ''}`;
	};
	const verdictTip = (r) => {
		// the module's sentence first (decision 21)
		const why = r.reasonText;
		const lines = [why ? `${r.verdict}: ${why}${/[.!?]$/.test(why) ? '' : '.'}` : `${r.verdict}.`, VERDICT_HELP[r.verdict]];
		if (r.ordersAhead !== null) {
			lines.push(`${fmtQty(r.unitsAhead)} ${r.unitsAhead === 1 ? 'unit' : 'units'} ahead in ${plural(r.ordersAhead, 'order')}${isNum(r.dailyVolume) ? ` at ${fmtRate(r.dailyVolume)} units a day in the region` : ''}${isNum(r.daysBehind) && r.daysBehind > 0 ? ` = ${behindText(r.daysBehind)} behind` : ''}.`);
			lines.push(`Limits: leave under ${thresholds.leaveHours}h, undercut over ${thresholds.undercutDays}d, ROI floor ${thresholds.minRoi}x.`);
		}
		if (isNum(r.expectedSalesBeforeUndercut)) {
			lines.push(`Others undercut after about ${dur(r.medianTimeOnTop)}: ~${nf2.format(Math.round(r.expectedSalesBeforeUndercut * 10) / 10)} ${Math.round(r.expectedSalesBeforeUndercut * 10) / 10 === 1 ? 'unit sells' : 'units sell'} before then${isNum(r.expectedGainBeforeUndercut) ? `, worth ~${fmtExact(r.expectedGainBeforeUndercut)}` : ''}${isNum(r.feeEstimate) ? ` against a fee of ~${fmtExact(r.feeEstimate)}.` : '. No relist of yours at this station is on record yet, so the fee is not weighed.'}`);
		}
		if (r.priceWar) lines.push(`Price war: the order that undercut this one changed its price ${r.reUndercuts} times since.`);
		return lines.filter(Boolean).join('\n');
	};

	const flagHtml = (b) => `<span class="flag ${BADGES[b].cls || ''}" title="${esc(BADGES[b].help)}">${esc(BADGES[b].label)}</span>`;
	// The verdict, its reason token as is (decision 21: '2.6d', '50%', '1.21x', 'no book'; nothing when empty) and the badges.
	const verdictCell = (r) => ({
		t: `<span class="verdict v-${r.verdict}" title="${esc(verdictTip(r))}">${esc(r.verdict)}</span>${r.reason ? ` <span class="reason dim" title="${esc(r.reasonText)}">${esc(r.reason)}</span>` : ''}${BADGE_ORDER.filter(b => r.badges.includes(b)).map(flagHtml).join('')}`,
		cls: 'text verdictCell stickV'
	});

	// The item name with its copy and export-snapshot buttons; the type id is in the tooltip only (decision 20).
	const itemCell = (r) => {
		const name = nameOf(r.typeId);
		const tip = `${name}\ntype ${r.typeId} · order ${r.orderId} · ${charName(r.characterId)} · ${stationOf(r)}`;
		const snap = runForRow(r) ? snapButtonHtml('order', `snap-${r.orderId}`, name, `data-order-id="${r.orderId}"`) : '';
		return {
			t: `<span class="name" title="${esc(tip)}">${esc(name)}</span><button type="button" class="copyName" data-type-id="${r.typeId}" data-fk="copy-${r.orderId}" title="Copy name" aria-label="Copy name of ${esc(name)}">${COPY_ICON}</button>${snap}`,
			cls: 'text nameCell stickI'
		};
	};
	const COLUMNS = [
		{ key: 'verdict', label: 'verdict', text: true, val: (r) => VERDICT_RANK[r.verdict], cell: verdictCell,
			help: 'what to do with this order and why; the default order is undercut, maybe, reconsider, leave, top, then the longest queue first' },
		{ key: 'item', label: 'item', text: true, val: (r) => nameOf(r.typeId).toLowerCase(), cell: itemCell,
			help: 'item name (type id in the tooltip)' },
		// decision 19: shown only while more than one character has open orders (ctx.manyChars)
		{ key: 'character', label: 'character', text: true, manyOnly: true, val: (r) => charName(r.characterId).toLowerCase(),
			help: 'whose order this is: the first name, the full name in the tooltip',
			cell: (r) => ({ t: esc(firstName(r.characterId)), title: charName(r.characterId) }) },
		{ key: 'remaining', label: 'remaining / total', val: (r) => r.volumeRemain,
			help: 'units still for sale of the units listed; underlined dotted when the public book is newer than the orders feed',
			cell: (r) => (fromBook(r)
				? {
					t: `<span class="fromBook">${fmtQty(r.volumeRemain)}</span> <span class="dim">/ ${fmtQty(r.volumeTotal)}</span>`,
					title: `${fmtQty(r.volumeRemain)} of ${fmtQty(r.volumeTotal)} left per the book of ${timeOf(r.stateAt)}; the orders feed, ${feedCacheText(r)}, still says ${fmtQty(r.feed.volumeRemain)} left (read ${timeOf(r.feed.fetchedAt)})`
				}
				: { t: `${fmtQty(r.volumeRemain)} <span class="dim">/ ${fmtQty(r.volumeTotal)}</span>`, title: `${fmtQty(r.volumeRemain)} of ${fmtQty(r.volumeTotal)} left` }) },
		{ key: 'price', label: 'my price', val: (r) => r.price,
			help: 'the price of this order now; underlined dotted when the public book is newer than the orders feed',
			cell: (r) => (priceFromBook(r)
				? {
					t: `<span class="fromBook">${price(r.price)}</span>`,
					title: `${price(r.price)} per the book of ${timeOf(r.stateAt)} (set ${timeOf(r.issued)}); the orders feed, ${feedCacheText(r)}, still says ${price(r.feed.price)} from ${timeOf(r.feed.issued)}`
				}
				: { t: price(r.price), title: `${fmtExact(r.price)}, set ${r.issued ? whenText(Date.parse(r.issued)) : DASH}` }) },
		{ key: 'best', label: 'best price (gap)', val: (r) => r.bestPrice, pos: true,
			help: 'the lowest sell price in the scope (this station or the whole region), our own order included, and in brackets how far this order\u2019s price is above it',
			cell: (r) => {
				const gap = isNum(r.gapToBest) ? (r.gapToBest === 0 ? '0%' : `+${(r.gapToBest * 100).toFixed(r.gapToBest < 0.1 ? 2 : 1)}%`) : DASH;
				const lines = [`${fmtExact(r.bestPrice)} ${scopeWord()}; the book is from ${r.bookFetchedAt ? whenText(Date.parse(r.bookFetchedAt)) : DASH}`];
				if (isNum(r.gapToBest)) lines.push(r.gapToBest === 0 ? 'this order is at the best price' : `${fmtExact(r.price)} is ${fmtPct(r.gapToBest)} above ${fmtExact(r.bestPrice)}`);
				return { t: `${price(r.bestPrice)} <span class="dim">(${gap})</span>`, cls: r.bestPrice === r.price ? 'dim' : '', title: lines.join('\n') };
			} },
		{ key: 'ahead', label: 'units ahead', val: (r) => r.unitsAhead, pos: true,
			help: 'units listed at a lower price (or the same price, earlier) ahead of this order in the scope; hover for the orders, our own orders and cheaper stock elsewhere',
			cell: (r) => {
				const lines = [`${fmtQty(r.unitsAhead)} ${r.unitsAhead === 1 ? 'unit' : 'units'} in ${plural(r.ordersAhead, 'order')} ahead ${scopeWord()}; this order is number ${r.rank} in the queue`];
				if (r.ownAhead.orders > 0) lines.push(`${plural(r.ownAhead.orders, 'order')} of ours (${fmtQty(r.ownAhead.units)} units) are also ahead and not counted`);
				if (r.cheaperElsewhere && r.cheaperElsewhere.orders > 0) lines.push(`${plural(r.cheaperElsewhere.orders, 'order')} (${fmtQty(r.cheaperElsewhere.units)} units) cheaper at other stations of the region, not counted`);
				return { t: fmtQty(r.unitsAhead), title: lines.join('\n'), cls: r.unitsAhead === 0 ? 'dim' : '' };
			} },
		{ key: 'behind', label: 'days behind', val: (r) => r.daysBehind, pos: true,
			help: 'units ahead divided by the daily volume: how long the queue in front takes to clear if nobody else lists (hours under a day)',
			cell: (r) => (isNum(r.daysBehind)
				? { t: behindText(r.daysBehind), title: `${fmtQty(r.unitsAhead)} units ahead ÷ ${fmtRate(r.dailyVolume)} units a day = ${nf2.format(r.daysBehind)} days` }
				: blank(r.ordersAhead === 0 ? 'nothing ahead' : isNum(r.dailyVolume) ? 'no volume in the history window' : 'no regional history for this item yet')) },
		{ key: 'volume', label: 'daily volume', val: (r) => r.dailyVolume,
			help: 'units a day traded in the region: the recency-weighted mean of the last 30 days of its history (all days, profitable or not)',
			cell: (r) => (isNum(r.dailyVolume)
				? { t: fmtRate(r.dailyVolume), title: `${nf2.format(r.dailyVolume)} units a day, recency-weighted over the last ${estimate.defaultConfig.DAYS_CONSIDERED} days (half-life ${estimate.defaultConfig.RECENCY_HALF_LIFE_DAYS} days)` }
				: blank('no regional history for this item yet')) },
		{ key: 'typical', label: 'typical trade', val: (r) => r.typicalTrade,
			help: 'units in a usual sale of this item; a queue no bigger than this is left alone',
			cell: (r) => (isNum(r.typicalTrade)
				? { t: `${r.typicalTradeFrom === 'history' ? '~' : ''}${fmtRate(r.typicalTrade)}`, title: r.typicalTradeFrom === 'sales' ? `${nf2.format(r.typicalTrade)} units: the median of our own sales of this item in the last 90 days` : `${nf2.format(r.typicalTrade)} units: the region’s daily volume per order (an estimate: we have fewer than five sales of this item in 90 days)` }
				: blank('no sales and no history to judge a typical trade by')) },
		{ key: 'undercut', label: 'undercut since', val: (r) => (r.undercutAt ? Date.parse(r.undercutAt) : null), pos: true,
			help: 'when the first order now ahead of this one went below its price; hover for that order',
			cell: (r, c) => {
				if (r.undercutAt) {
					const u = r.undercutBy;
					const lines = [`${whenText(Date.parse(r.undercutAt))}`];
					if (u) {
						lines.push(`undercut by order ${u.orderId} at ${fmtExact(u.price)}, ${fmtQty(u.volumeRemain)} units left, ${isNum(u.gap) ? `${fmtPct(u.gap)} below this order` : ''}`);
						lines.push(`its current price was set ${whenText(Date.parse(u.issued))}`);
					}
					if (isNum(r.reUndercuts)) lines.push(`it has gone below this order ${plural(r.reUndercuts, 'time')} since`);
					return { t: ageText(Date.parse(r.undercutAt), c.now), title: lines.join('\n') };
				}
				if (r.ordersAhead === 0) return blank('nothing ahead');
				return { t: '<span class="dim">listed behind</span>', title: 'every order ahead was already there when this price was set: no one undercut it' };
			} },
		{ key: 'ontop', label: 'time on top (median · episodes)', val: (r) => r.medianTimeOnTop,
			help: 'how long this item’s orders at the station stayed lowest after each price change before someone went below, and how many price changes that is from; "on top for" is the current stretch while nobody has',
			cell: (r) => {
				const bits = [];
				const lines = [];
				if (r.onTopFor !== null) {
					bits.push(`<b>on top ${dur(r.onTopFor)}</b>`);
					lines.push(`nobody is below this order: it has been lowest for ${dur(r.onTopFor)}`);
				}
				if (isNum(r.medianTimeOnTop)) {
					bits.push(`${r.onTopFor !== null ? '<span class="dim">typ. ' : ''}${r.timeOnTopEst ? '~' : ''}${dur(r.medianTimeOnTop)} · ${r.episodes}${r.onTopFor !== null ? '</span>' : ''}`);
					lines.push(`median ${dur(r.medianTimeOnTop)} on top over ${plural(r.undercutEpisodes, 'undercut price change')} of ${plural(r.episodes, 'price change')} (90 days, this item at this station)${r.timeOnTopEst ? '; fewer than three, so an estimate' : ''}`);
					lines.push('a competing order placed and gone between two book samples is missed');
				}
				if (bits.length === 0) return blank(r.episodes > 0 ? `${plural(r.episodes, 'price change')} seen and none undercut yet` : 'no price change of this item has been followed by a book log yet');
				return { t: bits.join(' '), title: lines.join('\n') };
			} },
		{ key: 'marginNow', label: 'margin now', val: (r) => r.marginNow,
			help: 'what one unit earns at the current price, after the observed sales tax and the landed cost (buy, haul, buy-order fee) of the unsold units',
			cell: (r) => (isNum(r.marginNow)
				? { t: money(r.marginNow, true), title: `${fmtExact(r.price)} × (1 − ${(r.taxRate * 100).toFixed(2)}% tax) − ${fmtExact(r.landedCost)} landed cost = ${fmtExact(r.marginNow)} a unit` }
				: blank('no landed cost: no lot of this item covers the unsold units')) },
		{ key: 'marginMatch', label: 'margin if match (ROI)', val: (r) => r.marginIfMatch, pos: true,
			help: 'what one unit would earn at the best price minus 0.01, and the ROI (net revenue ÷ landed cost, as the export page’s "x"); red below the ROI floor',
			cell: (r) => {
				if (r.matchPrice === null) return blank('nothing ahead: no undercut needed');
				if (!isNum(r.marginIfMatch)) return blank(`match price ${fmtExact(r.matchPrice)}; no landed cost, so no margin`);
				const roi = roiOf(r);
				const below = roi !== null && roi < thresholds.minRoi - 1e-9;
				const roiText = roi === null ? DASH : `${roi.toFixed(2)}x`;
				const lines = [`${fmtExact(r.matchPrice)} (best − 0.01) × (1 − ${(r.taxRate * 100).toFixed(2)}% tax) − ${fmtExact(r.landedCost)} landed cost = ${fmtExact(r.marginIfMatch)} a unit`, `ROI ${roiText} (floor ${thresholds.minRoi}x)${below ? ': below the floor' : ''}`];
				return { t: `${money(r.marginIfMatch, true)} <span class="${below ? 'below' : 'dim'}">(${below ? '▼ ' : ''}${roiText})</span>`, title: lines.join('\n') };
			} },
		{ key: 'fee', label: 'fee est.', val: (r) => r.feeEstimate,
			help: 'what changing this order\u2019s price probably costs: the relist fee is a flat share of the remaining order value, the same for every item, fitted from your newest relists at that station; without a rate of yours yet, the median of this order\u2019s or this item\u2019s past price-change fees',
			cell: (r) => {
				if (isNum(r.feeEstimate)) {
					if (r.feeEstimateFrom === 'rate' && isNum(r.feeRate)) return { t: `~${esc(fmtIsk(r.feeEstimate))}`, title: feeRateTip(r) };
					return { t: `~${esc(fmtIsk(r.feeEstimate))}`, title: `${fmtExact(r.feeEstimate)}: the median of ${r.feeEstimateFrom === 'order' ? 'this order\u2019s own' : 'this character\u2019s fees for this item\u2019s'} past price changes` };
				}
				if (isNum(r.feeRate)) return blank(`${pct3(r.feeRate)} of the remaining value at the new price, but there is no new price to work out (nothing is ahead)`);
				return blank(`no relist fee observed yet for ${charName(r.characterId)} anywhere, and no past price-change fee of this order or this item`);
			} },
		{ key: 'relists', label: 'relists (count · fees)', val: (r) => r.relistCount,
			help: 'price changes of this order seen in its log, and the fees they cost (the listing fee is not counted)',
			cell: (r) => (r.relistCount === null
				? blank('no order log for this order yet')
				: { t: `${r.relistCount} · ${esc(fmtIsk(r.relistFees || 0))}`, title: `${plural(r.relistCount, 'price change')}; fees ${isNum(r.relistFees) ? fmtExact(r.relistFees) : 'not found in the journal'}${isNum(r.listingFee) ? `; listing fee ${fmtExact(r.listingFee)}` : ''}${isNum(r.feeTotal) ? `; all fees ${fmtExact(r.feeTotal)}` : ''}` }) },
		{ key: 'listed', label: 'listed for', val: (r) => r.listedFor,
			help: 'since this order was first seen or placed',
			cell: (r) => (isNum(r.listedFor)
				? { t: dur(r.listedFor), title: `since ${whenText(Date.parse(r.listedSince))}` }
				: blank()) },
		{ key: 'lastFill', label: 'last fill', val: (r) => (r.lastFillAt ? Date.parse(r.lastFillAt) : null),
			help: 'when the units remaining of this order last dropped (a fill), from the order log',
			cell: (r, c) => (r.lastFillAt
				? { t: ageText(Date.parse(r.lastFillAt), c.now), title: `${whenText(Date.parse(r.lastFillAt))}: ${r.lastFillObserved === true ? 'when the order log first saw fewer units left (seen at the next check, so the fill is older)' : 'the last sale the wallet matched to this order'}` }
				: r.badges.includes('nolog') ? blank('no order log for this order yet') : { t: '<span class="dim">none seen</span>', title: 'no fill since this order was first seen' }) }
	];

	if (sort.key !== null && !COLUMNS.some(c => c.key === sort.key)) sort = { key: null, dir: 'desc' }; // a saved column that no longer exists

	const sortedRows = (rows) => {
		const col = COLUMNS.find(c => c.key === sort.key);
		if (!col) return rows;
		const dir = sort.dir === 'asc' ? 1 : -1;
		return rows.slice().sort((a, b) => {
			const x = col.val(a);
			const y = col.val(b);
			const xn = x === null || x === undefined || (typeof x === 'number' && Number.isNaN(x));
			const yn = y === null || y === undefined || (typeof y === 'number' && Number.isNaN(y));
			if (xn || yn) return xn === yn ? 0 : xn ? 1 : -1;
			if (x < y) return -dir;
			if (x > y) return dir;
			return 0; // equal: the module's order
		});
	};

	const verdictSummary = (rows) => {
		const n = {};
		for (const r of rows) n[r.verdict] = (n[r.verdict] || 0) + 1;
		return Object.keys(VERDICT_RANK).filter(v => n[v]).map(v => `${n[v]} ${v}`).join(' · ');
	};

	const renderOpen = () => {
		const res = data.result;
		if (!res) return;
		const rows = res.rows;
		const now = data.now;
		const units = rows.reduce((a, r) => a + (r.volumeRemain || 0), 0);
		setText(openCountEl, rows.length > 0 ? `${plural(rows.length, 'order')} · ${fmtQty(units)} units left` : '');
		defaultOrderBtn.hidden = !sort.key || rows.length === 0;
		ordersEl.hidden = rows.length === 0;
		if (rows.length === 0) {
			setHtml(openNoteEl, `No open sell orders right now: ${(state.characters || []).map(c => esc(c.name || c.characterId)).join(' and ')} ${(state.characters || []).length === 1 ? 'has' : 'have'} none listed. Sales below still show what sold.`);
			setHtml(tbodyEl, '');
			renderNotes();
			return;
		}
		setHtml(openNoteEl, `${esc(verdictSummary(rows))} <span class="dim">· competition ${esc(scopeWord())} · click a column title to sort · hover a column title, a verdict or a figure for what it means</span>`);
		const ctx = { now, manyChars: new Set(rows.map(r => r.characterId)).size > 1 };
		const shown = COLUMNS.filter(col => !col.manyOnly || ctx.manyChars);
		const head = shown.map(col => {
			const active = sort.key === col.key;
			const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
			const stick = col.key === 'verdict' ? ' stickV' : col.key === 'item' ? ' stickI' : '';
			return `<th class="${col.text ? 'text' : 'numeric'}${active ? ' sorted' : ''}${stick}" data-key="${col.key}" data-fk="th-${col.key}" tabindex="0" aria-sort="${active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}" title="${esc(typeof col.help === 'function' ? col.help() : col.help)}">${esc(col.label)}${arrow}</th>`;
		}).join('');
		setHtml(sortRowEl, head);
		const body = sortedRows(rows).map(r => {
			const noBook = r.ordersAhead === null;
			const cells = [];
			for (const col of shown) {
				if (noBook && col.pos) {
					if (col.key === 'best') cells.push('<td class="text dim" colspan="3" title="the book of this item is not stored yet">no book yet; the next refresh takes one</td>');
					if (['ahead', 'behind'].includes(col.key)) continue; // inside that colspan
					if (col.key === 'best') continue;
					cells.push(`<td class="numeric dim" title="needs the book of this item">${DASH}</td>`);
					continue;
				}
				const cell = col.cell(r, ctx);
				cells.push(`<td class="${col.text ? '' : 'numeric'}${cell.cls ? ` ${cell.cls}` : ''}"${cell.title ? ` title="${esc(cell.title)}"` : ''}>${cell.t}</td>`);
			}
			// a row the newest book no longer lists (filled or cancelled) is dimmed; its badge says why
			return `<tr data-order-id="${r.orderId}"${r.badges.includes('notInBook') ? ' class="notInBook"' : ''}>${cells.join('')}</tr>`;
		}).join('');
		setHtml(tbodyEl, body);
		// the item column is pinned right of the verdict column: its offset is that column's width
		const vTh = sortRowEl.querySelector('th.stickV');
		if (vTh) document.documentElement.style.setProperty('--stick-i', `${vTh.offsetWidth}px`);
		syncSnapExpanded();
		renderNotes();
	};

	// One dim line per linked character that has a relist-fee rate: where it applies and what it rests on.
	const renderFeeRates = () => {
		const rates = data.result && data.result.feeRates;
		const stations = stationsInput();
		const lines = [];
		for (const c of state.characters || []) {
			const byStation = rates[c.characterId];
			if (!byStation || typeof byStation !== 'object') continue;
			const parts = [];
			const tips = [];
			for (const [locationId, f] of Object.entries(byStation)) {
				if (!isNum(f.rate)) continue;
				const where = stations[locationId] ? stations[locationId].name : `station ${locationId}`;
				const since = f.since ? ` since ${dayText(Date.parse(f.since))}` : '';
				parts.push(`relist fee ${pct3(f.rate)} of the remaining value at ${esc(where)} (${isNum(f.rows) ? plural(f.rows, 'relist') : 'relists'}${since})`);
				if (isNum(f.rows) && f.rows < FEW_RELISTS) tips.push(`${where}: few observations`);
				const obs = f.observations.filter(o => isNum(o.rate)).slice().sort((x, y) => Date.parse(y.date) - Date.parse(x.date)).slice(0, 8);
				if (obs.length > 0) tips.push(`${where}, newest relists: ${obs.map(o => `${isNum(Date.parse(o.date)) ? stamp(Date.parse(o.date)) : DASH} ${pct3(o.rate)} (${nameOf(o.typeId)})`).join('; ')}`);
			}
			if (parts.length > 0) lines.push(`<div title="${esc(tips.join('\n'))}">${esc(c.name || `character ${c.characterId}`)}: ${parts.join('; ')}</div>`);
		}
		setHtml(feeRatesEl, lines.join(''));
		feeRatesEl.hidden = lines.length === 0;
	};

	const renderNotes = () => {
		const warnings = data.result ? data.result.warnings : [];
		notesEl.hidden = warnings.length === 0;
		if (warnings.length === 0) return;
		const open = notesEl.open;
		setHtml(notesEl, `<summary>${plural(warnings.length, 'note')} from the analysis</summary><ul>${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`);
		notesEl.open = open;
	};

	//--- copy-name buttons (the export page's idiom: confirm in place)

	const svgIcon = (body) => `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
	const COPY_ICON = svgIcon('<rect x="4.25" y="4.25" width="7" height="7" rx="1.5"/><path d="M7.75 3V2.25a1.5 1.5 0 0 0-1.5-1.5h-4a1.5 1.5 0 0 0-1.5 1.5v4a1.5 1.5 0 0 0 1.5 1.5H3"/>');
	const COPIED_ICON = svgIcon('<path d="M2 6.5l2.5 2.5L10 3"/>');
	const FAILED_ICON = svgIcon('<path d="M3 3l6 6M9 3l-6 6"/>');
	const SNAP_ICON = svgIcon('<path d="M1 4.25h2.25l1-1.5h3.5l1 1.5H11v6H1z"/><circle cx="6" cy="7" r="1.75"/>'); // a camera: the export snapshot
	const copyTimers = new WeakMap();
	const setCopyState = (btn, icon, label, cls = null) => {
		btn.innerHTML = icon;
		btn.title = label;
		btn.setAttribute('aria-label', label);
		btn.classList.remove('copied', 'failed');
		if (cls) btn.classList.add(cls);
	};
	tbodyEl.addEventListener('click', async (e) => {
		const btn = e.target.closest('button.copyName');
		if (!btn) return;
		const typeId = Number(btn.dataset.typeId);
		clearTimeout(copyTimers.get(btn));
		btn.classList.add('pending');
		try {
			if (state.names[typeId] === undefined) throw new Error('the item name has not loaded yet');
			await navigator.clipboard.writeText(state.names[typeId]);
			setCopyState(btn, COPIED_ICON, 'Copied', 'copied');
			copyTimers.set(btn, setTimeout(() => setCopyState(btn, COPY_ICON, 'Copy name'), 1000));
		} catch (err) {
			console.error('copy failed', err);
			setCopyState(btn, FAILED_ICON, 'Copy failed', 'failed');
			copyTimers.set(btn, setTimeout(() => setCopyState(btn, COPY_ICON, 'Copy name'), 1500));
		} finally {
			btn.classList.remove('pending');
		}
	});

	//--- the export snapshot (decision 22): the export run's prediction for the item against what the page has now

	let lotIndex = { key: null, byId: new Map() };
	const lotsById = () => {
		if (lotIndex.key !== data.factsKey) lotIndex = { key: data.factsKey, byId: new Map(asArray(data.facts && data.facts.lots).map(l => [l.lotId, l])) };
		return lotIndex.byId;
	};
	// The newest run (by when it was copied) among these run ids that lists the type: {run, row}, or null.
	const newestRunOf = (runIds, typeId) => {
		const ids = new Set(runIds.filter(id => id !== null && id !== undefined).map(String));
		if (ids.size === 0) return null;
		let best = null;
		for (const run of asArray(state.runs)) {
			if (!run || !ids.has(String(run.id))) continue;
			const row = asArray(run.rows).find(x => x && Number(x.typeId) === Number(typeId));
			if (!row) continue;
			const ms = Date.parse(run.copiedAt);
			if (best === null || ms > best.ms) best = { run, row, ms };
		}
		return best;
	};
	const runForRow = (r) => newestRunOf(r.lots.map(l => l.runId), r.typeId); // r.lots: the type's lots with units left, newest first
	const utcDay = (isoText) => new Date(Date.parse(isoText)).toISOString().slice(0, 10);
	// A sales-table row: the day's sales of the type -> their lots -> the lots' runs.
	const salesOfDay = (typeId, day) => (data.result ? data.result.sales.filter(s => s.typeId === typeId && utcDay(s.date) === day) : []);
	const runForDay = (typeId, day) => {
		const byId = lotsById();
		const runIds = [];
		for (const s of salesOfDay(typeId, day)) for (const id of s.lotIds) if (byId.has(id)) runIds.push(byId.get(id).runId);
		return newestRunOf(runIds, typeId);
	};

	const snapButtonHtml = (kind, fk, name, attrs) => `<button type="button" class="snapBtn" data-snap="${kind}" data-fk="${esc(fk)}" ${attrs} title="Export snapshot" aria-label="Export snapshot of ${esc(name)}" aria-haspopup="dialog" aria-expanded="false">${SNAP_ICON}</button>`;

	const STOP_WORDS = { horizon: 'bound by demand', roi: 'cut by the ROI floor', book: 'the source station ran out', cost: 'cut by the spend cap', target: 'target reached' };
	const pctObserved = (f) => `${Math.round(f * 1000) / 10}%`; // the export page's form
	const mil = (v) => (isNum(v) ? v * 1e6 : null);           // a run's *Mil fields are millions of ISK

	// What the panel compares: [label of the run's figure, the run's text, label of the figure now, its text, its title].
	const snapLines = (row, now) => [
		['sell price', fmtIsk(mil(row.sellPriceMil)), now.sell[0], now.sell[1], now.sell[2]],
		['cost per item', fmtIsk(mil(row.costPerItemMil)), now.cost[0], now.cost[1], now.cost[2]],
		['profit per item', fmtIsk(mil(row.profitPerItemMil), true), now.profit[0], now.profit[1], now.profit[2]],
		['days to clear', isNum(row.daysToClear) ? dur(row.daysToClear * DAY_MS) : DASH, now.days[0], now.days[1], now.days[2]],
		['daily demand', isNum(row.dailyDemand) ? fmtRate(row.dailyDemand) : DASH, now.demand[0], now.demand[1], now.demand[2]],
		['competing volume', isNum(row.competingVolume) ? fmtQty(row.competingVolume) : DASH, now.competing[0], now.competing[1], now.competing[2]]
	];
	// The figures now: an open order's, or a sales row's (the day's sales of the type).
	const nowOfOrder = (r) => ({
		sell: ['my price', fmtIsk(r.price), fmtExact(r.price)],
		cost: ['landed cost', fmtIsk(r.landedCost), isNum(r.landedCost) ? `${fmtExact(r.landedCost)} a unit: buy, haul and buy-order fee of the unsold units` : 'no lot covers the unsold units'],
		profit: ['margin now', fmtIsk(r.marginNow, true), isNum(r.marginNow) ? `${fmtExact(r.marginNow)} a unit at the current price, after tax and the landed cost` : 'no landed cost'],
		days: ['listed for', isNum(r.listedFor) ? dur(r.listedFor) : DASH, r.listedSince ? `since ${whenText(Date.parse(r.listedSince))}` : ''],
		demand: ['daily volume now', isNum(r.dailyVolume) ? fmtRate(r.dailyVolume) : DASH, 'units a day traded in the region, recency-weighted'],
		competing: ['units ahead now', isNum(r.unitsAhead) ? fmtQty(r.unitsAhead) : DASH, isNum(r.unitsAhead) ? `in ${plural(r.ordersAhead, 'order')} ahead ${scopeWord()}` : 'no book of this item yet']
	});
	const nowOfDay = (d) => {
		const sales = salesOfDay(d.typeId, d.day);
		const listed = sales.filter(s => isNum(s.daysSinceListed) && s.qty > 0);
		const listedQty = listed.reduce((a, s) => a + s.qty, 0);
		const daysListed = listedQty > 0 ? listed.reduce((a, s) => a + s.daysSinceListed * s.qty, 0) / listedQty : null;
		const open = data.result.rows.find(r => r.typeId === d.typeId) || null;
		const share = data.result.share.byType[d.typeId] || null;
		const winVolume = share && isNum(share.volume) && share.days.length > 0 ? share.volume / share.days.length : null;
		const per = (v) => (d.qty > 0 && isNum(v) ? v / d.qty : null);
		return {
			sell: ["the day's average price", fmtIsk(per(d.gross)), `${fmtExact(d.gross)} gross ÷ ${fmtQty(d.qty)} units`],
			cost: ['landed cost of the units sold', fmtIsk(per(d.net - d.profit)), 'net − profit, per unit: buy, haul and buy-order fee'],
			profit: ["the day's profit per unit", fmtIsk(per(d.profit), true), `${fmtExact(d.profit)} ÷ ${fmtQty(d.qty)} units`],
			days: ['days since listed', isNum(daysListed) ? dur(daysListed * DAY_MS) : DASH, isNum(daysListed) ? 'from listing to sale, the mean over the units sold that day' : 'not known for these sales'],
			demand: open && isNum(open.dailyVolume)
				? ['daily volume now', fmtRate(open.dailyVolume), 'units a day traded in the region, recency-weighted']
				: ['daily volume in the window', isNum(winVolume) ? fmtRate(winVolume) : DASH, isNum(winVolume) ? `units a day traded in the region over the ${share.days.length} days of the window the history covers` : 'no regional history of this item'],
			competing: ['units ahead now', open && isNum(open.unitsAhead) ? fmtQty(open.unitsAhead) : DASH, open ? (isNum(open.unitsAhead) ? `ahead of our open order ${scopeWord()}` : 'no book of this item yet') : 'no open order of this item']
		};
	};

	const snapPanelHtml = ({ typeId, run, row, now }) => {
		const name = nameOf(typeId);
		const route = `${run.route.start} → ${run.route.end}`;
		const rec = row.recommendation || {};
		const recommended = row.recommended;
		const stop = rec.floored ? 'nothing was worth buying' : STOP_WORDS[rec.stopReason] || 'limit not recorded';
		const lines = snapLines(row, now).map(([a, av, b, bv, title]) => `<tr><th scope="row">${esc(a)} <span class="dim">vs ${esc(b)}</span></th><td class="numeric">${esc(av)}</td><td class="numeric"${title ? ` title="${esc(title)}"` : ''}>${esc(bv)}</td></tr>`).join('');
		const seen = [];
		if (isNum(row.observedFractionEvents) && row.observedFractionEvents > 0) seen.push(`rivals ${pctObserved(row.observedFractionEvents)} observed`);
		if (isNum(row.observedFractionVolume) && row.observedFractionVolume > 0) seen.push(`demand ${pctObserved(row.observedFractionVolume)} observed`);
		if (isNum(row.soldBeforeUnits) && row.soldBeforeUnits > 0) seen.push(`sold before: ${plural(row.soldBeforeUnits, 'unit')} in the 90 days before the run`);
		return `<div class="snapHead"><h3 id="snapTitle">${esc(name)} — export snapshot</h3><button type="button" class="snapClose" data-act="snapClose">Close</button></div>
			<p class="snapRun">run ${esc(isNum(Date.parse(run.copiedAt)) ? stamp(Date.parse(run.copiedAt)) : DASH)} (${esc(route)}), ${esc(fmtQty(row.qty))} copied of ${esc(fmtQty(recommended))} recommended (${esc(stop)})</p>
			<table class="snapTable"><thead><tr><th scope="col"><span class="sr">figure</span></th><th scope="col" class="numeric">at the run</th><th scope="col" class="numeric">now</th></tr></thead><tbody>${lines}</tbody></table>
			${seen.length > 0 ? `<p class="snapSeen dim">${esc(seen.join(' · '))}</p>` : ''}`;
	};

	// One panel, anchored to the button that opened it; Escape, a click outside and its Close button close it, and
	// focus moves into it and back to that button (the button is found again by data-fk after a re-render).
	let snapFk = null;
	let snapOpener = null;
	const syncSnapExpanded = () => {
		for (const b of document.querySelectorAll('button.snapBtn[aria-expanded="true"]')) if (b.dataset.fk !== snapFk) b.setAttribute('aria-expanded', 'false');
		if (snapFk === null) return;
		const b = document.querySelector(`button.snapBtn[data-fk="${CSS.escape(snapFk)}"]`);
		if (b) b.setAttribute('aria-expanded', 'true');
	};
	const placeSnap = (btn) => {
		snapEl.style.left = '0px';
		snapEl.style.top = '0px';
		const b = btn.getBoundingClientRect();
		const p = snapEl.getBoundingClientRect();
		// the visible part of the page (on a phone the wide table makes the layout wider than the screen)
		const vv = window.visualViewport;
		const vx = vv ? vv.offsetLeft : 0;
		const vy = vv ? vv.offsetTop : 0;
		const vw = vv ? vv.width : window.innerWidth;
		const vh = vv ? vv.height : window.innerHeight;
		let x = b.left;
		if (x + p.width > vx + vw - 8) x = Math.max(vx + 8, vx + vw - 8 - p.width);
		let y = b.bottom + 4;
		if (y + p.height > vy + vh - 8 && b.top - 4 - p.height >= vy + 8) y = b.top - 4 - p.height;
		snapEl.style.left = `${Math.round(x + window.scrollX)}px`;
		snapEl.style.top = `${Math.round(y + window.scrollY)}px`;
	};
	const closeSnap = (restoreFocus) => {
		if (snapEl.hidden) return;
		snapEl.hidden = true;
		snapEl.replaceChildren();
		const fk = snapFk;
		const opener = snapOpener && snapOpener.isConnected ? snapOpener : fk ? document.querySelector(`button.snapBtn[data-fk="${CSS.escape(fk)}"]`) : null;
		snapFk = null;
		snapOpener = null;
		syncSnapExpanded();
		if (restoreFocus && opener) opener.focus();
	};
	const openSnap = (btn) => {
		if (!data.result) return;
		const typeId = Number(btn.dataset.typeId);
		let spec = null;
		if (btn.dataset.snap === 'order') {
			const r = data.result.rows.find(x => x.orderId === Number(btn.dataset.orderId));
			const found = r ? runForRow(r) : null;
			if (found) spec = { kind: 'order', typeId: r.typeId, run: found.run, row: found.row, now: nowOfOrder(r) };
		} else {
			const d = data.result.salesByTypeDay.find(x => x.typeId === typeId && x.day === btn.dataset.day);
			const found = d ? runForDay(d.typeId, d.day) : null;
			if (found) spec = { kind: 'day', typeId: d.typeId, run: found.run, row: found.row, now: nowOfDay(d) };
		}
		if (!spec) return; // the run is gone since the button was drawn
		hideTip();
		snapEl.innerHTML = snapPanelHtml(spec);
		snapEl.hidden = false;
		snapFk = btn.dataset.fk;
		snapOpener = btn;
		syncSnapExpanded();
		placeSnap(btn);
		snapEl.focus();
	};
	const toggleSnap = (btn) => {
		if (!snapEl.hidden && snapFk === btn.dataset.fk) { closeSnap(true); return; }
		closeSnap(false);
		openSnap(btn);
	};
	const onSnapClick = (e) => {
		const btn = e.target.closest('button.snapBtn');
		if (btn) toggleSnap(btn);
	};
	tbodyEl.addEventListener('click', onSnapClick);
	soldTableEl.addEventListener('click', onSnapClick);
	snapEl.addEventListener('click', (e) => {
		if (e.target.closest('button[data-act="snapClose"]')) closeSnap(true);
	});
	// a click outside closes it (capture: the target is fixed before anything moves); focus goes back to the
	// button only when the click did not put it somewhere else
	document.addEventListener('click', (e) => {
		if (snapEl.hidden || snapEl.contains(e.target) || e.target.closest('button.snapBtn')) return;
		const a = document.activeElement;
		closeSnap(!a || a === document.body || snapEl.contains(a));
	}, true);
	// Tab out of the panel closes it too, leaving focus where it went (not onto its own button: a click there toggles)
	snapEl.addEventListener('focusout', (e) => {
		const to = e.relatedTarget;
		if (!to || snapEl.contains(to) || (to.dataset && to.dataset.fk === snapFk)) return;
		closeSnap(false);
	});

	//--- the tooltip and the hit layer (insights.js's idiom: one tooltip, hover and focus alike, arrow keys)

	const el = (tag, attrs = {}, ...kids) => {
		const node = document.createElement(tag);
		for (const [k, v] of Object.entries(attrs)) {
			if (v === null || v === undefined || v === false) continue;
			if (k === 'class') node.className = v;
			else if (k === 'text') node.textContent = v;
			else node.setAttribute(k, v === true ? '' : String(v));
		}
		for (const kid of kids.flat()) {
			if (kid === null || kid === undefined || kid === false) continue;
			node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
		}
		return node;
	};
	const svgNode = (tag, attrs = {}) => {
		const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
		for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
		return node;
	};

	let tipOwner = null;
	const hideTip = () => {
		tipEl.hidden = true;
		tipOwner = null;
	};
	// spec: {title?, rows: [{shape?: 'profit' | 'loss' | 'hollow', value, name}], note?}
	const showTip = (spec, cx, cy, owner) => {
		tipEl.replaceChildren();
		if (spec.title) tipEl.append(el('div', { class: 'tt', text: spec.title }));
		for (const r of spec.rows || []) {
			tipEl.append(el('div', { class: 'tr' },
				r.shape ? el('span', { class: `tk ${r.shape}` }) : null,
				el('span', { class: 'tv', text: r.value }),
				r.name ? el('span', { class: 'tn', text: r.name }) : null));
		}
		if (spec.note) tipEl.append(el('div', { class: 'tx', text: spec.note }));
		tipEl.hidden = false;
		tipOwner = owner || null;
		const r = tipEl.getBoundingClientRect();
		let x = cx + 14;
		let y = cy + 14;
		if (x + r.width > window.innerWidth - 8) x = Math.max(8, cx - r.width - 14);
		if (y + r.height > window.innerHeight - 8) y = Math.max(8, cy - r.height - 14);
		tipEl.style.left = `${x}px`;
		tipEl.style.top = `${y}px`;
	};
	const tipText = (spec) => [spec.title, ...(spec.rows || []).map(r => `${r.value} ${r.name || ''}`.trim()), spec.note].filter(Boolean).join('. ');
	// Escape closes the topmost thing: the tooltip, else the export snapshot panel
	document.addEventListener('keydown', (e) => {
		if (e.key !== 'Escape') return;
		if (!tipEl.hidden) hideTip();
		else if (!snapEl.hidden) closeSnap(true);
	});

	// Plot draws the marks; this layer sits over them: transparent, larger than the mark, one tab stop for
	// the group with arrow keys between targets, the same tooltip on hover and on focus.
	// targets: [{x, y, r | (w, h), tip, noPointer?}]
	const attachTargets = (svg, targets, label) => {
		if (targets.length === 0) return;
		const g = svgNode('g', { class: 'hits', role: 'group', 'aria-label': label });
		const els = [];
		let active = 0;
		const clientOf = (t) => {
			const p = svg.createSVGPoint();
			p.x = t.r !== undefined ? t.x : t.x + t.w / 2;
			p.y = t.r !== undefined ? t.y : t.y + t.h / 2;
			const m = svg.getScreenCTM();
			return m ? p.matrixTransform(m) : { x: 0, y: 0 };
		};
		const show = (i, cx, cy) => {
			showTip(targets[i].tip, cx, cy, svg);
			els.forEach((n, j) => n.classList.toggle('on', j === i));
		};
		const off = () => {
			els.forEach(n => n.classList.remove('on'));
			if (tipOwner === svg) hideTip();
		};
		const focusAt = (i) => {
			els[active].setAttribute('tabindex', '-1');
			active = i;
			els[i].setAttribute('tabindex', '0');
			els[i].focus();
		};
		targets.forEach((t, i) => {
			const node = t.r !== undefined
				? svgNode('circle', { cx: t.x, cy: t.y, r: t.r })
				: svgNode('rect', { x: t.x, y: t.y, width: t.w, height: t.h, rx: 2 });
			node.setAttribute('class', 'hit');
			node.setAttribute('tabindex', i === 0 ? '0' : '-1');
			node.setAttribute('role', 'img');
			node.setAttribute('aria-label', tipText(t.tip));
			if (t.noPointer) node.style.pointerEvents = 'none'; // under a bigger mark: reachable by keyboard, not in the way of the pointer
			else {
				node.addEventListener('pointerenter', (e) => show(i, e.clientX, e.clientY));
				node.addEventListener('pointermove', (e) => show(i, e.clientX, e.clientY));
				node.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') off(); }); // a tapped mark stays until the next tap
			}
			node.addEventListener('focus', () => {
				active = i;
				const q = clientOf(t);
				show(i, q.x, q.y);
			});
			node.addEventListener('blur', off);
			node.addEventListener('keydown', (e) => {
				let next = null;
				if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = i + 1;
				else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = i - 1;
				else if (e.key === 'Home') next = 0;
				else if (e.key === 'End') next = targets.length - 1;
				if (next === null) return;
				e.preventDefault();
				if (next >= 0 && next < targets.length) focusAt(next);
			});
			els.push(node);
			g.append(node);
		});
		svg.append(g);
	};

	//--- rendering: sold recently

	const saleLine = (s) => {
		const ms = Date.parse(s.date);
		// orderMatch: 'unique' (the log's price at the time), 'byTime' (the log never saw this price: matched by when), 'ambiguous', 'none'
		const order = s.orderMatch === 'unique' ? `order ${s.orderId}`
			: s.orderMatch === 'byTime' ? `${s.orderId ? `order ${s.orderId}, ` : ''}matched by time (the log never saw this price)`
			: s.orderMatch === 'ambiguous' ? 'ambiguous (more than one order at this price)' : 'no match';
		const listed = isNum(s.daysSinceListed) ? ` · listed ${dur(s.daysSinceListed * DAY_MS)} before` : '';
		return {
			shape: s.profit < 0 ? 'loss' : 'profit',
			value: fmtIsk(s.profit, true),
			name: `${whenText(ms)} · ${fmtQty(s.qty)} × ${price(s.unitPrice)} · net ${fmtIsk(s.qty > 0 ? s.net / s.qty : null)} each · ${order}${listed}`
		};
	};
	const clusterTip = (c) => {
		const shown = c.sales.slice().sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
		const rows = shown.slice(0, 8).map(saleLine);
		if (shown.length > 8) rows.push({ value: `+${shown.length - 8}`, name: 'more sales in this dot (see the table below the chart)' });
		return {
			title: `${nameOf(c.typeId)}: ${plural(c.count, 'sale')}, ${plural(c.qty, 'unit')}, ${c.profit < 0 ? 'loss' : 'profit'} ${fmtExact(Math.abs(c.profit))}`,
			rows
		};
	};
	const pendingTip = (p) => ({
		title: `${nameOf(p.typeId)}: ${plural(p.qty, 'unit')} filled, not in the wallet yet`,
		rows: [{ shape: 'hollow', value: isNum(p.estProfit) ? fmtIsk(p.estProfit, true) : DASH, name: `${whenText(Date.parse(p.date))}${p.observed === true ? ' (seen at the next check, so the fill is older)' : ''} · ${fmtQty(p.qty)} × ${price(p.unitPrice)} · est. net ${fmtIsk(p.estNet)}${isNum(p.estProfit) ? '' : ' · profit unknown: no landed cost'} · order ${p.orderId}` }],
		note: 'the order log saw these units go; ESI holds wallet transactions back for up to an hour. An estimate, drawn hollow, until the sale arrives.'
	});
	// The total column's tooltip (decision 17): the item's sales, units, gross, net and profit over the window,
	// and the estimate of its pending fills.
	const totalTip = (t, winLabel) => {
		const rows = [];
		if (t.count > 0) {
			rows.push({ shape: t.profit < 0 ? 'loss' : 'profit', value: fmtIsk(t.profit, true), name: `profit from ${plural(t.count, 'sale')}, ${plural(t.qty, 'unit')}` });
			rows.push({ value: fmtIsk(t.gross), name: 'gross' });
			rows.push({ value: fmtIsk(t.net), name: 'net, after sales tax and broker fees' });
		}
		if (t.pendingCount > 0) {
			const unknown = t.pendingCount - t.pendingKnown;
			rows.push({ shape: 'hollow', value: isNum(t.pendingEst) ? fmtIsk(t.pendingEst, true) : DASH, name: `est. profit of ${plural(t.pendingQty, 'unit')} filled, not in the wallet yet${unknown > 0 ? ` (${plural(unknown, 'fill')} without a landed cost)` : ''}` });
		}
		return {
			title: `${nameOf(t.typeId)}: total over the last ${winLabel}`,
			rows,
			note: t.count > 0
				? 'The total column has its own scale: the mark’s area is the item’s profit over the window.'
				: 'No completed sale in the window: the hollow mark is the estimate for the pending fills, on the total column’s own scale.'
		};
	};

	// The presence lines (decision 18): what began a stretch, in words ('unknown' and anything new: not known).
	const CAUSE_WORDS = {
		listed: 'we listed a sell order',
		ourPrice: 'we changed a price',
		undercut: 'someone priced below us',
		cleared: 'the orders below ours went (filled, cancelled or repriced)',
		ended: 'a sell order of ours ended (filled, cancelled or expired)'
	};
	// One of our orders at a moment: its log's price with the latest `issued` at or before it (as the module's
	// priceAt), else the open row's price.
	const ourOrderAt = (orderId, ms) => {
		for (const [cid, log] of Object.entries(data.orderLogs || {})) {
			const rec = log && log[orderId];
			if (!rec) continue;
			const path = asArray(rec.path);
			let pick = null;
			for (const e of path) {
				const t = msOf(e.issued || e.at);
				if (Number.isFinite(t) && t <= ms && (pick === null || t >= pick.t)) pick = { t, price: e.price };
			}
			return { orderId, characterId: Number(cid), price: pick ? pick.price : path.length > 0 ? path[0].price : null };
		}
		const row = data.result ? data.result.rows.find(r => String(r.orderId) === String(orderId)) : null;
		return { orderId, characterId: row ? row.characterId : null, price: row ? row.price : null };
	};
	const presenceTip = (p, now) => {
		const s = p.seg;
		const known = s.known !== false;
		const what = s.state === 'top' ? 'on top: the lowest sell order at the station was ours'
			: known ? 'listed, but someone was priced below us'
			: 'listed; whether on top is unknown (before the book log of this item)';
		// the orders counted at the stretch's start; a price change of ours that kept the state merges into the
		// stretch, so a price is shown as start → end when it moved
		const ids = s.orderIds;
		const many = (state.characters || []).length > 1;
		const rows = [{ value: dur(p.toMs - p.fromMs), name: `${whenText(p.fromMs)} to ${now - p.toMs < MIN_MS ? 'now' : whenText(p.toMs)}` }];
		for (const id of ids.slice(0, 4)) {
			const a = ourOrderAt(id, p.fromMs);
			const b = ourOrderAt(id, p.toMs - 1);
			const moved = isNum(a.price) && isNum(b.price) && a.price !== b.price;
			rows.push({ value: moved ? `${price(a.price)} → ${price(b.price)}` : price(a.price), name: `our order ${id}${many && a.characterId !== null ? ` (${firstName(a.characterId)})` : ''}` });
		}
		if (ids.length > 4) rows.push({ value: `+${ids.length - 4}`, name: 'more orders of ours' });
		if (known && isNum(s.below)) {
			rows.push({ value: s.below === 0 ? 'none' : nf2.format(s.below), name: s.below === 0 ? 'priced below ours' : `${s.below === 1 ? 'order' : 'orders'} priced below ours${isNum(s.lowestBelow) ? `, the lowest at ${price(s.lowestBelow)}` : ''}` });
		}
		const cause = CAUSE_WORDS[s.cause];
		return { title: `${nameOf(p.typeId)}: ${what}`, rows, note: cause ? `It began when ${cause}.` : 'What began it is not known: the window or the book log starts here.' };
	};

	// What the timeline shows: a mark per cluster and per pending fill; a row per item, the window's profit highest
	// first and items with only pending fills after them (decision 17); each item's total for the last column; and
	// the presence segments of those items (decision 18).
	const timelineModel = (res, now, windowMs) => {
		const marks = [];
		for (const c of res.salesClusters) marks.push({ kind: 'sale', typeId: c.typeId, atMs: Date.parse(c.at), endMs: Date.parse(c.end), profit: c.profit, cluster: c });
		for (const p of res.pending) marks.push({ kind: 'pending', typeId: p.typeId, atMs: Date.parse(p.date), endMs: Date.parse(p.date), profit: p.estProfit, pending: p });
		if (marks.length === 0) return null;
		const totals = new Map();
		const totalOf = (typeId) => {
			if (!totals.has(typeId)) totals.set(typeId, { typeId, count: 0, qty: 0, gross: 0, net: 0, profit: 0, pendingCount: 0, pendingQty: 0, pendingKnown: 0, pendingProfit: 0 });
			return totals.get(typeId);
		};
		for (const c of res.salesClusters) {
			const t = totalOf(c.typeId);
			t.count += c.count;
			t.qty += c.qty;
			t.gross += c.gross;
			t.net += c.net;
			t.profit += c.profit;
		}
		for (const p of res.pending) {
			const t = totalOf(p.typeId);
			t.pendingCount++;
			t.pendingQty += p.qty;
			if (isNum(p.estProfit)) {
				t.pendingKnown++;
				t.pendingProfit += p.estProfit;
			}
		}
		for (const t of totals.values()) {
			t.pendingEst = t.pendingKnown > 0 ? t.pendingProfit : null;
			t.value = t.count > 0 ? t.profit : t.pendingEst; // what the total column draws: hollow for an estimate
		}
		const est = (t) => (isNum(t.pendingEst) ? t.pendingEst : -Infinity);
		const list = [...totals.values()];
		const types = [
			...list.filter(t => t.count > 0).sort((a, b) => b.profit - a.profit || a.typeId - b.typeId),
			...list.filter(t => t.count === 0).sort((a, b) => est(b) - est(a) || a.typeId - b.typeId)
		].map(t => t.typeId);
		const startMs = now - windowMs;
		const pres = res.presence;
		const presence = [];
		for (const typeId of types) {
			const p = pres[typeId];
			for (const seg of asArray(p && p.segments)) {
				if (!seg) continue;
				const fromMs = Math.max(startMs, msOf(seg.from));
				const toMs = Math.min(now, seg.to ? msOf(seg.to) : now);
				if (!(toMs > fromMs)) continue;
				presence.push({ typeId, fromMs, toMs, seg });
			}
		}
		return { marks, types, totals, presence, startMs };
	};

	const RMAX = 14;          // px radius of the biggest dot
	const RMIN = 3;           // below this a dot is drawn at this radius (the footnote says so)
	const ROW_H = 34;
	const LINE_INSET = 5;     // px from a row's bottom edge to its presence line
	const COL_GAP = RMAX + 4; // the total column's divider clears a sale dot at the right edge (now)

	const drawTimeline = (res, width) => {
		const win = WINDOWS.find(w => w.key === winKey);
		const now = data.now;
		const m = timelineModel(res, now, win.ms);
		if (m === null) return null;
		const mags = m.marks.map(k => (isNum(k.profit) ? Math.abs(k.profit) : 0));
		const M = Math.max(1, ...mags);
		const floor = M * (RMIN / RMAX) ** 2;
		for (const k of m.marks) k.mag = Math.max(isNum(k.profit) ? Math.abs(k.profit) : 0, floor);
		const radiusOf = (mag) => RMAX * Math.sqrt(mag / M);
		// the total column: one mark per item on its own sqrt scale, the figure beside it from 640 px
		const wide = width >= 640;
		const totals = m.types.map(id => m.totals.get(id));
		const TM = Math.max(1, ...totals.map(t => (isNum(t.value) ? Math.abs(t.value) : 0)));
		const tFloor = TM * (RMIN / RMAX) ** 2;
		const totalR = (v) => RMAX * Math.sqrt(Math.max(isNum(v) ? Math.abs(v) : 0, tFloor) / TM);
		const drawPresence = showPresence;
		const marginLeft = width < 640 ? 120 : 176;
		const marginRight = COL_GAP + (wide ? 100 : 42);
		const marginTop = 6;
		const marginBottom = 34;
		const height = m.types.length * ROW_H + marginTop + marginBottom;
		const startDate = new Date(m.startMs);
		const endDate = new Date(now);
		const sale = m.marks.filter(k => k.kind === 'sale');
		const pend = m.marks.filter(k => k.kind === 'pending');
		const marks = [
			Plot.rect(m.types.filter((_, i) => i % 2 === 0), { x1: () => startDate, x2: () => endDate, y: (d) => d, fill: STRIPE }),
			Plot.gridX({ stroke: GRID, strokeOpacity: 1, strokeWidth: 1 })
		];
		const dots = (list, symbol, fill, stroke) => {
			if (list.length > 0) marks.push(Plot.dot(list, { x: (d) => new Date(d.atMs), y: 'typeId', r: 'mag', symbol, fill, fillOpacity: fill === SURFACE ? 1 : 0.9, stroke, strokeWidth: 2 }));
		};
		dots(sale.filter(k => k.profit >= 0), 'circle', PROFIT, SURFACE);
		dots(sale.filter(k => k.profit < 0), 'square', LOSS, SURFACE);
		dots(pend.filter(k => isNum(k.profit) && k.profit >= 0), 'circle', SURFACE, PROFIT);
		dots(pend.filter(k => isNum(k.profit) && k.profit < 0), 'square', SURFACE, LOSS);
		dots(pend.filter(k => !isNum(k.profit)), 'circle', SURFACE, INK2);
		const plot = Plot.plot({
			width, height, marginLeft, marginRight, marginTop, marginBottom,
			style: PLOT_STYLE,
			x: { type: 'time', domain: [startDate, endDate], label: null, tickSize: 0, ticks: Math.max(3, Math.floor((width - marginLeft - marginRight) / 120)) },
			y: { type: 'band', domain: m.types, padding: 0, label: null, tickSize: 0, tickFormat: (id) => short(nameOf(id), width < 640 ? 16 : 26) },
			r: { type: 'sqrt', domain: [0, M], range: [0, RMAX] },
			marks
		});
		plot.setAttribute('role', 'group');
		plot.setAttribute('aria-label', `Sales timeline of the last ${win.label}: one row per item, the highest profit over the window first; one mark per sale or burst of sales, area proportional to profit; after a dashed divider, each item's total on its own scale${drawPresence ? '; and near the bottom of each row, a line while we had a sell order listed, solid while it was the lowest at its station and dotted while someone was lower' : ''}. The table below has the same figures.`);
		for (const g of plot.querySelectorAll(':scope > g')) g.setAttribute('aria-hidden', 'true');
		const sx = plot.scale('x');
		const sy = plot.scale('y');
		const rowTop = (typeId) => sy.apply(typeId);
		const rowCentre = (typeId) => rowTop(typeId) + sy.bandwidth / 2;
		const plotRight = width - marginRight;
		const divX = plotRight + COL_GAP;
		const colX = divX + 8 + RMAX;
		const bottom = height - marginBottom;
		// Plot draws the marks; what it has no mark for is added here, in its coordinates, under or over its groups
		const gridG = plot.querySelector(':scope > g[aria-label="x-grid"]');
		const firstDot = plot.querySelector(':scope > g[aria-label="dot"]');
		const insert = (node, ref) => { if (ref) plot.insertBefore(node, ref); else plot.append(node); };
		// the stripes run on under the total column, below the sale dots that reach past the right edge
		const stripes = svgNode('g', { 'aria-hidden': 'true' });
		m.types.forEach((id, i) => {
			if (i % 2 === 0) stripes.append(svgNode('rect', { x: plotRight, y: rowTop(id), width: width - plotRight, height: sy.bandwidth, fill: STRIPE }));
		});
		insert(stripes, gridG || firstDot);
		// the presence lines, under the sale dots: solid on top, dotted when listed, faint when unknown
		const presenceTargets = [];
		if (drawPresence && m.presence.length > 0) {
			const g = svgNode('g', { 'aria-hidden': 'true' });
			for (const p of m.presence) {
				const x1 = sx.apply(new Date(p.fromMs));
				const x2 = sx.apply(new Date(p.toMs));
				const y = rowTop(p.typeId) + sy.bandwidth - LINE_INSET;
				const top = p.seg.state === 'top';
				const attrs = { x1, x2, y1: y, y2: y, stroke: INK2, 'stroke-width': 2, 'stroke-linecap': top ? 'butt' : 'round' };
				if (!top) attrs['stroke-dasharray'] = '0 4'; // round caps on zero-length dashes: 2 px dots every 4 px
				if (p.seg.known === false) attrs['stroke-opacity'] = 0.45;
				g.append(svgNode('line', attrs));
				const w = Math.max(6, x2 - x1);
				presenceTargets.push({ x: (x1 + x2) / 2 - w / 2, y: y - 5, w, h: 10, tip: presenceTip(p, now) });
			}
			insert(g, firstDot);
		}
		// the total column: a dashed divider, a mark per item, its figure on wide charts, "total" in the axis row
		const col = svgNode('g', { 'aria-hidden': 'true' });
		col.append(svgNode('line', { x1: divX, x2: divX, y1: marginTop, y2: bottom, stroke: AXIS, 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
		for (const t of totals) {
			const cy = rowCentre(t.typeId);
			const r = totalR(t.value);
			const hollow = t.count === 0;
			const tone = !isNum(t.value) ? INK2 : t.value < 0 ? LOSS : PROFIT;
			const paint = hollow ? { fill: SURFACE, stroke: tone, 'stroke-width': 2 } : { fill: tone, 'fill-opacity': 0.9, stroke: SURFACE, 'stroke-width': 2 };
			if (isNum(t.value) && t.value < 0) {
				const side = r * Math.sqrt(Math.PI); // the area of a circle of radius r, as Plot sizes its squares
				col.append(svgNode('rect', { x: colX - side / 2, y: cy - side / 2, width: side, height: side, ...paint }));
			} else col.append(svgNode('circle', { cx: colX, cy, r, ...paint }));
			if (wide) {
				const figure = svgNode('text', { x: colX + RMAX + 6, y: cy, dy: '0.32em', fill: INK2, 'text-anchor': 'start', 'font-variant': 'tabular-nums' });
				figure.textContent = isNum(t.value) ? `${hollow ? '~' : ''}${fmtIsk(t.value, true)}` : DASH;
				col.append(figure);
			}
		}
		const label = svgNode('text', { x: colX, y: bottom + 9, dy: '0.71em', fill: INK2, 'text-anchor': 'middle' });
		label.textContent = 'total';
		col.append(label);
		plot.append(col);
		// the hit layer: the presence stretches first (under), then the sales, pending fills and totals, row by row
		attachTargets(plot, presenceTargets, 'When we were listed and on top, arrow keys move between the stretches');
		const markTargets = m.marks.map(k => ({
			row: m.types.indexOf(k.typeId), x: sx.apply(new Date(k.atMs)), y: rowCentre(k.typeId), r: Math.max(11, radiusOf(k.mag) + 3),
			tip: k.kind === 'sale' ? clusterTip(k.cluster) : pendingTip(k.pending)
		}));
		const totalTargets = totals.map(t => ({ row: m.types.indexOf(t.typeId), x: colX, y: rowCentre(t.typeId), r: Math.max(11, totalR(t.value) + 3), tip: totalTip(t, win.label) }));
		attachTargets(plot, [...markTargets, ...totalTargets].sort((a, b) => a.row - b.row || a.x - b.x), 'Sales, pending fills and each item’s total, arrow keys move between them');
		return { plot, model: m, wide, presenceDrawn: presenceTargets.length };
	};

	const legendHtml = () => {
		const keys = [
			['<span class="sw profit"></span>', 'profit (a circle)'],
			['<span class="sw loss"></span>', 'loss (a square)'],
			['<span class="sw pendProfit"></span><span class="sw pendLoss"></span>', 'hollow: filled per the order log, not in the wallet yet (estimated)']
		];
		if (showPresence) {
			keys.push(
				['<span class="sw line lineTop"></span>', 'solid line: on top (our sell order the lowest at its station)'],
				['<span class="sw line lineListed"></span>', 'dotted: listed, someone lower'],
				['<span class="sw line lineGap"></span>', 'a gap: no sell order of ours']);
		}
		keys.push(['', 'dot area = profit of the sale or burst of sales it stands for']);
		return keys.map(([sw, label]) => `<span class="key" role="listitem">${sw}${esc(label)}</span>`).join('');
	};

	const stateCard = (title, text, ...buttons) => el('div', { class: 'chartState', role: 'status' }, el('h3', { text: title }), text ? el('p', { text }) : null, buttons.length > 0 ? el('div', {}, buttons) : null);

	const renderSold = () => {
		const res = data.result;
		if (!res) return;
		const win = WINDOWS.find(w => w.key === winKey);
		for (const b of winSegEl.children) b.setAttribute('aria-pressed', b.dataset.win === winKey ? 'true' : 'false');
		presenceChk.checked = showPresence;
		hideTip();
		const t = res.totals;
		const pendingUnits = t.pendingUnits;
		const pendingProfit = res.pending.reduce((a, p) => a + (isNum(p.estProfit) ? p.estProfit : 0), 0);
		const region = regionWord();
		if (t.count === 0 && res.pending.length === 0) {
			setHtml(soldTotalsEl, '');
			setHtml(soldLegendEl, '');
			soldFootEl.replaceChildren();
			soldTableEl.replaceChildren();
			const wider = WINDOWS[WINDOWS.indexOf(win) + 1];
			const lastSale = res.asOf.transactions ? Date.parse(res.asOf.transactions) : null;
			soldBodyEl.replaceChildren(stateCard('No sales in this window',
				`Nothing sold in the last ${win.label}${lastSale ? ` (the newest sale on record is from ${whenText(lastSale)})` : ' (no sale on record at all)'}. ESI holds sales back for up to an hour.`,
				wider ? el('button', { type: 'button', 'data-win': wider.key, text: `Show the last ${wider.label}` }) : null));
			return;
		}
		setHtml(soldTotalsEl, [
			tot('sales', esc(nf2.format(t.count)), `${plural(t.count, 'wallet transaction')} in the last ${win.label}`),
			tot('units', esc(fmtQty(t.units)), `${fmtQty(t.units)} units`),
			tot('gross', esc(fmtIsk(t.gross)), fmtExact(t.gross)),
			tot('net', esc(fmtIsk(t.net)), `${fmtExact(t.net)} = gross − sales tax − broker fees (listing and relist shares)`),
			tot('profit', money(t.profit, true), `${fmtExact(t.profit)} = net − the landed cost (buy, haul, buy-order fee) of the units sold, FIFO over the whole ledger`, 'main'),
			tot('relist fees paid', esc(fmtIsk(t.relistFees)), `${fmtExact(t.relistFees)}: price-change fees in the journal dated inside the window`),
			tot(`share of ${region} volume`, esc(fmtPct(t.share)), `our units ÷ all units traded in the region, on the UTC days we sold that the history already covers${res.share.overall.volume ? `: ${fmtQty(res.share.overall.qty)} of ${fmtQty(res.share.overall.volume)}` : ''}`),
			pendingUnits > 0 ? tot('pending', `${esc(fmtQty(pendingUnits))} units`, `${fmtQty(pendingUnits)} units the order log saw fill that the wallet has not caught up with; est. profit ${fmtExact(pendingProfit)}. Drawn hollow below`) : ''
		].join(''));
		setHtml(soldLegendEl, legendHtml());
		// the chart
		let drawn = null;
		if (typeof Plot === 'undefined' || typeof d3 === 'undefined') {
			soldBodyEl.replaceChildren(stateCard('The chart library did not load', 'The timeline needs Observable Plot from jsdelivr. The table below has the same figures.'));
		} else {
			const width = Math.max(320, Math.min(1150, Math.floor(soldBodyEl.clientWidth) || 900));
			try {
				drawn = drawTimeline(res, width);
				soldBodyEl.replaceChildren(drawn ? drawn.plot : stateCard('No sales in this window', ''));
			} catch (e) {
				console.error(e);
				soldBodyEl.replaceChildren(stateCard('The timeline could not be drawn', `${e && e.message ? e.message : e}. The table below has the same figures.`));
			}
		}
		const foot = [
			`Each row is an item, the highest profit over the window on top; items with only pending fills follow. Sales of one item within ${dur(Math.max(10 * MIN_MS, win.ms / 150))} of each other are one dot. Dots under ${RMIN} px radius are drawn at ${RMIN} px, so the smallest profits read as larger than they are. Times are local; EVE time is in parentheses.`,
			drawn ? `The total column after the dashed line has its own scale: its mark's area is the item's profit over the window${drawn.wide ? ' (the figure beside it)' : ''}, sized against the largest total, not against the sale dots.` : '',
			res.pending.length > 0 ? `${plural(res.pending.length, 'hollow mark')}: units the order log saw fill that the wallet has not caught up with (ESI holds transactions back up to an hour).` : '',
			showPresence && drawn
				? (drawn.presenceDrawn > 0
					? 'The line near the bottom of a row is solid while one of our sell orders of the item was the lowest at its station, dotted while someone was lower, and missing while we had no sell order; it is faint before the book log covers the item, where whether we were on top is unknown.'
					: 'No sell order of ours was open for these items in this window, so no line is drawn.')
				: ''
		].filter(Boolean);
		soldFootEl.replaceChildren(...foot.map(text => el('p', { text })));
		soldTableEl.replaceChildren(res.salesByTypeDay.length > 0
			? soldTable(res)
			: el('p', { class: 'dim', text: 'No completed sale in this window yet: the hollow marks above are fills the wallet has not caught up with.' }));
		syncSnapExpanded();
	};

	const hasHistory = (typeId) => data.history[typeId] !== undefined || data.soldHistory.has(typeId);
	// The item cell of a sales row: the name, and the export-snapshot button when a run planned the day's sales.
	const soldItemCell = (r) => {
		const name = nameOf(r.typeId);
		const cell = el('td', { title: `type ${r.typeId}` }, name);
		if (runForDay(r.typeId, r.day)) {
			const b = el('button', {
				type: 'button', class: 'snapBtn', 'data-snap': 'day', 'data-type-id': r.typeId, 'data-day': r.day, 'data-fk': `snapday-${r.typeId}-${r.day}`,
				title: 'Export snapshot', 'aria-label': `Export snapshot of ${name}, ${r.day}`, 'aria-haspopup': 'dialog', 'aria-expanded': 'false'
			});
			b.innerHTML = SNAP_ICON;
			cell.append(b);
		}
		return cell;
	};
	const soldTable = (res) => {
		const t = res.totals;
		const rows = res.salesByTypeDay;
		const region = regionWord();
		const th = (label, numeric) => el('th', { class: numeric ? 'numeric' : '', scope: 'col', text: label });
		const td = (text, numeric, title, neg) => el('td', { class: `${numeric ? 'numeric' : ''}${neg ? ' neg' : ''}`, title: title || null, text });
		const body = rows.map(r => el('tr', {},
			soldItemCell(r),
			td(r.day, false, 'UTC day (EVE time)'),
			td(String(r.count), true), td(fmtQty(r.qty), true),
			td(fmtIsk(r.gross), true, fmtExact(r.gross)), td(fmtIsk(r.net), true, fmtExact(r.net)),
			td(fmtIsk(r.profit, true), true, fmtExact(r.profit), r.profit < 0),
			td(fmtQty(r.dayQty), true, 'our units sold that whole UTC day'),
			td(isNum(r.volume) ? fmtQty(r.volume) : DASH, true, isNum(r.volume) ? 'units traded in the region that day' : hasHistory(r.typeId) ? 'the history has no row for that day yet: ESI adds a day only once it is over' : 'no regional history is stored for this item (only the items you list are fetched)'),
			td(fmtPct(r.share), true, isNum(r.share) ? `${fmtQty(r.dayQty)} ÷ ${fmtQty(r.volume)}` : '')));
		body.push(el('tr', { class: 'total' },
			td('all items', false), td('', false),
			td(String(t.count), true), td(fmtQty(t.units), true),
			td(fmtIsk(t.gross), true, fmtExact(t.gross)), td(fmtIsk(t.net), true, fmtExact(t.net)),
			td(fmtIsk(t.profit, true), true, fmtExact(t.profit), t.profit < 0),
			td('', true), td('', true),
			td(fmtPct(t.share), true, `our units ÷ the region's volume, on the UTC days we sold that the history already covers`)));
		return el('div', { class: 'tableWrap', tabindex: 0, role: 'region', 'aria-label': 'Sales per item and day (table view of the timeline)' },
			el('table', { class: 'data' },
				el('caption', { text: `Sales per item and UTC day (EVE time): the table view of the timeline above. Share is our units that day ÷ ${region} volume that day.` }),
				el('thead', {}, el('tr', {}, th('item'), th('day (UTC)'), th('sales', true), th('units', true), th('gross', true), th('net', true), th('profit', true), th('our units that day', true), th(`${region} volume`, true), th('share', true))),
				el('tbody', {}, body)));
	};

	//--- the page

	const render = () => {
		// the loader learned packaged volumes since the last sums (it re-renders when it does): the landed costs move
		if (data.loaded && data.facts && state.snapshotSince === null && data.factsKey !== factsKeyNow()) recompute();
		renderBanners();
		renderChips();
		setHtml(stateBoxEl, stateBoxHtml());
		const live = isLive();
		liveEl.hidden = !live;
		if (!live) return;
		renderRefresh();
		renderStatusLine();
		renderFeeRates();
		renderOpen();
		renderSold();
	};

	// Item names arrived: the tables and the timeline's row labels redraw.
	const redrawNames = () => {
		if (!isLive()) return;
		renderOpen();
		renderSold();
	};

	//--- events

	// A threshold input: take what is typed when it is a number in range, say so when it is not; a committed
	// bad value goes back to the last good one.
	const THRESHOLD_INPUTS = [
		{ el: $('#thLeave'), key: 'leaveHours', min: 0, name: 'leave under', what: 'a number of hours, 0 or more' },
		{ el: $('#thUndercut'), key: 'undercutDays', min: 0, name: 'undercut over', what: 'a number of days, 0 or more' },
		{ el: $('#thRoi'), key: 'minRoi', min: 1, name: 'ROI floor', what: 'a ratio of 1 or more (net revenue ÷ landed cost)' }
	];
	let applyTimer = null;
	const applyThresholds = () => {
		store.set('thresholds', thresholds);
		clearTimeout(applyTimer);
		applyTimer = setTimeout(() => {
			recompute();
			render();
		}, 120);
	};
	const syncThresholdInputs = () => {
		for (const t of THRESHOLD_INPUTS) {
			t.el.value = String(thresholds[t.key]);
			t.el.removeAttribute('aria-invalid');
		}
		$('#thScope').value = thresholds.scope;
		setText(thNoteEl, '');
	};
	for (const t of THRESHOLD_INPUTS) {
		t.el.addEventListener('input', () => {
			const raw = t.el.value.trim();
			const v = raw === '' ? NaN : Number(raw);
			if (Number.isFinite(v) && v >= t.min) {
				t.el.removeAttribute('aria-invalid');
				setText(thNoteEl, '');
				if (v !== thresholds[t.key]) {
					thresholds[t.key] = v;
					applyThresholds();
				}
			} else {
				t.el.setAttribute('aria-invalid', 'true');
				setText(thNoteEl, `${t.name} needs ${t.what}. The verdicts keep using ${thresholds[t.key]} until then.`);
			}
		});
		t.el.addEventListener('change', () => {
			if (t.el.getAttribute('aria-invalid') === 'true') {
				t.el.value = String(thresholds[t.key]);
				t.el.removeAttribute('aria-invalid');
				setText(thNoteEl, '');
			}
		});
	}
	$('#thScope').addEventListener('change', (e) => {
		thresholds.scope = e.target.value === 'region' ? 'region' : 'station';
		applyThresholds();
	});

	const sortBy = (key) => {
		sort = sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: COLUMNS.find(c => c.key === key).text ? 'asc' : 'desc' };
		store.set('sort', sort);
		renderOpen();
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
	defaultOrderBtn.addEventListener('click', () => {
		sort = { key: null, dir: 'desc' };
		store.set('sort', sort);
		renderOpen();
		const th = sortRowEl.querySelector('th'); // the button that was pressed is gone
		if (th) th.focus();
	});

	const chooseWindow = (key) => {
		if (!WINDOWS.some(w => w.key === key) || key === winKey) return;
		winKey = key;
		store.set('window', key);
		recompute();
		renderOpen();
		renderSold();
		afterRender();
		const again = winSegEl.querySelector(`[data-win="${key}"]`);
		if (again) again.focus();
	};
	document.addEventListener('click', (e) => {
		const w = e.target.closest('button[data-win]');
		if (w) { chooseWindow(w.dataset.win); return; }
		const b = e.target.closest('button[data-act="retryLoad"]');
		if (b) { retryLoad(); return; }
		const d = e.target.closest('button[data-act="dismiss"]');
		if (d) {
			notices.splice(Number(d.dataset.i), 1);
			renderBanners();
		}
	});
	presenceChk.addEventListener('change', () => {
		showPresence = presenceChk.checked;
		store.set('showPresence', showPresence);
		renderSold();
	});
	refreshBtn.addEventListener('click', () => { tick(); });
	refreshChk.addEventListener('change', () => {
		refreshOpen = refreshChk.checked;
		store.set('refreshOpen', refreshOpen);
		if (refreshOpen && !ticking) planNext();
		renderStatusLine();
	});
	// Portraits come from another host; a failed one just leaves the grey square.
	chipsEl.addEventListener('error', (e) => {
		if (e.target && e.target.classList && e.target.classList.contains('portrait')) e.target.classList.add('noimg');
	}, true);

	// The timeline follows the width of the page.
	let lastWidth = 0;
	let resizeTimer = null;
	if (typeof ResizeObserver !== 'undefined') {
		new ResizeObserver(() => {
			const w = soldBodyEl.clientWidth;
			if (Math.abs(w - lastWidth) < 24) return;
			lastWidth = w;
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => { if (isLive()) renderSold(); }, 150);
		}).observe(soldBodyEl);
	}

	//--- init

	const retryLoad = async () => {
		state.fatal = null;
		state.cfg = null;
		data.fatalMsg = null;
		data.computeError = null;
		render();
		await init();
	};

	// Where a sign-in came back from: ?linked=<id>, or ?ssoError=<stage> with ?ssoReason=<code>, read once at
	// boot (results-shared drops the query from the address). The error is in the banners from the first
	// paint; its text learns the data directory when the config arrives. "Linked ..." waits for the characters.
	let ssoNotice = null;
	let linkedId = null;
	const readSignIn = () => {
		const result = resultsShared.readSsoResult();
		ssoNotice = result.notice;
		linkedId = result.linkedId;
		if (ssoNotice) notices.push(ssoNotice);
	};

	const init = async () => {
		try {
			state.cfg = await api('/api/config');
		} catch (e) {
			shared.loadFatal(e);
			render();
			return;
		}
		if (ssoNotice) resultsShared.fillSsoNotice(ssoNotice, state.cfg.env && state.cfg.env.dataDir);
		render();
		if (!state.cfg.configured) return;
		await shared.reloadData();
		if (linkedId !== null && !state.fatal) {
			notices.push({ kind: 'info', text: `Linked ${charName(linkedId)}. Its history is being synced now.` });
			linkedId = null;
			renderBanners();
		}
		if (state.fatal || !state.characters || state.characters.length === 0) { render(); return; }
		await loadOrdersData();
		const w = data.watch;
		const finished = w && w.finishedAt ? Date.parse(w.finishedAt) : null;
		if (finished !== null && Date.now() - finished < REFRESH_MS && !w.running) await tick({ skipWatch: true, nextFrom: finished });
		else await tick();
	};

	readSignIn();
	winSegEl.replaceChildren(...WINDOWS.map(w => el('button', { type: 'button', 'data-win': w.key, 'aria-pressed': 'false', text: w.label })));
	syncThresholdInputs();
	renderRefresh();
	render();
	init();

	// The countdown, the ages and the automatic refresh run off one clock.
	setInterval(() => {
		if (!isLive()) return;
		renderStatusLine();
		if (refreshOpen && !ticking && nextAt !== null && Date.now() >= nextAt) tick();
	}, 1000);
	// Relative times and the verdicts' clock move on without a read; not while a mark or a figure has focus.
	setInterval(() => {
		if (!isLive() || ticking || document.hidden || !snapEl.hidden) return; // nor under an open snapshot panel
		const a = document.activeElement;
		if (a && (tbodyEl.contains(a) || soldBodyEl.contains(a) || soldTableEl.contains(a))) return;
		recompute();
		renderChips();
		renderOpen();
		renderSold();
	}, REDRAW_MS);
})();
