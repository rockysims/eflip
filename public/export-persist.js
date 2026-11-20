// What the export page saves when "Copy orders" is pressed, and when it syncs on load. Pure: no
// DOM, no network, no clock (callers pass `now`), only `crypto.subtle` for the content hash. The
// page, lib/runs.js (which checks every posted run against it) and the tests share this one file.
//
// Browser: <script src="export-persist.js"></script> defines `window.exportPersist`.
// Node:    const exportPersist = require('./public/export-persist.js');
//
// A run (Comparison 1 of docs/trade-results-plan.md) is the export report as it stood when the
// orders were copied. It is the plan, not the truth: the hand-off contract says what was bought.
(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory();
	else root.exportPersist = factory();
})(typeof self !== 'undefined' ? self : this, () => {
	const DAY_MS = 24 * 60 * 60 * 1000;
	const MINUTE_MS = 60 * 1000;

	// The saved market context: this many best orders of each book side, and the destination history
	// rows no older than the estimator reads (the page passes its own figure).
	const BOOK_DEPTH = 20;
	const DEFAULT_HISTORY_DAYS = 90;
	// Order and history fields kept, with their types. The five the plan names, plus the ids and
	// totals that tie an order to later market snapshots (Data principle: save raw, derive later).
	// Anything else ESI sends (type_id, location_id, is_buy_order, ...) is the same for the whole
	// book or implied by its side, so it is not repeated.
	const ORDER_FIELDS = Object.freeze({
		order_id: 'number', price: 'number', volume_remain: 'number', volume_total: 'number',
		issued: 'string', duration: 'number', range: 'string', min_volume: 'number'
	});
	const HISTORY_FIELDS = Object.freeze({
		date: 'string', average: 'number', highest: 'number', lowest: 'number', order_count: 'number', volume: 'number'
	});
	// The per-row prediction fields a run keeps (numbers, or null when the report has none).
	const PREDICTION_FIELDS = Object.freeze([
		'costPerItemMil', 'revenuePerItemMil', 'sellPriceMil', 'profitPerItemMil', 'dailyProfitMil',
		'daysToClear', 'dailyDemand', 'competingVolume'
	]);
	const CONFIG_FIELDS = Object.freeze(['SELL_TAX', 'SALES_TAX', 'BROKER_FEE', 'HAULING_REWARD_FRACTION', 'MIN_ROI']);
	const ROUTE_ID_FIELDS = Object.freeze(['startStationId', 'endStationId', 'startRegionId', 'endRegionId']);

	// A page load syncs when any linked character was last synced longer ago than this.
	const SYNC_MAX_AGE_MS = 60 * MINUTE_MS;

	const pick = (source, fields) => {
		const out = {};
		if (source === null || typeof source !== 'object') return out;
		for (const key of Object.keys(fields)) {
			if (source[key] !== undefined) out[key] = source[key];
		}
		return out;
	};
	const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
	// Float noise out of the sums: ISK precision on millions.
	const round6 = (v) => Math.round(v * 1e6) / 1e6;

	const routeName = (route) => `${route.start}-${route.end}`;

	// What the content hash covers: the copied rows' type ids and quantities and nothing else, in
	// type id order, so the table's sort order or a changed factor that lands on the same quantity
	// makes no new run.
	const contentKey = (rows) => rows
		.map(row => [Number(row.typeId), Number(row.qty)])
		.sort((a, b) => a[0] - b[0] || a[1] - b[1])
		.map(([typeId, qty]) => `${typeId}:${qty}`)
		.join(',');

	const sha256Hex = async (text) => {
		const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
		return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
	};
	// 16 hex characters (64 bits) of the SHA-256 of the content key.
	const contentHash = async (rows) => (await sha256Hex(contentKey(rows))).slice(0, 16);

	// `<route>-<reportGeneratedAt ISO>-<contentHash>`. Takes a run body or the parts of one.
	const runId = async ({ route, reportGeneratedAt, rows }) => `${routeName(route)}-${reportGeneratedAt}-${await contentHash(rows)}`;

	// The best orders of one book (the orders at one station for one type): the cheapest sells and
	// the dearest buys, each at most BOOK_DEPTH deep. `filter` copies, so the input keeps its order.
	const bookContext = (orders) => {
		const list = Array.isArray(orders) ? orders : [];
		return {
			sell: list.filter(o => o.is_buy_order !== true).sort((a, b) => a.price - b.price).slice(0, BOOK_DEPTH).map(o => pick(o, ORDER_FIELDS)),
			buy: list.filter(o => o.is_buy_order === true).sort((a, b) => b.price - a.price).slice(0, BOOK_DEPTH).map(o => pick(o, ORDER_FIELDS))
		};
	};

	// What the estimator was given for one type: both books and the destination history, trimmed.
	// History rows keep their ESI date ("YYYY-MM-DD", UTC) and the ones aged at most `historyDays`
	// whole days at `now` stay, oldest first, which is the same cut the estimator makes.
	const marketContext = ({ srcOrders, destOrders, destDays, now, historyDays = DEFAULT_HISTORY_DAYS }) => {
		const nowMs = now instanceof Date ? now.getTime() : Number(now);
		const days = (Array.isArray(destDays) ? destDays : [])
			.filter(day => day && typeof day.date === 'string' && Math.floor((nowMs - Date.parse(`${day.date}T00:00:00Z`)) / DAY_MS) <= historyDays)
			.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
		return {
			src: bookContext(srcOrders),
			dest: bookContext(destOrders),
			history: days.map(day => pick(day, HISTORY_FIELDS))
		};
	};

	// The run to save, without its id (add it with `withId`). Synchronous, so it reads the page's
	// state at the moment of the click. Input:
	//   copiedAt, reportGeneratedAt: ISO strings (toISOString)
	//   route: {start, end, startStationId, endStationId, startRegionId, endRegionId}
	//   horizonDays, config: {SELL_TAX, SALES_TAX, BROKER_FEE, HAULING_REWARD_FRACTION, MIN_ROI}
	//   rows: the copied rows, {typeId, name, m3, qty, factor, report, context, orderCostMil,
	//     orderRevenueMil, km3}; the page works out qty and the order figures (it owns those formulas).
	// Rows of quantity 0 are no order and are left out; null when nothing is left to save.
	const buildRun = ({ copiedAt, reportGeneratedAt, route, horizonDays, config, rows }) => {
		const kept = rows.filter(row => row.qty >= 1);
		if (kept.length === 0) return null;
		const cost = kept.reduce((sum, row) => sum + row.orderCostMil, 0);
		const revenue = kept.reduce((sum, row) => sum + row.orderRevenueMil, 0);
		const context = {};
		for (const row of kept) context[row.typeId] = row.context;
		return {
			copiedAt,
			reportGeneratedAt,
			route: { start: route.start, end: route.end, ...Object.fromEntries(ROUTE_ID_FIELDS.map(key => [key, route[key]])) },
			horizonDays,
			config: Object.fromEntries(CONFIG_FIELDS.map(key => [key, config[key]])),
			rows: kept.map(row => ({
				typeId: row.typeId,
				name: row.name,
				m3: numOrNull(row.m3),
				qty: row.qty,
				factor: row.factor,
				recommended: row.report.volume,
				...Object.fromEntries(PREDICTION_FIELDS.map(key => [key, numOrNull(row.report[key])]))
			})),
			totals: {
				costMil: round6(cost),
				revenueMil: round6(revenue),
				profitMil: round6(revenue - cost),
				km3: round6(kept.reduce((sum, row) => sum + row.km3, 0))
			},
			context
		};
	};

	// The body to POST: the run with its id first.
	const withId = async (run) => ({ id: await runId(run), ...run });

	// Whether a page load should ask the server to sync: `status` is the answer of GET /api/sync.
	// True when some linked character has never synced or last synced more than `maxAgeMs` ago.
	// A character that is syncing right now does not count. The server skips fresh characters
	// anyway, so a true answer costs at most a few cheap checks.
	const syncIsStale = (status, nowMs, maxAgeMs = SYNC_MAX_AGE_MS) => {
		const characters = status && typeof status === 'object' && status.characters && typeof status.characters === 'object'
			? Object.values(status.characters)
			: [];
		return characters.some(character => {
			if (!character || typeof character !== 'object') return true;
			if (character.running === true) return false;
			return !(Date.parse(character.syncedAt) > nowMs - maxAgeMs);
		});
	};

	return {
		BOOK_DEPTH,
		DEFAULT_HISTORY_DAYS,
		ORDER_FIELDS,
		HISTORY_FIELDS,
		PREDICTION_FIELDS,
		CONFIG_FIELDS,
		ROUTE_ID_FIELDS,
		SYNC_MAX_AGE_MS,
		routeName,
		contentKey,
		contentHash,
		runId,
		marketContext,
		buildRun,
		withId,
		syncIsStale
	};
});
