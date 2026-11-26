// export.js: pipeline (runReport) + page UI for export.html.
// Every displayed number comes from ESI (station orders + region history) via estimate.js, blended where
// the server's book log covers the window with what that log observed (POST /api/market-stats; the log is
// ESI data the server stored). Fuzzwork aggregates are used ONLY for triage (deciding which types get a full report).
const {
	roundNonZero,
	constants: {
		JITA_REGION_ID,
		AMARR_REGION_ID,
		DODIXIE_REGION_ID,
		RENS_REGION_ID,
		STACMON_REGION_ID,

		JITA_STATION_ID,
		AMARR_STATION_ID,
		DODIXIE_STATION_ID,
		RENS_STATION_ID,
		STACMON_STATION_ID,

		SELL_TAX,
		SALES_TAX,
		BROKER_FEE
	}
} = util;

const STATIONS = {
	Jita: { regionId: JITA_REGION_ID, stationId: JITA_STATION_ID },
	Amarr: { regionId: AMARR_REGION_ID, stationId: AMARR_STATION_ID },
	Dodixie: { regionId: DODIXIE_REGION_ID, stationId: DODIXIE_STATION_ID },
	Rens: { regionId: RENS_REGION_ID, stationId: RENS_STATION_ID },
	Stacmon: { regionId: STACMON_REGION_ID, stationId: STACMON_STATION_ID }
};

const DAYS_CONSIDERED = 30;
const DEFAULT_DAYS_TO_COMPLETE = 5; // the page's "days to clear" input overrides it per run
const HAULING_REWARD_FRACTION = 0.10;
const COST_LIMIT = 10 * Math.pow(10, 9);
const DEFAULT_MIN_ROI = 1.5; // the page's "min ROI" input overrides it per run
// The destination history the estimator can read: the longer of its ordinary-price window and its
// demand window plus the recent-price lead-in. A saved run keeps that much (exportPersist.marketContext).
const CONTEXT_HISTORY_DAYS = Math.max(estimate.defaultConfig.ORDINARY_PRICE_DAYS, DAYS_CONSIDERED + estimate.defaultConfig.RECENT_THRESHOLD_DAYS);

const ignoreOneActiveSellerForTypeIds = [
	//Max
	// 31484, //Small Energy Locus Coordinator II (31484)
	// 56066, //Glorification-5 'Devana' Filament (56066) 
	// 18797, //Coreli A-Type Thermal Coating (18797)
	// 61203, //Common Moon Mining Crystal Type B II (61203)
	// 28282, //'Integrated' Infiltrator (28282)
	// 19229, //Pithum A-Type Kinetic Shield Amplifier (19229)

	//Taymor
	// 49099, //Zero-Point Mass Entangler (49099)
	// 34306, //Large Higgs Anchor I (34306)
	// 12221, //Medium Remote Capacitor Transmitter II (12221)
	// 34290, //Polarized Rocket Launcher (34290)
	// 34278, // Polarized Light Neutron Blaster (34278)
];

// Seeds the stocked-items box the first time the page is opened (list from master3, 2026-11-06).
// After that the box is the source of truth; this list is not consulted again.
const DEFAULT_ALWAYS_SHOW_NAMES = [
	'Blood Brass Tag',
	'Capital Compact Pb-Acid Cap Battery',
	'Corelum A-Type Kinetic Energized Membrane',
	'Corelum B-Type Thermal Energized Membrane',
	'Decayed Damage Control Mutaplasmid',
	'Information Command Burst I',
	'Ladar Sensor Cluster',
	'Large Polycarbon Engine Housing II',
	'Noctis Refined Resourcer SKIN',
	'Reaction-Orienting Neurolink Stabilizer',
	'Republic Fleet Rocket Launcher',
	'Standup Flak Round I',
	'Standup M-Set Energy Neutralizer Economy I',
	'Standup Radar ECM Script',
];

const isAbort = (e) => !!e && e.name === 'AbortError';

//--- observed figures

// The window the observed figures cover: max(days to clear, 3) days, and no more than the 60 the route takes.
const STATS_MIN_WINDOW_DAYS = 3;
const STATS_MAX_WINDOW_DAYS = 60;
const STATS_FLUSH_MS = 250;
const STATS_MAX_BATCH = 500; // types a call to /api/market-stats takes
const statsWindowDays = (daysToComplete) => Math.min(STATS_MAX_WINDOW_DAYS, Math.max(daysToComplete, STATS_MIN_WINDOW_DAYS));

// Fetches the observed figures (public/market-stats.js, served by POST /api/market-stats) of types at one
// destination station, batched: get(typeId, ordersPerDay) queues the type and resolves with its answer (the
// object computeMarketStats returns) or null (no book log for it, or no observation); the queue is sent as one
// request 250 ms after its first type, or at once at 500 types. A type asked for twice while queued shares one
// entry. It never rejects. When the route answers anything but 200 (503: SSO is not set up) or the request
// fails, every queued and later type resolves null, one line is logged and the route is not called again;
// an aborted signal resolves everything null quietly. Made once per run, and once per live refresh or
// lookup, so a route that was down is tried again by the next one.
const createStatsFetcher = ({ regionId, stationId, windowDays, signal = null, log = console }) => {
	let queue = new Map(); // typeId -> {typeId, ordersPerDay, resolvers}
	let timer = null;
	let unavailable = false;
	const isAborted = () => !!signal && signal.aborted;

	const settle = (entries, types) => {
		for (const entry of entries) {
			const answer = types ? types[entry.typeId] : null;
			const value = answer === undefined ? null : answer;
			for (const resolve of entry.resolvers) resolve(value);
		}
	};
	const takeQueue = () => {
		clearTimeout(timer);
		timer = null;
		const entries = [...queue.values()];
		queue = new Map();
		return entries;
	};
	const giveUp = (reason) => {
		if (unavailable) return;
		unavailable = true;
		log.warn(`market stats unavailable (${reason}): observed figures off for this run`);
	};

	const flush = async () => {
		const batch = takeQueue();
		if (batch.length === 0) return;
		if (unavailable || isAborted()) { settle(batch, null); return; }
		try {
			const response = await fetch('/api/market-stats', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ regionId, stationId, windowDays, types: batch.map(({ typeId, ordersPerDay }) => ({ typeId, ordersPerDay })) }),
				signal
			});
			if (!response.ok) {
				giveUp(response.status);
				settle(batch, null);
				return;
			}
			const answer = await response.json();
			settle(batch, answer && answer.types && typeof answer.types === 'object' ? answer.types : null);
		} catch (e) {
			if (!isAbort(e) && !isAborted()) giveUp('request failed');
			settle(batch, null);
		}
	};

	const get = (typeId, ordersPerDay) => {
		if (unavailable || isAborted()) return Promise.resolve(null);
		return new Promise((resolve) => {
			let entry = queue.get(typeId);
			if (!entry) queue.set(typeId, entry = { typeId, ordersPerDay, resolvers: [] });
			entry.resolvers.push(resolve);
			if (queue.size >= STATS_MAX_BATCH) flush();
			else if (timer === null) timer = setTimeout(flush, STATS_FLUSH_MS);
		});
	};

	if (signal) signal.addEventListener('abort', () => settle(takeQueue(), null), { once: true });
	return { get, flush };
};

//--- pipeline

// Runs one report. Calls onRow({typeId, name, m3, report, isAlwaysShow, daysToComplete, inputs}) for every report (filtered ones too).
// Calls onProgress at least every 500ms.
// Loads both regions' order books once (a few hundred paginated requests instead of two per type:
// ESI's market-order rate limit counts requests) and indexes them by type, station-filtered.
// Resolves {src: Map typeId -> sell orders at the start station, dest: Map typeId -> all orders at
// the end station}. onProgress(done, total) reports pages fetched.
const loadBooks = async ({ start, end, options = {}, onProgress = () => {} }) => {
	const counts = [{ done: 0, total: null }, { done: 0, total: null }];
	const report = () => onProgress(
		counts[0].done + counts[1].done,
		counts[0].total === null || counts[1].total === null ? null : counts[0].total + counts[1].total
	);
	const onPage = (i) => (done, total) => { counts[i] = { done, total }; report(); };
	// Own queue, so the pages are not stuck behind the triage requests already queued; ESI's
	// market-order limit (~13/s per IP) is the real pace.
	const bookOptions = { ...options, queue: options.queue || util.createQueue({ concurrency: 12 }) };
	const [srcAll, destAll] = await Promise.all([
		util.getRegionOrders(start.regionId, 'sell', 0.5, bookOptions, onPage(0)),
		util.getRegionOrders(end.regionId, 'all', 0.5, bookOptions, onPage(1))
	]);
	const index = (orders, stationId) => {
		const byType = new Map();
		for (const order of orders) {
			if (order.location_id !== stationId) continue;
			let list = byType.get(order.type_id);
			if (!list) byType.set(order.type_id, list = []);
			list.push(order);
		}
		return byType;
	};
	return { src: index(srcAll, start.stationId), dest: index(destAll, end.stationId) };
};

// The estimate's config for one row (the page re-estimates a row with the same config for another quantity).
const reportConfig = ({ typeId, isAlwaysShow, daysToComplete, minRoi }) => ({
	DAYS_CONSIDERED,
	DAYS_TO_COMPLETE: daysToComplete,
	HAULING_REWARD_FRACTION,
	COST_LIMIT,
	MIN_ROI: minRoi,
	SELL_TAX,
	isAlwaysShow,
	ignoreOneActiveSeller: ignoreOneActiveSellerForTypeIds.includes(typeId)
});

// Fetches the ESI data for one type and computes its report.
// Resolves {typeId, name, m3, report, isAlwaysShow, context, daysToComplete, minRoi, inputs}; report is null when there is nothing to buy.
// context is what the estimator was given (top of each order book, destination history), kept so
// Copy orders can save it with the run. inputs (the orders, history and clock the report was computed from)
// let the page re-estimate the row for another quantity without a request. The order arrays may be shared
// with the in-memory books: the estimate copies before mutating, so that is fine.
// options ({signal, queue}) is passed through to util so callers can use their own request queue.
// With `books` (from loadBooks) the orders come from memory; otherwise one request per station.
// daysToComplete: the horizon the recommended quantity covers (days of demand minus competing stock).
// minRoi: the ROI floor the walk stops at (a source order that returns less is not bought).
// stats: a stats fetcher (createStatsFetcher) for the end station, or null for a row without observed figures.
// With it the type's observed figures are fetched once the history is in (its pace sets how close two book-log
// samples must be to count), passed to the estimate, and kept in inputs with the pace so a re-estimate for
// another quantity blends the same way.
const buildRow = async ({ start, end, typeId, isAlwaysShow, books = null, options = {}, daysToComplete = DEFAULT_DAYS_TO_COMPLETE, minRoi = DEFAULT_MIN_ROI, stats = null }) => {
	// 'all' returns buy and sell orders in one request; the estimate uses dest buy orders to spot buy-fill days.
	const srcOrders = books
		? (books.src.get(typeId) || [])
		: (await util.getOrders(start.regionId, typeId, 'all', 0.5, options)).filter(o => o.location_id === start.stationId);
	const destOrders = books
		? (books.dest.get(typeId) || [])
		: (await util.getOrders(end.regionId, typeId, 'all', 0.5, options)).filter(o => o.location_id === end.stationId);
	const destDays = await util.getDays(end.regionId, typeId, options);
	const m3 = await util.getTypeM3(typeId, options);
	const name = await util.getTypeName(typeId, options);
	const now = new Date();
	const ordersPerDay = estimate.typicalOrdersPerDay(destDays, now);
	const observed = stats ? await stats.get(typeId, ordersPerDay) : null;
	const report = estimate.computeItemReport({
		srcOrders,
		destOrders,
		destDays,
		typeId,
		now,
		observed,
		config: reportConfig({ typeId, isAlwaysShow, daysToComplete, minRoi })
	});
	const context = report ? exportPersist.marketContext({ srcOrders, destOrders, destDays, now, historyDays: CONTEXT_HISTORY_DAYS }) : null;
	return { typeId, name, m3, report, isAlwaysShow, context, daysToComplete, minRoi, inputs: { srcOrders, destOrders, destDays, now, observed, ordersPerDay } };
};

// Resolves item names to type ids. Resolves {ids: Set, unresolved: [names]}.
const resolveTypeNames = async (names, options = {}) => {
	const ids = new Set();
	const unresolved = [];
	const results = await Promise.all(names.map(name => util.getTypeIdByName(name, options).catch(e => { if (isAbort(e)) throw e; return null; })));
	results.forEach((typeId, i) => {
		if (typeId === null || typeId === undefined) unresolved.push(names[i]);
		else ids.add(typeId);
	});
	return { ids, unresolved };
};

// alwaysShowIds: already-resolved type ids to report regardless of triage/filters. isAlwaysShow(typeId) is
// consulted when each report is built, so the caller may change the set while the run is going.
// minRoi: the ROI floor of this run: triage skips items whose Fuzzwork margin is below it, and each walk stops there.
const runReport = async ({ startStationKey, endStationKey, alwaysShowIds = new Set(), isAlwaysShow = (id) => alwaysShowIds.has(id), daysToComplete = DEFAULT_DAYS_TO_COMPLETE, minRoi = DEFAULT_MIN_ROI, signal, onRow = () => {}, onProgress = () => {}, onBooks = () => {} }) => {
	const start = STATIONS[startStationKey];
	const end = STATIONS[endStationKey];
	if (!start || !end) throw new Error(`unknown station (${startStationKey} -> ${endStationKey})`);

	const startedAt = Date.now();
	const progress = {
		typesTotal: 0,
		triaged: 0,
		triagePassed: 0,
		reportsDone: 0,
		reportsFailed: 0,
		rowsShown: 0,
		rowsFiltered: 0,
		noReport: 0,
		books: { done: 0, total: null, loaded: false },
		phase: 'typeIds'
	};
	const emit = () => onProgress({
		...progress,
		queue: util.queueStats(),
		elapsedMs: Date.now() - startedAt
	});
	const timer = setInterval(emit, 250);
	const aborted = () => !!(signal && signal.aborted);

	util.setAbortSignal(signal);
	try {
		emit();
		// One fetcher for the run: every report task asks it for its type's observed figures once its history is in,
		// and it sends them to the server in batches (the end station's region and station, the run's window).
		const stats = createStatsFetcher({ regionId: end.regionId, stationId: end.stationId, windowDays: statsWindowDays(daysToComplete), signal });
		// Order books load alongside the type list and triage; report tasks wait for them.
		const booksPromise = loadBooks({
			start,
			end,
			onProgress: (done, total) => { progress.books.done = done; progress.books.total = total; }
		}).then(books => {
			progress.books.loaded = true;
			onBooks(books);
			return books;
		});
		booksPromise.catch(() => {}); // surfaced where awaited
		const typeIds = (await util.getTypeIds(end.regionId)).slice();

		const alwaysShowIdSet = new Set(alwaysShowIds);
		for (const typeId of alwaysShowIdSet) {
			if (!typeIds.includes(typeId)) typeIds.push(typeId);
		}

		progress.typesTotal = typeIds.length;
		progress.phase = 'running';
		emit();

		// The util queue is FIFO, so starting thousands of report tasks at once would run every task's
		// first request before any task's second one and rows would only appear at the very end.
		// Cap the number of report tasks in progress so rows stream in steadily.
		const MAX_ACTIVE_REPORTS = 40;
		let activeReports = 0;
		const waiting = [];
		const reportPromises = [];
		const acquire = () => {
			if (activeReports < MAX_ACTIVE_REPORTS) { activeReports++; return Promise.resolve(); }
			return new Promise(resolve => waiting.push(resolve));
		};
		const release = () => {
			const next = waiting.shift();
			if (next) next(); else activeReports--;
		};
		const startReport = (typeId) => {
			if (aborted()) return;
			const task = (async () => {
				await acquire();
				try {
					if (aborted()) return;
					const books = await booksPromise;
					if (aborted()) return;
					const row = await buildRow({ start, end, typeId, isAlwaysShow: isAlwaysShow(typeId), books, daysToComplete, minRoi, stats });
					if (aborted()) return; // (a stopped run's stats answer null: no row without its observed figures)
					progress.reportsDone++;
					if (!row.report) {
						progress.noReport++;
						return;
					}
					if (row.report.filteredReason) progress.rowsFiltered++;
					else progress.rowsShown++;
					onRow(row);
				} catch (e) {
					if (isAbort(e)) return;
					console.error(`report failed (typeId: ${typeId})`, e);
					progress.reportsFailed++;
				} finally {
					release();
				}
			})();
			reportPromises.push(task);
		};

		// Always-show types skip triage.
		for (const typeId of alwaysShowIdSet) {
			progress.triaged++;
			progress.triagePassed++;
			startReport(typeId);
		}

		// Triage chunks of 25, all kicked off at once (the util queue caps concurrency).
		const chunks = [];
		const triageIds = typeIds.filter(id => !alwaysShowIdSet.has(id));
		for (let i = 0; i < triageIds.length; i += 25) chunks.push(triageIds.slice(i, i + 25));

		await Promise.all(chunks.map(async (chunk) => {
			try {
				const [srcFuzzByTypeId, destFuzzByTypeId] = await Promise.all([
					util.getFuzzworkPricesInRegion(start.regionId, chunk),
					util.getFuzzworkPricesInRegion(end.regionId, chunk)
				]);
				for (const typeId of chunk) {
					if (aborted()) break;
					progress.triaged++;
					const srcFuzzPrice = +(srcFuzzByTypeId?.[typeId]?.sell?.min ?? 0);
					const destFuzzPrice = +(destFuzzByTypeId?.[typeId]?.sell?.min ?? 0);
					if (!srcFuzzPrice || !destFuzzPrice) {
						console.warn(`${typeId} fuzz no price (src: ${srcFuzzPrice}, dest: ${destFuzzPrice})`);
						continue;
					}
					if (destFuzzPrice < srcFuzzPrice) {
						console.log(`${typeId} fuzz negative spread (src: ${util.roundMils(srcFuzzPrice)}, dest: ${util.roundMils(destFuzzPrice)})`);
						continue;
					}
					if (destFuzzPrice < srcFuzzPrice * minRoi) {
						// Fuzz margin too slim
						console.log(`${typeId} fuzz margin too slim (${Math.round(100 * destFuzzPrice / srcFuzzPrice) / 100}x)`);
						continue;
					}
					console.log(`${typeId} fuzz margin ok (${Math.round(100 * destFuzzPrice / srcFuzzPrice) / 100}x)`);
					progress.triagePassed++;
					startReport(typeId);
				}
			} catch (e) {
				if (isAbort(e)) return;
				console.error('triage chunk failed', e);
				progress.triaged += chunk.length;
			}
		}));

		await Promise.all(reportPromises);
		progress.phase = aborted() ? 'stopped' : 'done';
	} catch (e) {
		if (isAbort(e) || aborted()) progress.phase = 'stopped';
		else {
			console.error('runReport failed', e);
			progress.phase = 'error';
		}
	} finally {
		clearInterval(timer);
		util.setAbortSignal(null);
		emit();
	}
};

//--- UI

(() => {
	if (typeof document === 'undefined') return;

	const $ = (sel) => document.querySelector(sel);
	const nf = new Intl.NumberFormat('en-US');
	const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

	//--- localStorage (guarded)
	const PREFIX = 'eflip.export.';
	const lsGet = (key, fallback) => {
		try {
			const raw = localStorage.getItem(PREFIX + key);
			return raw === null ? fallback : JSON.parse(raw);
		} catch (e) { return fallback; }
	};
	const lsSet = (key, val) => {
		try { localStorage.setItem(PREFIX + key, JSON.stringify(val)); } catch (e) { /* ignore */ }
	};

	//--- elements
	const startSel = $('#startStation');
	const endSel = $('#endStation');
	const runBtn = $('#run');
	const stopBtn = $('#stop');
	const autoRunChk = $('#autoRun');
	const globalFactorInput = $('#globalFactor');
	const daysToClearInput = $('#daysToClear');
	const minRoiInput = $('#minRoi');
	const showFilteredChk = $('#showFiltered');
	const searchInput = $('#search');
	const searchNote = $('#searchNote');
	const copyBtn = $('#copy');
	const progressElem = $('#progress');
	const headerElem = $('#reportHeader');
	const tableElem = $('#table');
	const theadElem = $('#table thead');
	const tbodyElem = $('#table tbody');
	const sumsElem = $('#sums');
	const totalsElem = $('#totals');
	const alwaysShowText = $('#alwaysShowText');
	const alwaysShowNote = $('#alwaysShowNote');

	// The totals strip is sticky at the top; the table header sticks just below it.
	const updateStickyOffset = () => {
		document.documentElement.style.setProperty('--sticky-offset', totalsElem.offsetHeight + 'px');
		document.documentElement.style.setProperty('--head-h', $('#sortRow').offsetHeight + 'px');
	};
	if (typeof ResizeObserver !== 'undefined') {
		const ro = new ResizeObserver(updateStickyOffset);
		ro.observe(totalsElem);
		ro.observe($('#sortRow'));
	}
	updateStickyOffset();

	const stationNames = Object.keys(STATIONS);
	for (const sel of [startSel, endSel]) {
		for (const name of stationNames) sel.add(new Option(name, name));
	}
	const savedRoute = lsGet('route', { start: 'Jita', end: 'Amarr' });
	startSel.value = STATIONS[savedRoute.start] ? savedRoute.start : 'Jita';
	endSel.value = STATIONS[savedRoute.end] ? savedRoute.end : 'Amarr';
	if (startSel.value === endSel.value) endSel.value = startSel.value === 'Amarr' ? 'Jita' : 'Amarr';

	//--- state
	let routeKey = '';
	let rows = [];            // all rows of the current run
	let rowByTypeId = new Map();
	let selected = new Set(); // type ids (current route)
	let factorOverrides = {}; // typeId -> factor (current route)
	let globalFactor = +lsGet('globalFactor', 1);
	if (!(globalFactor >= 0)) globalFactor = 1;
	// "days to clear": an integer >= 1. daysToClear is the input's last valid value; runDaysToComplete is
	// the horizon every row in the table shares (live always-show edits and search lookups included).
	// Run reads it once, so changing the input mid-run applies to the next Run. Without a run's rows
	// (none yet, or the route changed since) it follows the input while the table is empty, so rows
	// a search fetched before any run never disagree with it.
	const parseDaysToClear = (v) => {
		const d = Number(v);
		return Number.isInteger(d) && d >= 1 ? d : null;
	};
	let daysToClear = parseDaysToClear(lsGet('daysToClear', DEFAULT_DAYS_TO_COMPLETE)) ?? DEFAULT_DAYS_TO_COMPLETE;
	let runDaysToComplete = daysToClear;
	let horizonFromRun = false;
	// "min ROI": a number >= 1, the ROI floor of triage and of the book walk. It mirrors days to clear: minRoi is
	// the input's last valid value, runMinRoi the floor every row in the table shares (read once by Run, and
	// following the input only while the table holds no run's rows).
	const parseMinRoi = (v) => {
		const d = Number(v);
		return Number.isFinite(d) && d >= 1 ? d : null;
	};
	let minRoi = parseMinRoi(lsGet('minRoi', DEFAULT_MIN_ROI)) ?? DEFAULT_MIN_ROI;
	let runMinRoi = minRoi;
	let sort = lsGet('sort', { key: 'dailyProfitMil', dir: 'desc' });
	let showFiltered = !!lsGet('showFiltered', false);
	let pendingRender = false;
	let renderTimer = null;
	let lastRenderAt = 0;
	let currentRun = null; // {controller}
	let currentBooks = null; // order books from the latest run (used by live always-show edits)
	let reportGeneratedAt = null;
	let reportGeneratedAtIso = null; // when the table's report was generated; saved with a copied run, null after a route change until set again
	let searchGen = 0; // bumped when the query changes or the table is cleared; a lookup that sees it move drops its result
	let searchNoteIsMiss = false; // the note says "no item named …"
	const setSearchNote = (text, isMiss = false) => {
		searchNote.textContent = text;
		searchNoteIsMiss = isMiss;
	};

	const route = () => `${startSel.value}-${endSel.value}`;
	const loadRouteState = () => {
		routeKey = route();
		selected = new Set(lsGet(`selected.${routeKey}`, []));
		factorOverrides = lsGet(`factors.${routeKey}`, {});
	};
	const saveSelected = () => lsSet(`selected.${routeKey}`, [...selected]);
	const saveFactors = () => lsSet(`factors.${routeKey}`, factorOverrides);

	//--- columns
	const fmtNum = (v) => v === null || v === undefined ? '' : nf.format(v);
	const fmtMil = (v) => v === null || v === undefined ? '' : String(v);
	const fmtRoi = (v) => v === null || v === undefined ? '' : nf2.format(v);
	const num = (v) => v === null || v === undefined ? null : +v;

	// quantity = what the Copy button writes: the report's volume, i.e. the recommendation at factor 1, else the
	// units the re-estimate bought toward ceil(recommended × factor)
	const orderQty = (row) => row.report.volume;
	// The row's report is the estimate for its quantity. At factor 1 that is the recommendation itself (row.base);
	// otherwise the estimate is re-run with ceil(recommended × factor) as the target, bought for real up the
	// source book (past the ROI floor; the spend cap still applies), from the same orders, history and clock as
	// the recommendation, so only the quantity differs. The filtered state stays the recommendation's, and the
	// column filters hide a row by its recommendation's figures (baseView), so a factor never hides a row. No request is made: the inputs are kept on the row. A recommendation of 0 (no unit to
	// floor to: an empty source book, no sell price) stays 0 at any factor, so it keeps the recommendation (and its
	// real stop reason); a floored recommendation of 1 unit scales from that 1.
	const reportForFactor = (row) => {
		if (row.factor === 1 || !row.inputs || row.base.volume === 0) return row.base;
		const target = Math.ceil(row.base.volume * row.factor);
		const report = estimate.computeItemReport({
			...row.inputs,
			typeId: row.typeId,
			targetVolume: target,
			config: reportConfig({ typeId: row.typeId, isAlwaysShow: row.isAlwaysShow, daysToComplete: row.daysToComplete, minRoi: row.minRoi })
		});
		if (!report) return row.base;
		report.filteredReason = row.base.filteredReason;
		return report;
	};
	// Order totals, in millions. Revenue is net of sales tax and the broker (listing) fee; cost is
	// buy price plus hauling. revenue − cost = quantity × profit/item, the same as the per-item figures.
	const sellPriceOf = (row) => row.report.sellPriceMil ?? (row.report.revenuePerItemMil / (1 - SELL_TAX));
	const orderCost = (row) => row.report.costPerItemMil * orderQty(row);
	const orderRevenue = (row) => row.report.revenuePerItemMil * orderQty(row);
	const orderProfit = (row) => orderRevenue(row) - orderCost(row);
	const fmtTotal = (v) => v === null || v === undefined ? '' : roundNonZero(Math.round(v * 1000) / 1000, 3);
	const km3Of = (row) => Math.ceil(orderQty(row) * (row.m3 || 0)) / 1000;

	// text: left aligned, sorts ascending first ; sort: custom sort value ; val/fmt: displayed number
	// Tooltip text. `help` is the column definition (on the header); `tip(row)` is the per-cell working.
	const cfg = estimate.defaultConfig;
	const pct = (f) => (Math.round(f * 1000) / 10) + '%';
	const mil = (v) => v === null || v === undefined ? '?' : `${v}M`;
	const SUPPLY_BAND_TXT = `within ${pct(cfg.SUPPLY_BAND)} above the sell price`;
	// What bound the recommended quantity (the factor-1 report `base`): the demand cap and the limit that cut it.
	const recommendedClause = (base, minRoi) => {
		const head = `Demand cap ${nf.format(base.horizonVolume)} (${base.dailyDemand}/day × ${runDaysToComplete} days − ${nf.format(base.competingVolume)} competing)`;
		// a floored base recommends nothing: its 1 unit is there so the figures are real
		if (base.floored) {
			const shown = 'shown for 1 unit so the figures are real';
			return base.stopReason === 'roi'
				? `${head}; cut to 0 by the ROI floor: the cheapest source order (${mil(base.stopPriceMil)}) returns ${base.stopRoi}x, below ${minRoi}x; ${shown}`
				: `${head}: nothing to buy; ${shown}`;
		}
		switch (base.stopReason) {
			case 'horizon': return `${head} sets the recommended quantity`;
			case 'roi': return `${head}; cut to ${nf.format(base.volume)} by the ROI floor: the next source order (${mil(base.stopPriceMil)}) returns ${base.stopRoi}x, below ${minRoi}x`;
			case 'book': return `${head}; cut to ${nf.format(base.volume)}: the source station lists no more units`;
			case 'cost': return `${head}; cut to ${nf.format(base.volume)} by the ${COST_LIMIT / 1e9}B spend cap`;
			default: return head;
		}
	};
	// Why a cell is red for a limit of the estimate (limitBreaches names the columns): appended to the cell's
	// tooltip. A function takes the row. A cell outside its column's min/max says so itself (colFilterBreaches).
	const BREACH_TEXT = {
		rivals: 'too much competition',
		daysToClear: (row) => `beyond the ${row.daysToComplete}-day horizon`
	};
	// Observed figures (the book log's, blended into the estimate by covered time; estimate.js, public/market-stats.js).
	// observedGap: "events gap 3 h" / "volume gap 24 h" from the coverage the report carries.
	const observedGap = (report, part) => {
		const hours = report.observedCoverage && report.observedCoverage[part] ? report.observedCoverage[part].gapHours : null;
		return hours === null || hours === undefined ? '' : ` (${part} gap ${nf2.format(hours)} h)`;
	};
	const orQ = (v, unit = '') => v === null || v === undefined ? '?' : `${nf2.format(v)}${unit}`;
	// What a cell blended with observation says beside its own tooltip, or null when none of it was observed.
	const rivalsMark = (r) => r.report.observedFractionEvents > 0
		? `observed f=${r.report.observedFractionEvents.toFixed(2)}${observedGap(r.report, 'events')}: ${orQ(r.report.rivalsObserved)} observed · ${orQ(r.report.rivalsModel)} model`
		: null;
	const demandMark = (r) => r.report.observedFractionVolume > 0
		? `demand observed f=${r.report.observedFractionVolume.toFixed(2)}${observedGap(r.report, 'volume')}: ${orQ(r.report.dailyDemandObserved, '/day')} observed · ${orQ(r.report.dailyDemandModel, '/day')} model`
		: null;
	// "observed 2.6 of 3 days (events gap 3 h, 61 samples, median gap 1 h)": what the observed figures stand on
	const coverageWords = (r) => {
		const cov = r.report.observedCoverage;
		if (!cov) return 'no observation';
		const events = cov.events || {};
		const parts = [];
		if (events.gapHours !== null && events.gapHours !== undefined) parts.push(`events gap ${nf2.format(events.gapHours)} h`);
		parts.push(`${nf.format(cov.samples)} sample${cov.samples === 1 ? '' : 's'}`);
		if (cov.medianGapHours !== null && cov.medianGapHours !== undefined) parts.push(`median gap ${nf2.format(cov.medianGapHours)} h`);
		return `observed ${orQ(events.coveredDays)} of ${nf2.format(cov.windowDays)} days (${parts.join(', ')})`;
	};
	const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
	// "+12", "-3.4": signed, one decimal at most, no minus zero
	const signed1 = (v) => {
		const r = Math.round(v * 10) / 10;
		return r > 0 ? `+${nf1.format(r)}` : nf1.format(r === 0 ? 0 : r);
	};
	const BLENDED_HELP = 'Blended with what the book log observed when it covers part of the window; dotted underline marks it, the tooltip shows both figures';
	// `help` is a string, or a function for text that depends on the run (read on every header render).
	// `display(row)` replaces fmt(val(row)) as the cell's text where the number alone is not enough (avg days idle
	// reads "≥ 1.5" for a censored value); sorting and the column filters still use val. `mark(row)` is the cell's
	// observed-figure sentence (null when nothing was observed): it adds the dotted underline and ends the tooltip.
	const COLUMNS = [
		{ key: 'select', label: '', sort: (r) => selected.has(r.typeId) ? 1 : 0, help: 'checked rows are always shown, summed in the totals and included in Copy orders. Greyed rows are stocked items.' },
		{ key: 'name', label: 'name', sort: (r) => r.name.toLowerCase(), text: true, help: 'dim rows were filtered out; hover the name for the reason' },
		{ key: 'dailyProfitMil', label: 'daily profit', val: (r) => num(r.report.dailyProfitMil), fmt: fmtMil,
			help: `profit on the quantity ÷ max(days to clear, 1), in millions. Red when outside the column's min/max (the default min is the old filter limit, 1M/day). ${BLENDED_HELP}`,
			tip: (r) => `${mil(r.report.profitPerItemMil)} profit/item × ${nf.format(orderQty(r))} = ${mil(Math.round(r.report.profitPerItemMil * r.report.volume * 100) / 100)}, over max(${r.report.daysToClear ?? '?'} days to clear, 1)`,
			mark: demandMark },
		{ key: 'roi', label: 'ROI', val: (r) => num(r.report.roi), fmt: fmtRoi,
			help: () => `revenue/item ÷ cost/item for the quantity. The recommendation stops at the min ROI (${runMinRoi}x), so only a factor above 1 or a 1-unit 'nothing to buy' row goes below it. Red when outside the column's min/max (its min starts at the min ROI and follows that input until you set your own)`,
			tip: (r) => `${mil(r.report.revenuePerItemMil)} ÷ ${mil(r.report.costPerItemMil)}` },
		{ key: 'factor', label: 'factor', val: (r) => r.factor, help: 'multiplier on the recommended quantity. The row is re-estimated for ceil(recommended × factor), bought for real up the source book. Clear a row\'s factor to follow the global factor again' },
		{ key: 'qty', label: 'quantity', val: orderQty, fmt: fmtNum,
			help: () => `recommended × factor, bought for real up the source book, so cost/item, ROI, the order totals, days to clear and daily profit are for this quantity. Recommended = ${runDaysToComplete} days of demand minus competing stock (within ${pct(cfg.COMPETE_BAND)} above the sell price in full, dearer stock by its seller's rival weight), bought while each order still clears ${runMinRoi}x ROI; a factor above 1 buys past that floor. The cell tooltip names the limit that bound. When nothing is worth buying the row shows 1 unit so its figures are real, filtered as 'nothing to buy'`,
			tip: (r) => {
				const base = r.base || r.report;
				const baseWord = base.floored ? 'shown' : 'recommended'; // a floored base recommends nothing
				if (r.report === base) return `${nf.format(base.volume)} ${baseWord} × factor ${r.factor}. ${recommendedClause(base, r.minRoi)}`;
				const target = Math.ceil(base.volume * r.factor);
				const bought = r.report.volume;
				const outcome = bought >= target
					? ', bought for real up the source book'
					: r.report.stopReason === 'cost'
						? `; only ${nf.format(bought)} bought: the ${COST_LIMIT / 1e9}B spend cap`
						: `; only ${nf.format(bought)} bought: the source station lists no more units`;
				return `${nf.format(target)} = ${nf.format(base.volume)} ${baseWord} × factor ${r.factor}${outcome}. Recommended: ${recommendedClause(base, r.minRoi)}`;
			} },
		{ key: 'daysOfSupply', label: 'days of supply left', val: (r) => num(r.report.daysOfSupply), fmt: fmtRoi,
			help: `units listed at the destination ${SUPPLY_BAND_TXT} ÷ demand per day: how long until the cheap stock is gone and the price steps up`,
			tip: (r) => `${nf.format(r.report.supplyVolume)} units listed ${SUPPLY_BAND_TXT} (${mil(r.report.sellPriceMil)}) ÷ ${r.report.dailyDemand}/day`
				+ (r.report.stockTrendPerDay === null || r.report.stockTrendPerDay === undefined ? '' : `; stock trend ${signed1(r.report.stockTrendPerDay)}/day`) },
		{ key: 'activeSellers', label: 'active sellers', val: (r) => num(r.report.activeSellers), fmt: fmtNum,
			help: 'destination sell orders at any price that were placed or changed within 24h of the newest one; empty when the station has no sell orders. Rivals weights these by price and recency',
			tip: (r) => `${nf.format(r.report.destSellOrderCount)} sell orders at the station, cheapest ${mil(r.report.destBestSellPriceMil)}; ${r.report.activeSellers ?? 0} active; best buy order ${mil(r.report.destBestBuyPriceMil)}` },
		{ key: 'rivals', label: 'rivals', val: (r) => num(r.report.rivals), fmt: fmtRoi,
			help: `expected number of sellers who will undercut you: every sell order at the station counts its chance = ${cfg.RIVAL_RECENCY_DECAY} per idle day since it was touched × 1 within ${pct(cfg.SUPPLY_BAND)} above the sell price, falling as 1/multiple² beyond that. Drives the "too much competition" filter and weights out-of-band stock in competing volume. Red when there is too much competition. ${BLENDED_HELP}`,
			tip: (r) => `${r.report.rivals ?? '?'} expected rivals among ${nf.format(r.report.destSellOrderCount)} sell orders (sell price ${mil(r.report.sellPriceMil)})`,
			mark: rivalsMark },
		{ key: 'daysSinceSellerUpdate', label: 'days idle', val: (r) => num(r.report.daysSinceSellerUpdate), fmt: fmtRoi,
			help: `days since the newest destination sell order at any price was placed or changed. The cell tooltip gives the same figure for the orders ${SUPPLY_BAND_TXT}`,
			tip: (r) => {
				const idle = r.report.daysSinceInBandSellerUpdate;
				return `${SUPPLY_BAND_TXT}: ${idle === null || idle === undefined ? 'no orders' : `${idle} days idle`}`;
			} },
		{ key: 'avgDaysIdle', label: 'avg days idle', val: (r) => num(r.report.avgDaysIdle), fmt: fmtRoi,
			display: (r) => {
				const text = fmtRoi(num(r.report.avgDaysIdle));
				return text !== '' && r.report.avgDaysIdleCensored ? `≥ ${text}` : text;
			},
			help: () => `mean days between price moves of the destination sellers priced within ${pct(cfg.SUPPLY_BAND)} above the cheapest listing, over the observed part of the last ${statsWindowDays(runDaysToComplete)} days (max(days to clear, 3)); blank without observation; ≥ when nobody moved in the observed time`,
			tip: coverageWords },
		{ key: 'km3', label: 'km3', val: km3Of, fmt: fmtNum, help: 'packaged volume of the order quantity, in thousands of m3',
			tip: (r) => `${nf.format(r.m3 || 0)} m3 packaged per unit × ${nf.format(orderQty(r))}` },
		{ key: 'activeDaysFraction', label: 'active days', val: (r) => num(r.report.activeDaysFraction), fmt: fmtRoi,
			help: `fraction of the last ${DAYS_CONSIDERED} days with sell-side trades at the destination that would have been profitable. Red when outside the column's min/max (the default min is the old filter limit, 0.2)`,
			tip: (r) => `${r.report.activeDays} of ${DAYS_CONSIDERED} days` },
		{ key: 'costPerItemMil', label: 'cost/item', val: (r) => num(r.report.costPerItemMil), fmt: fmtMil,
			help: `average source price over the orders bought, plus ${pct(HAULING_REWARD_FRACTION)} hauling reward`,
			tip: (r) => `cheapest source order ${mil(r.report.srcBestSellPriceMil)} + ${pct(HAULING_REWARD_FRACTION)} haul (averaged up the book)` },
		{ key: 'revenuePerItemMil', label: 'revenue/item', val: (r) => num(r.report.revenuePerItemMil), fmt: fmtMil,
			help: `sell price − ${pct(SELL_TAX)} broker fee and sales tax. Sell price = the lower of (cheapest destination listing − 0.01) and the recent sell-side trade average`,
			tip: (r) => `sell price ${mil(r.report.sellPriceMil)} − ${pct(SELL_TAX)} tax (cheapest listing ${mil(r.report.destBestSellPriceMil)})` },
		{ key: 'orderCost', label: 'order cost', val: orderCost, fmt: fmtTotal,
			help: `quantity × cost/item (buy price + ${pct(HAULING_REWARD_FRACTION)} hauling), in millions`,
			tip: (r) => `${nf.format(orderQty(r))} × ${mil(r.report.costPerItemMil)}` },
		{ key: 'orderRevenue', label: 'order revenue', val: orderRevenue, fmt: fmtTotal,
			help: `quantity × (sell price − ${pct(SALES_TAX)} sales tax − ${pct(BROKER_FEE)} listing fee), in millions`,
			tip: (r) => `${nf.format(orderQty(r))} × (${mil(sellPriceOf(r))} − ${pct(SALES_TAX)} − ${pct(BROKER_FEE)})` },
		{ key: 'orderProfit', label: 'order profit', val: orderProfit, fmt: fmtTotal,
			help: 'order revenue − order cost, in millions',
			tip: (r) => `${fmtTotal(orderRevenue(r))} − ${fmtTotal(orderCost(r))}` },
		{ key: 'daysToClear', label: 'days to clear', val: (r) => num(r.report.daysToClear), fmt: fmtRoi,
			help: `(quantity + competing stock: within ${pct(cfg.COMPETE_BAND)} above the sell price in full, dearer stock by its seller's rival weight) ÷ demand per day. Red when beyond the days-to-clear horizon`,
			tip: (r) => `(${nf.format(r.report.volume)} + ${nf.format(r.report.competingVolume)} competing) ÷ ${r.report.dailyDemand}/day` }
	];
	const sortValue = (col, row) => col.sort ? col.sort(row) : col.val(row);
	if (!COLUMNS.some(c => c.key === sort.key) || (sort.dir !== 'asc' && sort.dir !== 'desc')) {
		sort = { key: 'dailyProfitMil', dir: 'desc' };
	}

	const esc = (s) => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

	const sortRowElem = $('#sortRow');
	const filterRowElem = $('#filterRow');
	const renderHead = () => {
		sortRowElem.innerHTML = COLUMNS.map(col => {
			const active = sort.key === col.key;
			const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
			const cls = (col.text ? 'text ' : 'numeric ') + (active ? 'sorted' : '');
			const help = typeof col.help === 'function' ? col.help() : col.help;
			return `<th class="${cls}" data-key="${col.key}" title="${esc(help || '')}">${esc(col.label)}${arrow}</th>`;
		}).join('');
	};

	//--- column filters: min/max per numeric column (blank = no limit); persisted globally.
	// Empty values pass. Selected rows and search matches ignore column filters.
	// A filter hides a row by its recommendation's figures (baseView), so a factor never makes a row vanish;
	// the cells are marked red by the displayed figures (colFilterBreaches).
	const FILTERABLE = (col) => !['select', 'name', 'factor'].includes(col.key);
	let colFilters = lsGet('colFilters', {});
	// The single-column limits the estimate used to hard-code are seeded once as these columns' mins: daily
	// profit 1M/day, the min ROI, active days 0.2. The flag keeps a bound the user clears from coming back.
	if (!lsGet('colFiltersSeeded', false)) {
		for (const [key, min] of [['dailyProfitMil', 1], ['roi', minRoi], ['activeDaysFraction', 0.2]]) {
			const f = colFilters[key] || (colFilters[key] = { min: null, max: null });
			if (f.min === null || f.min === undefined) f.min = min;
		}
		lsSet('colFilters', colFilters);
		lsSet('colFiltersSeeded', true);
	}
	// the row as its recommendation shows it (factor 1): what the column filters test
	const baseView = (row) => row.report === row.base ? row : { ...row, report: row.base };
	const passesColFilters = (row) => {
		for (const col of COLUMNS) {
			const f = colFilters[col.key];
			if (!f) continue;
			const v = col.val(row);
			if (v === null || v === undefined || Number.isNaN(v)) continue;
			if (f.min !== null && f.min !== undefined && v < f.min) return false;
			if (f.max !== null && f.max !== undefined && v > f.max) return false;
		}
		return true;
	};
	// The columns whose displayed figure is outside its min/max: Map column key -> why.
	const colFilterBreaches = (row) => {
		const breaches = new Map();
		for (const col of COLUMNS) {
			const f = colFilters[col.key];
			if (!f || !FILTERABLE(col)) continue;
			const v = col.val(row);
			if (typeof v !== 'number' || !Number.isFinite(v)) continue;
			if (f.min !== null && f.min !== undefined && v < f.min) breaches.set(col.key, `below the column's min ${f.min}`);
			else if (f.max !== null && f.max !== undefined && v > f.max) breaches.set(col.key, `above the column's max ${f.max}`);
		}
		return breaches;
	};
	// "ROI below the column's min 1.5": the first column (in table order) the row's figures are outside of
	const firstColFilterText = (row) => {
		const breaches = colFilterBreaches(row);
		const col = COLUMNS.find(c => breaches.has(c.key));
		return col ? `${col.label} ${breaches.get(col.key)}` : '';
	};
	// Each filterable column shows "min - max" where each side is a clickable label (the set value, or
	// "min"/"max" when unset). Clicking turns it into a number field: it saves on every keystroke,
	// closes on Enter/Tab/blur, and Escape restores the previous value. Blank clears the bound.
	const boundLabel = (key, bound) => {
		const f = colFilters[key];
		const v = f ? f[bound] : null;
		const isSet = v !== null && v !== undefined;
		return `<span class="fval${isSet ? ' set' : ''}" data-key="${key}" data-bound="${bound}" title="click to edit">${isSet ? v : bound}</span>`;
	};
	const buildFilterRow = () => {
		filterRowElem.innerHTML = COLUMNS.map(col => {
			if (col.key === 'name') return '<th class="text"><a href="#" id="clearFilters" title="clear all column filters">clear</a></th>';
			if (!FILTERABLE(col)) return '<th></th>';
			return `<th class="numeric">${boundLabel(col.key, 'min')} - ${boundLabel(col.key, 'max')}</th>`;
		}).join('');
	};
	const setBound = (key, bound, value) => {
		const f = colFilters[key] || (colFilters[key] = { min: null, max: null });
		f[bound] = Number.isFinite(value) ? value : null;
		if (f.min === null && f.max === null) delete colFilters[key];
		lsSet('colFilters', colFilters);
	};
	// every row that has a <tr> follows the filters: dimming, the name tooltip and the red cells depend on them
	const refreshRowEls = () => {
		for (const row of rows) {
			const tr = trByTypeId.get(row.typeId);
			if (tr) updateRowEl(tr, row);
		}
	};
	let colFilterTimer = null;
	const scheduleFilterRender = () => {
		clearTimeout(colFilterTimer);
		colFilterTimer = setTimeout(() => { refreshRowEls(); render(); }, 150);
	};
	const openBoundEditor = (span) => {
		const { key, bound } = span.dataset;
		const f = colFilters[key];
		const previous = f && f[bound] !== null && f[bound] !== undefined ? f[bound] : null;
		const input = document.createElement('input');
		input.type = 'number';
		input.step = 'any';
		input.placeholder = bound;
		input.value = previous === null ? '' : previous;
		input.dataset.key = key;
		input.dataset.bound = bound;
		let closed = false;
		const close = (restore) => {
			if (closed) return;
			closed = true;
			if (restore) {
				setBound(key, bound, previous);
				scheduleFilterRender();
			}
			const fresh = document.createElement('template');
			fresh.innerHTML = boundLabel(key, bound);
			input.replaceWith(fresh.content.firstChild);
		};
		input.addEventListener('input', () => {
			setBound(key, bound, parseFloat(input.value));
			scheduleFilterRender();
		});
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); close(false); }
			else if (e.key === 'Escape') { e.preventDefault(); close(true); }
		});
		input.addEventListener('blur', () => close(false));
		span.replaceWith(input);
		input.focus();
		input.select();
	};
	filterRowElem.addEventListener('click', (e) => {
		const span = e.target.closest('span.fval');
		if (span) { openBoundEditor(span); return; }
		if (e.target.id !== 'clearFilters') return;
		e.preventDefault();
		colFilters = {};
		lsSet('colFilters', colFilters);
		buildFilterRow();
		refreshRowEls();
		render();
	});

	//--- rows: one persistent <tr> per type id; created once, updated in place, moved/detached but never rebuilt
	const trByTypeId = new Map();

	const clearRows = () => {
		rows = [];
		rowByTypeId = new Map();
		trByTypeId.clear();
		tbodyElem.innerHTML = '';
		searchGen++; // a search lookup still in flight belongs to the old table
		setSearchNote('');
	};

	// Copy-name button icons (12px, drawn in currentColor). The button swaps its icon to confirm.
	const svgIcon = (body) => `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
	const COPY_ICON = svgIcon('<rect x="4.25" y="4.25" width="7" height="7" rx="1.5"/><path d="M7.75 3V2.25a1.5 1.5 0 0 0-1.5-1.5h-4a1.5 1.5 0 0 0-1.5 1.5v4a1.5 1.5 0 0 0 1.5 1.5H3"/>');
	const COPIED_ICON = svgIcon('<path d="M2 6.5l2.5 2.5L10 3"/>');
	const FAILED_ICON = svgIcon('<path d="M3 3l6 6M9 3l-6 6"/>');

	// One body cell as the row shows it: its text, its tooltip (the column's working, then its observed-figure
	// sentence, then why it is red), and whether it is red (`breach`) or blended with observation (`observed`).
	// `breaches` is the Set of columns past a limit of the estimate, `colBreaches` colFilterBreaches(row).
	const cellView = (col, row, breaches, colBreaches) => {
		const mark = col.mark ? col.mark(row) : null;
		const text = breaches.has(col.key) ? BREACH_TEXT[col.key] : null;
		const reasons = [typeof text === 'function' ? text(row) : text, colBreaches.get(col.key)].filter(Boolean);
		return {
			text: col.display ? col.display(row) : col.fmt(col.val(row)),
			title: [col.tip ? col.tip(row) : '', mark, ...reasons].filter(Boolean).join('; '),
			breach: reasons.length > 0,
			observed: mark !== null
		};
	};

	const updateRowEl = (tr, row) => {
		// hidden (or dimmed, with show filtered) by the estimate's filter, or by a column filter on the recommendation's figures
		const base = baseView(row);
		const colHidden = !passesColFilters(base);
		const filtered = !!row.report.filteredReason || colHidden;
		tr.classList.toggle('filtered', filtered);
		tr.classList.toggle('dim', filtered);
		tr.classList.toggle('alwaysShowItem', !!row.isAlwaysShow);
		const nameCell = tr.querySelector('td.nameCell');
		nameCell.title = row.report.filteredReason || (colHidden ? firstColFilterText(base) : '');
		// the displayed figures that break a limit turn red, the tooltip says which: the estimate's (too many
		// rivals, days to clear beyond the horizon) and the columns' own min/max
		const breaches = new Set(estimate.limitBreaches(row.report, reportConfig({ typeId: row.typeId, isAlwaysShow: row.isAlwaysShow, daysToComplete: row.daysToComplete, minRoi: row.minRoi })));
		const colBreaches = colFilterBreaches(row);
		for (const cell of tr.querySelectorAll('td[data-col]')) {
			const col = COLUMNS.find(c => c.key === cell.dataset.col);
			const view = cellView(col, row, breaches, colBreaches);
			cell.textContent = view.text;
			cell.classList.toggle('breach', view.breach);
			cell.classList.toggle('observed', view.observed);
			cell.title = view.title;
		}
		const factorInput = tr.querySelector('input.factor');
		if (document.activeElement !== factorInput && factorInput.value !== String(row.factor)) factorInput.value = row.factor;
		factorInput.classList.toggle('own', !!row.hasOverride);
		factorInput.title = row.hasOverride
			? "this row's own factor; clear it to follow the global factor"
			: 'follows the global factor; type a number to give this row its own';
	};

	const createRowEl = (row) => {
		const tr = document.createElement('tr');
		tr.dataset.typeId = row.typeId;
		for (const col of COLUMNS) {
			const td = document.createElement('td');
			switch (col.key) {
				case 'select': {
					td.className = 'sel';
					const box = document.createElement('input');
					box.type = 'checkbox';
					box.className = 'selbox';
					box.checked = selected.has(row.typeId);
					td.appendChild(box);
					break;
				}
				case 'name': {
					td.className = 'text nameCell';
					const nameSpan = document.createElement('span');
					nameSpan.className = 'name';
					nameSpan.textContent = row.name;
					const copyName = document.createElement('button');
					copyName.type = 'button';
					copyName.className = 'copyName';
					copyName.title = 'Copy name';
					copyName.setAttribute('aria-label', 'Copy name');
					copyName.innerHTML = COPY_ICON;
					const idSpan = document.createElement('span');
					idSpan.className = 'dim';
					idSpan.textContent = row.typeId;
					td.append(nameSpan, copyName, ' ', idSpan);
					break;
				}
				case 'factor': {
					td.className = 'numeric';
					const input = document.createElement('input');
					input.type = 'number';
					input.className = 'factor';
					input.step = '0.1';
					input.min = '0';
					td.appendChild(input);
					break;
				}
				default:
					td.className = 'numeric';
					td.dataset.col = col.key;
			}
			tr.appendChild(td);
		}
		trByTypeId.set(row.typeId, tr);
		updateRowEl(tr, row);
		return tr;
	};

	// selected rows are always visible; else a search matches every row (filtered ones too); else the estimate's
	// filter and the column filters (on the recommendation's figures, so a factor never hides a row) apply,
	// unless show filtered reveals what they hide (dimmed, see updateRowEl)
	const isRowVisible = (row, query) => {
		if (selected.has(row.typeId) || row.isAlwaysShow) return true;
		if (query) return row.name.toLowerCase().includes(query);
		return showFiltered || (!row.report.filteredReason && passesColFilters(baseView(row)));
	};

	const searchQuery = () => searchInput.value.trim().toLowerCase();
	const sortedVisibleRows = (query = searchQuery()) => {
		const col = COLUMNS.find(c => c.key === sort.key);
		const dir = sort.dir === 'asc' ? 1 : -1;
		const list = rows.filter(r => isRowVisible(r, query));
		const keyed = list.map(r => ({ r, v: sortValue(col, r) }));
		keyed.sort((a, b) => {
			const an = a.v === null || a.v === undefined || Number.isNaN(a.v);
			const bn = b.v === null || b.v === undefined || Number.isNaN(b.v);
			if (an || bn) return an === bn ? 0 : (an ? 1 : -1); // nulls last regardless of direction
			if (a.v < b.v) return -dir;
			if (a.v > b.v) return dir;
			return 0;
		});
		return keyed.map(k => k.r);
	};

	const isEditing = () => {
		const el = document.activeElement;
		return !!el && tbodyElem.contains(el) && el.tagName === 'INPUT' && el.type === 'number';
	};

	const updateSums = () => {
		let cost = 0, revenue = 0, km3 = 0, count = 0, hiddenByColFilters = 0;
		for (const row of rows) {
			if (!selected.has(row.typeId) && !row.isAlwaysShow && !row.report.filteredReason && !passesColFilters(baseView(row))) hiddenByColFilters++;
			if (!selected.has(row.typeId)) continue;
			cost += orderCost(row);
			revenue += orderRevenue(row);
			km3 += km3Of(row);
			count++;
		}
		sumsElem.innerHTML =
			`${roundNonZero(revenue - cost)}` +
			`<span class="dim"> (-${roundNonZero(cost)} + ${roundNonZero(revenue)}) </span>` +
			`${roundNonZero(km3)}km3 <span class="dim">&middot; ${count} selected</span>` +
			(hiddenByColFilters ? `<span class="dim"> &middot; ${hiddenByColFilters} ${showFiltered ? 'outside' : 'hidden by'} column filters</span>` : '');
	};

	const render = () => {
		pendingRender = false;
		lastRenderAt = Date.now();
		renderHead();
		const scrollY = window.scrollY;
		const query = searchQuery();
		const ordered = sortedVisibleRows(query);
		const orderedIds = new Set(ordered.map(r => r.typeId));
		// detach hidden rows (kept in trByTypeId so they can come back)
		for (const [typeId, tr] of trByTypeId) {
			if (tr.parentNode && !orderedIds.has(typeId)) tr.remove();
		}
		// put visible rows in order, moving only the nodes that are out of place
		let cursor = tbodyElem.firstChild;
		for (const row of ordered) {
			const tr = trByTypeId.get(row.typeId) || createRowEl(row);
			if (tr === cursor) cursor = cursor.nextSibling;
			else tbodyElem.insertBefore(tr, cursor);
		}
		// Bold the names the search matches; rows shown only because they are selected or stocked stay regular.
		let anyHit = false;
		for (const [typeId, tr] of trByTypeId) {
			const row = rowByTypeId.get(typeId);
			const hit = !!query && !!row && row.name.toLowerCase().includes(query);
			tr.classList.toggle('searchHit', hit);
			if (hit && orderedIds.has(typeId)) anyHit = true;
		}
		// rows stream in during a run: a "no item named" note goes once a name contains the query after all
		if (anyHit && searchNoteIsMiss) setSearchNote('');
		if (window.scrollY !== scrollY) window.scrollTo(window.scrollX, scrollY);
		updateSums();
	};

	// Throttled: at most one render per 500ms. Suspended while a row input is focused or while the
	// pointer is over the table (so rows never re-sort under a click); resumes on blur / mouseleave.
	let pointerInTable = false;
	let renderHeld = false;
	const scheduleRender = () => {
		if (pendingRender) return;
		pendingRender = true;
		const wait = Math.max(0, 500 - (Date.now() - lastRenderAt));
		renderTimer = setTimeout(() => {
			if (isEditing() || pointerInTable) { pendingRender = false; renderHeld = true; return; }
			render(); // (not requestAnimationFrame: it never fires in a hidden tab)
		}, wait);
	};
	const resumeRender = () => {
		if (renderHeld && !isEditing() && !pointerInTable) {
			renderHeld = false;
			scheduleRender();
		}
	};
	tableElem.addEventListener('mouseenter', () => { pointerInTable = true; });
	tableElem.addEventListener('mouseleave', () => { pointerInTable = false; resumeRender(); });

	//--- row events
	const rowFromEvent = (e) => {
		const tr = e.target.closest('tr[data-type-id]');
		return tr ? { tr, row: rowByTypeId.get(+tr.dataset.typeId) } : null;
	};

	tbodyElem.addEventListener('input', (e) => {
		if (!e.target.classList.contains('factor')) return;
		const hit = rowFromEvent(e);
		if (!hit || !hit.row) return;
		const { tr, row } = hit;
		const raw = e.target.value.trim();
		if (raw === '') {
			// a cleared factor goes back to following the global one (the input snaps to it on commit, below)
			if (!row.hasOverride) return;
			delete factorOverrides[row.typeId];
			row.hasOverride = false;
			row.factor = globalFactor;
			saveFactors();
			row.report = reportForFactor(row);
			updateRowEl(tr, row);
			updateSums();
			return;
		}
		const f = parseFloat(raw);
		if (!(f >= 0)) return;
		row.factor = f;
		row.hasOverride = true;
		factorOverrides[row.typeId] = f;
		saveFactors();
		row.report = reportForFactor(row);
		updateRowEl(tr, row);
		updateSums();
	});

	// on commit, a blank or invalid factor snaps back to the value in force (like the days-to-clear input)
	tbodyElem.addEventListener('change', (e) => {
		if (!e.target.classList.contains('factor')) return;
		const hit = rowFromEvent(e);
		if (!hit || !hit.row) return;
		if (!(parseFloat(e.target.value) >= 0)) e.target.value = hit.row.factor;
	});

	tbodyElem.addEventListener('change', (e) => {
		if (!e.target.classList.contains('selbox')) return;
		const hit = rowFromEvent(e);
		if (!hit || !hit.row) return;
		if (e.target.checked) selected.add(hit.row.typeId);
		else selected.delete(hit.row.typeId);
		saveSelected();
		updateSums(); // no re-render here: the row node stays put, hiding (if now unselected) happens on the next render
	});

	// Copy-name buttons confirm in place: a check mark for 1s, or a red cross for 1.5s when the clipboard refuses.
	const copyNameTimers = new WeakMap();
	const setCopyNameState = (btn, icon, label, cls = null) => {
		btn.innerHTML = icon;
		btn.title = label;
		btn.setAttribute('aria-label', label);
		btn.classList.remove('copied', 'failed');
		if (cls) btn.classList.add(cls);
	};
	tbodyElem.addEventListener('click', async (e) => {
		const btn = e.target.closest('button.copyName');
		if (!btn) return;
		const hit = rowFromEvent(e);
		if (!hit || !hit.row) return;
		clearTimeout(copyNameTimers.get(btn));
		btn.classList.add('pending');
		try {
			await navigator.clipboard.writeText(hit.row.name);
			setCopyNameState(btn, COPIED_ICON, 'Copied', 'copied');
			copyNameTimers.set(btn, setTimeout(() => setCopyNameState(btn, COPY_ICON, 'Copy name'), 1000));
		} catch (err) {
			console.error('clipboard write failed', err);
			setCopyNameState(btn, FAILED_ICON, 'Copy failed', 'failed');
			copyNameTimers.set(btn, setTimeout(() => setCopyNameState(btn, COPY_ICON, 'Copy name'), 1500));
		} finally {
			btn.classList.remove('pending');
		}
	});

	tbodyElem.addEventListener('focusout', () => {
		// let focus settle (tabbing between inputs of a row), then resume if not editing
		setTimeout(resumeRender, 0);
	});

	theadElem.addEventListener('click', (e) => {
		const th = e.target.closest('th[data-key]');
		if (!th) return;
		const key = th.dataset.key;
		if (sort.key === key) sort = { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
		else sort = { key, dir: COLUMNS.find(c => c.key === key).text ? 'asc' : 'desc' };
		lsSet('sort', sort);
		render();
	});

	//--- row intake (buffered)
	let rowBuffer = [];
	const addRow = (row) => {
		rowBuffer.push(row);
		scheduleFlush();
	};
	let flushTimer = null;
	const scheduleFlush = () => {
		if (flushTimer) return;
		flushTimer = setTimeout(() => {
			flushTimer = null;
			flushRows();
		}, 250);
	};
	const flushRows = () => {
		for (const r of rowBuffer) {
			const override = factorOverrides[r.typeId];
			const row = {
				...r,
				base: r.report,
				factor: override !== undefined ? override : globalFactor,
				hasOverride: override !== undefined
			};
			row.report = reportForFactor(row);
			const existing = rowByTypeId.get(r.typeId);
			if (existing) rows[rows.indexOf(existing)] = row;
			else rows.push(row);
			rowByTypeId.set(r.typeId, row);
			const tr = trByTypeId.get(r.typeId);
			if (tr) updateRowEl(tr, row);
		}
		rowBuffer = [];
		scheduleRender();
	};

	//--- progress
	const fmtElapsed = (ms) => {
		const s = Math.floor(ms / 1000);
		const m = Math.floor(s / 60);
		return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
	};
	let lastProgress = null;
	const showProgress = (p) => {
		lastProgress = p;
		const q = p.queue || {};
		const parts = [];
		if (p.phase === 'typeIds') parts.push('loading type ids');
		else {
			if (p.books && !p.books.loaded) parts.push(`order books ${p.books.done}/${p.books.total ?? '?'} pages`);
			parts.push(`triage ${p.triaged}/${p.typesTotal}`);
			parts.push(`reports ${p.reportsDone}/${p.triagePassed} done`);
			if (p.reportsFailed) parts.push(`${p.reportsFailed} failed`);
		}
		parts.push(`in flight ${q.inFlight ?? 0}`);
		parts.push(`queued ${q.queued ?? 0}`);
		if (q.pausedUntil && q.pausedUntil > Date.now()) parts.push(`paused ${Math.ceil((q.pausedUntil - Date.now()) / 1000)}s`);
		parts.push(fmtElapsed(p.elapsedMs));
		parts.push(`rows ${p.rowsShown}` + (p.rowsFiltered ? ` (+${p.rowsFiltered} filtered)` : ''));
		if (p.phase === 'done' || p.phase === 'stopped' || p.phase === 'error') parts.push(p.phase);
		progressElem.textContent = parts.join(' · ');
	};

	//--- run / stop
	const setRunning = (running) => {
		runBtn.disabled = running;
		stopBtn.disabled = !running;
		startSel.disabled = running;
		endSel.disabled = running;
	};

	const run = async () => {
		if (currentRun) return;
		if (startSel.value === endSel.value) return;
		loadRouteState();
		clearRows();
		rowBuffer = [];
		currentBooks = null; // (before the await below, so a search lookup in the meantime fetches fresh orders)
		runDaysToComplete = daysToClear; // fixed for this run
		runMinRoi = minRoi;
		horizonFromRun = true;
		reportGeneratedAt = moment().format('MMM. Do, h:mm a');
		reportGeneratedAtIso = new Date().toISOString();
		const horizon = `${runDaysToComplete} day${runDaysToComplete === 1 ? '' : 's'} to clear`;
		headerElem.innerHTML = `${esc(startSel.value)} &rarr; ${esc(endSel.value)} <span class="dim">&middot;</span> ${horizon} <span class="dim">&middot;</span> min ROI ${runMinRoi}x <span class="dim">&middot; ${reportGeneratedAt}</span>`;
		render();
		scheduleSearchLookup(); // a standing search keeps finding its item in the new table

		const controller = new AbortController();
		currentRun = { controller };
		setRunning(true);
		try {
			await syncAlwaysShow({ refreshRows: false });
			await runReport({
				startStationKey: startSel.value,
				endStationKey: endSel.value,
				alwaysShowIds,
				isAlwaysShow: (id) => alwaysShowIds.has(id),
				daysToComplete: runDaysToComplete,
				minRoi: runMinRoi,
				signal: controller.signal,
				onRow: addRow,
				onProgress: showProgress,
				onBooks: (books) => { currentBooks = books; }
			});
		} finally {
			flushRows();
			currentRun = null;
			setRunning(false);
			// in-flight may still be draining after a stop; keep refreshing the stats briefly
			if (lastProgress) {
				const drain = setInterval(() => {
					const q = util.queueStats();
					showProgress({ ...lastProgress, queue: q });
					if (q.inFlight === 0 && q.queued === 0) clearInterval(drain);
				}, 500);
				setTimeout(() => clearInterval(drain), 30000);
			}
		}
	};

	runBtn.addEventListener('click', run);
	stopBtn.addEventListener('click', () => {
		if (currentRun) currentRun.controller.abort();
	});

	//--- controls
	const onRouteChange = (changed) => {
		const other = changed === startSel ? endSel : startSel;
		if (startSel.value === endSel.value) {
			// pick the first station that differs
			other.value = stationNames.find(n => n !== changed.value);
		}
		lsSet('route', { start: startSel.value, end: endSel.value });
		loadRouteState();
		currentBooks = null; // books belong to a route
		clearRows();
		headerElem.textContent = '';
		reportGeneratedAtIso = null;
		// the table no longer holds a run's rows: the horizon follows the input again until the next Run
		horizonFromRun = false;
		runDaysToComplete = daysToClear;
		runMinRoi = minRoi;
		render();
		scheduleSearchLookup();
	};
	startSel.addEventListener('change', () => onRouteChange(startSel));
	endSel.addEventListener('change', () => onRouteChange(endSel));

	autoRunChk.checked = !!lsGet('autoRun', false);
	autoRunChk.addEventListener('change', () => lsSet('autoRun', autoRunChk.checked));

	globalFactorInput.value = globalFactor;
	globalFactorInput.addEventListener('input', () => {
		const f = parseFloat(globalFactorInput.value);
		if (!(f >= 0)) return;
		globalFactor = f;
		lsSet('globalFactor', f);
		for (const row of rows) {
			if (row.hasOverride) continue;
			row.factor = f;
			row.report = reportForFactor(row);
			const tr = trByTypeId.get(row.typeId);
			if (tr) updateRowEl(tr, row);
		}
		render();
	});

	daysToClearInput.value = daysToClear;
	daysToClearInput.addEventListener('input', () => {
		const d = parseDaysToClear(daysToClearInput.value);
		if (d === null) return;
		daysToClear = d;
		lsSet('daysToClear', d);
		if (!horizonFromRun && rows.length === 0) {
			runDaysToComplete = d;
			renderHead();
		}
	});
	// on commit, an invalid entry (blank, 0, 2.5) snaps back to the last valid value
	daysToClearInput.addEventListener('change', () => { daysToClearInput.value = daysToClear; });

	minRoiInput.value = minRoi;
	minRoiInput.addEventListener('input', () => {
		const d = parseMinRoi(minRoiInput.value);
		if (d === null) return;
		// the ROI column's min follows the input until the user sets their own (blank or another value stays)
		const f = colFilters.roi;
		if (f && f.min === minRoi) {
			setBound('roi', 'min', d);
			buildFilterRow();
			scheduleFilterRender();
		}
		minRoi = d;
		lsSet('minRoi', d);
		if (!horizonFromRun && rows.length === 0) {
			runMinRoi = d;
			renderHead();
		}
	});
	// on commit, an invalid entry (blank, 0.5) snaps back to the last valid value
	minRoiInput.addEventListener('change', () => { minRoiInput.value = minRoi; });

	showFilteredChk.checked = showFiltered;
	showFilteredChk.addEventListener('change', () => {
		showFiltered = showFilteredChk.checked;
		lsSet('showFiltered', showFiltered);
		render();
	});

	//--- copy orders
	const copiedRows = () => sortedVisibleRows().filter(r => selected.has(r.typeId));
	const buildOrdersText = () => copiedRows()
		.map(r => `${r.name}\t${orderQty(r)}`)
		.join('\n');
	window.getOrdersText = buildOrdersText; // for debugging / tests

	// Saves the copied orders as a run (docs/trade-results-plan.md, Comparison 1). The server dedupes
	// by content: the same orders copied again only bump the run's copyCount.
	const saveRun = async (copiedAt) => {
		// rows a search fetched before any Run have no report time yet: their first copy sets it
		if (!reportGeneratedAtIso) reportGeneratedAtIso = new Date().toISOString();
		const start = STATIONS[startSel.value];
		const end = STATIONS[endSel.value];
		// (buildRun reads the table now, before the first await below)
		const run = exportPersist.buildRun({
			copiedAt,
			reportGeneratedAt: reportGeneratedAtIso,
			route: { start: startSel.value, end: endSel.value, startStationId: start.stationId, endStationId: end.stationId, startRegionId: start.regionId, endRegionId: end.regionId },
			horizonDays: runDaysToComplete,
			config: { SELL_TAX, SALES_TAX, BROKER_FEE, HAULING_REWARD_FRACTION, MIN_ROI: runMinRoi },
			rows: copiedRows().map(r => ({
				typeId: r.typeId, name: r.name, m3: r.m3, qty: orderQty(r), factor: r.factor, base: r.base, report: r.report, context: r.context,
				orderCostMil: orderCost(r), orderRevenueMil: orderRevenue(r), km3: km3Of(r)
			}))
		});
		if (run === null) return;
		const response = await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(await exportPersist.withId(run)) });
		if (!response.ok) throw new Error(`POST /api/runs answered ${response.status}`);
	};

	let copyTimer = null;
	let runSaveFailed = false; // this click's save failed: said on the label while it reads "Copied"
	const showSaveFailed = () => {
		copyBtn.textContent = 'Copied (run not saved)';
		clearTimeout(copyTimer);
		copyTimer = setTimeout(() => { copyBtn.textContent = 'Copy orders'; }, 2500);
	};
	copyBtn.addEventListener('click', async () => {
		copyBtn.classList.add('pending');
		runSaveFailed = false;
		// Never awaited: a slow or failed save (server stopped, say) must not hold up or fail the copy;
		// it only changes what the label says (Comparison 1).
		saveRun(new Date().toISOString()).catch(e => {
			console.error('run not saved', e);
			runSaveFailed = true;
			if (copyBtn.textContent === 'Copied') showSaveFailed();
		});
		try {
			await navigator.clipboard.writeText(buildOrdersText());
			if (runSaveFailed) {
				showSaveFailed();
			} else {
				copyBtn.textContent = 'Copied';
				clearTimeout(copyTimer);
				copyTimer = setTimeout(() => { copyBtn.textContent = 'Copy orders'; }, 1000);
			}
		} catch (e) {
			console.error('clipboard write failed', e);
			copyBtn.textContent = 'Copy failed';
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => { copyBtn.textContent = 'Copy orders'; }, 1500);
		} finally {
			copyBtn.classList.remove('pending');
		}
	});

	//--- always-show list (textarea, persisted; seeded from DEFAULT_ALWAYS_SHOW_NAMES once)
	const alwaysShowNamesFromUi = () => [...new Set(
		alwaysShowText.value.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//'))
	)];
	const storedAlwaysShow = lsGet('alwaysShowNames', null);
	alwaysShowText.value = Array.isArray(storedAlwaysShow) ? storedAlwaysShow.join('\n') : DEFAULT_ALWAYS_SHOW_NAMES.join('\n');
	if (!Array.isArray(storedAlwaysShow)) lsSet('alwaysShowNames', alwaysShowNamesFromUi());

	// Edits apply live: names are resolved, the set is swapped, and every item that entered or left it
	// gets its report rebuilt (always-show bypasses the ROI stop and the filters, so the numbers change),
	// fetching a report for items the run never produced. Syncs are chained so edits never interleave.
	let alwaysShowIds = new Set();
	let alwaysShowSyncChain = Promise.resolve();
	// Own small queue, so live edits are not stuck behind a running report's backlog.
	const liveQueue = util.createQueue({ concurrency: 4 });
	const liveOptions = { queue: liveQueue };
	// A stats fetcher for live work (always-show edits, search lookups) at an end station, with the table's
	// horizon. Short-lived: one per refresh or lookup, so each asks the server once (a lookup waits up to the
	// fetcher's 250 ms flush) and a server that answers 503 is only found out, and logged, per refresh or lookup.
	const liveStats = (end) => createStatsFetcher({ regionId: end.regionId, stationId: end.stationId, windowDays: statsWindowDays(runDaysToComplete) });
	const syncAlwaysShow = ({ refreshRows = true } = {}) => {
		alwaysShowSyncChain = alwaysShowSyncChain.then(async () => {
			const names = alwaysShowNamesFromUi();
			lsSet('alwaysShowNames', names);
			alwaysShowNote.textContent = names.length ? 'resolving…' : '';
			let resolved;
			try {
				resolved = await resolveTypeNames(names, liveOptions);
			} catch (e) {
				if (isAbort(e)) return;
				throw e;
			}
			const added = [...resolved.ids].filter(id => !alwaysShowIds.has(id));
			const removed = [...alwaysShowIds].filter(id => !resolved.ids.has(id));
			alwaysShowIds = resolved.ids;
			alwaysShowNote.textContent = resolved.unresolved.length
				? `${resolved.ids.size} resolved; not found: ${resolved.unresolved.join(', ')}`
				: (names.length ? `${resolved.ids.size} resolved` : '');

			if (!refreshRows || !reportGeneratedAt) return;
			const start = STATIONS[startSel.value];
			const end = STATIONS[endSel.value];
			// one short-lived stats fetcher for the refreshed types (a run's own is gone when the run ends)
			const stats = liveStats(end);
			await Promise.all([...added, ...removed].map(async (typeId) => {
				try {
					const row = await buildRow({ start, end, typeId, isAlwaysShow: alwaysShowIds.has(typeId), books: currentBooks, options: liveOptions, daysToComplete: runDaysToComplete, minRoi: runMinRoi, stats });
					if (row.report) addRow(row);
				} catch (e) {
					if (!isAbort(e)) console.error(`always-show refresh failed (typeId: ${typeId})`, e);
				}
			}));
		}).catch(e => console.error('always-show sync failed', e));
		return alwaysShowSyncChain;
	};
	let alwaysShowInputTimer = null;
	alwaysShowText.addEventListener('input', () => {
		clearTimeout(alwaysShowInputTimer);
		alwaysShowInputTimer = setTimeout(() => syncAlwaysShow(), 400);
	});
	$('#alwaysShowDetails').open = !!lsGet('alwaysShowOpen', false);
	$('#alwaysShowDetails').addEventListener('toggle', e => lsSet('alwaysShowOpen', e.target.open));

	//--- search: filters the table as you type; a query that exactly names an item without a row (it
	// failed triage, or there is no run yet) fetches that item's row after a pause.
	// ESI /universe/ids matches exact names only (case-insensitive); util caches hits, not misses.
	const searchMisses = new Set(); // lower-cased names ESI does not know
	let searchTimer = null;
	const lookUpSearch = async () => {
		const typed = searchInput.value.trim();
		const q = typed.toLowerCase();
		if (!q || rows.some(r => r.name.toLowerCase() === q)) return;
		const gen = searchGen;
		const stale = () => gen !== searchGen;
		const startKey = startSel.value;
		const endKey = endSel.value;
		// a miss stays quiet while the text is part of names already in the table (a partial query)
		const noteMiss = () => {
			if (rows.some(r => r.name.toLowerCase().includes(q))) setSearchNote('');
			else setSearchNote(`no item named “${typed}”`, true);
		};
		if (searchMisses.has(q)) { noteMiss(); return; }
		setSearchNote(`looking up ${typed}…`);
		try {
			const typeId = await util.getTypeIdByName(typed, liveOptions);
			if (stale()) return;
			if (typeId === null || typeId === undefined) {
				searchMisses.add(q);
				noteMiss();
				return;
			}
			if (rowByTypeId.has(typeId)) { setSearchNote(''); return; }
			const row = await buildRow({
				start: STATIONS[startKey],
				end: STATIONS[endKey],
				typeId,
				isAlwaysShow: alwaysShowIds.has(typeId),
				books: currentBooks,
				options: liveOptions,
				daysToComplete: runDaysToComplete,
				minRoi: runMinRoi,
				stats: liveStats(STATIONS[endKey]) // (a lookup is one type: its own short-lived fetcher)
			});
			if (stale()) return;
			if (row.report) {
				addRow(row); // the row appearing is the outcome
				setSearchNote('');
			} else {
				setSearchNote(`${row.name}: no sell orders at ${startKey}`);
			}
		} catch (e) {
			if (stale()) return;
			if (isAbort(e)) { setSearchNote(''); return; } // Stop pressed mid-lookup
			console.error(`search lookup failed (${typed})`, e);
			setSearchNote(`lookup failed for “${typed}”`);
		}
	};
	const scheduleSearchLookup = () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(lookUpSearch, 400);
	};
	let lastSearchQuery = searchQuery();
	searchInput.addEventListener('input', () => {
		render();
		const q = searchQuery();
		if (q === lastSearchQuery) return; // (whitespace-only edits)
		lastSearchQuery = q;
		searchGen++; // drop the result of a lookup still in flight for the old query
		setSearchNote('');
		scheduleSearchLookup();
	});

	//--- init
	loadRouteState();
	setRunning(false);
	buildFilterRow();
	render();
	if (autoRunChk.checked) run();

	// Env notice (docs/order-monitor-plan.md, UI 2): a reminder while EFLIP_DATA_DIR or ESI_USER_AGENT
	// is unset, and an error while the data directory cannot be written (env.dataDirError: characters
	// cannot be linked and syncs cannot be saved there). It reads /api/config, which answers before SSO
	// is set up, so it shows whether or not the app is configured. Built with textContent only; when
	// the read fails, nothing is shown. The same sentences as results-shared.js's envNoticeLines.
	const showEnvNotice = (env) => {
		const box = $('#envNotice');
		if (!box || !env || typeof env !== 'object') return;
		const lines = [];
		if (env.dataDirError && typeof env.dataDirError === 'object') {
			const where = typeof env.dataDir === 'string' ? ` ${env.dataDir}` : '';
			const message = env.dataDirError.message ? ` ${env.dataDirError.message}` : '';
			lines.push({ kind: 'err', text: `The data directory${where} is not writable (${env.dataDirError.code || 'error'}): characters cannot be linked and syncs cannot be saved.${message}` });
		}
		if (env.dataDirFromEnv === false && typeof env.dataDir === 'string') {
			lines.push({ kind: 'note', text: `Synced data is in ${env.dataDir} because EFLIP_DATA_DIR is not set. Add EFLIP_DATA_DIR=/path to .env so every checkout shares one store.` });
		}
		if (env.userAgentFromEnv === false) lines.push({ kind: 'note', text: 'ESI_USER_AGENT is not set; CCP asks for a contact in it.' });
		for (const { kind, text } of lines) {
			const line = document.createElement('div');
			if (kind === 'err') line.className = 'err';
			const label = document.createElement('strong');
			label.textContent = kind === 'err' ? 'Error:' : 'Note:';
			line.append(label, ` ${text}`);
			box.append(line);
		}
	};

	// Sync the linked characters when one has not synced for an hour (docs/trade-results-plan.md,
	// Sync). Fire and forget, errors dropped: nothing waits on it, and Run and auto-run have started
	// above. market: false, since the market snapshot draws on the market-order budget a Run uses.
	(async () => {
		try {
			const config = await (await fetch('/api/config')).json();
			showEnvNotice(config.env);
			if (!config.configured) return;
			const status = await (await fetch('/api/sync')).json();
			if (!exportPersist.syncIsStale(status, Date.now())) return;
			await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ market: false }) });
		} catch (e) { /* a convenience: the results page and "Sync now" do the same */ }
	})();
})();
