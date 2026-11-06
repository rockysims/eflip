const test = require('node:test');
const assert = require('node:assert/strict');
const estimate = require('../public/estimate.js');

const { computeItemReport, applyFilters, getOrdinaryPrice, defaultConfig } = estimate;
const { roundMils, recencyWeight } = estimate._internal;

const NOW = new Date('2026-06-01T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const M = 1e6;

const dateForAge = age => new Date(Date.UTC(2026, 5, 1) - age * DAY_MS).toISOString().slice(0, 10);
const isoHoursAgo = hours => new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();

// A flat day (highest === lowest === average) counts all its volume as sell-side volume.
const flatDay = (age, price, volume) => ({ date: dateForAge(age), average: price, highest: price, lowest: price, volume, order_count: 1 });
const flatHistory = (fromAge, toAge, price, volume) => {
	const days = [];
	for (let age = toAge; age >= fromAge; age--) days.push(flatDay(age, price, volume));
	return days;
};

const sellOrder = (price, volume_remain, hoursAgo = 48) => ({ price, volume_remain, is_buy_order: false, issued: isoHoursAgo(hoursAgo) });

const weightTotal = (() => {
	let total = 0;
	for (let age = 1; age <= defaultConfig.DAYS_CONSIDERED; age++) total += recencyWeight(age, defaultConfig.RECENCY_HALF_LIFE_DAYS);
	return total;
})();

const approx = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} !== ${expected} (±${eps})`);

// Base scenario: 30 full days at 10M, 10 units/day => dailyDemand 10.
// Dest best 9M => sellPrice 9M - 0.01. Band edge = 9.9M.
const baseDays = () => flatHistory(1, 30, 10 * M, 10);
const baseDest = () => [
	sellOrder(9 * M, 3),
	sellOrder(9.8 * M, 4), // inside the 10% band
	sellOrder(10 * M, 5)   // outside
];
const SELL_PRICE = 9 * M - 0.01;
const REVENUE_PER_ITEM = SELL_PRICE * (1 - defaultConfig.SELL_TAX);

test('getOrdinaryPrice returns dominant bucket price; null for no days', () => {
	assert.equal(getOrdinaryPrice([]), null);
	const days = [flatDay(1, 100, 10), flatDay(2, 101, 10), flatDay(3, 300, 5)];
	approx(getOrdinaryPrice(days), 100.5);
});

test('ordinary price ignores days older than ORDINARY_PRICE_DAYS', () => {
	// Recent 90 days: high 2M, low 1M, average 1.5M, except a spike to 8M yesterday.
	// Older days: 10M with huge volume.
	const recent = [];
	for (let age = 90; age >= 1; age--) recent.push({ date: dateForAge(age), average: 1.5 * M, highest: age === 1 ? 8 * M : 2 * M, lowest: 1 * M, volume: 10 });
	const old = flatHistory(91, 200, 10 * M, 100000);
	// No dest orders, so sellPrice = average of the last 5 profitable days' capped highs, where the
	// cap is max(ordinaryPrice, trailing 10-day average high). With the 90-day window the ordinary
	// price is 1.5M, so the spike day is capped at the trailing average (9*2M + 8M)/10 = 2.6M and
	// the last five days average (4*2M + 2.6M)/5 = 2.12M. With old days included the ordinary price
	// would be ~10M and the spike would count in full (3.2M).
	const report = computeItemReport({
		srcOrders: [sellOrder(0.5 * M, 1000)],
		destOrders: [],
		destDays: [...old, ...recent],
		now: NOW
	});
	assert.equal(report.revenuePerItemMil, Number(roundMils(Math.floor(2.12 * M * (1 - defaultConfig.SELL_TAX)), 3)));
});

test('recency weight: a day 30 days old counts half', () => {
	approx(recencyWeight(30, 30), 0.5);
	approx(recencyWeight(0, 30), 1);

	const run = age => computeItemReport({
		srcOrders: [sellOrder(1 * M, 1000)],
		destOrders: [],
		destDays: [flatDay(age, 10 * M, 1000)],
		now: NOW
	});
	const old = run(30);
	approx(old.dailyDemand, Math.round(0.5 * 1000 / weightTotal * 100) / 100, 0.001);
	const fresh = run(1);
	approx(fresh.dailyDemand, Math.round(recencyWeight(1, 30) * 1000 / weightTotal * 100) / 100, 0.001);
	assert.ok(old.dailyDemand < fresh.dailyDemand);
	// days beyond DAYS_CONSIDERED contribute nothing
	assert.equal(run(31).dailyDemand, 0);
});

test('full window of constant volume gives dailyDemand equal to that volume', () => {
	const report = computeItemReport({ srcOrders: [sellOrder(1 * M, 1000)], destOrders: baseDest(), destDays: baseDays(), now: NOW });
	assert.equal(report.dailyDemand, 10);
	assert.equal(report.activeDaysFraction, 1);
});

test('competing volume counts only dest orders within the band', () => {
	const report = computeItemReport({ srcOrders: [sellOrder(1 * M, 1000)], destOrders: baseDest(), destDays: baseDays(), now: NOW });
	assert.equal(report.competingVolume, 7);

	const wider = computeItemReport({ srcOrders: [sellOrder(1 * M, 1000)], destOrders: baseDest(), destDays: baseDays(), now: NOW, config: { COMPETE_BAND: 0.2 } });
	assert.equal(wider.competingVolume, 12);
});

test('days of supply counts dest orders within SUPPLY_BAND of sellPrice; null without demand or sellPrice', () => {
	const destOrders = [sellOrder(1 * M, 4), sellOrder(1.2 * M, 6), sellOrder(1.3 * M, 50)];
	const report = computeItemReport({ srcOrders: [sellOrder(0.1 * M, 1000)], destOrders, destDays: baseDays(), now: NOW });
	assert.equal(report.dailyDemand, 10);
	assert.equal(report.daysOfSupply, 1); // (4 + 6) / 10; the 1.3M order is outside the 25% band

	const noDemand = computeItemReport({ srcOrders: [sellOrder(0.1 * M, 1000)], destOrders, destDays: [], now: NOW });
	assert.equal(noDemand.daysOfSupply, null);

	const noSellPrice = computeItemReport({ srcOrders: [sellOrder(0.1 * M, 1000)], destOrders: [], destDays: [], now: NOW });
	assert.equal(noSellPrice.daysOfSupply, null);
});

test('buy cap without overhang = demand * horizon - competing volume', () => {
	const report = computeItemReport({ srcOrders: [sellOrder(1 * M, 1000)], destOrders: baseDest(), destDays: baseDays(), now: NOW });
	assert.equal(report.volume, 10 * 5 - 7);
});

test('buy cap with overhang >= horizon demand => volume 0 and fallback figures', () => {
	const report = computeItemReport({
		srcOrders: [sellOrder(1 * M, 1000)],
		destOrders: [sellOrder(9 * M, 60)],
		destDays: baseDays(),
		now: NOW
	});
	assert.equal(report.volume, 0);
	assert.equal(report.dailyProfitMil, 0);
	assert.equal(report.dailyProfitOldMil, 0);
	assert.equal(report.costPerItemMil, 1);
	assert.equal(report.revenuePerItemMil, 9);
	assert.equal(report.competingVolume, 60);
	assert.equal(report.daysToClear, 6);
	assert.equal(report.filteredReason, 'not profitable');
});

test('marginal ROI stop walks only the cheap orders; caller orders are not mutated', () => {
	// ROI vs ~8.06M revenue: 1M -> 7.3, 4M -> 1.83, 6M -> 1.22 (< 1.5, stop)
	const srcOrders = [sellOrder(6 * M, 10), sellOrder(1 * M, 10), sellOrder(4 * M, 10)];
	const report = computeItemReport({ srcOrders, destOrders: baseDest(), destDays: baseDays(), now: NOW });
	assert.equal(report.volume, 20);
	assert.deepEqual(srcOrders.map(o => o.volume_remain), [10, 10, 10]);

	// daysToClear = (20 + 7) / 10
	assert.equal(report.daysToClear, 2.7);

	const cost = 10 * 1 * M * 1.1 + 10 * 4 * M * 1.1;
	const revenue = 20 * REVENUE_PER_ITEM;
	const profit = revenue - cost;
	assert.equal(report.dailyProfitMil, Number(roundMils(profit / 2.7)));
	assert.equal(report.dailyProfitOldMil, Number(roundMils(profit / 5)));
	assert.equal(report.roi, Math.round(revenue / cost * 100) / 100);
	assert.equal(report.costPerItemMil, Number(roundMils(Math.ceil(cost / 20), 3)));
	assert.equal(report.revenuePerItemMil, Number(roundMils(Math.floor(revenue / 20), 3)));
	assert.equal(report.profitPerItemMil, Number(roundMils(profit / 20, 3)));
});

test('daysToClear below 1 does not inflate daily profit', () => {
	// Demand 100/day, no competition, only 20 units available => daysToClear 0.2
	const report = computeItemReport({
		srcOrders: [sellOrder(1 * M, 20)],
		destOrders: [],
		destDays: flatHistory(1, 30, 10 * M, 100),
		now: NOW
	});
	assert.equal(report.volume, 20);
	assert.equal(report.daysToClear, 0.2);
	const profit = 20 * (10 * M * (1 - defaultConfig.SELL_TAX) - 1.1 * M);
	assert.equal(report.dailyProfitMil, Number(roundMils(profit / 1)));
});

test('COST_LIMIT caps the spend', () => {
	const report = computeItemReport({
		srcOrders: [sellOrder(1 * M, 1000)],
		destOrders: baseDest(),
		destDays: baseDays(),
		now: NOW,
		config: { COST_LIMIT: 10 * M }
	});
	// Budget is tracked on cost incl. hauling (1.1M/unit) but units are sized
	// by order price, as in the old code: day 1 buys 8 (8.8M), day 2 buys 1.
	assert.equal(report.volume, 9);
});

test('always-show ignores the ROI stop but still respects the cap, and bypasses filters', () => {
	const srcOrders = [sellOrder(6 * M, 10), sellOrder(1 * M, 10), sellOrder(4 * M, 10), sellOrder(7 * M, 100)];
	const report = computeItemReport({ srcOrders, destOrders: baseDest(), destDays: baseDays(), now: NOW, config: { isAlwaysShow: true } });
	assert.equal(report.volume, 43);
	assert.equal(report.filteredReason, null);
	assert.equal(applyFilters({ volume: 0, dailyProfitMil: 0 }, { isAlwaysShow: true }), null);
});

test('no source sell orders => null', () => {
	assert.equal(computeItemReport({ srcOrders: [], destOrders: baseDest(), destDays: baseDays(), now: NOW }), null);
	const buyOnly = [{ price: 1 * M, volume_remain: 10, is_buy_order: true, issued: isoHoursAgo(1) }];
	assert.equal(computeItemReport({ srcOrders: buyOnly, destOrders: baseDest(), destDays: baseDays(), now: NOW }), null);
});

test('bad input is caught and returns null', () => {
	const warn = console.warn;
	console.warn = () => {};
	try {
		assert.equal(computeItemReport({ srcOrders: [sellOrder(1 * M, 10)], destDays: [{ date: null }], now: NOW }), null);
	} finally {
		console.warn = warn;
	}
});

test('seller count and days since update', () => {
	const destOrders = [sellOrder(9 * M, 1, 12), sellOrder(9.5 * M, 1, 20), sellOrder(9.6 * M, 1, 30), sellOrder(9.7 * M, 1, 100)];
	const report = computeItemReport({ srcOrders: [sellOrder(1 * M, 10)], destOrders, destDays: baseDays(), now: NOW });
	assert.equal(report.activeSellers, 3); // 12h, 20h, 30h are within 24h of the newest (12h); 100h is not
	assert.equal(report.daysSinceSellerUpdate, 0.5);

	const ignored = computeItemReport({ srcOrders: [sellOrder(1 * M, 10)], destOrders, destDays: baseDays(), now: NOW, config: { ignoreOneActiveSeller: true } });
	assert.equal(ignored.activeSellers, 2);

	const none = computeItemReport({ srcOrders: [sellOrder(1 * M, 10)], destOrders: [], destDays: baseDays(), now: NOW });
	assert.equal(none.activeSellers, null);
	assert.equal(none.daysSinceSellerUpdate, null);
});

test('applyFilters reasons', () => {
	const ok = {
		volume: 10,
		costPerItemMil: 1,
		revenuePerItemMil: 5,
		dailyProfitMil: 20,
		activeDaysFraction: 0.5,
		daysSinceSellerUpdate: 3,
		activeSellers: 0
	};
	assert.equal(applyFilters(ok, {}), null);
	assert.equal(applyFilters(null, {}), 'no report');
	assert.equal(applyFilters({ ...ok, dailyProfitMil: 0.5 }, {}), 'not profitable');
	assert.equal(applyFilters({ ...ok, volume: 0 }, {}), 'not profitable');
	assert.equal(applyFilters({ ...ok, revenuePerItemMil: 1.2 }, {}), 'margin too slim');
	assert.equal(applyFilters({ ...ok, activeDaysFraction: 0.1 }, {}), 'too slow');
	// dailyProfit 2 => threshold 1.00 day
	assert.equal(applyFilters({ ...ok, dailyProfitMil: 2, daysSinceSellerUpdate: 0.5 }, {}), 'seller updated too recently');
	assert.equal(applyFilters({ ...ok, dailyProfitMil: 2, daysSinceSellerUpdate: 1.01 }, {}), null);
	// 5 sellers updated 2 days ago => adjusted 4.55; 5.55 > ROI 3 and dailyProfit 10 < 13.65
	assert.equal(applyFilters({ ...ok, revenuePerItemMil: 3, dailyProfitMil: 10, activeSellers: 5, daysSinceSellerUpdate: 2 }, {}), 'too much competition');
	assert.equal(applyFilters({ ...ok, revenuePerItemMil: 3, dailyProfitMil: 20, activeSellers: 5, daysSinceSellerUpdate: 2 }, {}), null);
	// every reason is bypassed for always-show
	assert.equal(applyFilters({ ...ok, activeDaysFraction: 0 }, { isAlwaysShow: true }), null);
});

test('regression: realistic fixture produces the full report shape', () => {
	// 60 days of noisy history around 25M with a spike day and some quiet days.
	const destDays = [];
	for (let age = 60; age >= 1; age--) {
		if (age % 7 === 3) continue; // no trades that day
		const base = 25 * M + ((age * 7919) % 11 - 5) * 0.2 * M;
		const spike = age === 12;
		destDays.push({
			date: dateForAge(age),
			average: spike ? base * 1.4 : base,
			highest: spike ? base * 2 : base * 1.08,
			lowest: base * 0.9,
			volume: 4 + (age % 5),
			order_count: 3
		});
	}
	const destOrders = [
		sellOrder(24.5 * M, 6, 30),
		sellOrder(26.0 * M, 3, 50),
		sellOrder(31.0 * M, 10, 400),
		{ price: 15 * M, volume_remain: 50, is_buy_order: true, issued: isoHoursAgo(5) }
	];
	const srcOrders = [
		sellOrder(9.8 * M, 5, 10),
		sellOrder(10.2 * M, 12, 10),
		sellOrder(13.5 * M, 8, 10),
		sellOrder(16.0 * M, 40, 10)
	];
	const before = JSON.stringify(srcOrders);
	const report = computeItemReport({ srcOrders, destOrders, destDays, typeId: 12345, now: NOW });
	assert.equal(JSON.stringify(srcOrders), before);

	assert.deepEqual(Object.keys(report).sort(), [
		'activeDaysFraction',
		'activeSellers',
		'competingVolume',
		'costPerItemMil',
		'dailyDemand',
		'dailyProfitMil',
		'dailyProfitOldMil',
		'daysOfSupply',
		'daysSinceSellerUpdate',
		'daysToClear',
		'filteredReason',
		'profitPerItemMil',
		'revenuePerItemMil',
		'roi',
		'volume'
	]);
	for (const [key, val] of Object.entries(report)) {
		if (key === 'filteredReason') continue;
		assert.equal(typeof val, 'number', `${key} should be a number`);
		assert.ok(Number.isFinite(val), `${key} should be finite`);
	}

	assert.deepEqual(report, {
		// demand 2.83/day * 5 days - 9 competing => cap 5, all from the 9.8M order
		volume: 5,
		costPerItemMil: 10.78,
		revenuePerItemMil: 21.95,
		profitPerItemMil: 11.17,
		roi: 2.04,
		dailyProfitMil: 11.3,
		dailyProfitOldMil: 11.1, // roundNonZero truncates
		daysToClear: 4.94, // (5 + 9) / 2.83
		daysOfSupply: 3.17, // 9 within 25% of sellPrice (31.0M is outside) / ~2.834
		competingVolume: 9, // 24.5M x6 and 26.0M x3 are within 10% of 24.5M - 0.01
		dailyDemand: 2.83,
		activeSellers: 2,
		daysSinceSellerUpdate: 1.25,
		activeDaysFraction: 0.86,
		filteredReason: null
	});
	assert.ok(report.roi >= defaultConfig.MIN_ROI);
});

test('rising recent prices count even when the ordinary price is lower', () => {
	// 20 days at 10M (10/day) dominate volume, so ordinaryPrice is 10M. The last 10 days sold at 20M.
	// Jita 9M + 10% haul = 9.9M needs an 11.05M sell price, so the 10M cap alone would give zero
	// profitable days. The trailing 10-day average high reaches 12M once two of the ten days are
	// at 20M (ages 9..1), so nine days count.
	const days = [...flatHistory(11, 30, 10 * M, 10), ...flatHistory(1, 10, 20 * M, 1)];
	const report = computeItemReport({
		srcOrders: [sellOrder(9 * M, 1000)],
		destOrders: [],
		destDays: days,
		now: NOW
	});
	assert.ok(report.volume > 0, `volume ${report.volume}`);
	assert.equal(report.activeDaysFraction, 0.3);
});

test('zero-volume fallback with no dest orders uses the history price', () => {
	// Jita 100M, Amarr history flat at 10M: nothing is profitable and there are no dest orders.
	const report = computeItemReport({
		srcOrders: [sellOrder(100 * M, 10)],
		destOrders: [],
		destDays: flatHistory(1, 30, 10 * M, 10),
		now: NOW
	});
	assert.equal(report.volume, 0);
	assert.equal(report.revenuePerItemMil, 10);
	assert.equal(report.roi, 0.1);
});

test('buy-order-fill days do not drag the recent high cap down', () => {
	// Like the rising-price case, but every other recent day is a buy-order fill at 2M
	// (highest === lowest === 2M, below the recent middle). Those days must be ignored when
	// averaging recent highs. With them included the cap for the last five profitable days
	// averages ~10.6M (revenue ~9.5M); excluded, it averages ~14.9M (revenue ~13.3M).
	const days = [...flatHistory(11, 30, 10 * M, 10)];
	for (let age = 10; age >= 1; age--) days.push(flatDay(age, age % 2 === 0 ? 2 * M : 20 * M, 1));
	const report = computeItemReport({
		srcOrders: [sellOrder(7 * M, 1000)],
		destOrders: [],
		destDays: days,
		now: NOW
	});
	assert.ok(report.volume > 0, `volume ${report.volume}`);
	assert.ok(report.revenuePerItemMil > 12, `revenuePerItemMil ${report.revenuePerItemMil}`);
});
