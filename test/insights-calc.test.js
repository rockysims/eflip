// Phase 8 of docs/trade-results-plan.md: what the insights page's charts group out of the fact table
// (public/insights-calc.js). Hand-written rows, shaped like what public/results-calc.js returns; the
// waterfall also runs against a real compute() on a tiny ledger, since its figures must equal the
// results page's totals.
const test = require('node:test');
const assert = require('node:assert/strict');
const resultsCalc = require('../public/results-calc.js');
const insights = require('../public/insights-calc.js');

const DAY = 24 * 60 * 60 * 1000;
const approx = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} !== ${expected} (±${eps})`);
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const T0 = Date.parse('2026-11-01T00:00:00Z');

//--- waterfall

test('waterfall: the steps run from gross sales down to the net profit and add up', () => {
	const rows = [
		{ gross: 1000, tax: 40, brokerListing: 10, brokerRelist: 5, brokerEst: 3, brokerBuyUnfilled: 2, haul: 60, buyCost: 500, buyFee: 20, realizedProfit: 360, soldQty: 5 },
		{ gross: 500, tax: 20, brokerListing: 0, brokerRelist: 0, brokerEst: 0, brokerBuyUnfilled: 0, haul: 30, buyCost: 400, buyFee: 0, realizedProfit: 50, soldQty: 2 }
	];
	const w = insights.waterfall({ rows });
	assert.deepEqual(w.steps.map(s => s.key), ['gross', 'tax', 'listing', 'relist', 'haul', 'buy', 'net']);
	assert.equal(w.gross, 1500);
	assert.equal(w.tax, 60);
	assert.equal(w.listing, 12); // listing fees plus buy orders that never filled
	assert.equal(w.relist, 8); // relists plus the estimated share of unmatched fees
	assert.equal(w.broker, 20);
	assert.equal(w.haul, 90);
	assert.equal(w.buy, 920); // buy cost plus buy-order fees
	assert.equal(w.net, 410);
	assert.equal(w.residual, 0);
	assert.deepEqual(w.steps.map(s => [s.start, s.end]), [[0, 1500], [1500, 1440], [1440, 1428], [1428, 1420], [1420, 1330], [1330, 410], [0, 410]]);
	assert.equal(w.min, 0);
	assert.equal(w.max, 1500);
});

test('waterfall: a loss draws the net profit below zero', () => {
	const w = insights.waterfall({ rows: [{ gross: 100, tax: 10, haul: 20, buyCost: 200, buyFee: 0, realizedProfit: -130, soldQty: 1 }] });
	assert.equal(w.net, -130);
	assert.equal(w.residual, 0);
	assert.equal(w.min, -130);
	assert.deepEqual([w.steps[5].start, w.steps[5].end], [70, -130]);
});

test('waterfall: the unplanned view takes the listing and relist split from its sell rows', () => {
	const rows = [{ gross: 300, tax: 10, broker: 9, brokerListing: null, brokerRelist: null, brokerEst: null, brokerBuyUnfilled: null, haul: 20, buyCost: 200, buyFee: 0, realizedProfit: 61, soldQty: 3 }];
	const sells = [{ brokerShare: 4, relistShare: 1 }, { brokerShare: 3, relistShare: 1 }];
	const w = insights.waterfall({ rows, sells, unplanned: true });
	assert.equal(w.listing, 7);
	assert.equal(w.relist, 2);
	assert.equal(w.residual, 0);
});

test('waterfall: the figures equal results-calc compute() totals for the same window', () => {
	const A = 91000001;
	const S = 60003760;
	const D = 60008494;
	const CLIENT = 94000001;
	const buyAt = '2026-11-01T10:00:00Z';
	const sellAt = '2026-11-02T10:00:00Z';
	const tx = (id, isBuy, qty, price, date, loc) => ({ client_id: CLIENT, date, is_buy: isBuy, is_personal: true, journal_ref_id: 0, location_id: loc, quantity: qty, transaction_id: id, type_id: 501, unit_price: price });
	const j = (id, amount, date, ref, extra = {}) => ({ id, amount, balance: 0, date, description: '', first_party_id: A, second_party_id: A, ref_type: ref, reason: '', ...extra });
	const ledger = {
		transactions: [tx(1, true, 100, 50, buyAt, S), tx(2, false, 60, 90, sellAt, D)],
		journal: [
			j(10, -5000, buyAt, 'market_escrow', { context_id: 1, context_id_type: 'market_transaction_id' }),
			j(20, 5400, sellAt, 'market_transaction', { context_id: 2, context_id_type: 'market_transaction_id' }),
			j(21, -405, sellAt, 'transaction_tax'),
			j(30, -120, '2026-11-02T09:00:00Z', 'brokers_fee')
		],
		ordersHistory: [], contracts: [], contractItems: {}, snapshots: []
	};
	const out = resultsCalc.compute({
		characterIds: [A], ledgers: { [A]: ledger },
		route: { startStationId: S, endStationId: D, startRegionId: 10000002, endRegionId: 10000043 },
		runs: [], m3: { 501: 1 }, window: { since: '2026-10-31T00:00:00Z' }, now: Date.parse('2026-11-05T00:00:00Z')
	});
	assert.equal(out.totals.soldQty, 60);
	const w = insights.waterfall({ rows: out.types });
	approx(w.gross, out.totals.gross);
	approx(w.tax, out.totals.tax);
	approx(w.broker, out.totals.broker);
	approx(w.haul, out.totals.haul);
	approx(w.net, out.totals.realizedProfit);
	approx(w.residual, 0, 1e-6);
	assert.equal(w.gross, 5400);
	assert.equal(w.buy, 3000);
});

//--- heatmap

test('heat: bins sells by weekday (Monday first) and hour, in EVE time or local time', () => {
	// 2026-11-16 is a Monday, 2026-11-22 a Sunday.
	const sells = [
		{ date: '2026-11-16T14:05:00Z', gross: 100, qty: 2, characterId: 1, sellTxId: 10 },
		{ date: '2026-11-16T14:55:00Z', gross: 50, qty: 1, characterId: 1, sellTxId: 11 },
		{ date: '2026-11-16T14:55:00Z', gross: 25, qty: 1, characterId: 1, sellTxId: 11 }, // the same sale split over two lots
		{ date: '2026-11-22T23:30:00Z', gross: 400, qty: 4, characterId: 2, sellTxId: 12 }
	];
	const h = insights.heat(sells, { utc: true });
	assert.equal(h.cells.length, 168);
	const mon14 = h.cells[0 * 24 + 14];
	assert.deepEqual([mon14.isk, mon14.units, mon14.sales], [175, 4, 2]);
	const sun23 = h.cells[6 * 24 + 23];
	assert.deepEqual([sun23.isk, sun23.units, sun23.sales], [400, 4, 1]);
	assert.deepEqual(h.totals, { isk: 575, units: 8, sales: 3 });
	assert.equal(h.top.isk.weekday, 6);
	assert.equal(h.max.units, 4);
	assert.equal(h.cells.filter(c => c.sales === 0).length, 166);
	// local time: the same instants, binned with the machine's own offset
	const local = insights.heat(sells, { utc: false });
	const d = new Date('2026-11-16T14:05:00Z');
	const idx = ((d.getDay() + 6) % 7) * 24 + d.getHours();
	assert.equal(local.cells[idx].isk >= 100, true);
	assert.equal(local.totals.isk, 575);
});

test('heat: an empty window gives 168 empty cells and no top cell', () => {
	const h = insights.heat([]);
	assert.equal(h.cells.length, 168);
	assert.equal(h.top.isk, null);
	assert.equal(h.totals.sales, 0);
});

//--- sell-through

const lot = (batchId, qty, arrivedAt, extra = {}) => ({ lotId: `${batchId}-${qty}`, batchId, qty, arrivedAt, typeId: 501, ...extra });
const sale = (batchId, date, qty) => ({ batchId, date, qty });

test('sellThrough: cumulative share against days since arrival, step by sale, to now when stock is left', () => {
	const arrived = iso(T0);
	const out = insights.sellThrough({
		batches: [{ batchId: 1, runId: null, dateIssued: iso(T0 - 3600000), items: [{ typeId: 501, qty: 100 }] }],
		lots: [lot(1, 60, arrived), lot(1, 40, arrived)],
		sells: [sale(1, iso(T0 + 1 * DAY), 25), sale(1, iso(T0 + 2 * DAY), 25)],
		runs: [], now: T0 + 5 * DAY
	});
	assert.equal(out.pending.length, 0);
	const s = out.series[0];
	assert.equal(s.units, 100);
	assert.equal(s.sold, 50);
	assert.equal(s.soldOut, false);
	assert.deepEqual(s.points.map(p => [p.day, p.share]), [[0, 0], [1, 0.25], [2, 0.5]]);
	assert.equal(s.endDay, 5);
	assert.equal(s.days50, 2);
	assert.equal(s.days100, null);
	assert.equal(insights.shareAt(s, 1.5), 0.25);
	assert.equal(insights.shareAt(s, 0), 0);
	assert.equal(insights.shareAt(s, 9), 0.5);
});

test('sellThrough: a sold-out batch ends at its last sale; sales before delivery sit at day 0 and are counted', () => {
	const arrived = iso(T0);
	const out = insights.sellThrough({
		batches: [{ batchId: 2, runId: null, dateIssued: arrived, items: [{ typeId: 501, qty: 10 }] }],
		lots: [lot(2, 10, arrived)],
		sells: [sale(2, iso(T0 - 3600000), 2), sale(2, iso(T0 + 3 * DAY), 8)],
		runs: [], now: T0 + 9 * DAY
	});
	const s = out.series[0];
	assert.equal(s.soldOut, true);
	assert.equal(s.early, 2);
	assert.deepEqual(s.points.map(p => p.day), [0, 0, 3]);
	assert.equal(s.endDay, 3);
	assert.equal(s.days100, 3);
});

test('sellThrough: the predicted days to clear is the longest the run gave the batch’s types; undelivered batches wait in pending', () => {
	const arrived = iso(T0);
	const runs = [{ id: 'run-1', rows: [{ typeId: 501, daysToClear: 3 }, { typeId: 502, daysToClear: 6 }, { typeId: 503, daysToClear: 20 }] }];
	const out = insights.sellThrough({
		batches: [
			{ batchId: 3, runId: 'run-1', dateIssued: arrived, items: [{ typeId: 501, qty: 5 }, { typeId: 502, qty: 5 }] },
			{ batchId: 4, runId: null, dateIssued: iso(T0 + DAY), items: [{ typeId: 501, qty: 5 }] }
		],
		lots: [lot(3, 10, arrived), lot(4, 5, null)],
		sells: [], runs, now: T0 + DAY
	});
	assert.equal(out.series.length, 1);
	assert.equal(out.series[0].predictedDays, 6); // 503 is not in the batch
	assert.deepEqual(out.pending.map(p => p.batchId), [4]);
});

//--- calibration

test('calibration: profit per item and days to clear, predicted against actual, per run and item', () => {
	const run = { id: 'run-1', copiedAt: '2026-11-01T00:00:00Z', rows: [{ typeId: 501, profitPerItemMil: 0.002, daysToClear: 4 }, { typeId: 502, profitPerItemMil: 1.5, daysToClear: 2 }, { typeId: 503, profitPerItemMil: 1, daysToClear: 3 }] };
	const rows = [
		{ typeId: 501, predicted: { listed: true, daysToClear: 4 }, soldQty: 100, boughtQty: 100, realizedProfit: 150000, soldOut: true, daysOnMarket: 5, projectedDaysToClear: 5 },
		{ typeId: 502, predicted: { listed: true, daysToClear: 2 }, soldQty: 5, boughtQty: 20, realizedProfit: 9e6, soldOut: false, daysOnMarket: 1, projectedDaysToClear: 4 },
		{ typeId: 503, predicted: { listed: true, daysToClear: 3 }, soldQty: 0, boughtQty: 10, realizedProfit: 0, soldOut: false, daysOnMarket: 2, projectedDaysToClear: null },
		{ typeId: 999, predicted: { listed: false }, soldQty: 3, boughtQty: 3, realizedProfit: 1, soldOut: true, daysOnMarket: 1 }
	];
	const pts = insights.calibration([{ run, rows }]);
	assert.equal(pts.length, 3); // the unplanned type 999 is not a calibration point
	assert.deepEqual([pts[0].predictedProfit, pts[0].realizedProfit], [2000, 1500]);
	assert.deepEqual([pts[0].predictedDays, pts[0].actualDays, pts[0].projected], [4, 5, false]);
	assert.deepEqual([pts[1].predictedProfit, pts[1].realizedProfit], [1500000, 1800000]);
	assert.deepEqual([pts[1].actualDays, pts[1].projected], [4, true]); // not sold out: the projection
	assert.equal(pts[2].realizedProfit, null); // nothing sold yet: no realized profit per item
	assert.equal(pts[2].actualDays, null); // and no projection
});

//--- capital at work

const S = 60003760;
const D = 60008494;
const snap = (syncedAt, balance, { orders = [], assets = [] } = {}) => ({ syncedAt, balance, orders, assets });
const asset = (type, qty, loc, extra = {}) => ({ item_id: Math.floor(Math.random() * 1e9), type_id: type, quantity: qty, location_id: loc, location_type: 'station', ...extra });

test('capital: wallet, escrow, source, transit, destination and listed by day, stock at cost', () => {
	const d1 = iso(T0 + 12 * 3600000);
	const d2 = iso(T0 + DAY + 12 * 3600000);
	const lots = [
		{ lotId: 'a', typeId: 501, qty: 100, unitPrice: 10, buyFeePerUnit: 0, haulPerUnit: 2, date: iso(T0 - DAY) },
		{ lotId: 'b', typeId: 501, qty: 50, unitPrice: 20, buyFeePerUnit: 1, haulPerUnit: 2, date: iso(T0 - 3600000) },
		{ lotId: 'later', typeId: 501, qty: 10, unitPrice: 999, buyFeePerUnit: 0, haulPerUnit: 0, date: iso(T0 + 5 * DAY) }
	];
	const snapshots = {
		1: [
			snap(d1, 1000, { orders: [{ is_buy_order: true, escrow: 300, type_id: 501, location_id: S }], assets: [asset(501, 20, S)] }),
			snap(d2, 900, { orders: [{ is_buy_order: false, type_id: 501, volume_remain: 10, location_id: D }], assets: [asset(501, 30, D)] })
		]
	};
	const couriers = [{ courierId: 7, dateIssued: iso(T0 + 3600000), dateCompleted: iso(T0 + DAY + 3600000), arrived: true, dead: false, failed: false, carried: [{ typeId: 501, qty: 40 }] }];
	const out = insights.capital({ snapshots, lots, couriers, route: { startStationId: S, endStationId: D }, toMs: T0 + 2 * DAY });
	assert.equal(out.days.length, 3);
	const [day1, day2, day3] = out.days;
	// day 1: 20 at the source + 40 in the courier = 60 units; the newest 60 are 50 at 21 and 10 at 10
	// => 50*21 + 10*10 = 1150 over 60 units; landed adds 2 per unit.
	const avgBuy1 = (50 * 21 + 10 * 10) / 60;
	approx(day1.source, 20 * avgBuy1);
	approx(day1.transit, 40 * (avgBuy1 + 2));
	approx(day1.wallet, 1000);
	approx(day1.escrow, 300);
	assert.equal(day1.unvaluedUnits, 0);
	// day 2: 30 at the destination, 10 listed, the courier delivered => 40 units: 40 of the 50 at 21
	approx(day2.dest, 30 * (21 + 2));
	approx(day2.listed, 10 * (21 + 2));
	approx(day2.transit, 0);
	approx(day2.escrow, 0);
	approx(day2.total, 900 + 40 * 23);
	// day 3 carries day 2's snapshot forward
	approx(day3.total, day2.total);
	assert.equal(out.characters[0].snapshots, 2);
});

test('capital: units no purchase accounts for stay unvalued and are counted; a lot bought later never values earlier stock', () => {
	const d1 = iso(T0 + 12 * 3600000);
	const lots = [{ lotId: 'x', typeId: 501, qty: 5, unitPrice: 10, buyFeePerUnit: 0, haulPerUnit: 0, date: iso(T0 - DAY) }];
	const snapshots = { 1: [snap(d1, 0, { assets: [asset(501, 8, S), asset(777, 3, S)] })] };
	const out = insights.capital({ snapshots, lots, couriers: [], route: { startStationId: S, endStationId: D }, toMs: T0 + DAY / 2 });
	assert.equal(out.days.length, 1);
	approx(out.days[0].source, 5 * 10);
	assert.equal(out.days[0].unvaluedUnits, 3 + 3);
	assert.equal(out.days[0].unvaluedTypes, 2);
});

test('capital: containers resolve to their station; the chart starts on the first day every character has a snapshot', () => {
	const container = asset(3465, 1, S, { item_id: 555 });
	const inside = { item_id: 556, type_id: 501, quantity: 7, location_id: 555, location_type: 'item' };
	const lots = [{ lotId: 'x', typeId: 501, qty: 7, unitPrice: 10, buyFeePerUnit: 0, haulPerUnit: 0, date: iso(T0 - DAY) }];
	const snapshots = {
		1: [snap(iso(T0 + 1000), 100, { assets: [container, inside] })],
		2: [snap(iso(T0 + 2 * DAY), 50)]
	};
	const out = insights.capital({ snapshots, lots, couriers: [], route: { startStationId: S, endStationId: D }, toMs: T0 + 2 * DAY + 3600000 });
	assert.equal(out.days.length, 1); // day 3 is the first day both have a snapshot
	approx(out.days[0].source, 70);
	approx(out.days[0].wallet, 150);
	assert.equal(out.days[0].characters, 2);
	assert.ok(out.earlierThan !== null);
});

test('capital: no snapshots, no days', () => {
	assert.deepEqual(insights.capital({ snapshots: { 1: [] }, lots: [], couriers: [], route: {} }).days, []);
});
