// Order monitor analysis: from our open sell orders, the logs of their price paths, the newest books
// and book logs of their types, the destination history and the facts of a results-calc compute,
// works out per order where it stands in the queue, whether and since when it was undercut, how fast
// others undercut us, what updating it would earn, and a verdict; and what sold recently, in clusters,
// with pending fills and our share of the regional volume. Pure: no network, no DOM, no clock (the
// caller passes `now`), so it runs under `node --test` and loads in the page with a plain <script>.
// The rules are docs/order-monitor-plan.md, "Analysis rules" 1-10; comments name the rule they implement.
//
// Browser: <script src="orders-calc.js"></script> defines `window.ordersCalc`.
// Node:    const ordersCalc = require('./public/orders-calc.js');
//
// INPUT: compute({characterIds, openOrders, orderLogs, books, bookLogs, history, facts,
//                 observedTaxRate, stations, thresholds, now}). Never mutated. Any field but `now` may
//   be missing or empty: a type with no book, history, log or lots still gets its row, with nulls and
//   badges. Timestamps are ISO strings (ESI's `issued`/`date`, a raw `fetchedAt`) or ms.
//   characterIds    the pooled characters; rows, sales and episodes are theirs. Default: the keys of
//                   openOrders and orderLogs. Every order id in openOrders, orderLogs or facts.relists
//                   is "ours", whichever character, and never counts as competition.
//   openOrders      {[characterId]: rows | {fetchedAt, orders: rows}}: ESI /characters/{id}/orders rows
//                   {order_id, type_id, location_id, region_id, price, volume_remain, volume_total,
//                   issued, duration, range, is_buy_order (absent on a sell)}. Buy orders are skipped.
//   orderLogs       {[characterId]: order-log.json}: {[orderId]: {typeId, locationId, regionId, isBuy,
//                   volumeTotal, duration, firstSeen, lastSeen, path: [{at, price, volumeRemain,
//                   issued}], end: null | {state, volumeRemain, at}}}.
//   books           {[typeId]: {[regionId]: {fetchedAt, orders}}}: ESI /markets/{region}/orders rows
//                   {order_id, type_id, location_id, system_id, price, volume_remain, volume_total,
//                   issued, duration, range, min_volume, is_buy_order}. Our own orders are in it.
//   bookLogs        {[typeId]: {[regionId]: market/<regionId>/<typeId>.json}}: {samples: [{at, stored}],
//                   orders: {[orderId]: {isBuy, locationId, systemId, volumeTotal, duration, minVolume,
//                   range, firstSeen, lastSeen, path: [{at, price, volumeRemain, issued}]}}}.
//   history         {[typeId]: [{date: 'YYYY-MM-DD', average, highest, lowest, order_count, volume}]},
//                   ESI daily history of the destination region.
//   facts           {sells, lots, relists} of a results-calc compute over the whole ledger (its
//                   `facts`; fields used: sells {date, typeId, characterId, sellTxId, qty, unitPrice,
//                   gross, tax, brokerShare, relistShare, profit, lotId, daysSinceListed, locationId?},
//                   lots {typeId, qty, soldQty, remainingQty, unitPrice, haulPerUnit, buyFeePerUnit},
//                   relists {orderId, characterId, typeId, locationId, isBuy, firstSeenAt, pricePath:
//                   [{at, price, volumeRemain, issued}], fees: [{id, date, amount (negative)}], feeTotal}).
//   observedTaxRate results-calc's, a fraction; null falls back to 0.08 (results-calc SALES_TAX), warned.
//   stations        {[locationId]: {name, regionId, systemId}} (optional; names, and a region fallback).
//   thresholds      overrides for defaultThresholds (below); the page may pass estimate.defaultConfig's
//                   MIN_ROI, RECENCY_HALF_LIFE_DAYS and DAYS_CONSIDERED as minRoi, halfLifeDays,
//                   daysConsidered.
//   now             ms since the epoch (or an ISO string). Required: compute throws without it.
//
// OUTPUT (rule 10): {rows, sales, salesClusters, pending, salesByTypeDay, share, timeOnTop: {overall,
//   byType}, totals, feeRates, asOf: {orders, books, transactions}, warnings, taxRate, thresholds}.
//   Dates are ISO strings, durations ms, prices and amounts ISK, nothing rounded (the page formats).
//   rows, one per open sell order of characterIds, sorted per rule 7 (undercut, maybe, reconsider,
//   leave, top; then daysBehind descending, nulls last; then orderId):
//     rule 1  orderId, characterId, typeId, locationId, regionId, stationName, price, volumeRemain,
//             volumeTotal, issued, firstSeen (order log), listedSince (the earliest of firstSeen, the
//             first logged issued and facts.relists firstSeenAt), listedFor = now - listedSince,
//             relistCount (price changes in the log path), relistFees (fees after the first in
//             facts.relists), listingFee (the first), feeTotal (all), lastFillAt and lastFillObserved:
//             the last observed volumeRemain drop (true) while the wallet has not covered it, else the
//             newest sale matched to the order (false), else the last observed drop (true).
//     rule 2  bookFetchedAt, unitsAhead, ordersAhead, rank (1 + ordersAhead), bestPrice (lowest in scope,
//             ours included, our other orders not), gapToBest = (price - bestPrice) / bestPrice,
//             cheaperElsewhere {orders, units} (station scope; null for region), ownAhead {orders,
//             units} (our other orders ahead, left out of the figures above). All null without a book.
//     rule 3  undercutAt (among the orders ahead issued after ours, the earliest moment one went below
//             us: its first logged price below ours issued after ours, else its current issued; null
//             when every order ahead predates ours), undercutBy {orderId, locationId, price,
//             volumeRemain, issued (current), gap = (price - theirs) / theirs}, reUndercuts (its price
//             changes issued after ours that left it below us, the first included; null without it
//             in the book log), priceWar (two of those within 24 h).
//     rule 4  dailyVolume, typicalTrade, typicalTradeFrom ('sales' | 'history' | null), daysBehind,
//             myRate7d.
//     rule 5  episodes, undercutEpisodes, medianTimeOnTop, timeOnTopEst (of the type at this station),
//             onTopFor (nothing ahead and the current episode not undercut: now - issued).
//     rule 6  taxRate, landedCost, landedUnits, marginNow, matchPrice (null when nothing is ahead),
//             marginIfMatch, roiIfMatch = marginIfMatch / landedCost, expectedSalesBeforeUndercut,
//             expectedGainBeforeUndercut, and the fee (decision 15): feeRate (the character's relist-fee
//             rate at this station, feeRateScope 'station', else over all its stations, 'character';
//             null without one), feeRateRows (observations behind it, at most 5), feeRateSince (the
//             oldest of those), feeRateEst (fewer than 5), feeEstimate = feeRate × (matchPrice, or price
//             on a top row) × volumeRemain with feeEstimateFrom 'rate'; without a rate the median of this
//             order's relist fees ('order'), else of the character's on the type ('type'), else null.
//     rule 7  verdict, reason (short phrase), badges: subset of priceWar, nocost, nofee, est (time on
//             top from under three episodes), nobook, nobooklog, nohistory, nolog (no order log). The
//             typical-trade `leave` needs a known daysBehind under undercutDays (decision 14).
//   sales (rule 8): one per wallet transaction (results-calc rows of one sellTxId merged) in [now -
//     windowMs, now], newest first: {date, sellTxId, typeId, characterId, qty, unitPrice, gross, tax,
//     brokerShare, relistShare, net = gross - tax - brokerShare - relistShare, profit, orderId,
//     orderMatch, daysSinceListed, lotIds}. orderMatch: 'unique' (the one order whose logged price
//     then equals unitPrice), 'ambiguous' (several; orderId null), 'byTime' (no logged price equals
//     it and exactly one order of the character, type and, when the sale row has one, location was
//     open then by its log), 'none' (orderId null).
//   salesClusters: per type, sales each within clusterGapMs of the previous: {typeId, start, end, at
//     (midpoint), count, qty, gross, net, profit (signed sums), sales}, newest first.
//   pending: per open order, {orderId, characterId, typeId, locationId, date (its last observed drop),
//     observed: true, qty, unitPrice, gross, filledPerLog, filledPerTx, allocated, estNet, estProfit};
//     only those dated inside the window. Per character and type since logging began: each order's
//     drops (filledPerLog) less its matched sales (filledPerTx); the sales matched to no order are
//     then taken off oldest drop first (allocated). So a type's pending units never exceed its drops
//     less all of the character's sales of it since logging began.
//   salesByTypeDay: {typeId, day, count, qty, gross, net, profit, dayQty (our units that whole UTC
//     day), volume (history; null when no row), share = dayQty / volume}, day descending.
//   share (rule 9): {overall, window, byType}. overall {share, qty, volume} = sum of dayQty / sum of
//     volume over exactly the salesByTypeDay rows that have a volume (what the table shows); window
//     {share, qty, volume} and byType[typeId] {share, qty, volume, days} = our units over the volume
//     of every day of the window that has a history row, for every type listed or sold.
//   timeOnTop (rule 5): overall {episodes, undercutEpisodes, medianTimeOnTop, est}; byType[typeId] the
//     same plus onTopFor, bookLogSince and list (episodes {orderId, characterId, locationId, price,
//     start, end, current, undercut, undercutAt, undercutBy, undercutPrice, timeOnTop}).
//   totals: {count, units, gross, net, profit, relistFees, pendingUnits, share} for the window.
//   feeRates (decision 15): {[characterId]: {[locationId]: {rate, rows, since, est, observations:
//     [{date, rate, orderId, typeId}]}}} per pooled character with an observation: observations are
//     every observed rate at the station, newest first; rate is the median of the first `rows` (at
//     most 5), since the oldest of those. An observation is a fee row of facts.relists within 2.5 s
//     of a logged price cut (path entry priced below the one before; the order log's path, else the
//     relist's pricePath) of one of the character's sell orders: fee / (price × volumeRemain) there,
//     kept when in (0, 5 %].
//   asOf: orders = newest openOrders fetchedAt / order-log lastSeen; books = newest book fetchedAt or
//     book-log sample; transactions = newest sale date (any age). warnings: strings.
(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory();
	else root.ordersCalc = factory();
})(typeof self !== 'undefined' ? self : this, () => {
	const MINUTE_MS = 60 * 1000;
	const HOUR_MS = 60 * MINUTE_MS;
	const DAY_MS = 24 * HOUR_MS;

	const defaultThresholds = Object.freeze({
		leaveHours: 8,                // decision 3: leave when the queue ahead clears within this
		undercutDays: 2,              // decision 3: undercut when this far behind or more
		minRoi: 1.5,                  // estimate.js defaultConfig.MIN_ROI: net revenue / cost (the export page's "1.5x")
		scope: 'station',             // decision 4: 'station' | 'region'
		halfLifeDays: 30,             // estimate.js defaultConfig.RECENCY_HALF_LIFE_DAYS
		daysConsidered: 30,           // estimate.js defaultConfig.DAYS_CONSIDERED
		clusterGapMs: 10 * MINUTE_MS, // rule 8: the page passes the window over 150, at least 10 minutes
		windowMs: 7 * DAY_MS          // rule 8: the sold-recently window (24 h, 2 d, 7 d, 30 d)
	});
	const LOOKBACK_MS = 90 * DAY_MS;  // own sales for the typical trade; episodes for time on top
	const MIN_OWN_SALES = 5;          // typical trade from own sales from this many on
	const RATE_MS = 7 * DAY_MS;       // myRate7d
	const EST_UNDER = 3;              // time on top from fewer undercut episodes is flagged est
	const PRICE_WAR_MS = DAY_MS;      // two re-undercuts within this is a price war
	const FALLBACK_TAX = 0.08;        // results-calc defaultOptions.SALES_TAX
	const PRICE_EPS = 0.005;          // a transaction's unit_price equals a logged price within half a cent
	const ORDERS_CACHE_MS = 20 * MINUTE_MS; // /characters/{id}/orders cache: the first logged answer may be this old
	const FEE_MATCH_MS = 2500;        // decision 15: a brokers_fee row within this of a logged price cut's issued
	const FEE_RATE_MAX = 0.05;        // ...a rate outside (0, 5 %] is a mismatch
	const FEE_RATE_ROWS = 5;          // ...the rate is the median of the newest this many; fewer flag est
	const VERDICTS = ['undercut', 'maybe', 'reconsider', 'leave', 'top'];

	//--- helpers

	const toMs = (value) => {
		if (value === null || value === undefined || value === '') return null;
		if (typeof value === 'number') return Number.isFinite(value) ? value : null;
		if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
		const ms = Date.parse(value);
		return Number.isFinite(ms) ? ms : null;
	};
	const iso = (ms) => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString().replace('.000Z', 'Z'));
	const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
	const idNum = (value) => {
		if (value === null || value === undefined || value === '') return null;
		const n = Number(value);
		return Number.isFinite(n) ? n : null;
	};
	const isObj = (value) => value !== null && typeof value === 'object';
	const entriesOf = (value) => (isObj(value) && !Array.isArray(value) ? Object.entries(value) : []);
	const sum = (list, f) => list.reduce((acc, x) => acc + f(x), 0);
	const maxOf = (a, b) => (a === null ? b : b === null ? a : Math.max(a, b));
	const groupBy = (list, keyOf) => {
		const map = new Map();
		for (const x of list) {
			const k = keyOf(x);
			if (!map.has(k)) map.set(k, []);
			map.get(k).push(x);
		}
		return map;
	};
	const median = (list) => {
		const xs = list.filter(x => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
		if (xs.length === 0) return null;
		const mid = Math.floor(xs.length / 2);
		return xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
	};
	const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
	const dayStart = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;
	// History dates are "YYYY-MM-DD" in UTC. Age in whole days, truncated (estimate.js dayAge).
	const dayAge = (dateStr, nowMs) => {
		const [y, m, d] = String(dateStr).split('-').map(Number);
		return Math.floor((nowMs - Date.UTC(y, m - 1, d)) / DAY_MS);
	};
	const recencyWeight = (age, halfLifeDays) => Math.pow(0.5, age / halfLifeDays);
	const samePrice = (a, b) => a !== null && b !== null && Math.abs(a - b) < PRICE_EPS;

	// Text for reasons only; every numeric field stays unrounded.
	const fmtHours = (hours) => {
		if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
		return hours < 10 ? `${Math.round(hours * 10) / 10} h` : `${Math.round(hours)} h`;
	};
	const fmtDays = (daysValue) => (daysValue < 1 ? fmtHours(daysValue * 24) : `${Math.round(daysValue * 10) / 10} d`);

	const thresholdsOf = (overrides, warnings) => {
		const t = { ...defaultThresholds };
		for (const [k, v] of entriesOf(overrides)) {
			if (!(k in defaultThresholds) || v === null || v === undefined) continue;
			if (k === 'scope') t.scope = v;
			else if (typeof v === 'number' && Number.isFinite(v)) t[k] = v;
		}
		if (t.scope !== 'station' && t.scope !== 'region') {
			warnings.push(`unknown scope ${JSON.stringify(t.scope)}; station used`);
			t.scope = 'station';
		}
		return Object.freeze(t);
	};

	//--- logs

	const parsePath = (path) => (Array.isArray(path) ? path : [])
		.filter(isObj)
		.map(e => ({ atMs: toMs(e.at), price: num(e.price), volumeRemain: num(e.volumeRemain), issuedMs: toMs(e.issued) }))
		.sort((a, b) => (a.atMs === null ? 0 : a.atMs) - (b.atMs === null ? 0 : b.atMs));

	const parseOrderLog = (characterId, orderId, rec) => ({
		orderId, characterId,
		typeId: idNum(rec.typeId), locationId: idNum(rec.locationId), regionId: idNum(rec.regionId),
		isBuy: rec.isBuy === true, volumeTotal: num(rec.volumeTotal),
		firstSeenMs: toMs(rec.firstSeen), lastSeenMs: toMs(rec.lastSeen),
		path: parsePath(rec.path),
		end: isObj(rec.end) ? { state: rec.end.state || null, volumeRemain: num(rec.end.volumeRemain), atMs: toMs(rec.end.at) } : null,
		synthetic: false
	});

	const parseBookLog = (log) => {
		if (!isObj(log)) return null;
		const orders = [];
		for (const [id, rec] of entriesOf(log.orders)) {
			if (!isObj(rec)) continue;
			orders.push({ orderId: idNum(id), isBuy: rec.isBuy === true, locationId: idNum(rec.locationId), path: parsePath(rec.path) });
		}
		const samples = (Array.isArray(log.samples) ? log.samples : []).map(s => toMs(isObj(s) ? s.at : s)).filter(ms => ms !== null).sort((a, b) => a - b);
		return { orders, samples, byId: new Map(orders.map(o => [o.orderId, o])) };
	};

	// Rule 8: the price an order of ours asked at `ms`: the path entry with the latest `issued` at or
	// before `ms` (`issued` dates a price exactly; `at` only says when it was seen). Null before the
	// first logged `issued`, and after the order ended.
	const priceAt = (rec, ms) => {
		if (rec.end && rec.end.atMs !== null && rec.end.atMs < ms) return null;
		let best = null;
		for (const e of rec.path) {
			if (e.issuedMs === null || e.price === null || e.issuedMs > ms) continue;
			if (best === null || e.issuedMs >= best.issuedMs) best = e;
		}
		return best === null ? null : best.price;
	};

	// Rule 1: path entries whose price differs from the entry before.
	const priceChanges = (path) => {
		let n = 0;
		for (let i = 1; i < path.length; i++) if (path[i].price !== null && path[i - 1].price !== null && path[i].price !== path[i - 1].price) n++;
		return n;
	};

	// Rule 5: an episode is one price of one order, from an `issued` to the next `issued` of that order,
	// or to the order's end (end.at), or to now while it is open (censored there).
	const episodesOf = (rec, nowMs) => {
		const starts = rec.path.filter(e => e.issuedMs !== null && e.price !== null).sort((a, b) => a.issuedMs - b.issuedMs)
			.filter((e, i, list) => i === 0 || e.issuedMs !== list[i - 1].issuedMs);
		const endMs = rec.end && rec.end.atMs !== null ? rec.end.atMs : nowMs;
		return starts.map((e, i) => {
			const last = i === starts.length - 1;
			return { start: e.issuedMs, price: e.price, end: last ? Math.max(e.issuedMs, endMs) : starts[i + 1].issuedMs, current: last && !rec.end };
		});
	};

	// Competing sell orders of a book log for one of our orders: not ours, at its station unless the
	// scope is the region.
	const competitorsIn = (bookLog, locationId, ownIds, scope) => bookLog.orders.filter(o =>
		!o.isBuy && !ownIds.has(o.orderId) && (scope === 'region' || o.locationId === locationId));

	// Rule 5: the first competing `issued` inside the episode (after its start, before its end) with a
	// price below the episode's price. Null while none has (censored).
	const firstUndercut = (ep, competitors) => {
		let best = null;
		for (const c of competitors) {
			for (const e of c.path) {
				if (e.price === null || e.issuedMs === null) continue;
				if (e.price < ep.price && e.issuedMs > ep.start && e.issuedMs < ep.end && (best === null || e.issuedMs < best.at)) {
					best = { at: e.issuedMs, orderId: c.orderId, price: e.price };
				}
			}
		}
		return best;
	};

	const timeOnTopStats = (episodes) => {
		const cut = episodes.filter(e => e.undercut);
		const med = median(cut.map(e => e.timeOnTop));
		return { episodes: episodes.length, undercutEpisodes: cut.length, medianTimeOnTop: med, est: med !== null && cut.length < EST_UNDER };
	};

	// Rule 3: the undercutter's price changes in the book log since our `issued` that left it below us
	// (the change that first took it below us counts too). Two within 24 h is a price war.
	const reUndercutsOf = (path, myPrice, myIssuedMs) => {
		const times = [];
		for (let i = 1; i < path.length; i++) {
			const prev = path[i - 1];
			const e = path[i];
			if (e.price === null || prev.price === null || e.price === prev.price) continue;
			const ms = e.issuedMs !== null ? e.issuedMs : e.atMs;
			if (ms === null || (myIssuedMs !== null && ms <= myIssuedMs)) continue;
			if (e.price < myPrice) times.push(ms);
		}
		times.sort((a, b) => a - b);
		let priceWar = false;
		for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] <= PRICE_WAR_MS) priceWar = true;
		return { count: times.length, priceWar };
	};

	//--- position (rule 2) and undercut (rule 3)

	// Units ahead: strictly lower price, or equal price issued earlier (decision 12). Our own other
	// orders are counted apart (ownAhead), never as competition. The undercutter is the order ahead
	// issued after us that went below us first: `firstBelow(orderId)` (from the book log, optional)
	// dates that at its first logged price below ours issued after ours, else its current `issued`.
	const positionOf = (o, bookOrders, ownIds, scope, firstBelow = () => null) => {
		const myIssuedMs = toMs(o.issued);
		const isAhead = (b) => b.price < o.price || (b.price === o.price && (myIssuedMs === null || (toMs(b.issued) !== null && toMs(b.issued) < myIssuedMs)));
		const sells = bookOrders.filter(b => isObj(b) && b.is_buy_order !== true && idNum(b.order_id) !== o.orderId && num(b.price) !== null && num(b.volume_remain) > 0);
		const inScope = (b) => scope === 'region' || idNum(b.location_id) === o.locationId;
		const competing = sells.filter(b => !ownIds.has(idNum(b.order_id)));
		const ahead = competing.filter(b => inScope(b) && isAhead(b));
		const ownAhead = sells.filter(b => ownIds.has(idNum(b.order_id)) && inScope(b) && isAhead(b));
		const units = (list) => sum(list, b => num(b.volume_remain) || 0);
		const bestPrice = Math.min(o.price, ...competing.filter(inScope).map(b => b.price));
		const elsewhere = scope === 'station' ? competing.filter(b => idNum(b.location_id) !== o.locationId && b.price < o.price) : null;
		let undercutter = null;
		if (myIssuedMs !== null) {
			for (const b of ahead) {
				const issuedMs = toMs(b.issued);
				if (issuedMs === null || issuedMs <= myIssuedMs) continue;
				const logged = firstBelow(idNum(b.order_id));
				const ms = logged !== null && logged < issuedMs ? logged : issuedMs;
				if (undercutter === null || ms < undercutter.ms) undercutter = { ms, issuedMs, b };
			}
		}
		return {
			unitsAhead: units(ahead),
			ordersAhead: ahead.length,
			rank: ahead.length + 1,
			bestPrice,
			gapToBest: bestPrice > 0 ? (o.price - bestPrice) / bestPrice : null,
			cheaperElsewhere: elsewhere === null ? null : { orders: elsewhere.length, units: units(elsewhere) },
			ownAhead: { orders: ownAhead.length, units: units(ownAhead) },
			undercutAt: undercutter === null ? null : undercutter.ms,
			undercutBy: undercutter === null ? null : {
				orderId: idNum(undercutter.b.order_id), locationId: idNum(undercutter.b.location_id),
				price: undercutter.b.price, volumeRemain: num(undercutter.b.volume_remain), issued: iso(undercutter.issuedMs),
				gap: undercutter.b.price > 0 ? (o.price - undercutter.b.price) / undercutter.b.price : null
			}
		};
	};

	//--- demand (rule 4)

	// Recency-weighted mean of the daily volume over the last daysConsidered days, with estimate.js's
	// weights: ages 1..daysConsidered (today counts as age 1), days missing from history count as zero,
	// so the denominator is the weight of every calendar day in the window. Null without history.
	const dailyVolumeOf = (rows, nowMs, t) => {
		if (!Array.isArray(rows) || rows.length === 0) return null;
		const byAge = new Map();
		for (const d of rows) {
			if (!isObj(d) || typeof d.date !== 'string') continue;
			const age = dayAge(d.date, nowMs);
			if (age > t.daysConsidered) continue;
			const a = Math.max(1, age);
			byAge.set(a, (byAge.get(a) || 0) + (num(d.volume) || 0));
		}
		let weighted = 0;
		let weightTotal = 0;
		for (let age = 1; age <= t.daysConsidered; age++) {
			const w = recencyWeight(age, t.halfLifeDays);
			weightTotal += w;
			if (byAge.has(age)) weighted += w * byAge.get(age);
		}
		return weightTotal > 0 ? weighted / weightTotal : null;
	};

	// Median units per sale: our own sales of the type in the last 90 days when there are at least
	// five, else the recency-weighted mean of the daily volume / order_count over the days present.
	const typicalTradeOf = (ownSales, rows, nowMs, t) => {
		const recent = ownSales.filter(s => s.ms >= nowMs - LOOKBACK_MS && s.ms <= nowMs);
		if (recent.length >= MIN_OWN_SALES) return { typicalTrade: median(recent.map(s => s.qty)), from: 'sales' };
		let weighted = 0;
		let weightTotal = 0;
		for (const d of Array.isArray(rows) ? rows : []) {
			if (!isObj(d) || typeof d.date !== 'string') continue;
			const count = num(d.order_count);
			const volume = num(d.volume);
			const age = dayAge(d.date, nowMs);
			if (!(count > 0) || volume === null || age > t.daysConsidered) continue;
			const w = recencyWeight(Math.max(1, age), t.halfLifeDays);
			weighted += w * volume / count;
			weightTotal += w;
		}
		return weightTotal > 0 ? { typicalTrade: weighted / weightTotal, from: 'history' } : { typicalTrade: null, from: null };
	};

	//--- economics (rule 6)

	// Landed cost per unit over the FIFO remainder of the type's lots (qty-weighted); null when none
	// remains.
	const landedCostOf = (lots, typeId) => {
		let units = 0;
		let cost = 0;
		for (const l of lots) {
			if (!isObj(l) || idNum(l.typeId) !== typeId) continue;
			const rem = num(l.remainingQty) !== null ? l.remainingQty : (num(l.qty) || 0) - (num(l.soldQty) || 0);
			if (!(rem > 0)) continue;
			units += rem;
			cost += ((num(l.unitPrice) || 0) + (num(l.haulPerUnit) || 0) + (num(l.buyFeePerUnit) || 0)) * rem;
		}
		return units > 0 ? { landedCost: cost / units, units } : { landedCost: null, units: 0 };
	};

	// An order's fee rows by date: the first is the listing, later ones relists (results-calc rule 5).
	const feesOf = (relist) => (Array.isArray(relist.fees) ? relist.fees : [])
		.filter(f => isObj(f) && num(f.amount) !== null)
		.map(f => ({ ms: toMs(f.date), cost: -f.amount, id: idNum(f.id) }))
		.sort((a, b) => (a.ms === null ? 0 : a.ms) - (b.ms === null ? 0 : b.ms) || (a.id === null ? 0 : a.id) - (b.id === null ? 0 : b.id));

	// Rule 6 / decision 15: the relist-fee rates one order shows. Each fee row is paired (closest first,
	// one each) with a path entry whose `issued` is within 2.5 s of it and whose price is below the
	// entry before (a price cut); the rate is the fee over that entry's price × volumeRemain. A rate
	// outside (0, 5 %] is a mismatch and dropped.
	const feeObservationsOf = (relist, path) => {
		const fees = feesOf(relist).filter(f => f.ms !== null && f.cost > 0);
		const cuts = [];
		for (let i = 1; i < path.length; i++) {
			const e = path[i];
			const prev = path[i - 1];
			if (e.issuedMs === null || e.price === null || prev.price === null || !(e.price < prev.price) || !(e.volumeRemain > 0)) continue;
			cuts.push(e);
		}
		const pairs = [];
		fees.forEach((f, fi) => cuts.forEach((c, ci) => {
			const d = Math.abs(f.ms - c.issuedMs);
			if (d <= FEE_MATCH_MS) pairs.push({ fi, ci, d });
		}));
		pairs.sort((a, b) => a.d - b.d || a.fi - b.fi || a.ci - b.ci);
		const feeTaken = new Set();
		const cutTaken = new Set();
		const out = [];
		for (const p of pairs) {
			if (feeTaken.has(p.fi) || cutTaken.has(p.ci)) continue;
			feeTaken.add(p.fi);
			cutTaken.add(p.ci);
			const cut = cuts[p.ci];
			const rate = fees[p.fi].cost / (cut.price * cut.volumeRemain);
			if (rate > 0 && rate <= FEE_RATE_MAX) out.push({ ms: fees[p.fi].ms, rate });
		}
		return out;
	};

	// The rate of a set of observations: the median of the newest five by fee date, so a step (the
	// clone state changing the broker rate) is followed rather than averaged.
	const feeRateOf = (observations) => {
		const newest = observations.slice().sort((a, b) => b.ms - a.ms || a.orderId - b.orderId);
		const used = newest.slice(0, FEE_RATE_ROWS);
		return {
			rate: median(used.map(o => o.rate)), rows: used.length, since: iso(Math.min(...used.map(o => o.ms))), est: used.length < FEE_RATE_ROWS,
			observations: newest.map(o => ({ date: iso(o.ms), rate: o.rate, orderId: o.orderId, typeId: o.typeId }))
		};
	};

	// The median of this order's relist fees, else of the character's relist fees on the type, else null.
	const feeEstimateOf = (relists, orderId, characterId, typeId) => {
		const own = relists.find(r => idNum(r.orderId) === orderId);
		const ownFees = own ? feesOf(own).slice(1).map(f => f.cost) : [];
		if (ownFees.length > 0) return { feeEstimate: median(ownFees), from: 'order' };
		const typeFees = relists
			.filter(r => idNum(r.characterId) === characterId && idNum(r.typeId) === typeId && r.isBuy !== true)
			.flatMap(r => feesOf(r).slice(1).map(f => f.cost));
		if (typeFees.length > 0) return { feeEstimate: median(typeFees), from: 'type' };
		return { feeEstimate: null, from: null };
	};

	//--- verdict (rule 7)

	const verdictOf = (r, t) => {
		if (r.ordersAhead === null) return { verdict: 'maybe', reason: 'no book yet' };
		if (r.ordersAhead === 0) return { verdict: 'top', reason: r.ownAhead && r.ownAhead.orders > 0 ? 'only our own orders ahead' : 'nothing ahead' };
		if (r.daysBehind !== null && r.daysBehind * 24 < t.leaveHours) return { verdict: 'leave', reason: `the queue ahead clears in ~${fmtHours(r.daysBehind * 24)}` };
		// decision 14: one unit ahead of an item that sells every five days is still days behind
		if (r.typicalTrade !== null && r.unitsAhead <= r.typicalTrade && r.daysBehind !== null && r.daysBehind < t.undercutDays) {
			return { verdict: 'leave', reason: 'no more ahead than a typical trade' };
		}
		if (r.landedCost !== null && r.matchPrice !== null) {
			const netIfMatch = r.matchPrice * (1 - r.taxRate);
			if (netIfMatch <= r.landedCost) return { verdict: 'reconsider', reason: 'below cost' };
			// minRoi is the export page's revenue / cost ratio, so roiIfMatch (margin / cost) < minRoi - 1
			if (netIfMatch < t.minRoi * r.landedCost) return { verdict: 'reconsider', reason: 'below the ROI floor' };
		}
		if (r.daysBehind !== null && r.daysBehind >= t.undercutDays) {
			if (r.expectedGainBeforeUndercut !== null && r.feeEstimate !== null && r.expectedGainBeforeUndercut < r.feeEstimate) {
				return { verdict: 'maybe', reason: `others undercut within ~${fmtHours(r.medianTimeOnTop / HOUR_MS)}; the fee outweighs the expected sales` };
			}
			return { verdict: 'undercut', reason: `${fmtDays(r.daysBehind)} behind` };
		}
		if (r.daysBehind === null) return { verdict: 'maybe', reason: r.dailyVolume === null ? 'no history' : 'no volume in the history window' };
		return { verdict: 'maybe', reason: `${fmtDays(r.daysBehind)} behind` };
	};

	const compareRows = (a, b) => {
		const v = VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict);
		if (v !== 0) return v;
		if (a.daysBehind !== b.daysBehind) {
			if (a.daysBehind === null) return 1;
			if (b.daysBehind === null) return -1;
			return b.daysBehind - a.daysBehind;
		}
		return (a.orderId || 0) - (b.orderId || 0);
	};

	//--- sales (rule 8)

	// One sale per wallet transaction: results-calc writes one row per lot a sale drew from.
	const mergeSales = (rows) => {
		const byKey = new Map();
		rows.forEach((s, i) => {
			const ms = toMs(s.date);
			if (ms === null) return;
			const txId = s.sellTxId === undefined || s.sellTxId === null ? null : s.sellTxId;
			const key = txId === null ? `row:${i}` : `${s.characterId}:${txId}`;
			let sale = byKey.get(key);
			if (!sale) {
				sale = {
					ms, sellTxId: txId, typeId: idNum(s.typeId), characterId: idNum(s.characterId),
					locationId: idNum(s.locationId !== undefined ? s.locationId : s.location_id),
					qty: 0, unitPrice: num(s.unitPrice), gross: 0, tax: 0, brokerShare: 0, relistShare: 0, profit: 0,
					daysSinceListed: null, lotIds: [], orderId: null, orderMatch: 'none'
				};
				byKey.set(key, sale);
			}
			sale.qty += num(s.qty) || 0;
			sale.gross += num(s.gross) !== null ? s.gross : (num(s.qty) || 0) * (num(s.unitPrice) || 0);
			sale.tax += num(s.tax) || 0;
			sale.brokerShare += num(s.brokerShare) || 0;
			sale.relistShare += num(s.relistShare) || 0;
			sale.profit += num(s.profit) || 0;
			if (sale.daysSinceListed === null && num(s.daysSinceListed) !== null) sale.daysSinceListed = s.daysSinceListed;
			if (s.lotId !== undefined && s.lotId !== null) sale.lotIds.push(s.lotId);
		});
		const out = [...byKey.values()];
		for (const s of out) s.net = s.gross - s.tax - s.brokerShare - s.relistShare;
		return out;
	};

	// When an order of ours was open by its log: from the earlier of its first logged `issued` and
	// its firstSeen, to end.at (open-ended while it has no end).
	const openSpanOf = (rec) => {
		let start = rec.firstSeenMs;
		for (const e of rec.path) if (e.issuedMs !== null && (start === null || e.issuedMs < start)) start = e.issuedMs;
		return { start, end: rec.end && rec.end.atMs !== null ? rec.end.atMs : null };
	};

	// Rule 8: the order of the same character and type (and location, when the sale row carries one)
	// whose logged price at the sale's time equals the unit price ('unique'; 'ambiguous' and null when
	// several). When no logged price matches, the one such order open at the sale's time ('byTime': a
	// price set and changed again between two samples is never logged); 'none' and null otherwise.
	const matchSales = (sales, logsByCharType) => {
		for (const sale of sales) {
			const mine = (logsByCharType.get(`${sale.characterId}:${sale.typeId}`) || [])
				.filter(rec => sale.locationId === null || rec.locationId === sale.locationId);
			const exact = mine.filter(rec => samePrice(priceAt(rec, sale.ms), sale.unitPrice));
			if (exact.length > 0) {
				sale.orderId = exact.length === 1 ? exact[0].orderId : null;
				sale.orderMatch = exact.length === 1 ? 'unique' : 'ambiguous';
				continue;
			}
			const open = mine.filter(rec => {
				const span = openSpanOf(rec);
				return span.start !== null && span.start <= sale.ms && (span.end === null || sale.ms <= span.end);
			});
			sale.orderId = open.length === 1 ? open[0].orderId : null;
			sale.orderMatch = open.length === 1 ? 'byTime' : 'none';
		}
	};

	// The fills the log saw of one of our orders since logging began, as drops (decision 13: a drop of
	// volumeRemain is a fill): between two path entries; at the first sighting of an order placed after
	// logging began (volumeTotal less the volumeRemain first seen); and after the last entry, to the
	// open row's volume_remain (at `currentAt`) or to the ended order's end.volumeRemain (at end.at).
	const dropsOf = (rec, logStart, currentRemain, currentAt) => {
		const out = [];
		const entries = rec.path.filter(e => e.atMs !== null && e.volumeRemain !== null);
		if (entries.length === 0) return out;
		const first = entries[0];
		if (logStart !== null && rec.firstSeenMs !== null && rec.firstSeenMs > logStart && rec.volumeTotal !== null && rec.volumeTotal > first.volumeRemain) {
			out.push({ atMs: first.atMs, units: rec.volumeTotal - first.volumeRemain, price: first.price });
		}
		for (let i = 1; i < entries.length; i++) {
			if (entries[i].volumeRemain < entries[i - 1].volumeRemain) out.push({ atMs: entries[i].atMs, units: entries[i - 1].volumeRemain - entries[i].volumeRemain, price: entries[i].price });
		}
		const last = entries[entries.length - 1];
		if (currentRemain !== null) {
			if (currentRemain < last.volumeRemain) out.push({ atMs: Math.max(currentAt, last.atMs), units: last.volumeRemain - currentRemain, price: last.price });
		} else if (rec.end && rec.end.volumeRemain !== null && rec.end.atMs !== null && rec.end.volumeRemain < last.volumeRemain) {
			out.push({ atMs: rec.end.atMs, units: last.volumeRemain - rec.end.volumeRemain, price: last.price });
		}
		return out;
	};

	const saleOut = (s) => ({
		date: iso(s.ms), sellTxId: s.sellTxId, typeId: s.typeId, characterId: s.characterId,
		qty: s.qty, unitPrice: s.unitPrice, gross: s.gross, tax: s.tax, brokerShare: s.brokerShare, relistShare: s.relistShare,
		net: s.net, profit: s.profit, orderId: s.orderId, orderMatch: s.orderMatch, daysSinceListed: s.daysSinceListed, lotIds: s.lotIds.slice()
	});

	// Rule 8 / decision 10: per type, consecutive sales each within gapMs of the previous form one
	// cluster, dated at its midpoint; sums keep their signs (a loss and a profit net out).
	const clusterSales = (items, gapMs) => {
		const clusters = [];
		for (const [typeId, list] of groupBy(items, x => x.sale.typeId)) {
			list.sort((a, b) => a.ms - b.ms);
			let cur = null;
			for (const x of list) {
				if (cur === null || x.ms - cur.endMs > gapMs) {
					cur = { typeId, startMs: x.ms, endMs: x.ms, items: [] };
					clusters.push(cur);
				}
				cur.endMs = x.ms;
				cur.items.push(x);
			}
		}
		return clusters
			.map(c => {
				const sales = c.items.map(x => x.sale);
				return {
					typeId: c.typeId, start: iso(c.startMs), end: iso(c.endMs), at: iso(Math.round((c.startMs + c.endMs) / 2)),
					count: sales.length, qty: sum(sales, s => s.qty), gross: sum(sales, s => s.gross),
					net: sum(sales, s => s.net), profit: sum(sales, s => s.profit), sales, endMs: c.endMs
				};
			})
			.sort((a, b) => b.endMs - a.endMs || a.typeId - b.typeId)
			.map(({ endMs, ...c }) => c);
	};

	// The window's UTC days, oldest first.
	const windowDays = (nowMs, windowMs) => {
		const out = [];
		for (let d = dayStart(nowMs - windowMs); d <= dayStart(nowMs); d += DAY_MS) out.push(dayKey(d));
		return out;
	};
	const historyByDay = (rows) => {
		const map = new Map();
		for (const d of Array.isArray(rows) ? rows : []) {
			if (!isObj(d) || typeof d.date !== 'string') continue;
			map.set(d.date, (map.get(d.date) || 0) + (num(d.volume) || 0));
		}
		return map;
	};

	//--- entry point

	const compute = (input = {}) => {
		const nowMs = toMs(input.now);
		if (nowMs === null) throw new TypeError('ordersCalc.compute: now is required');
		const warnings = [];
		const t = thresholdsOf(input.thresholds, warnings);
		const facts = isObj(input.facts) ? input.facts : {};
		const factSells = (Array.isArray(facts.sells) ? facts.sells : []).filter(isObj);
		const lots = (Array.isArray(facts.lots) ? facts.lots : []).filter(isObj);
		const relists = (Array.isArray(facts.relists) ? facts.relists : []).filter(isObj);
		const stations = isObj(input.stations) ? input.stations : {};
		const books = isObj(input.books) ? input.books : {};
		const bookLogs = isObj(input.bookLogs) ? input.bookLogs : {};
		const history = isObj(input.history) ? input.history : {};
		let taxRate = num(input.observedTaxRate);
		if (taxRate === null) {
			taxRate = FALLBACK_TAX;
			warnings.push(`no observed tax rate; ${FALLBACK_TAX * 100} % assumed`);
		}

		// open orders and order logs
		const openByChar = new Map();
		let ordersAsOf = null;
		for (const [cid, value] of entriesOf(input.openOrders)) {
			const rows = Array.isArray(value) ? value : (isObj(value) && Array.isArray(value.orders) ? value.orders : []);
			if (isObj(value) && !Array.isArray(value)) ordersAsOf = maxOf(ordersAsOf, toMs(value.fetchedAt));
			openByChar.set(idNum(cid), rows.filter(isObj));
		}
		const logById = new Map();
		const logChars = [];
		for (const [cid, log] of entriesOf(input.orderLogs)) {
			logChars.push(idNum(cid));
			for (const [oid, rec] of entriesOf(log)) {
				if (!isObj(rec) || idNum(oid) === null) continue;
				const parsed = parseOrderLog(idNum(cid), idNum(oid), rec);
				logById.set(parsed.orderId, parsed);
			}
		}
		const characterIds = Array.isArray(input.characterIds)
			? [...new Set(input.characterIds.map(idNum).filter(id => id !== null))]
			: [...new Set([...openByChar.keys(), ...logChars].filter(id => id !== null))].sort((a, b) => a - b);
		const charSet = new Set(characterIds);
		for (const rec of logById.values()) if (charSet.has(rec.characterId)) ordersAsOf = maxOf(ordersAsOf, rec.lastSeenMs);

		// every order of ours, whichever character: never competition
		const ownIds = new Set(logById.keys());
		for (const rows of openByChar.values()) for (const o of rows) if (idNum(o.order_id) !== null) ownIds.add(idNum(o.order_id));
		for (const r of relists) if (idNum(r.orderId) !== null) ownIds.add(idNum(r.orderId));

		// open sell orders of the pooled characters, normalised; one without a log gets a one-entry path
		// from its row so that sales can be matched to it and its current episode is known
		const open = [];
		for (const cid of characterIds) {
			for (const o of openByChar.get(cid) || []) {
				if (o.is_buy_order === true) continue;
				const orderId = idNum(o.order_id);
				const typeId = idNum(o.type_id);
				const price = num(o.price);
				if (orderId === null || typeId === null || price === null) continue;
				const locationId = idNum(o.location_id);
				let rec = logById.get(orderId) || null;
				const hasLog = rec !== null;
				const issuedMs = toMs(o.issued);
				if (rec === null) {
					rec = {
						orderId, characterId: cid, typeId, locationId, regionId: idNum(o.region_id), isBuy: false,
						volumeTotal: num(o.volume_total), firstSeenMs: null, lastSeenMs: null,
						path: [{ atMs: null, price, volumeRemain: num(o.volume_remain), issuedMs }], end: null, synthetic: true
					};
					logById.set(orderId, rec);
				} else if (issuedMs !== null && rec.path.every(e => e.issuedMs === null || e.issuedMs < issuedMs)) {
					// the row is newer than the log: its price change opens the current episode
					rec = { ...rec, path: [...rec.path, { atMs: maxOf(ordersAsOf, issuedMs), price, volumeRemain: num(o.volume_remain), issuedMs }] };
					logById.set(orderId, rec);
				}
				const station = isObj(stations[locationId]) ? stations[locationId] : null;
				let regionId = idNum(o.region_id);
				if (regionId === null) regionId = rec.regionId;
				if (regionId === null && station) regionId = idNum(station.regionId);
				if (regionId === null && isObj(books[typeId]) && Object.keys(books[typeId]).length === 1) regionId = idNum(Object.keys(books[typeId])[0]);
				open.push({
					o: { orderId, typeId, locationId, price, issued: o.issued }, characterId: cid, regionId, rec, hasLog, issuedMs,
					volumeRemain: num(o.volume_remain), volumeTotal: num(o.volume_total), stationName: station && typeof station.name === 'string' ? station.name : null
				});
			}
		}

		// book logs, parsed once per type and region
		const bookLogCache = new Map();
		const bookLogOf = (typeId, regionId) => {
			const key = `${typeId}:${regionId}`;
			if (!bookLogCache.has(key)) bookLogCache.set(key, isObj(bookLogs[typeId]) && regionId !== null ? parseBookLog(bookLogs[typeId][regionId]) : null);
			return bookLogCache.get(key);
		};
		const regionOfRec = (rec) => {
			if (rec.regionId !== null) return rec.regionId;
			const st = isObj(stations[rec.locationId]) ? stations[rec.locationId] : null;
			return st ? idNum(st.regionId) : null;
		};

		// rule 5: episodes of every sell order of the pooled characters within 90 days
		const episodes = [];
		for (const rec of logById.values()) {
			if (rec.isBuy || !charSet.has(rec.characterId) || rec.typeId === null) continue;
			const log = bookLogOf(rec.typeId, regionOfRec(rec));
			if (log === null) continue; // no book log: nothing to judge the episodes by
			const competitors = competitorsIn(log, rec.locationId, ownIds, t.scope);
			for (const ep of episodesOf(rec, nowMs)) {
				if (ep.start < nowMs - LOOKBACK_MS) continue;
				const cut = firstUndercut(ep, competitors);
				episodes.push({
					orderId: rec.orderId, characterId: rec.characterId, typeId: rec.typeId, locationId: rec.locationId,
					price: ep.price, startMs: ep.start, endMs: ep.end, current: ep.current,
					undercut: cut !== null, undercutAtMs: cut === null ? null : cut.at,
					undercutBy: cut === null ? null : cut.orderId, undercutPrice: cut === null ? null : cut.price,
					timeOnTop: (cut === null ? ep.end : cut.at) - ep.start
				});
			}
		}
		const statsByTypeLoc = new Map();
		for (const [key, list] of groupBy(episodes, e => `${e.typeId}:${e.locationId}`)) statsByTypeLoc.set(key, timeOnTopStats(list));

		// sales of the pooled characters, matched to orders (rule 8)
		const allSales = mergeSales(factSells.filter(s => charSet.has(idNum(s.characterId))));
		const sellLogs = [...logById.values()].filter(rec => !rec.isBuy && charSet.has(rec.characterId));
		matchSales(allSales, groupBy(sellLogs, rec => `${rec.characterId}:${rec.typeId}`));
		const salesByType = groupBy(allSales, s => s.typeId);
		const ambiguous = allSales.filter(s => s.orderMatch === 'ambiguous').length;
		if (ambiguous > 0) warnings.push(`${ambiguous} sale(s) match more than one order at their price; left unmatched`);

		// rule 8, the fill account behind pending fills, per character and type, since logging began (the
		// character's first logged orders answer, less its cache time): each order's drops less the sales
		// matched to it; the sales matched to no order (and any excess matched to one) are then taken
		// from those remainders, oldest drop first. So the type's pending units never exceed its drops
		// less all of the character's sales of it since logging began.
		const logStartByChar = new Map();
		for (const rec of logById.values()) {
			if (rec.synthetic || rec.firstSeenMs === null) continue;
			const cur = logStartByChar.get(rec.characterId);
			if (cur === undefined || rec.firstSeenMs < cur) logStartByChar.set(rec.characterId, rec.firstSeenMs);
		}
		const openById = new Map(open.map(x => [x.o.orderId, x]));
		const salesByCharType = groupBy(allSales, s => `${s.characterId}:${s.typeId}`);
		const accountById = new Map();
		for (const [key, recs] of groupBy(sellLogs, rec => `${rec.characterId}:${rec.typeId}`)) {
			const logStart = logStartByChar.get(recs[0].characterId);
			if (logStart === undefined) continue;
			const typeSales = (salesByCharType.get(key) || []).filter(s => s.ms > logStart - ORDERS_CACHE_MS);
			const accounts = recs.map(rec => {
				const x = openById.get(rec.orderId);
				const drops = rec.synthetic ? [] : dropsOf(rec, logStart, x ? x.volumeRemain : null, ordersAsOf === null ? nowMs : ordersAsOf);
				const filledPerLog = sum(drops, d => d.units);
				const filledPerTx = sum(typeSales.filter(s => s.orderId === rec.orderId), s => s.qty);
				return { orderId: rec.orderId, drops, filledPerLog, filledPerTx, allocated: 0, residual: filledPerLog - filledPerTx };
			});
			let unexplained = sum(typeSales.filter(s => s.orderId === null), s => s.qty) + sum(accounts, a => Math.max(0, -a.residual));
			for (const a of accounts) a.residual = Math.max(0, a.residual);
			const byOldestDrop = accounts.filter(a => a.residual > 0).sort((a, b) => a.drops[0].atMs - b.drops[0].atMs || a.orderId - b.orderId);
			for (const a of byOldestDrop) {
				const take = Math.min(a.residual, unexplained);
				a.residual -= take;
				a.allocated += take;
				unexplained -= take;
			}
			for (const a of accounts) accountById.set(a.orderId, a);
		}
		const newestSaleByOrder = new Map();
		for (const s of allSales) if (s.orderId !== null && (!newestSaleByOrder.has(s.orderId) || s.ms > newestSaleByOrder.get(s.orderId))) newestSaleByOrder.set(s.orderId, s.ms);

		// rule 6 / decision 15: each pooled character's relist-fee rate, per station and over all of them,
		// from its sell orders' fee rows (facts.relists) against their price paths (the order log, else
		// the relist facts' own pricePath)
		const observationsByChar = new Map();
		for (const r of relists) {
			const cid = idNum(r.characterId);
			const orderId = idNum(r.orderId);
			if (r.isBuy === true || !charSet.has(cid) || orderId === null) continue;
			const rec = logById.get(orderId);
			const logged = rec !== undefined && !rec.synthetic && rec.characterId === cid;
			const path = logged ? rec.path : parsePath(r.pricePath);
			const locationId = logged && rec.locationId !== null ? rec.locationId : idNum(r.locationId);
			const typeId = logged && rec.typeId !== null ? rec.typeId : idNum(r.typeId);
			for (const ob of feeObservationsOf(r, path)) {
				if (!observationsByChar.has(cid)) observationsByChar.set(cid, []);
				observationsByChar.get(cid).push({ ...ob, orderId, typeId, locationId });
			}
		}
		const feeRates = {};
		const feeRateAll = new Map();
		for (const [cid, list] of observationsByChar) {
			feeRates[cid] = {};
			for (const [locationId, atStation] of groupBy(list, ob => ob.locationId)) feeRates[cid][locationId] = feeRateOf(atStation);
			feeRateAll.set(cid, feeRateOf(list));
		}

		// rows (rules 1-7)
		const landedByType = new Map();
		const landedOf = (typeId) => {
			if (!landedByType.has(typeId)) landedByType.set(typeId, landedCostOf(lots, typeId));
			return landedByType.get(typeId);
		};
		const relistById = new Map(relists.map(r => [idNum(r.orderId), r]));
		const rows = [];
		let noLog = 0;
		for (const x of open) {
			const { o, rec } = x;
			const typeId = o.typeId;
			const badges = [];
			if (!x.hasLog) {
				badges.push('nolog');
				noLog++;
			}

			// rule 1
			const relist = relistById.get(o.orderId) || null;
			const fees = relist ? feesOf(relist) : [];
			const firstIssued = rec.path.reduce((acc, e) => (e.issuedMs === null ? acc : acc === null ? e.issuedMs : Math.min(acc, e.issuedMs)), null);
			const listedSince = [rec.firstSeenMs, firstIssued, relist ? toMs(relist.firstSeenAt) : null]
				.filter(ms => ms !== null).reduce((acc, ms) => (acc === null ? ms : Math.min(acc, ms)), null);
			// the last fill: an observed drop the wallet has not covered yet, else the newest matched sale,
			// else the last observed drop (an observation time: up to one refresh after the sale)
			const account = accountById.get(o.orderId) || null;
			const lastObserved = account !== null && account.drops.length > 0 ? account.drops[account.drops.length - 1].atMs : null;
			const newestSale = newestSaleByOrder.has(o.orderId) ? newestSaleByOrder.get(o.orderId) : null;
			const lastFill = account !== null && account.residual > 0 ? { ms: lastObserved, observed: true }
				: newestSale !== null ? { ms: newestSale, observed: false }
				: lastObserved !== null ? { ms: lastObserved, observed: true } : { ms: null, observed: false };

			// rule 2 / 3
			const bookEntry = isObj(books[typeId]) && x.regionId !== null ? books[typeId][x.regionId] : null;
			const book = isObj(bookEntry) && Array.isArray(bookEntry.orders) ? bookEntry : null;
			if (book === null) badges.push('nobook');
			const log = bookLogOf(typeId, x.regionId);
			if (log === null) badges.push('nobooklog');
			const firstBelow = (orderId) => {
				if (log === null || x.issuedMs === null || !log.byId.has(orderId)) return null;
				let best = null;
				for (const e of log.byId.get(orderId).path) {
					if (e.price !== null && e.issuedMs !== null && e.price < o.price && e.issuedMs > x.issuedMs && (best === null || e.issuedMs < best)) best = e.issuedMs;
				}
				return best;
			};
			const pos = book === null ? null : positionOf(o, book.orders, ownIds, t.scope, firstBelow);
			let reUndercuts = null;
			let priceWar = false;
			if (pos !== null && pos.undercutBy !== null && log !== null && log.byId.has(pos.undercutBy.orderId)) {
				const re = reUndercutsOf(log.byId.get(pos.undercutBy.orderId).path, o.price, x.issuedMs);
				reUndercuts = re.count;
				priceWar = re.priceWar;
			}
			if (priceWar) badges.push('priceWar');

			// rule 4
			const hist = history[typeId];
			const dailyVolume = dailyVolumeOf(hist, nowMs, t);
			if (dailyVolume === null) badges.push('nohistory');
			const ownSales = salesByType.get(typeId) || [];
			const trade = typicalTradeOf(ownSales, hist, nowMs, t);
			const daysBehind = pos !== null && dailyVolume !== null && dailyVolume > 0 ? pos.unitsAhead / dailyVolume : null;
			const myRate7d = sum(ownSales.filter(s => s.ms > nowMs - RATE_MS && s.ms <= nowMs), s => s.qty) / 7;

			// rule 5
			const stats = statsByTypeLoc.get(`${typeId}:${o.locationId}`) || { episodes: 0, undercutEpisodes: 0, medianTimeOnTop: null, est: false };
			if (stats.est) badges.push('est');
			const currentEp = episodes.find(e => e.orderId === o.orderId && e.current) || null;
			const onTopFor = pos !== null && pos.ordersAhead === 0 && !(currentEp && currentEp.undercut) && x.issuedMs !== null
				? nowMs - x.issuedMs : null;

			// rule 6
			const { landedCost, units: landedUnits } = landedOf(typeId);
			if (landedCost === null) badges.push('nocost');
			const matchPrice = pos !== null && pos.ordersAhead > 0 ? pos.bestPrice - 0.01 : null;
			// decision 15: the character's rate at this station, else over all its stations, times the
			// value left at the match price (the order's own price on a top row); else the old medians
			const stationRates = feeRates[x.characterId] || {};
			const rate = stationRates[o.locationId] !== undefined ? { ...stationRates[o.locationId], scope: 'station' }
				: feeRateAll.has(x.characterId) ? { ...feeRateAll.get(x.characterId), scope: 'character' } : null;
			const fee = rate !== null && x.volumeRemain !== null
				? { feeEstimate: rate.rate * (matchPrice !== null ? matchPrice : o.price) * x.volumeRemain, from: 'rate' }
				: feeEstimateOf(relists, o.orderId, x.characterId, typeId);
			if (fee.feeEstimate === null) badges.push('nofee');
			const marginNow = landedCost === null ? null : o.price * (1 - taxRate) - landedCost;
			const marginIfMatch = landedCost === null || matchPrice === null ? null : matchPrice * (1 - taxRate) - landedCost;
			const roiIfMatch = marginIfMatch === null || !(landedCost > 0) ? null : marginIfMatch / landedCost;
			// capped at our remaining units: we cannot sell more than we list
			const expectedSalesBeforeUndercut = dailyVolume === null || stats.medianTimeOnTop === null ? null
				: Math.min(dailyVolume * stats.medianTimeOnTop / DAY_MS, x.volumeRemain === null ? Infinity : x.volumeRemain);
			const expectedGainBeforeUndercut = expectedSalesBeforeUndercut === null || marginIfMatch === null ? null : expectedSalesBeforeUndercut * marginIfMatch;

			const row = {
				orderId: o.orderId, characterId: x.characterId, typeId, locationId: o.locationId, regionId: x.regionId, stationName: x.stationName,
				price: o.price, volumeRemain: x.volumeRemain, volumeTotal: x.volumeTotal, issued: iso(x.issuedMs),
				firstSeen: iso(rec.firstSeenMs), listedSince: iso(listedSince), listedFor: listedSince === null ? null : nowMs - listedSince,
				relistCount: x.hasLog ? priceChanges(rec.path) : null,
				relistFees: relist ? sum(fees.slice(1), f => f.cost) : null,
				listingFee: fees.length > 0 ? fees[0].cost : null,
				feeTotal: relist && num(relist.feeTotal) !== null ? relist.feeTotal : (relist ? sum(fees, f => f.cost) : null),
				lastFillAt: iso(lastFill.ms),
				lastFillObserved: lastFill.observed,

				bookFetchedAt: book === null ? null : iso(toMs(book.fetchedAt)),
				unitsAhead: pos === null ? null : pos.unitsAhead,
				ordersAhead: pos === null ? null : pos.ordersAhead,
				rank: pos === null ? null : pos.rank,
				bestPrice: pos === null ? null : pos.bestPrice,
				gapToBest: pos === null ? null : pos.gapToBest,
				cheaperElsewhere: pos === null ? null : pos.cheaperElsewhere,
				ownAhead: pos === null ? null : pos.ownAhead,

				undercutAt: pos === null ? null : iso(pos.undercutAt),
				undercutBy: pos === null ? null : pos.undercutBy,
				reUndercuts, priceWar,

				dailyVolume, typicalTrade: trade.typicalTrade, typicalTradeFrom: trade.from, daysBehind, myRate7d,

				episodes: stats.episodes, undercutEpisodes: stats.undercutEpisodes, medianTimeOnTop: stats.medianTimeOnTop,
				timeOnTopEst: stats.est, onTopFor,

				taxRate, landedCost, landedUnits, marginNow, matchPrice, marginIfMatch, roiIfMatch,
				feeEstimate: fee.feeEstimate, feeEstimateFrom: fee.from,
				feeRate: rate === null ? null : rate.rate, feeRateRows: rate === null ? 0 : rate.rows,
				feeRateSince: rate === null ? null : rate.since, feeRateScope: rate === null ? null : rate.scope,
				feeRateEst: rate !== null && rate.est,
				expectedSalesBeforeUndercut, expectedGainBeforeUndercut
			};
			const v = verdictOf(row, t);
			row.verdict = v.verdict;
			row.reason = v.reason;
			row.badges = badges;
			rows.push(row);
		}
		rows.sort(compareRows);
		if (noLog > 0) warnings.push(`${noLog} open order(s) have no order log yet`);

		// rule 5 output
		const byType = {};
		for (const [typeId, list] of groupBy(episodes, e => e.typeId)) {
			const stats = timeOnTopStats(list);
			const onTop = rows.filter(r => r.typeId === typeId && r.onTopFor !== null).map(r => r.onTopFor);
			const sinces = [];
			for (const [key, log] of bookLogCache) if (log !== null && key.startsWith(`${typeId}:`) && log.samples.length > 0) sinces.push(log.samples[0]);
			byType[typeId] = {
				...stats,
				onTopFor: onTop.length > 0 ? Math.max(...onTop) : null,
				bookLogSince: sinces.length > 0 ? iso(Math.min(...sinces)) : null,
				list: list.slice().sort((a, b) => a.startMs - b.startMs || a.orderId - b.orderId).map(e => ({
					orderId: e.orderId, characterId: e.characterId, locationId: e.locationId, price: e.price,
					start: iso(e.startMs), end: iso(e.endMs), current: e.current, undercut: e.undercut,
					undercutAt: iso(e.undercutAtMs), undercutBy: e.undercutBy, undercutPrice: e.undercutPrice, timeOnTop: e.timeOnTop
				}))
			};
		}
		const timeOnTop = { overall: timeOnTopStats(episodes), byType };

		// rule 8: the window
		const startMs = nowMs - t.windowMs;
		const inWindow = (ms) => ms !== null && ms >= startMs && ms <= nowMs;
		const windowSales = allSales.filter(s => inWindow(s.ms)).sort((a, b) => b.ms - a.ms || (a.sellTxId || 0) - (b.sellTxId || 0));
		const outByInternal = new Map(windowSales.map(s => [s, saleOut(s)]));
		const sales = windowSales.map(s => outByInternal.get(s));
		const salesClusters = clusterSales(windowSales.map(s => ({ ms: s.ms, sale: outByInternal.get(s) })), t.clusterGapMs);

		// pending fills: per open order, what is left of its fill account (above), dated at its last drop
		const pending = [];
		for (const x of open) {
			const a = accountById.get(x.o.orderId);
			if (!x.hasLog || !a || !(a.residual > 0)) continue;
			const drop = a.drops[a.drops.length - 1];
			if (!inWindow(drop.atMs)) continue;
			const qty = a.residual;
			const unitPrice = drop.price !== null ? drop.price : x.o.price;
			const landed = landedOf(x.o.typeId).landedCost;
			pending.push({
				orderId: x.o.orderId, characterId: x.characterId, typeId: x.o.typeId, locationId: x.o.locationId,
				date: iso(drop.atMs), observed: true, qty, unitPrice, gross: qty * unitPrice,
				filledPerLog: a.filledPerLog, filledPerTx: a.filledPerTx, allocated: a.allocated,
				estNet: qty * unitPrice * (1 - taxRate),
				estProfit: landed === null ? null : qty * (unitPrice * (1 - taxRate) - landed),
				ms: drop.atMs
			});
		}
		pending.sort((a, b) => b.ms - a.ms || a.orderId - b.orderId);
		for (const p of pending) delete p.ms;

		// rule 9: share of the regional volume, by type and UTC day, whole days on both sides (a day not
		// yet in the history has no volume)
		const days = windowDays(nowMs, t.windowMs);
		const dayQty = new Map(); // `${typeId}:${day}` -> our units that whole day
		for (const s of allSales) {
			const k = `${s.typeId}:${dayKey(s.ms)}`;
			dayQty.set(k, (dayQty.get(k) || 0) + s.qty);
		}
		const salesByTypeDay = [];
		for (const [key, list] of groupBy(windowSales, s => `${s.typeId}:${dayKey(s.ms)}`)) {
			const typeId = list[0].typeId;
			const day = dayKey(list[0].ms);
			const byDay = historyByDay(history[typeId]);
			const volume = byDay.has(day) ? byDay.get(day) : null;
			const whole = dayQty.get(key) || 0;
			salesByTypeDay.push({
				typeId, day, count: list.length, qty: sum(list, s => s.qty), gross: sum(list, s => s.gross),
				net: sum(list, s => s.net), profit: sum(list, s => s.profit),
				dayQty: whole, volume, share: volume !== null && volume > 0 ? whole / volume : null
			});
		}
		salesByTypeDay.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.typeId - b.typeId));

		// overall: over exactly the type-day rows above that have a volume, so it agrees with the table
		const withVolume = salesByTypeDay.filter(r => r.volume !== null && r.volume > 0);
		const tableQty = sum(withVolume, r => r.dayQty);
		const tableVolume = sum(withVolume, r => r.volume);
		// byType and window: every day of the window that has a history row, for every type listed or sold,
		// days we sold nothing included
		const shareTypes = [...new Set([...rows.map(r => r.typeId), ...windowSales.map(s => s.typeId)])].sort((a, b) => a - b);
		const shareByType = {};
		let windowQty = 0;
		let windowVolume = 0;
		for (const typeId of shareTypes) {
			const hist = history[typeId];
			if (!Array.isArray(hist) || hist.length === 0) {
				shareByType[typeId] = { share: null, qty: null, volume: null, days: [] };
				continue;
			}
			const byDay = historyByDay(hist);
			const covered = days.filter(d => byDay.has(d));
			const qty = sum(covered, d => dayQty.get(`${typeId}:${d}`) || 0);
			const volume = sum(covered, d => byDay.get(d));
			shareByType[typeId] = { share: volume > 0 ? qty / volume : null, qty, volume, days: covered };
			if (volume > 0) {
				windowQty += qty;
				windowVolume += volume;
			}
		}
		const share = {
			overall: { share: tableVolume > 0 ? tableQty / tableVolume : null, qty: tableQty, volume: tableVolume },
			window: { share: windowVolume > 0 ? windowQty / windowVolume : null, qty: windowQty, volume: windowVolume },
			byType: shareByType
		};

		// totals: relist fees are the fee rows after each order's first, dated inside the window
		let relistFees = 0;
		for (const r of relists) {
			if (r.isBuy === true || !charSet.has(idNum(r.characterId))) continue;
			for (const f of feesOf(r).slice(1)) if (inWindow(f.ms)) relistFees += f.cost;
		}
		const totals = {
			count: windowSales.length,
			units: sum(windowSales, s => s.qty),
			gross: sum(windowSales, s => s.gross),
			net: sum(windowSales, s => s.net),
			profit: sum(windowSales, s => s.profit),
			relistFees,
			pendingUnits: sum(pending, p => p.qty),
			share: share.overall.share
		};

		// asOf
		let booksAsOf = null;
		for (const [, byRegion] of entriesOf(books)) for (const [, b] of entriesOf(byRegion)) if (isObj(b)) booksAsOf = maxOf(booksAsOf, toMs(b.fetchedAt));
		for (const [typeId, byRegion] of entriesOf(bookLogs)) {
			for (const [regionId] of entriesOf(byRegion)) {
				const log = bookLogOf(idNum(typeId), idNum(regionId));
				if (log !== null && log.samples.length > 0) booksAsOf = maxOf(booksAsOf, log.samples[log.samples.length - 1]);
			}
		}
		const txAsOf = allSales.reduce((acc, s) => maxOf(acc, s.ms), null);

		return {
			rows, sales, salesClusters, pending, salesByTypeDay, share, timeOnTop, totals, feeRates,
			asOf: { orders: iso(ordersAsOf), books: iso(booksAsOf), transactions: iso(txAsOf) },
			warnings, taxRate, thresholds: t
		};
	};

	return {
		defaultThresholds,
		compute,
		// exposed for tests
		_internal: {
			toMs, iso, median, recencyWeight, dayAge, priceAt, priceChanges, openSpanOf, dropsOf, episodesOf, firstUndercut,
			reUndercutsOf, positionOf, dailyVolumeOf, typicalTradeOf, landedCostOf, feeObservationsOf, feeRateOf, feeEstimateOf, verdictOf,
			compareRows, mergeSales, clusterSales, windowDays
		}
	};
});
