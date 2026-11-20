// insights-calc.js: what each chart of the insights page (insights.html) groups out of the results
// module's fact table. Pure: no DOM, no network, no clock (callers pass `now`), so it runs under
// `node --test` and loads in the page with a plain <script>. Phase 8 of docs/trade-results-plan.md.
//
// Browser: <script src="insights-calc.js"></script> defines `window.insightsCalc`.
// Node:    const insightsCalc = require('./public/insights-calc.js');
//
// The inputs are the shapes results-calc.js returns: `types` rows (per item), `facts.sells`
// (one row per sell allocation), `facts.lots`, `batches`, `couriers`, and the saved runs. A chart
// never does accounting of its own: it sums, bins or orders these rows and nothing else.
(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory();
	else root.insightsCalc = factory();
})(typeof self !== 'undefined' ? self : this, () => {
	const DAY_MS = 24 * 60 * 60 * 1000;

	const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
	const num = (v) => (isNum(v) ? v : 0);
	const sum = (list, f) => list.reduce((acc, x) => acc + f(x), 0);
	const toMs = (v) => {
		if (isNum(v)) return v;
		if (typeof v !== 'string') return null;
		const ms = Date.parse(v);
		return Number.isFinite(ms) ? ms : null;
	};

	//--- 1. cost waterfall

	// Gross sales -> sales tax -> listing fees -> relist fees -> haul -> buy cost -> net profit, from
	// the per-item rows of the window (what the results page's totals strip sums). The haul and the
	// buy cost are those of the units sold (the cost of goods sold), because that is what takes the
	// gross to the realized profit; the strip's "haul" is what was paid in the window, a larger
	// figure while stock waits unsold, and its "spent" is everything bought. Buy-order fees are part
	// of the buy cost. The rows of the "unplanned batches" view carry no listing/relist split, so
	// that view passes its sell rows (`unplanned: true`) and the split comes from their shares.
	const waterfall = ({ rows = [], sells = [], unplanned = false } = {}) => {
		const gross = sum(rows, r => num(r.gross));
		const tax = sum(rows, r => num(r.tax));
		let listing;
		let relist;
		if (unplanned) {
			listing = sum(sells, s => num(s.brokerShare));
			relist = sum(sells, s => num(s.relistShare));
		} else {
			listing = sum(rows, r => num(r.brokerListing) + num(r.brokerBuyUnfilled));
			relist = sum(rows, r => num(r.brokerRelist) + num(r.brokerEst));
		}
		const haul = sum(rows, r => num(r.haul));
		const buyCost = sum(rows, r => num(r.buyCost));
		const buyFee = sum(rows, r => num(r.buyFee));
		const net = sum(rows, r => num(r.realizedProfit));
		const costs = [
			{ key: 'tax', label: 'Sales tax', amount: tax },
			{ key: 'listing', label: 'Listing fees', amount: listing },
			{ key: 'relist', label: 'Relist fees', amount: relist },
			{ key: 'haul', label: 'Haul', amount: haul },
			{ key: 'buy', label: 'Buy cost', amount: buyCost + buyFee }
		];
		const steps = [{ key: 'gross', label: 'Gross sales', amount: gross, start: 0, end: gross, kind: 'total' }];
		let level = gross;
		for (const c of costs) {
			steps.push({ ...c, start: level, end: level - c.amount, kind: 'cost' });
			level -= c.amount;
		}
		steps.push({ key: 'net', label: 'Net profit', amount: net, start: 0, end: net, kind: 'total' });
		const ends = steps.flatMap(s => [s.start, s.end]);
		return {
			steps, gross, tax, listing, relist, broker: listing + relist, haul, buyCost, buyFee, buy: buyCost + buyFee, net,
			residual: level - net, // 0 when the rows add up (they do: realized = gross - tax - broker - cogs)
			min: Math.min(0, ...ends), max: Math.max(0, ...ends),
			soldQty: sum(rows, r => num(r.soldQty))
		};
	};

	//--- 2. sales heatmap

	const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

	// Weekday (Monday first) x hour of day, by sell allocation: ISK (gross), units, and sales (a sell
	// transaction split over several lots counts once). `utc` bins in EVE time, else in local time.
	const heat = (sells = [], { utc = true } = {}) => {
		const cells = Array.from({ length: 7 * 24 }, (_, i) => ({ weekday: Math.floor(i / 24), hour: i % 24, isk: 0, units: 0, sales: 0 }));
		const seen = cells.map(() => new Set());
		for (const s of sells) {
			const ms = toMs(s.date);
			if (ms === null) continue;
			const d = new Date(ms);
			const wd = ((utc ? d.getUTCDay() : d.getDay()) + 6) % 7;
			const hour = utc ? d.getUTCHours() : d.getHours();
			const i = wd * 24 + hour;
			cells[i].isk += isNum(s.gross) ? s.gross : num(s.unitPrice) * num(s.qty);
			cells[i].units += num(s.qty);
			seen[i].add(`${s.characterId}:${s.sellTxId}`);
		}
		cells.forEach((c, i) => { c.sales = seen[i].size; });
		const best = (key) => cells.reduce((b, c) => (c[key] > 0 && (b === null || c[key] > b[key]) ? c : b), null);
		return {
			cells,
			totals: { isk: sum(cells, c => c.isk), units: sum(cells, c => c.units), sales: sum(cells, c => c.sales) },
			max: { isk: Math.max(0, ...cells.map(c => c.isk)), units: Math.max(0, ...cells.map(c => c.units)) },
			top: { isk: best('isk'), units: best('units') }
		};
	};

	//--- 3. sell-through curves

	// Per batch: the cumulative share of its units sold against days since the courier delivered
	// them. A batch's units are those of its lots (what the books could trace to a purchase, so an
	// unsourced item is not in the denominator). Sales dated before the delivery are drawn at day 0
	// and counted in `early`. A batch with no delivered lot has no clock yet and goes to `pending`.
	// `predictedDays` is the longest days-to-clear the batch's run predicted for the batch's types.
	const sellThrough = ({ batches = [], lots = [], sells = [], runs = [], now } = {}) => {
		const series = [];
		const pending = [];
		const lotsOf = new Map();
		for (const l of lots) {
			if (l.batchId === null || l.batchId === undefined) continue;
			if (!lotsOf.has(l.batchId)) lotsOf.set(l.batchId, []);
			lotsOf.get(l.batchId).push(l);
		}
		const sellsOf = new Map();
		for (const s of sells) {
			if (s.batchId === null || s.batchId === undefined) continue;
			if (!sellsOf.has(s.batchId)) sellsOf.set(s.batchId, []);
			sellsOf.get(s.batchId).push(s);
		}
		const ordered = batches.slice().sort((a, b) => (toMs(a.dateIssued) || 0) - (toMs(b.dateIssued) || 0) || a.batchId - b.batchId);
		for (const b of ordered) {
			const bl = lotsOf.get(b.batchId) || [];
			const units = sum(bl, l => l.qty);
			if (units <= 0) continue;
			const arrivals = bl.map(l => toMs(l.arrivedAt)).filter(ms => ms !== null);
			const arrivedMs = arrivals.length > 0 ? Math.min(...arrivals) : null;
			const base = { batchId: b.batchId, runId: b.runId === undefined ? null : b.runId, issuedAt: b.dateIssued, units, types: b.items.length };
			if (arrivedMs === null) {
				pending.push(base);
				continue;
			}
			const own = (sellsOf.get(b.batchId) || []).map(s => ({ ms: toMs(s.date), qty: s.qty })).filter(s => s.ms !== null).sort((a, c) => a.ms - c.ms);
			const points = [{ day: 0, share: 0, sold: 0 }];
			let cum = 0;
			let early = 0;
			for (const s of own) {
				cum += s.qty;
				if (s.ms < arrivedMs) early += s.qty;
				points.push({ day: Math.max(0, (s.ms - arrivedMs) / DAY_MS), share: Math.min(1, cum / units), sold: cum });
			}
			const soldOut = cum >= units - 1e-9;
			const lastDay = points[points.length - 1].day;
			const nowDay = isNum(now) ? Math.max(0, (now - arrivedMs) / DAY_MS) : lastDay;
			const endDay = soldOut ? lastDay : Math.max(lastDay, nowDay);
			const firstDayAt = (share) => { const p = points.find(x => x.share >= share - 1e-9 && x.share > 0); return p ? p.day : null; };
			let predictedDays = null;
			const run = b.runId ? runs.find(r => r.id === b.runId) : null;
			if (run) {
				const wanted = new Set(b.items.map(it => it.typeId));
				const days = (run.rows || []).filter(r => wanted.has(r.typeId) && isNum(r.daysToClear)).map(r => r.daysToClear);
				if (days.length > 0) predictedDays = Math.max(...days);
			}
			series.push({
				...base, arrivedAt: new Date(arrivedMs).toISOString(), points, sold: cum, soldShare: Math.min(1, cum / units), soldOut,
				early, endDay, days50: firstDayAt(0.5), days100: soldOut ? lastDay : null, predictedDays
			});
		}
		return { series, pending };
	};

	// The cumulative share of a series at `day` (a step function: it holds until the next sale).
	const shareAt = (series, day) => {
		let share = 0;
		for (const p of series.points) {
			if (p.day <= day + 1e-9) share = p.share;
			else break;
		}
		return share;
	};

	//--- 4. prediction calibration

	// One point per (run, item) that the run listed: the prediction's profit per item against the
	// realized profit per unit sold, and its days to clear against the days the item took (sold out)
	// or is projected to take (still stock left). `runs` is [{run, rows}]: the saved run and the
	// per-item rows compute() returned for that run's window (they carry `predicted`).
	const calibration = (runs = []) => {
		const points = [];
		for (const { run, rows } of runs) {
			for (const r of rows || []) {
				const p = r.predicted;
				if (!p || !p.listed) continue;
				const plan = (run.rows || []).find(x => x.typeId === r.typeId);
				const planProfit = plan && isNum(plan.profitPerItemMil) ? plan.profitPerItemMil * 1e6 : null;
				const hasProfit = planProfit !== null && r.soldQty > 0;
				const actualDays = r.soldOut ? r.daysOnMarket : r.projectedDaysToClear;
				const hasDays = isNum(p.daysToClear) && isNum(actualDays);
				points.push({
					runId: run.id, copiedAt: run.copiedAt, typeId: r.typeId, soldQty: r.soldQty, boughtQty: r.boughtQty, soldOut: !!r.soldOut,
					predictedProfit: hasProfit ? planProfit : null,
					realizedProfit: hasProfit ? r.realizedProfit / r.soldQty : null,
					predictedDays: hasDays ? p.daysToClear : null,
					actualDays: hasDays ? actualDays : null,
					projected: hasDays && !r.soldOut
				});
			}
		}
		return points;
	};

	//--- 5. capital at work

	const CAPITAL_SERIES = ['wallet', 'escrow', 'source', 'transit', 'dest', 'listed'];
	const dayStart = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;

	// Assets of one snapshot at the two stations, containers resolved through item_id, and the
	// open orders: sell orders at the destination (listed), buy-order escrow. Cached per snapshot.
	const snapshotView = (() => {
		const cache = new WeakMap();
		return (snap, S, D) => {
			const key = `${S}:${D}`;
			let byKey = cache.get(snap);
			if (!byKey) cache.set(snap, byKey = new Map());
			if (byKey.has(key)) return byKey.get(key);
			const source = new Map();
			const dest = new Map();
			const listed = new Map();
			const assets = snap.assets || [];
			const byItem = new Map(assets.map(a => [a.item_id, a]));
			for (const a of assets) {
				let loc = a.location_id;
				let type = a.location_type;
				for (let guard = 0; type === 'item' && byItem.has(loc) && guard < 20; guard++) {
					const parent = byItem.get(loc);
					loc = parent.location_id;
					type = parent.location_type;
				}
				if (loc === S) source.set(a.type_id, (source.get(a.type_id) || 0) + num(a.quantity));
				else if (loc === D) dest.set(a.type_id, (dest.get(a.type_id) || 0) + num(a.quantity));
			}
			let escrow = 0;
			for (const o of snap.orders || []) {
				if (o.is_buy_order === true) escrow += num(o.escrow);
				else if (o.location_id === D) listed.set(o.type_id, (listed.get(o.type_id) || 0) + num(o.volume_remain));
			}
			const view = { source, dest, listed, escrow, wallet: num(snap.balance) };
			byKey.set(key, view);
			return view;
		};
	})();

	// ISK at work by day (UTC), from the retained snapshots of the linked characters. Per day each
	// character's newest snapshot at or before the day's end counts (carried forward until the next
	// one). The chart starts on the first day every character that has snapshots has one.
	//   wallet   the wallet balance
	//   escrow   what open buy orders hold in escrow
	//   source   assets at the source station, at cost (buy price + buy-order fee per unit)
	//   transit  units in open courier contracts at that time, at cost plus haul
	//   dest     assets at the destination station, at cost plus haul
	//   listed   open sell orders at the destination, at cost plus haul
	// Cost per unit: the units of an item that are physically there (all five places together) are
	// the newest ones the lots bought up to that moment can account for (FIFO sells the oldest
	// first), and their weighted average cost is the item's cost per unit then. Units no lot
	// accounts for are not valued (counted in `unvaluedUnits`). Courier and hand-off cost already
	// paid shows once the units are out of the source (the lot's `haulPerUnit`).
	const capital = ({ snapshots = {}, lots = [], couriers = [], route = {}, fromMs = null, toMs: toMsIn = null } = {}) => {
		const S = route.startStationId;
		const D = route.endStationId;
		const chars = [];
		for (const [id, list] of Object.entries(snapshots)) {
			const snaps = (list || []).filter(s => toMs(s.syncedAt) !== null).slice().sort((a, b) => toMs(a.syncedAt) - toMs(b.syncedAt));
			if (snaps.length > 0) chars.push({ id: Number(id), snaps });
		}
		if (chars.length === 0) return { days: [], characters: [], note: 'no snapshots' };
		const lastSnapMs = Math.max(...chars.map(c => toMs(c.snaps[c.snaps.length - 1].syncedAt)));
		const toDay = dayStart(isNum(toMsIn) ? toMsIn : lastSnapMs);
		const firstDays = chars.map(c => dayStart(toMs(c.snaps[0].syncedAt)));
		let startDay = Math.max(...firstDays);
		if (isNum(fromMs)) startDay = Math.max(startDay, dayStart(fromMs));
		const earliest = Math.min(...firstDays);
		const lotsByType = new Map();
		for (const l of lots) {
			const ms = toMs(l.date);
			if (ms === null || !(l.qty > 0)) continue;
			if (!lotsByType.has(l.typeId)) lotsByType.set(l.typeId, []);
			lotsByType.get(l.typeId).push({ ms, qty: l.qty, buy: num(l.unitPrice) + num(l.buyFeePerUnit), haul: num(l.haulPerUnit), id: l.lotId });
		}
		for (const list of lotsByType.values()) list.sort((a, b) => b.ms - a.ms || String(b.id).localeCompare(String(a.id)));
		const live = couriers.filter(k => !k.dead && !k.failed);
		const days = [];
		for (let d = startDay; d <= toDay; d += DAY_MS) {
			const t = Math.min(d + DAY_MS - 1, isNum(toMsIn) ? toMsIn : d + DAY_MS - 1);
			let wallet = 0;
			let escrow = 0;
			const qty = { source: new Map(), transit: new Map(), dest: new Map(), listed: new Map() };
			const add = (m, typeId, q) => { if (q > 0) m.set(typeId, (m.get(typeId) || 0) + q); };
			let counted = 0;
			for (const c of chars) {
				let snap = null;
				for (const s of c.snaps) {
					if (toMs(s.syncedAt) <= t) snap = s;
					else break;
				}
				if (!snap) continue;
				counted++;
				const v = snapshotView(snap, S, D);
				wallet += v.wallet;
				escrow += v.escrow;
				for (const [typeId, q] of v.source) add(qty.source, typeId, q);
				for (const [typeId, q] of v.dest) add(qty.dest, typeId, q);
				for (const [typeId, q] of v.listed) add(qty.listed, typeId, q);
			}
			for (const k of live) {
				const issued = toMs(k.dateIssued);
				const done = toMs(k.dateCompleted);
				if (issued === null || issued > t || (done !== null && done <= t)) continue;
				if (done === null && k.arrived) continue;
				for (const it of k.carried || []) add(qty.transit, it.typeId, it.qty);
			}
			const typeIds = new Set();
			for (const m of Object.values(qty)) for (const id of m.keys()) typeIds.add(id);
			const value = { source: 0, transit: 0, dest: 0, listed: 0 };
			let unvaluedUnits = 0;
			const unvaluedTypes = new Set();
			for (const typeId of typeIds) {
				const total = sum(Object.values(qty), m => m.get(typeId) || 0);
				let need = total;
				let buy = 0;
				let landed = 0;
				for (const l of lotsByType.get(typeId) || []) {
					if (l.ms > t || need <= 0) continue;
					const take = Math.min(l.qty, need);
					buy += take * l.buy;
					landed += take * (l.buy + l.haul);
					need -= take;
				}
				const taken = total - need;
				if (need > 0) {
					unvaluedUnits += need;
					unvaluedTypes.add(typeId);
				}
				if (taken <= 0) continue;
				// units no lot accounts for stay out of the value: each place keeps its valued share
				const valued = taken / total;
				const avgBuy = buy / taken * valued;
				const avgLanded = landed / taken * valued;
				value.source += (qty.source.get(typeId) || 0) * avgBuy;
				value.transit += (qty.transit.get(typeId) || 0) * avgLanded;
				value.dest += (qty.dest.get(typeId) || 0) * avgLanded;
				value.listed += (qty.listed.get(typeId) || 0) * avgLanded;
			}
			const row = { day: d, wallet, escrow, source: value.source, transit: value.transit, dest: value.dest, listed: value.listed, unvaluedUnits, unvaluedTypes: unvaluedTypes.size, characters: counted };
			row.total = row.wallet + row.escrow + row.source + row.transit + row.dest + row.listed;
			days.push(row);
		}
		return {
			days,
			characters: chars.map(c => ({ id: c.id, firstAt: c.snaps[0].syncedAt, snapshots: c.snaps.length })),
			earlierThan: earliest < startDay ? earliest : null
		};
	};

	return { DAY_MS, WEEKDAYS, CAPITAL_SERIES, waterfall, heat, sellThrough, shareAt, calibration, capital };
});
