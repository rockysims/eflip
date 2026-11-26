const test = require('node:test');
const assert = require('node:assert/strict');
const estimate = require('../public/estimate.js');

const { computeItemReport, applyFilters, limitBreaches, getOrdinaryPrice, typicalOrdersPerDay, defaultConfig } = estimate;
const { roundMils, recencyWeight, dayAge } = estimate._internal;

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
	sellOrder(10 * M, 5, 60 * 24) // outside the 10% band, and 60 days idle so it carries no rival weight
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
	const destOrders = [sellOrder(1 * M, 4), sellOrder(1.6 * M, 6), sellOrder(1.8 * M, 50)];
	const report = computeItemReport({ srcOrders: [sellOrder(0.1 * M, 1000)], destOrders, destDays: baseDays(), now: NOW });
	assert.equal(report.dailyDemand, 10);
	assert.equal(report.daysOfSupply, 1); // (4 + 6) / 10; the 1.8M order is outside the 75% band (edge 1.7325M)

	const noDemand = computeItemReport({ srcOrders: [sellOrder(0.1 * M, 1000)], destOrders, destDays: [], now: NOW });
	assert.equal(noDemand.daysOfSupply, null);

	const noSellPrice = computeItemReport({ srcOrders: [sellOrder(0.1 * M, 1000)], destOrders: [], destDays: [], now: NOW });
	assert.equal(noSellPrice.daysOfSupply, null);
});

test('buy cap without overhang = demand * horizon - competing volume', () => {
	const report = computeItemReport({ srcOrders: [sellOrder(1 * M, 1000)], destOrders: baseDest(), destDays: baseDays(), now: NOW });
	assert.equal(report.volume, 10 * 5 - 7);
	assert.equal(report.stopReason, 'horizon');
	assert.equal(report.horizonVolume, 43);
	assert.equal(report.stopPriceMil, null);
	assert.equal(report.stopRoi, null);
	assert.equal(report.floored, false);
});

test('buy cap with overhang >= horizon demand => 1 unit shown, filtered as nothing to buy', () => {
	const report = computeItemReport({
		srcOrders: [sellOrder(1 * M, 1000)],
		destOrders: [sellOrder(9 * M, 60)],
		destDays: baseDays(),
		now: NOW
	});
	// the walk buys 0 (cap 0), so the figures are for 1 unit from the cheapest source order
	assert.equal(report.volume, 1);
	assert.equal(report.floored, true);
	assert.equal(report.stopReason, 'horizon');
	assert.equal(report.horizonVolume, 0);
	assert.equal(report.competingVolume, 60);
	assert.equal(report.costPerItemMil, 1.1);
	assert.equal(report.revenuePerItemMil, 8.06);
	assert.equal(report.roi, 7.33);
	assert.equal(report.daysToClear, 6.1); // (1 + 60) / 10
	assert.equal(report.dailyProfitMil, Number(roundMils((REVENUE_PER_ITEM - 1.1 * M) / 6.1)));
	assert.equal(report.filteredReason, 'nothing to buy');
});

test('ROI floor on the cheapest order: 1 unit shown, filtered as nothing to buy', () => {
	// 8M returns REVENUE_PER_ITEM / 8.8M = 0.916x, below MIN_ROI, so the walk buys nothing
	const report = computeItemReport({ srcOrders: [sellOrder(8 * M, 1000)], destOrders: baseDest(), destDays: baseDays(), now: NOW });
	assert.equal(report.volume, 1);
	assert.equal(report.floored, true);
	assert.equal(report.stopReason, 'roi');
	assert.equal(report.stopPriceMil, 8);
	assert.equal(report.stopRoi, 0.92);
	assert.equal(report.horizonVolume, 43);
	assert.equal(report.costPerItemMil, 8.8);
	assert.equal(report.roi, 0.92);
	assert.equal(report.daysToClear, 0.8); // (1 + 7) / 10
	assert.equal(report.filteredReason, 'nothing to buy');
	// the figures are below the ROI floor; that is the page's ROI column filter to flag, not limitBreaches's
	assert.ok(report.roi < defaultConfig.MIN_ROI);
	assert.ok(!limitBreaches(report, {}).includes('roi'));
});

test('an empty book keeps the volume-0 fallback', () => {
	// a sell order with nothing left: no unit to show
	const report = computeItemReport({ srcOrders: [sellOrder(1 * M, 0)], destOrders: baseDest(), destDays: baseDays(), now: NOW });
	assert.equal(report.volume, 0);
	assert.equal(report.floored, false);
	assert.equal(report.stopReason, 'book');
	assert.equal(report.costPerItemMil, 1); // no hauling in the fallback
	assert.equal(report.dailyProfitMil, 0);
	assert.equal(report.filteredReason, 'not profitable');
});

test('nothing is floored without a sell price to value the unit at, or when the cheapest order is over the spend cap', () => {
	// no dest orders and no profitable day: no sell price, so the raw-prices fallback stays
	const noPrice = computeItemReport({ srcOrders: [sellOrder(100 * M, 10)], destOrders: [], destDays: flatHistory(1, 30, 10 * M, 10), now: NOW });
	assert.equal(noPrice.volume, 0);
	assert.equal(noPrice.floored, false);
	assert.equal(noPrice.sellPriceMil, null);
	assert.equal(noPrice.filteredReason, 'not profitable');

	// the cheapest order alone is over COST_LIMIT: the walk stops on the spend cap and nothing is floored
	const dear = computeItemReport({ srcOrders: [sellOrder(2 * M, 10)], destOrders: baseDest(), destDays: baseDays(), now: NOW, config: { COST_LIMIT: 1 * M } });
	assert.equal(dear.volume, 0);
	assert.equal(dear.floored, false);
	assert.equal(dear.stopReason, 'cost');
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
	assert.equal(report.stopReason, 'cost');
	assert.equal(report.stopPriceMil, 1);
});

test('ROI floor stops the walk and reports the order it stopped at', () => {
	// 1M clears the floor; the 8M order returns REVENUE_PER_ITEM / 8.8M = 0.916x, below MIN_ROI
	const srcOrders = [sellOrder(1 * M, 10), sellOrder(8 * M, 1000)];
	const report = computeItemReport({ srcOrders, destOrders: baseDest(), destDays: baseDays(), now: NOW });
	assert.equal(report.volume, 10);
	assert.equal(report.stopReason, 'roi');
	assert.equal(report.stopPriceMil, 8);
	assert.equal(report.stopRoi, Math.round(REVENUE_PER_ITEM / (8 * M * 1.1) * 100) / 100);
	assert.equal(report.stopRoi, 0.92);
	assert.equal(report.horizonVolume, 43);
});

test('source book running out is reported, unless it ran out exactly at the cap', () => {
	const short = computeItemReport({ srcOrders: [sellOrder(1 * M, 10)], destOrders: baseDest(), destDays: baseDays(), now: NOW });
	assert.equal(short.volume, 10);
	assert.equal(short.stopReason, 'book');
	assert.equal(short.stopPriceMil, null);
	assert.equal(short.stopRoi, null);
	assert.equal(short.horizonVolume, 43);

	// 43 is exactly the cap: the cap wins
	const exact = computeItemReport({ srcOrders: [sellOrder(1 * M, 43)], destOrders: baseDest(), destDays: baseDays(), now: NOW });
	assert.equal(exact.volume, 43);
	assert.equal(exact.stopReason, 'horizon');
});

test('target volume walks the source book to the target, past the ROI floor', () => {
	// the 8M order returns 0.916x, below MIN_ROI, so the recommendation stops at the 10 cheap units
	const srcOrders = [sellOrder(1 * M, 10), sellOrder(8 * M, 1000)];
	const recommended = computeItemReport({ srcOrders, destOrders: baseDest(), destDays: baseDays(), now: NOW });
	assert.equal(recommended.volume, 10);
	assert.equal(recommended.stopReason, 'roi');
	assert.equal(recommended.targetVolume, null);

	const report = computeItemReport({ srcOrders, destOrders: baseDest(), destDays: baseDays(), now: NOW, targetVolume: 30 });
	assert.equal(report.volume, 30);
	assert.equal(report.stopReason, 'target');
	assert.equal(report.targetVolume, 30);
	assert.equal(report.horizonVolume, 43); // the demand cap is still reported
	assert.equal(report.stopPriceMil, null);
	assert.equal(report.stopRoi, null);
	assert.equal(report.costPerItemMil, 6.23); // (10 x 1.1M + 20 x 8.8M) / 30 = 6.233M
	assert.equal(report.roi, 1.29);
	assert.equal(report.roi < defaultConfig.MIN_ROI, true);
	assert.equal(report.filteredReason, null); // a slim ROI is the page's column filter now, not the estimate's; the page keeps the recommendation's filtered state anyway
	assert.deepEqual(srcOrders.map(o => o.volume_remain), [10, 1000]);
});

test('a target below the recommendation buys only the cheapest units', () => {
	const srcOrders = [sellOrder(1 * M, 10), sellOrder(2 * M, 100)];
	const recommended = computeItemReport({ srcOrders, destOrders: baseDest(), destDays: baseDays(), now: NOW });
	assert.equal(recommended.volume, 43);
	assert.ok(recommended.costPerItemMil > 1.1);

	const report = computeItemReport({ srcOrders, destOrders: baseDest(), destDays: baseDays(), now: NOW, targetVolume: 5 });
	assert.equal(report.volume, 5);
	assert.equal(report.costPerItemMil, 1.1);
	assert.equal(report.stopReason, 'target');
});

test('a target beyond the book reports the book', () => {
	const report = computeItemReport({ srcOrders: [sellOrder(1 * M, 10)], destOrders: baseDest(), destDays: baseDays(), now: NOW, targetVolume: 20 });
	assert.equal(report.volume, 10);
	assert.equal(report.stopReason, 'book');
	assert.equal(report.targetVolume, 20);
});

test('a target under the spend cap reports the cap', () => {
	const report = computeItemReport({
		srcOrders: [sellOrder(1 * M, 1000)],
		destOrders: baseDest(),
		destDays: baseDays(),
		now: NOW,
		targetVolume: 20,
		config: { COST_LIMIT: 10 * M }
	});
	assert.equal(report.volume, 9); // same arithmetic as the COST_LIMIT test above
	assert.equal(report.stopReason, 'cost');
	assert.equal(report.stopPriceMil, 1);
});

test('target 0 buys nothing', () => {
	const report = computeItemReport({ srcOrders: [sellOrder(1 * M, 1000)], destOrders: baseDest(), destDays: baseDays(), now: NOW, targetVolume: 0 });
	assert.equal(report.volume, 0);
	assert.equal(report.floored, false); // a targeted walk is never floored
	assert.equal(report.stopReason, 'target');
	assert.equal(report.dailyProfitMil, 0);
	assert.equal(report.filteredReason, 'not profitable');
});

test('a loss keeps its digits: negative mils are not cut to -0', () => {
	assert.equal(roundMils(-2940, 3), '-0.00294');
	assert.equal(roundMils(-12345, 3), '-0.0123');
	// a cheap item bought toward a target past the ROI floor: 9,500 ISK a unit against a 9,000 ISK best dest sell
	const report = computeItemReport({ srcOrders: [sellOrder(9500, 100)], destOrders: [sellOrder(9000, 3)], destDays: flatHistory(1, 30, 10000, 10), now: NOW, targetVolume: 20 });
	assert.equal(report.volume, 20);
	assert.ok(report.profitPerItemMil < 0, `profitPerItemMil ${report.profitPerItemMil}`);
	assert.ok(report.dailyProfitMil < 0, `dailyProfitMil ${report.dailyProfitMil}`);
});

test('always-show ignores the ROI stop but still respects the cap, and bypasses filters', () => {
	const srcOrders = [sellOrder(6 * M, 10), sellOrder(1 * M, 10), sellOrder(4 * M, 10), sellOrder(7 * M, 100)];
	const report = computeItemReport({ srcOrders, destOrders: baseDest(), destDays: baseDays(), now: NOW, config: { isAlwaysShow: true } });
	assert.equal(report.volume, 43);
	assert.equal(report.stopReason, 'horizon');
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
	assert.equal(report.daysSinceInBandSellerUpdate, 0.5); // all four orders are in band here, so the in-band figure matches

	const ignored = computeItemReport({ srcOrders: [sellOrder(1 * M, 10)], destOrders, destDays: baseDays(), now: NOW, config: { ignoreOneActiveSeller: true } });
	assert.equal(ignored.activeSellers, 2);

	const none = computeItemReport({ srcOrders: [sellOrder(1 * M, 10)], destOrders: [], destDays: baseDays(), now: NOW });
	assert.equal(none.activeSellers, null);
	assert.equal(none.daysSinceSellerUpdate, null);
	assert.equal(none.daysSinceInBandSellerUpdate, null);
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
	assert.equal(applyFilters({ ...ok, volume: 0 }, {}), 'not profitable');
	// daily profit, ROI and active days are the page's column filters now: alone, a low value passes
	assert.equal(applyFilters({ ...ok, dailyProfitMil: 0.5 }, {}), null);
	assert.equal(applyFilters({ ...ok, revenuePerItemMil: 1.2 }, {}), null);
	assert.equal(applyFilters({ ...ok, activeDaysFraction: 0.1 }, {}), null);
	// all three low at once, with units to buy, an idle seller and no rivals, still passes
	assert.equal(applyFilters({ ...ok, roi: 1.2, revenuePerItemMil: 1.2, dailyProfitMil: 0.5, activeDaysFraction: 0.1 }, {}), null);
	// a seller who just updated is no reason to hide a row (that filter is gone), whichever idle figure is short
	// and whatever the daily profit
	assert.equal(applyFilters({ ...ok, dailyProfitMil: 2, daysSinceSellerUpdate: 0.5 }, {}), null);
	assert.equal(applyFilters({ ...ok, dailyProfitMil: 2, daysSinceSellerUpdate: 0.01, daysSinceInBandSellerUpdate: 0.01 }, {}), null);
	assert.equal(applyFilters({ ...ok, dailyProfitMil: 2, daysSinceSellerUpdate: 1.01 }, {}), null);
	// 5 sellers updated 2 days ago => adjusted 4.55; 5.55 > ROI 3 and dailyProfit 10 < 13.65
	assert.equal(applyFilters({ ...ok, revenuePerItemMil: 3, dailyProfitMil: 10, activeSellers: 5, daysSinceSellerUpdate: 2, rivals: 5 }, {}), 'too much competition');
	assert.equal(applyFilters({ ...ok, revenuePerItemMil: 3, dailyProfitMil: 20, activeSellers: 5, daysSinceSellerUpdate: 2 }, {}), null);
	// every reason is bypassed for always-show
	assert.equal(applyFilters({ ...ok, activeDaysFraction: 0 }, { isAlwaysShow: true }), null);
});

test('applyFilters: a floored report is filtered as nothing to buy, unless always-show', () => {
	assert.equal(applyFilters({ floored: true, volume: 1, dailyProfitMil: 50 }, {}), 'nothing to buy');
	assert.equal(applyFilters({ floored: true, volume: 1, dailyProfitMil: 50 }, { isAlwaysShow: true }), null);
	assert.equal(applyFilters({ floored: false, volume: 1, costPerItemMil: 1, revenuePerItemMil: 5, dailyProfitMil: 50, activeDaysFraction: 0.5 }, {}), null);
});

test('limitBreaches names the fields that break a limit', () => {
	// a low daily profit, ROI and active days are the page's column filters: they are not named here
	const broken = { volume: 10, dailyProfitMil: 0.5, revenuePerItemMil: 1, costPerItemMil: 1, activeDaysFraction: 0.1, daysSinceInBandSellerUpdate: 10, rivals: 0, daysToClear: 9 };
	assert.deepEqual(limitBreaches({ ...broken, daysToClear: 4 }, { DAYS_TO_COMPLETE: 5 }), []);
	assert.deepEqual(limitBreaches(broken, { DAYS_TO_COMPLETE: 5 }), ['daysToClear']);

	const healthy = { volume: 10, dailyProfitMil: 20, revenuePerItemMil: 5, costPerItemMil: 1, activeDaysFraction: 0.5, daysSinceInBandSellerUpdate: 3, rivals: 0, daysToClear: 4 };
	assert.deepEqual(limitBreaches(healthy, { DAYS_TO_COMPLETE: 5 }), []);
	assert.deepEqual(limitBreaches(healthy), [], 'the default config has the 5-day horizon');

	// a seller who just updated breaks no limit: the idle figures, short or not, are never named
	assert.deepEqual(limitBreaches({ ...healthy, daysSinceInBandSellerUpdate: 0.01, daysSinceSellerUpdate: 9 }, {}), []);
	const { daysSinceInBandSellerUpdate, ...noInBand } = healthy;
	assert.deepEqual(limitBreaches({ ...noInBand, daysSinceSellerUpdate: 0.01 }, {}), []);

	// too much competition: 5 rivals, ROI 3, daily profit 10 (the case applyFilters names above)
	assert.deepEqual(limitBreaches({ ...healthy, revenuePerItemMil: 3, costPerItemMil: 1, dailyProfitMil: 10, rivals: 5 }, {}), ['rivals']);

	// the horizon is the config's: the same days to clear is fine against a longer one
	assert.deepEqual(limitBreaches({ ...healthy, daysToClear: 9 }, { DAYS_TO_COMPLETE: 10 }), []);
	assert.deepEqual(limitBreaches({ ...healthy, daysToClear: null }, {}), []);

	// always-show and floored do not matter
	assert.deepEqual(limitBreaches({ ...healthy, volume: 0, dailyProfitMil: 0 }, {}), []);
	assert.deepEqual(limitBreaches({ ...broken, floored: true }, { isAlwaysShow: true, DAYS_TO_COMPLETE: 5 }), ['daysToClear']);
	assert.deepEqual(limitBreaches(null, {}), []);

	// a healthy estimate has none of them and still passes applyFilters
	const report = computeItemReport({ srcOrders: [sellOrder(1 * M, 1000)], destOrders: baseDest(), destDays: baseDays(), now: NOW });
	assert.equal(applyFilters(report, {}), null);
	assert.equal(report.filteredReason, null);
	assert.deepEqual(limitBreaches(report, {}), []);
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

	// the observed-figure fields: all at their no-observation values here (see the 'observed' tests below)
	const OBSERVED_KEYS = ['observedFractionEvents', 'observedFractionVolume', 'dailyDemandModel', 'dailyDemandObserved', 'rivalsModel', 'rivalsObserved', 'avgDaysIdle', 'avgDaysIdleCensored', 'stockTrendPerDay', 'observedCoverage'];
	const CONTEXT_KEYS = ['activeDays', 'supplyVolume', 'sellPriceMil', 'srcBestSellPriceMil', 'destBestSellPriceMil', 'destBestBuyPriceMil', 'destSellOrderCount', 'stopReason', 'stopPriceMil', 'stopRoi', 'horizonVolume', 'targetVolume', 'floored', ...OBSERVED_KEYS];
	assert.deepEqual(Object.keys(report).sort(), [
		'activeDaysFraction',
		'activeSellers',
		'competingVolume',
		'costPerItemMil',
		'dailyDemand',
		'dailyProfitMil',
		'daysOfSupply',
		'daysSinceInBandSellerUpdate',
		'daysSinceSellerUpdate',
		'daysToClear',
		'filteredReason',
		'profitPerItemMil',
		'revenuePerItemMil',
		'roi',
		'rivals',
		'volume',
		...CONTEXT_KEYS
	].sort());
	for (const [key, val] of Object.entries(report)) {
		if (key === 'filteredReason' || key === 'stopReason' || key === 'floored') continue; // text and a boolean
		if (val === null && (key === 'stopPriceMil' || key === 'stopRoi')) continue; // null when the demand cap bound
		if (val === null && key === 'targetVolume') continue; // null for a recommendation
		if (key === 'avgDaysIdleCensored') { assert.equal(val, false); continue; } // a boolean
		if (val === null && OBSERVED_KEYS.includes(key)) continue; // null without observation (observedCoverage is an object when observed)
		assert.equal(typeof val, 'number', `${key} should be a number`);
		assert.ok(Number.isFinite(val), `${key} should be finite`);
	}

	const context = {};
	for (const key of CONTEXT_KEYS) { context[key] = report[key]; delete report[key]; }
	assert.deepEqual(context, {
		activeDays: 26,
		supplyVolume: 19,
		sellPriceMil: 24.49, // 24.5M - 0.01, truncated
		srcBestSellPriceMil: 9.8,
		destBestSellPriceMil: 24.5,
		destBestBuyPriceMil: 15,
		destSellOrderCount: 3,
		stopReason: 'horizon', // the demand cap (5) bound the volume, not the book or the ROI floor
		stopPriceMil: null,
		stopRoi: null,
		horizonVolume: 5,
		targetVolume: null,
		floored: false,
		observedFractionEvents: 0,
		observedFractionVolume: 0,
		dailyDemandModel: 2.83, // = dailyDemand: nothing observed
		dailyDemandObserved: null,
		rivalsModel: 1.26, // = rivals
		rivalsObserved: null,
		avgDaysIdle: null,
		avgDaysIdleCensored: false,
		stockTrendPerDay: null,
		observedCoverage: null
	});

	assert.deepEqual(report, {
		// demand 2.83/day * 5 days - 9 competing => cap 5, all from the 9.8M order
		volume: 5,
		costPerItemMil: 10.78,
		revenuePerItemMil: 21.95,
		profitPerItemMil: 11.17,
		roi: 2.04,
		dailyProfitMil: 11.2, // 55.85 / 4.97
		daysToClear: 4.97, // (5 + 9.08) / 2.83
		daysOfSupply: 6.7, // 19 within 75% of sellPrice (31.0M is inside) / ~2.834
		competingVolume: 9.08, // 24.5M x6 and 26.0M x3 within 10% of 24.5M - 0.01, plus 31.0M x10 at its rival weight 0.75^16.7
		rivals: 1.26, // 0.75^1.25 + 0.75^2.08 + 0.75^16.7 (all within the 75% band)
		dailyDemand: 2.83,
		activeSellers: 2,
		daysSinceSellerUpdate: 1.25,
		daysSinceInBandSellerUpdate: 1.25, // every order is within the 75% band, so same as daysSinceSellerUpdate
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

test('active sellers and days idle count every dest sell order; the in-band idle figure and days of supply stay in-band', () => {
	// Best dest order 1M (48h old) plus a joke order at 10M (refreshed 1h ago). sellPrice ~1M, band edge 1.75M,
	// so the 10M order is out of band: not supply, and not in the in-band idle figure. It is still a seller.
	const destOrders = [sellOrder(1 * M, 4, 48), sellOrder(10 * M, 6, 1)];
	const report = computeItemReport({ srcOrders: [sellOrder(0.1 * M, 1000)], destOrders, destDays: baseDays(), now: NOW });
	// The 10M order (1h) is the newest; the 1M order (48h) is 47h older, outside the 24h window.
	assert.equal(report.activeSellers, 1);
	assert.equal(report.daysSinceSellerUpdate, 0.04); // 1 whole hour / 24, 2dp
	assert.equal(report.daysSinceInBandSellerUpdate, 2); // only the 1M order is in band: 48h / 24
	assert.equal(report.daysOfSupply, 0.4); // 4 in-band units / 10 per day

	// A second order within 24h of the newest counts as an active seller whatever its price.
	const two = computeItemReport({ srcOrders: [sellOrder(0.1 * M, 1000)], destOrders: [sellOrder(1 * M, 4, 20), sellOrder(10 * M, 6, 1)], destDays: baseDays(), now: NOW });
	assert.equal(two.activeSellers, 2);
	assert.equal(two.daysSinceSellerUpdate, 0.04);
	assert.equal(two.daysSinceInBandSellerUpdate, 0.83); // 20h / 24
	const twoIgnored = computeItemReport({ srcOrders: [sellOrder(0.1 * M, 1000)], destOrders: [sellOrder(1 * M, 4, 20), sellOrder(10 * M, 6, 1)], destDays: baseDays(), now: NOW, config: { ignoreOneActiveSeller: true } });
	assert.equal(twoIgnored.activeSellers, 1);

	// Only the joke order, with history at 1M so the sell price stays ~1M: it is the one seller, but nothing is in band.
	const onlyJoke = computeItemReport({ srcOrders: [sellOrder(0.1 * M, 1000)], destOrders: [sellOrder(10 * M, 6, 1)], destDays: flatHistory(1, 30, 1 * M, 10), now: NOW });
	assert.equal(onlyJoke.activeSellers, 1);
	assert.equal(onlyJoke.daysSinceSellerUpdate, 0.04);
	assert.equal(onlyJoke.daysSinceInBandSellerUpdate, null);
	assert.equal(onlyJoke.daysOfSupply, 0);
});

test('a recently updated seller does not hide an item, whether the fresh order is in band or far above the market', () => {
	// Modest-profit item (history 1M, source 0.1M, dailyProfit ~6.5M): the old filter's threshold for it was ~0.46 day.
	// In-band order at 0.9M, joke order at 9M.
	const run = (inBandHoursAgo, jokeHoursAgo) => computeItemReport({
		srcOrders: [sellOrder(0.1 * M, 1000)],
		destOrders: [sellOrder(0.9 * M, 3, inBandHoursAgo), sellOrder(9 * M, 5, jokeHoursAgo)],
		destDays: flatHistory(1, 30, 1 * M, 10),
		now: NOW
	});

	// In-band seller idle 2 days, joke order refreshed 1h ago: the all-orders figure is 0.04, the in-band one 2.
	const jokeFresh = run(48, 1);
	assert.equal(jokeFresh.daysSinceSellerUpdate, 0.04);
	assert.equal(jokeFresh.daysSinceInBandSellerUpdate, 2);
	assert.ok(jokeFresh.dailyProfitMil < 10, `dailyProfitMil ${jokeFresh.dailyProfitMil}`);
	assert.equal(jokeFresh.filteredReason, null);

	// The same item with the in-band order refreshed 1h ago used to be filtered; both idle figures stay reported, the row stays.
	const inBandFresh = run(1, 1);
	assert.equal(inBandFresh.daysSinceSellerUpdate, 0.04);
	assert.equal(inBandFresh.daysSinceInBandSellerUpdate, 0.04);
	assert.equal(inBandFresh.filteredReason, null);
	assert.deepEqual(limitBreaches(inBandFresh, {}), []);

	// Hand-built reports: no combination of the two idle figures filters a row.
	const ok = { volume: 10, costPerItemMil: 1, revenuePerItemMil: 5, dailyProfitMil: 2, activeDaysFraction: 0.5, activeSellers: 0 };
	assert.equal(applyFilters({ ...ok, daysSinceSellerUpdate: 0.5 }, {}), null);
	assert.equal(applyFilters({ ...ok, daysSinceSellerUpdate: 0.5, daysSinceInBandSellerUpdate: 3 }, {}), null);
	assert.equal(applyFilters({ ...ok, daysSinceSellerUpdate: 3, daysSinceInBandSellerUpdate: 0.5 }, {}), null);
	assert.equal(applyFilters({ ...ok, daysSinceSellerUpdate: 0.5, daysSinceInBandSellerUpdate: null }, {}), null);
});

test('days priced at or below the best dest buy order are buy-order fills and add no demand', () => {
	// 30 flat days at 0.05M, 1000/day. With a dest buy order at 0.05M those are buy fills: no demand.
	const days = flatHistory(1, 30, 0.05 * M, 1000);
	const buyOrder = { price: 0.05 * M, volume_remain: 5000, is_buy_order: true, issued: isoHoursAgo(1) };
	const withBuy = computeItemReport({ srcOrders: [sellOrder(0.01 * M, 100000)], destOrders: [buyOrder], destDays: days, now: NOW });
	assert.equal(withBuy.dailyDemand, 0);
	assert.equal(withBuy.volume, 0);
	assert.equal(withBuy.destBestBuyPriceMil, 0.05);
	// Without buy orders the same days count as sell-side demand.
	const without = computeItemReport({ srcOrders: [sellOrder(0.01 * M, 100000)], destOrders: [], destDays: days, now: NOW });
	assert.equal(without.dailyDemand, 1000);
	assert.ok(without.volume > 0);
	// A buy order well below the traded price (0.02M vs 0.05M) does not reclassify the days.
	const lowBuy = computeItemReport({ srcOrders: [sellOrder(0.01 * M, 100000)], destOrders: [{ ...buyOrder, price: 0.02 * M }], destDays: days, now: NOW });
	assert.equal(lowBuy.dailyDemand, 1000);
});

test('rivals: recency decays 0.75 per idle day, proximity falls as 1/multiple^2 beyond the band edge', () => {
	// sellPrice ~1M (best dest order 1M), band edge 1.75M.
	const day = 24;
	// A fresh 1M order anchors the sell price in every case and itself counts 1 (or 0.75^2 when 2 days idle).
	const cases = [
		{ orders: [sellOrder(1 * M, 1, 0)], expect: 1 },
		{ orders: [sellOrder(1 * M, 1, 2 * day)], expect: 0.5625 },
		{ orders: [sellOrder(1 * M, 1, 0), sellOrder(3.5 * M, 1, 0)], expect: 1.25 },        // twice the band edge: 1/2^2
		{ orders: [sellOrder(1 * M, 1, 0), sellOrder(17.5 * M, 1, 0)], expect: 1.01 },       // ten times the edge
		{ orders: [sellOrder(1 * M, 1, 0), sellOrder(3.5 * M, 1, 2 * day)], expect: 1.1406 } // 1 + 0.25 * 0.75^2
	];
	for (const { orders, expect } of cases) {
		const report = computeItemReport({ srcOrders: [sellOrder(0.1 * M, 1000)], destOrders: orders, destDays: baseDays(), now: NOW });
		approx(report.rivals, expect, 0.011);
	}
});

test('out-of-band stock counts toward competing volume only by its rival weight', () => {
	// best dest order 1M x 3 (fresh): in the 10% band => counts fully.
	// 3.5M x 100 fresh: outside the band, weight 0.25 => 25 units.
	const destOrders = [sellOrder(1 * M, 3, 0), sellOrder(3.5 * M, 100, 0)];
	const report = computeItemReport({ srcOrders: [sellOrder(0.1 * M, 1000)], destOrders, destDays: baseDays(), now: NOW });
	assert.equal(report.competingVolume, 28);
	// the same 100 units twelve days idle contribute ~0.25 * 0.75^12 * 100 = 0.79
	const stale = computeItemReport({ srcOrders: [sellOrder(0.1 * M, 1000)], destOrders: [sellOrder(1 * M, 3, 0), sellOrder(3.5 * M, 100, 12 * 24)], destDays: baseDays(), now: NOW });
	approx(stale.competingVolume, 3.79, 0.02);
});

// ---- typicalOrdersPerDay

test('typicalOrdersPerDay: a flat history gives its order count; none gives 1; a missing day lowers it', () => {
	const flat = (count, fromAge = 1, toAge = 30) => flatHistory(fromAge, toAge, 10 * M, 10).map(day => ({ ...day, order_count: count }));
	assert.equal(typicalOrdersPerDay(flat(4), NOW), 4);
	assert.equal(typicalOrdersPerDay([], NOW), 1, 'no history: the floor');
	assert.equal(typicalOrdersPerDay(flat(0), NOW), 1, 'a quiet history is floored at 1');
	assert.equal(typicalOrdersPerDay(flat(0.4), NOW), 1);

	// a day with no trades counts 0, at its recency weight: dropping age 2 takes 4 x w(2) / sum(w) off
	const missing = flat(4).filter(day => day.date !== dateForAge(2));
	const expected = 4 - 4 * recencyWeight(2, defaultConfig.RECENCY_HALF_LIFE_DAYS) / weightTotal;
	assert.equal(typicalOrdersPerDay(missing, NOW), Math.round(expected * 100) / 100);
	assert.ok(typicalOrdersPerDay(missing, NOW) < 4);

	// 10 days of history instead of 30: only their weights count, the rest of the window is 0
	const tenDays = flat(4, 1, 10);
	let tenWeights = 0;
	for (let age = 1; age <= 10; age++) tenWeights += recencyWeight(age, defaultConfig.RECENCY_HALF_LIFE_DAYS);
	assert.equal(typicalOrdersPerDay(tenDays, NOW), Math.round(4 * tenWeights / weightTotal * 100) / 100);
});

test('typicalOrdersPerDay: recent days weigh more, days past DAYS_CONSIDERED are ignored, today counts as age 1', () => {
	// the same two counts either way round, split at 15 days: the half-life weights favour the recent half
	const history = (recentCount, oldCount) => flatHistory(1, 30, 10 * M, 10).map(day => ({ ...day, order_count: dayAge(day.date, NOW) <= 15 ? recentCount : oldCount }));
	assert.ok(typicalOrdersPerDay(history(20, 2), NOW) > typicalOrdersPerDay(history(2, 20), NOW));

	const base = flatHistory(1, 30, 10 * M, 10).map(day => ({ ...day, order_count: 4 }));
	const withOld = [...base, { ...flatDay(31, 10 * M, 10), order_count: 500 }, { ...flatDay(45, 10 * M, 10), order_count: 500 }];
	assert.equal(typicalOrdersPerDay(withOld, NOW), 4);

	// age 0 is today's partial day, weighed as age 1 (the same as calcDemand): one 4-order day today alone is w(1) x 4 / sum(w)
	const today = [{ ...flatDay(0, 10 * M, 10), order_count: 4 }];
	assert.equal(typicalOrdersPerDay(today, NOW), Math.max(1, Math.round(4 * recencyWeight(1, defaultConfig.RECENCY_HALF_LIFE_DAYS) / weightTotal * 100) / 100));
	// the clock and the config are read: a shorter window counts a shorter history
	assert.equal(typicalOrdersPerDay(base, NOW, { DAYS_CONSIDERED: 10 }), 4);
	// ten days later the same history is aged 11..40: the days still within 30 weigh at their new, older age
	let laterWeights = 0;
	for (let age = 11; age <= 30; age++) laterWeights += recencyWeight(age, defaultConfig.RECENCY_HALF_LIFE_DAYS);
	assert.equal(typicalOrdersPerDay(base, new Date(NOW.getTime() + 10 * DAY_MS)), Math.round(4 * laterWeights / weightTotal * 100) / 100);
});

// ---- observed figures blended into the report

// What computeMarketStats answers, built by hand: only the fields the estimate reads.
const observedOf = (over = {}) => ({
	coverage: { windowDays: 3, samples: 40, medianGapHours: 1, maxGapHours: 2, from: '2026-05-29T12:00:00.000Z', to: '2026-06-01T12:00:00.000Z', events: { gapHours: 3, coveredDays: 3, fraction: 1 }, volume: { gapHours: 24, coveredDays: 3, fraction: 1 } },
	repriceEvents: 7,
	avgDaysIdle: 0.4,
	censored: false,
	undercutsPerDay: 2,
	fillsPerDay: 20,
	vanishedUnitsPerDay: 1,
	stockTrendPerDay: -3,
	...over
});
const withFractions = (events, volume, over = {}) => {
	const observed = observedOf(over);
	observed.coverage.events.fraction = events;
	observed.coverage.volume.fraction = volume;
	return observed;
};
const baseReport = (observed) => computeItemReport({ srcOrders: [sellOrder(1 * M, 1000)], destOrders: baseDest(), destDays: baseDays(), now: NOW, observed });

test('observed, fully covered: demand is the observed fills, the cap follows, rivals are undercuts x days to clear', () => {
	const report = baseReport(observedOf());
	assert.equal(report.dailyDemand, 20);
	assert.equal(report.dailyDemandObserved, 20);
	assert.equal(report.dailyDemandModel, 10);
	assert.equal(report.horizonVolume, 20 * 5 - 7, 'the demand cap is observed demand x horizon - competing');
	assert.equal(report.volume, 93, 'against 1000 units on the book');
	assert.equal(report.stopReason, 'horizon');
	assert.equal(report.daysToClear, 5); // (93 + 7) / 20
	assert.equal(report.rivalsObserved, 2 * report.daysToClear);
	assert.equal(report.rivals, report.rivalsObserved);
	assert.equal(report.rivals, 10);
	assert.equal(report.rivalsModel, baseReport(null).rivals, 'the model figure is what no observation gives');
	assert.equal(report.observedFractionEvents, 1);
	assert.equal(report.observedFractionVolume, 1);
	assert.equal(report.avgDaysIdle, 0.4);
	assert.equal(report.avgDaysIdleCensored, false);
	assert.equal(report.stockTrendPerDay, -3);
	assert.deepEqual(report.observedCoverage, observedOf().coverage);
	// everything downstream follows the blended demand: days of supply and daily profit
	assert.equal(report.daysOfSupply, 0.6); // 12 units listed within the band / 20 a day
	approx(report.dailyProfitMil, report.profitPerItemMil * 93 / 5, 1.5); // profit over max(days to clear, 1), roundNonZero truncating
	assert.ok(report.dailyProfitMil > baseReport(null).dailyProfitMil);
});

test('observed at half coverage: the midpoint of the observed and the model figures', () => {
	const model = baseReport(null);
	const half = baseReport(withFractions(0.5, 0.5));
	assert.equal(model.dailyDemand, 10);
	assert.equal(half.dailyDemand, 15); // 0.5 x 20 + 0.5 x 10
	assert.equal(half.dailyDemandModel, model.dailyDemand);
	assert.equal(half.dailyDemandObserved, 20);
	assert.equal(half.observedFractionEvents, 0.5);
	assert.equal(half.observedFractionVolume, 0.5);
	assert.equal(half.horizonVolume, 15 * 5 - 7);
	assert.equal(half.daysToClear, round2Of((half.volume + 7) / 15));
	// rivals: observed = 2/day x days to clear; the model sum is untouched by the observation
	approx(half.rivalsModel, model.rivals, 0.011);
	approx(half.rivalsObserved, 2 * (half.volume + 7) / 15, 0.011);
	approx(half.rivals, 0.5 * half.rivalsObserved + 0.5 * half.rivalsModel, 0.011);
	assert.ok(half.rivals > half.rivalsModel && half.rivals < half.rivalsObserved, 'between the model and the observed figure');

	// the two fractions are independent: events fully covered, volume not at all
	const eventsOnly = baseReport(withFractions(1, 0));
	assert.equal(eventsOnly.dailyDemand, model.dailyDemand, 'no volume coverage: the model demand');
	assert.equal(eventsOnly.rivals, eventsOnly.rivalsObserved);
	const volumeOnly = baseReport(withFractions(0, 1));
	assert.equal(volumeOnly.dailyDemand, 20);
	assert.equal(volumeOnly.rivals, volumeOnly.rivalsModel);
});
const round2Of = (x) => Math.round(x * 100) / 100;

test('observed with no coverage is the same as no observation, apart from the carried fields', () => {
	const none = baseReport(null);
	const zero = baseReport(withFractions(0, 0, { avgDaysIdle: null, undercutsPerDay: null, fillsPerDay: null, stockTrendPerDay: null }));
	const figures = (report) => {
		const { observedCoverage, ...rest } = report;
		return rest;
	};
	assert.deepEqual(figures(zero), figures(none));
	// even with rates present, a fraction of 0 leaves the model alone
	const ignored = baseReport(withFractions(0, 0));
	assert.equal(ignored.dailyDemand, none.dailyDemand);
	assert.equal(ignored.rivals, none.rivals);
	assert.equal(ignored.volume, none.volume);
	assert.equal(ignored.daysToClear, none.daysToClear);
	assert.equal(ignored.dailyProfitMil, none.dailyProfitMil);
	assert.equal(ignored.dailyDemandObserved, 20, 'the observed figure is still reported');
	assert.equal(ignored.rivalsObserved, 2 * ignored.daysToClear);
	assert.deepEqual(none.observedCoverage, null);
});

test('observed: a null rate leaves the model figure whatever the coverage says', () => {
	const none = baseReport(null);
	const noFills = baseReport(observedOf({ fillsPerDay: null }));
	assert.equal(noFills.dailyDemand, none.dailyDemand, 'fraction 1 but nothing to blend: the model demand');
	assert.equal(noFills.dailyDemandObserved, null);
	assert.equal(noFills.volume, none.volume);
	assert.equal(noFills.observedFractionVolume, 1, 'the coverage is still reported');
	const noUndercuts = baseReport(observedOf({ undercutsPerDay: null }));
	assert.equal(noUndercuts.rivals, none.rivals);
	assert.equal(noUndercuts.rivalsObserved, null);
	assert.equal(noUndercuts.dailyDemand, 20, 'the fills still blend');
	// no demand at all: days to clear is null, and the observed rivals count a one-day clear
	const noDemand = computeItemReport({ srcOrders: [sellOrder(1 * M, 1000)], destOrders: baseDest(), destDays: [], now: NOW, observed: withFractions(1, 0) });
	assert.equal(noDemand.daysToClear, null);
	assert.equal(noDemand.rivalsObserved, 2);
	assert.equal(noDemand.rivals, 2);
});

test('observed: censored, the idle figure and the stock trend pass through unblended; the input is never mutated', () => {
	const observed = observedOf({ avgDaysIdle: 1.5, censored: true, repriceEvents: 0, stockTrendPerDay: null });
	const before = JSON.stringify(observed);
	const report = baseReport(observed);
	assert.equal(JSON.stringify(observed), before);
	assert.equal(report.avgDaysIdle, 1.5);
	assert.equal(report.avgDaysIdleCensored, true);
	assert.equal(report.stockTrendPerDay, null);
	const nobody = baseReport(observedOf({ avgDaysIdle: null, censored: false }));
	assert.equal(nobody.avgDaysIdle, null);
	assert.equal(nobody.avgDaysIdleCensored, false);
	// a half-covered observation still reports the observed idle figure as it is
	assert.equal(baseReport(withFractions(0.25, 0.25, { avgDaysIdle: 0.4 })).avgDaysIdle, 0.4);
	// the report does not share the model figures with the page by accident: a re-estimate with the same
	// observation (the page's factor path) is the same report
	const again = baseReport(observed);
	assert.deepEqual(again, report);
});

test('observed: a malformed observation counts as none rather than failing the report', () => {
	const none = baseReport(null);
	for (const bad of [{}, { coverage: {} }, { coverage: { events: {}, volume: {} }, fillsPerDay: 'x' }, { coverage: { events: { fraction: NaN }, volume: { fraction: NaN } }, fillsPerDay: 20, undercutsPerDay: 2 }]) {
		const report = baseReport(bad);
		assert.notEqual(report, null);
		assert.equal(report.dailyDemand, none.dailyDemand);
		assert.equal(report.rivals, none.rivals);
	}
	// fractions are held to [0, 1]
	assert.equal(baseReport(withFractions(7, 7)).observedFractionVolume, 1);
	assert.equal(baseReport(withFractions(-1, -1)).observedFractionVolume, 0);
});

test('too much competition reads the blended rivals', () => {
	// the base scenario's model rivals are small; observing 30 undercuts a day makes the row "too much competition"
	const calm = baseReport(null);
	assert.equal(calm.filteredReason, null);
	const busy = baseReport(observedOf({ undercutsPerDay: 30 }));
	assert.ok(busy.rivals > calm.rivals);
	assert.equal(busy.rivals, busy.rivalsObserved);
	assert.equal(busy.filteredReason, 'too much competition');
	assert.deepEqual(limitBreaches(busy, {}), ['rivals']);
});
