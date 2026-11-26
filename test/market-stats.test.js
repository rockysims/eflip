const test = require('node:test');
const assert = require('node:assert/strict');
const { foldBook } = require('../lib/derive.js');
const marketStats = require('../public/market-stats.js');

const { computeMarketStats } = marketStats;
const { coveredIntervals } = marketStats._internal;

const HOUR_MS = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const STATION = 60008494;
const OTHER_STATION = 60002122;

// Times are T0 + n hours.
const at = (hours) => new Date(T0 + hours * HOUR_MS).toISOString();
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const approx = (actual, expected, eps = 1e-4) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} !== ${expected} (±${eps})`);

// ---- literal builders: a sample, an order ([hours, price, volumeRemain] path entries), a log

const sample = (hours, stored = true) => ({ at: at(hours), stored });
const order = (id, { firstSeen, lastSeen, path, isBuy = false, locationId = STATION }) => [String(id), {
	isBuy,
	locationId,
	firstSeen: at(firstSeen),
	lastSeen: at(lastSeen),
	path: path.map(([hours, price, volumeRemain]) => ({ at: at(hours), price, volumeRemain, issued: at(firstSeen) }))
}];
const bookLog = (samples, orders = []) => ({ samples, orders: Object.fromEntries(orders) });

// ---- folded builders: the whole book at each check hour, folded by lib/derive.js foldBook

const row = (orderId, price, volume, { isBuy = false, locationId = STATION } = {}) => ({
	order_id: orderId, price, volume_remain: volume, is_buy_order: isBuy, location_id: locationId, issued: at(0)
});
const foldedLog = (hours, rowsAt) => {
	const log = { samples: [], orders: {} };
	for (const h of hours) foldBook(log, { at: at(h), stored: true, rows: rowsAt(h) });
	return log;
};

// The hourly scenario, five days of checks (hours 0..120) of one station's book:
//   A  10 units at 105, then re-prices every 12 h from hour 6, alternately to 99 (below B, an
//      undercut) and 102 (not below the best, A's own 99): hours 6, 18, 30, ...
//   B  a static 100 that sells one unit every 4 h (path entries without a price change)
//   C  out of band (above best × 1.75), re-pricing every 12 h between 300 and 310: never counted
// With `noise`, orders that must be ignored: a buy order at the station priced under every sell
// order, and a cheap sell order at another station, both re-pricing and filling every hour.
const priceA = (h) => (h < 6 ? 105 : Math.floor((h - 6) / 12) % 2 === 0 ? 99 : 102);
const scenarioRows = (noise) => (h) => {
	const rows = [
		row(1, priceA(h), 10),
		row(2, 100, 1000 - Math.floor(h / 4)),
		row(3, 300 + 10 * (Math.floor(h / 12) % 2), 7)
	];
	if (noise) {
		rows.push(row(4, 50 + (h % 2), 500 - h, { isBuy: true }));
		rows.push(row(5, 10 + (h % 2), 200 - h, { locationId: OTHER_STATION }));
	}
	return rows;
};
const hourlyLog = ({ hours = range(0, 120), noise = false } = {}) => foldedLog(hours, scenarioRows(noise));

const stats = (log, options = {}) => computeMarketStats({ log, stationId: STATION, now: at(120), ...options });

// ---- the covered-interval helper

test('coveredIntervals: consecutive samples within the gap cover the time between them, merged', () => {
	const h = (hours) => hours * HOUR_MS;
	const times = [0, 1, 2, 10, 11].map(h);
	assert.deepEqual(coveredIntervals(times, h(3), -Infinity, Infinity), { intervals: [[h(0), h(2)], [h(10), h(11)]], coveredMs: h(3) });
});

test('coveredIntervals: a gap exactly the acceptable size is covered, a millisecond more is not', () => {
	assert.equal(coveredIntervals([0, 3 * HOUR_MS], 3 * HOUR_MS, 0, Infinity).coveredMs, 3 * HOUR_MS);
	assert.equal(coveredIntervals([0, 3 * HOUR_MS + 1], 3 * HOUR_MS, 0, Infinity).coveredMs, 0);
});

test('coveredIntervals: clipped to the window; a lone sample covers nothing', () => {
	const h = (hours) => hours * HOUR_MS;
	assert.deepEqual(coveredIntervals([0, 1, 2, 10, 11].map(h), h(3), h(1), h(10.5)), { intervals: [[h(1), h(2)], [h(10), h(10.5)]], coveredMs: h(1.5) });
	assert.deepEqual(coveredIntervals([h(5)], h(3), 0, h(24)), { intervals: [], coveredMs: 0 });
	assert.deepEqual(coveredIntervals([0, h(5), h(10)], h(3), 0, h(24)), { intervals: [], coveredMs: 0 });
});

// ---- no data

test('no samples, or none at or before now: null', () => {
	assert.equal(computeMarketStats({ log: bookLog([]), stationId: STATION, now: at(0) }), null);
	assert.equal(computeMarketStats({ log: { samples: [], orders: {} }, stationId: STATION, now: at(0) }), null);
	assert.equal(computeMarketStats({ log: bookLog([sample(5), sample(6)]), stationId: STATION, now: at(4) }), null);
});

test('one sample: coverage 0, every rate null', () => {
	const log = bookLog([sample(0)], [order(1, { firstSeen: 0, lastSeen: 0, path: [[0, 100, 5]] })]);
	assert.deepEqual(computeMarketStats({ log, stationId: STATION, now: at(1) }), {
		coverage: {
			windowDays: 3, samples: 1, medianGapHours: null, maxGapHours: null, from: at(-72), to: at(0),
			events: { gapHours: 12, coveredDays: 0, fraction: 0 },
			volume: { gapHours: 24, coveredDays: 0, fraction: 0 }
		},
		repriceEvents: 0,
		avgDaysIdle: null,
		censored: false,
		undercutsPerDay: null,
		fillsPerDay: null,
		vanishedUnitsPerDay: null,
		stockTrendPerDay: null
	});
});

// ---- the hourly scenario

test('hourly over 5 days, ordersPerDay 4 (events gap 3 h): re-prices, undercuts and fills over a 3-day window', () => {
	const result = stats(hourlyLog(), { ordersPerDay: 4 });
	const { stockTrendPerDay, ...rest } = result;
	assert.deepEqual(rest, {
		coverage: {
			windowDays: 3, samples: 73, medianGapHours: 1, maxGapHours: 1, from: at(48), to: at(120),
			events: { gapHours: 3, coveredDays: 3, fraction: 1 },
			volume: { gapHours: 24, coveredDays: 3, fraction: 1 }
		},
		repriceEvents: 6, // A at 54, 66, 78, 90, 102, 114; C is out of band, B never re-prices
		avgDaysIdle: 0.5,
		censored: false,
		undercutsPerDay: 1, // A to 99 under B's 100 at 54, 78, 102
		fillsPerDay: 6, // B: one unit every 4 h, 18 in the window
		vanishedUnitsPerDay: 0
	});
	// In-band volume is A's 10 plus B's falling stock (C is out of band): about -6 a day.
	assert.ok(stockTrendPerDay < 0);
	approx(stockTrendPerDay, -6, 0.1);
});

test('the same log at ordersPerDay 48 (events gap 15 min): no events coverage, volume unchanged', () => {
	const log = hourlyLog();
	const slow = stats(log, { ordersPerDay: 4 });
	const busy = stats(log, { ordersPerDay: 48 });
	assert.deepEqual(busy.coverage.events, { gapHours: 0.25, coveredDays: 0, fraction: 0 });
	assert.deepEqual(busy.coverage.volume, slow.coverage.volume);
	assert.equal(busy.repriceEvents, 0);
	assert.equal(busy.avgDaysIdle, null);
	assert.equal(busy.censored, false);
	assert.equal(busy.undercutsPerDay, null);
	// Fills, vanished units and the stock trend do not depend on the pace.
	assert.equal(busy.fillsPerDay, 6);
	assert.equal(busy.vanishedUnitsPerDay, 0);
	assert.equal(busy.stockTrendPerDay, slow.stockTrendPerDay);
});

test('events gap: half the typical interval between orders, clamped to 10 min..24 h', () => {
	const log = hourlyLog({ hours: range(0, 2) });
	const gapAt = (ordersPerDay) => computeMarketStats({ log, stationId: STATION, now: at(2), ordersPerDay }).coverage.events.gapHours;
	assert.equal(gapAt(1), 12);
	assert.equal(gapAt(4), 3);
	assert.equal(gapAt(7), 1.7143);
	assert.equal(gapAt(0.25), 24);
	assert.equal(gapAt(0), 24);
	assert.equal(gapAt(100), 0.1667);
	assert.equal(computeMarketStats({ log, stationId: STATION, now: at(2) }).coverage.volume.gapHours, 24);
});

test('a 10 h gap shrinks events coverage, not volume coverage; no event in the gap counts, fills across it do', () => {
	// No checks at hours 77..85: samples 76 and 86 are 10 h apart. A's re-price at 78 (an undercut)
	// is first seen at 86, inside the gap; B's drops at 80 and 84 are seen at 86 as one drop of 2.
	const result = stats(hourlyLog({ hours: range(0, 120).filter(h => h < 77 || h > 85) }), { ordersPerDay: 4 });
	assert.equal(result.coverage.samples, 64);
	assert.equal(result.coverage.medianGapHours, 1);
	assert.equal(result.coverage.maxGapHours, 10);
	assert.deepEqual(result.coverage.events, { gapHours: 3, coveredDays: 2.5833, fraction: 0.8611 }); // 62 h of 72
	assert.deepEqual(result.coverage.volume, { gapHours: 24, coveredDays: 3, fraction: 1 });
	assert.equal(result.repriceEvents, 5);
	assert.equal(result.avgDaysIdle, 0.5167); // (62 / 24) / 5
	assert.equal(result.undercutsPerDay, 0.7742); // 2 / (62 / 24): 54 and 102, not 78
	assert.equal(result.fillsPerDay, 6);
	assert.equal(result.vanishedUnitsPerDay, 0);
});

test('censored: nothing re-prices, avg days idle is the covered days', () => {
	const log = foldedLog(range(0, 72), h => [row(2, 100, 1000 - Math.floor(h / 4)), row(6, 120, 3)]);
	const result = computeMarketStats({ log, stationId: STATION, now: at(72), ordersPerDay: 4 });
	assert.equal(result.coverage.events.coveredDays, 3);
	assert.equal(result.repriceEvents, 0);
	assert.equal(result.avgDaysIdle, 3);
	assert.equal(result.censored, true);
	assert.equal(result.undercutsPerDay, 0);
});

test('windowDays and now clip the window: only samples in [to - windowDays, to] count', () => {
	const log = hourlyLog();
	const oneDay = stats(log, { ordersPerDay: 4, windowDays: 1 });
	assert.equal(oneDay.coverage.samples, 25);
	assert.equal(oneDay.coverage.from, at(96));
	assert.deepEqual(oneDay.coverage.events, { gapHours: 3, coveredDays: 1, fraction: 1 });
	assert.equal(oneDay.repriceEvents, 2); // 102, 114
	assert.equal(oneDay.avgDaysIdle, 0.5);
	assert.equal(oneDay.undercutsPerDay, 1); // 102
	assert.equal(oneDay.fillsPerDay, 6); // 100, 104, ..., 120

	// `now` between samples: the window ends at the newest sample at or before it; later ones are
	// ignored. A 3-day window ending at hour 60 starts before the first sample: 2.5 days covered.
	const early = computeMarketStats({ log, stationId: STATION, now: at(60.5), ordersPerDay: 4 });
	assert.equal(early.coverage.to, at(60));
	assert.equal(early.coverage.from, at(-12));
	assert.equal(early.coverage.samples, 61);
	assert.deepEqual(early.coverage.events, { gapHours: 3, coveredDays: 2.5, fraction: 0.8333 });
	assert.equal(early.repriceEvents, 5); // 6, 18, 30, 42, 54
	assert.equal(early.avgDaysIdle, 0.5);
	assert.equal(early.undercutsPerDay, 1.2); // 6, 30, 54 over 2.5 days
	assert.equal(early.fillsPerDay, 6); // 15 units over 2.5 days
});

test('buy orders and other stations are ignored; the station id may be a string', () => {
	const clean = stats(hourlyLog(), { ordersPerDay: 4 });
	assert.deepEqual(stats(hourlyLog({ noise: true }), { ordersPerDay: 4 }), clean);
	assert.deepEqual(stats(hourlyLog({ noise: true }), { ordersPerDay: 4, stationId: String(STATION) }), clean);
	// At the other station only its own order counts: one unit an hour, re-pricing every hour.
	const other = stats(hourlyLog({ noise: true }), { ordersPerDay: 4, stationId: OTHER_STATION });
	assert.equal(other.repriceEvents, 72);
	assert.equal(other.fillsPerDay, 24);
});

// ---- volume: fills, vanished orders, unstored samples

test('fills are drops of orders present in both samples; a vanished order counts apart; a new order is no fill', () => {
	// Checks at 0, 12, 24 over a 1-day window. P drops 10 -> 7 -> 4 (fills 6); V (5 units) is gone
	// at 24 (vanished 5); W arrives at 12 with 8 units at 98, under the best of 100 at hour 0.
	const log = bookLog([sample(0), sample(12), sample(24)], [
		order(1, { firstSeen: 0, lastSeen: 24, path: [[0, 100, 10], [12, 100, 7], [24, 100, 4]] }),
		order(2, { firstSeen: 0, lastSeen: 12, path: [[0, 101, 5]] }),
		order(3, { firstSeen: 12, lastSeen: 24, path: [[12, 98, 8]] })
	]);
	const result = computeMarketStats({ log, stationId: STATION, now: at(24), windowDays: 1 });
	assert.deepEqual(result.coverage.events, { gapHours: 12, coveredDays: 1, fraction: 1 }); // 12 h apart is within a 12 h gap
	assert.deepEqual(result.coverage.volume, { gapHours: 24, coveredDays: 1, fraction: 1 });
	assert.equal(result.fillsPerDay, 6);
	assert.equal(result.vanishedUnitsPerDay, 5);
	assert.equal(result.repriceEvents, 0);
	assert.equal(result.censored, true);
	assert.equal(result.undercutsPerDay, 1); // W's first entry
	// In-band volume 15, 20, 12 at 0, 0.5, 1 days.
	assert.equal(result.stockTrendPerDay, -3);
});

test('a stored: false sample saw the book unchanged: orders stay present until a stored sample drops them', () => {
	// P (5 units) was last stored at 0 and is gone at the stored check at 4; Q drops 9 -> 6 at 4.
	const log = bookLog([sample(0), sample(1, false), sample(2, false), sample(3, false), sample(4)], [
		order(1, { firstSeen: 0, lastSeen: 0, path: [[0, 100, 5]] }),
		order(2, { firstSeen: 0, lastSeen: 4, path: [[0, 101, 9], [4, 101, 6]] })
	]);
	const before = computeMarketStats({ log, stationId: STATION, now: at(3) });
	assert.equal(before.vanishedUnitsPerDay, 0);
	assert.equal(before.fillsPerDay, 0);
	assert.equal(before.stockTrendPerDay, 0); // 14 units throughout

	const after = computeMarketStats({ log, stationId: STATION, now: at(4) });
	assert.equal(after.coverage.volume.coveredDays, 0.1667); // 4 h
	assert.equal(after.vanishedUnitsPerDay, 30); // 5 units over 4 h
	assert.equal(after.fillsPerDay, 18); // 3 units over 4 h
});

// ---- stock trend

test('stockTrendPerDay: positive when in-band stock grows, null with fewer than three covered samples', () => {
	// A new 10-unit order at 100 every 12 h: in-band stock steps up 20 a day.
	const growing = foldedLog(range(0, 72), h => range(0, Math.floor(h / 12)).map(k => row(10 + k, 100, 10)));
	const up = computeMarketStats({ log: growing, stationId: STATION, now: at(72) });
	assert.ok(up.stockTrendPerDay > 0);
	approx(up.stockTrendPerDay, 20, 1);

	const two = bookLog([sample(0), sample(12)], [order(1, { firstSeen: 0, lastSeen: 12, path: [[0, 100, 10], [12, 100, 8]] })]);
	assert.equal(computeMarketStats({ log: two, stationId: STATION, now: at(12) }).stockTrendPerDay, null);

	// Three samples in the window, but the third is 36 h after the second: only two are covered.
	const gappy = bookLog([sample(0), sample(12), sample(48)], [order(1, { firstSeen: 0, lastSeen: 48, path: [[0, 100, 10], [12, 100, 8], [48, 100, 2]] })]);
	const result = computeMarketStats({ log: gappy, stationId: STATION, now: at(48) });
	assert.equal(result.coverage.samples, 3);
	assert.equal(result.stockTrendPerDay, null);
	assert.equal(result.fillsPerDay, 4); // the covered pair only: 2 units over 12 h
});

// ---- in band

test('a re-price counts only while the order is in band at that sample', () => {
	// Best is 100 throughout; band edge 175 at the default 0.75, 120 at 0.2. X re-prices 150 -> 160 -> 150.
	const log = bookLog([sample(0), sample(6), sample(12)], [
		order(1, { firstSeen: 0, lastSeen: 12, path: [[0, 100, 5]] }),
		order(2, { firstSeen: 0, lastSeen: 12, path: [[0, 150, 5], [6, 160, 5], [12, 150, 5]] })
	]);
	assert.equal(computeMarketStats({ log, stationId: STATION, now: at(12), windowDays: 0.5 }).repriceEvents, 2);
	assert.equal(computeMarketStats({ log, stationId: STATION, now: at(12), windowDays: 0.5, supplyBand: 0.2 }).repriceEvents, 0);
});

test('invalid inputs throw', () => {
	const log = bookLog([sample(0)]);
	assert.throws(() => computeMarketStats({ log, stationId: STATION, now: 'not a time' }), TypeError);
	assert.throws(() => computeMarketStats({ log, stationId: STATION, now: at(0), windowDays: 0 }), RangeError);
	assert.throws(() => computeMarketStats({ log, stationId: STATION, now: at(0), ordersPerDay: -1 }), RangeError);
});
