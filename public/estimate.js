// Pure export estimate: given source/destination station sell orders and the
// destination region history for one type, work out how many units to haul and
// what that is worth. No network, no DOM, no globals, so it can be unit tested
// in Node (`node --test test/`) and loaded in the page with a plain <script>.
//
// Browser: <script src="estimate.js"></script> defines `window.estimate`.
// Node:    const estimate = require('./public/estimate.js');
(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory();
	else root.estimate = factory();
})(typeof self !== 'undefined' ? self : this, () => {
	const DAY_MS = 24 * 60 * 60 * 1000;
	const HOUR_MS = 60 * 60 * 1000;

	const defaultConfig = Object.freeze({
		DAYS_CONSIDERED: 30,
		DAYS_TO_COMPLETE: 5,
		HAULING_REWARD_FRACTION: 0.10,
		COST_LIMIT: 10 * Math.pow(10, 9),
		MIN_ROI: 1.5,
		SELL_TAX: 0.08 + 0.024,
		COMPETE_BAND: 0.10,
		SUPPLY_BAND: 0.25,
		ORDINARY_PRICE_DAYS: 90,
		RECENCY_HALF_LIFE_DAYS: 30,
		RECENT_THRESHOLD_DAYS: 10,
		ignoreOneActiveSeller: false,
		isAlwaysShow: false
	});

	//--- helpers (copied from util.js so this module has no runtime dependencies)

	// Returns a string, like util.roundNonZero.
	const roundNonZero = (num, nonZeroDigits = 2) => {
		const numStr = '' + num;
		if (numStr.indexOf('e') !== -1) return numStr;

		const index = numStr.search(/[^\.0]/);
		if (index === -1) return numStr;

		const dotIndex = numStr.indexOf('.');
		const end = Math.max(
			index + nonZeroDigits,
			dotIndex === -1
				? numStr.length
				: dotIndex + (
					num < Math.pow(10, nonZeroDigits)
						? nonZeroDigits
						: 0
				)
		);
		return numStr.substring(0, end);
	};

	const roundMils = (amount, nonZeroDigits = 2) => roundNonZero(amount / 1000000, nonZeroDigits);

	// Numeric versions used for report fields, so the table can sort them.
	const milsNum = (amount, nonZeroDigits = 2) => Number(roundMils(amount, nonZeroDigits));
	const nonZeroNum = (num, nonZeroDigits = 2) => Number(roundNonZero(num, nonZeroDigits));
	const round2 = num => Math.round(num * 100) / 100;

	const avg = list => list.reduce((acc, cur) => acc + cur, 0) / list.length;

	// History dates are "YYYY-MM-DD" in UTC. Age in whole days, truncated.
	const dayAge = (dateStr, now) => {
		const [y, m, d] = dateStr.split('-').map(Number);
		return Math.floor((now.getTime() - Date.UTC(y, m - 1, d)) / DAY_MS);
	};

	//---

	// Takes days and buckets them into volume weighted price buckets then returns the price from the dominant bucket.
	// Callers pass only the last ORDINARY_PRICE_DAYS days (computeItemReport does the slicing).
	const getOrdinaryPrice = (days, priceBucketPercent = 0.2) => {
		if (days.length === 0) return null;

		// Step 1: compute reference price
		const overallAveragePrice = days.reduce((sum, day) => sum + day.average, 0) / days.length;

		// Step 2: fixed bucket size derived from reference price
		const bucketSize = overallAveragePrice * priceBucketPercent;

		// bucketKey -> bucket
		const bucketByKey = {};

		for (const day of days) {
			const averagePrice = day.average;
			const tradeVolume = day.volume;

			// Step 3: assign to bucket
			const bucketKey = Math.round(averagePrice / bucketSize);

			let bucket = bucketByKey[bucketKey];
			if (!bucket) {
				bucket = {
					totalVolume: 0,
					weightedPriceSum: 0
				};
				bucketByKey[bucketKey] = bucket;
			}

			// Step 4: accumulate
			bucket.totalVolume += tradeVolume;
			bucket.weightedPriceSum += averagePrice * tradeVolume;
		}

		// Step 5: find dominant bucket
		let dominantBucket = null;
		for (const bucket of Object.values(bucketByKey)) {
			if (
				dominantBucket === null ||
				bucket.totalVolume > dominantBucket.totalVolume
			) {
				dominantBucket = bucket;
			}
		}

		// Step 6: volume-weighted price of dominant bucket
		return dominantBucket.weightedPriceSum / dominantBucket.totalVolume;
	};

	const recencyWeight = (age, halfLifeDays) => Math.pow(0.5, age / halfLifeDays);

	// Walks the destination history. Returns recency-weighted daily demand
	// (units/day sold on the sell side on profitable days), the number of
	// profitable days and the per-day sell prices of those days (oldest first).
	//
	// "Considered days" are ages 1..DAYS_CONSIDERED (age 0, today's partial day,
	// is counted as age 1). Days missing from history count as zero demand, so
	// the denominator sums the weight of every calendar day in the window.
	const calcDemand = (daysAsc, ordinaryPrice, srcBestSellPrice, now, c) => {
		let activeDays = 0;
		let weightedVolume = 0;
		const destSellPrices = [];
		const pastDays = [];

		for (const day of daysAsc) {
			const age = dayAge(day.date, now);
			if (age > c.DAYS_CONSIDERED + c.RECENT_THRESHOLD_DAYS) continue;
			pastDays.push(day);
			if (age > c.DAYS_CONSIDERED) continue;

			//calc recentMiddlePrice (and skip day if crazy over priced || recent high/low prices are the same)
			const recentDays = pastDays.slice(-1 * c.RECENT_THRESHOLD_DAYS);
			const recentHighPrice = avg(recentDays.map(day => day.highest));
			const recentLowPrice = avg(recentDays.map(day => day.lowest));

			const recentMiddlePrice = recentHighPrice === recentLowPrice
				? ordinaryPrice
				: recentLowPrice + (recentHighPrice - recentLowPrice) * 0.5;

			if (day.highest > recentMiddlePrice * 10) continue; //crazy over priced so skip day

			//calc highVolume
			const lowFrac = day.highest === day.lowest
				? (day.highest < recentMiddlePrice ? 1 : 0)
				: (day.highest - day.average) / (day.highest - day.lowest);
			const highFrac = 1 - lowFrac;
			const highVolume = highFrac * day.volume;

			//calc profitPerItem. The day's sell price is capped at the ordinary price or, when the
			//market has moved up recently, at the trailing RECENT_THRESHOLD_DAYS average high, so a
			//rising price counts within a couple of weeks while one-day spikes are still blocked.
			//Days whose high sits below the recent middle are buy-order-fill days (same rule as lowFrac
			//below); their "highs" are buy prices and must not drag the sell-side average down.
			const recentSellSideHighs = recentDays.filter(d => d.highest >= recentMiddlePrice).map(d => d.highest);
			const recentSellHighPrice = recentSellSideHighs.length > 0 ? avg(recentSellSideHighs) : recentHighPrice;
			const priceCap = Math.max(ordinaryPrice, recentSellHighPrice);
			const sellPrice = Math.min(day.highest, priceCap);
			const sellRevenue = sellPrice * (1 - c.SELL_TAX);
			const haulCost = c.HAULING_REWARD_FRACTION * srcBestSellPrice;
			const profitPerItem = sellRevenue - (srcBestSellPrice + haulCost);

			if (profitPerItem > 0) {
				destSellPrices.push(sellPrice);
				weightedVolume += recencyWeight(Math.max(1, age), c.RECENCY_HALF_LIFE_DAYS) * highVolume;
				activeDays++;
			}
		}

		let weightTotal = 0;
		for (let age = 1; age <= c.DAYS_CONSIDERED; age++) weightTotal += recencyWeight(age, c.RECENCY_HALF_LIFE_DAYS);

		return {
			dailyDemand: weightTotal > 0 ? weightedVolume / weightTotal : 0,
			activeDays,
			destSellPrices
		};
	};

	// sellerCount = dest sell orders issued within 24h of the most recent one
	// (minus one if ignoreOneActiveSeller); daysSinceSellerUpdate = whole hours
	// since the most recent order / 24, to 2dp.
	const calcDestSellers = (destSellOrders, now, c) => {
		if (destSellOrders.length === 0) return { sellerCount: null, daysSinceSellerUpdate: null };

		const issuedMs = destSellOrders.map(order => new Date(order.issued).getTime());
		const mostRecentMs = Math.max(...issuedMs);
		const recentCount = issuedMs.filter(ms => mostRecentMs - ms < 24 * HOUR_MS).length;
		const sellerCount = Math.max(0, recentCount - (c.ignoreOneActiveSeller ? 1 : 0));
		const hoursSince = Math.trunc((now.getTime() - mostRecentMs) / HOUR_MS);
		const daysSinceSellerUpdate = Math.round(hoursSince / 24 * 100) / 100;

		return { sellerCount, daysSinceSellerUpdate };
	};

	// Inputs:
	//   srcOrders, destOrders: ESI market orders ALREADY filtered to the source /
	//     destination station by the caller. Buy orders are dropped here
	//     (anything with is_buy_order === true), so passing mixed orders is fine.
	//     The caller's order objects are never mutated.
	//   destDays: ESI region history for the destination region (any order).
	//   now: Date, defaults to new Date().
	//   config: overrides for defaultConfig.
	// Returns a report object, or null when there is nothing to buy (no source
	// sell orders) or the calculation fails (the reason is logged).
	const computeItemReport = ({ srcOrders = [], destOrders = [], destDays = [], typeId = null, now = new Date(), config = {} } = {}) => {
		try {
			const c = { ...defaultConfig, ...config };

			const srcSellOrders = srcOrders.filter(order => order.is_buy_order !== true);
			const destSellOrders = destOrders.filter(order => order.is_buy_order !== true);
			if (srcSellOrders.length === 0) return null;

			const srcBestSellPrice = Math.min(...srcSellOrders.map(order => order.price));
			const destBestSellPrice = destSellOrders.length > 0
				? Math.min(...destSellOrders.map(order => order.price))
				: null;

			const daysAsc = [...destDays].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
			const ordinaryDays = daysAsc.filter(day => dayAge(day.date, now) <= c.ORDINARY_PRICE_DAYS);
			const ordinaryPrice = getOrdinaryPrice(ordinaryDays) || 0;

			const { dailyDemand, activeDays, destSellPrices } = calcDemand(daysAsc, ordinaryPrice, srcBestSellPrice, now, c);
			const destSellers = calcDestSellers(destSellOrders, now, c);

			//calc sellPrice (undercut the best dest order, but never above the recent average)
			const destRecentAverageSellPrice = destSellPrices.length > 0
				? avg(destSellPrices.slice(-1 * c.DAYS_TO_COMPLETE))
				: null;
			const sellPriceCandidates = [
				destBestSellPrice === null ? null : destBestSellPrice - 0.01,
				destRecentAverageSellPrice
			].filter(price => price !== null && Number.isFinite(price));
			const sellPrice = sellPriceCandidates.length > 0 ? Math.min(...sellPriceCandidates) : null;
			const revenuePerItem = sellPrice === null ? 0 : sellPrice * (1 - c.SELL_TAX);

			//calc competingVolume (dest stock we'd have to sell through first, or alongside)
			const competingVolume = sellPrice === null
				? 0
				: destSellOrders
					.filter(order => order.price <= sellPrice * (1 + c.COMPETE_BAND))
					.reduce((acc, order) => acc + order.volume_remain, 0);

			//calc supplyVolume (dest stock priced close enough to our sellPrice to matter for how long the market takes to absorb it)
			const supplyVolume = sellPrice === null
				? 0
				: destSellOrders
					.filter(order => order.price <= sellPrice * (1 + c.SUPPLY_BAND))
					.reduce((acc, order) => acc + order.volume_remain, 0);

			//calc buy cap over the horizon
			const cap = Math.max(0, dailyDemand * c.DAYS_TO_COMPLETE - competingVolume);

			//walk the source book cheapest first (copies, so the caller's orders aren't mutated)
			const book = srcSellOrders
				.map(order => ({ price: order.price, volume_remain: order.volume_remain }))
				.filter(order => order.volume_remain > 0)
				.sort((a, b) => a.price - b.price);
			let bookIndex = 0;
			let stopped = book.length === 0;

			const dayReports = [];
			for (let d = 1; d <= c.DAYS_TO_COMPLETE; d++) {
				let volume = 0;
				let cost = 0;
				let revenue = 0;

				const pastDaysVolume = dayReports.reduce((acc, cur) => acc + cur.volume, 0);
				const pastDaysCost = dayReports.reduce((acc, cur) => acc + cur.cost, 0);
				// (tiny epsilon so float noise in dailyDemand doesn't floor 43 to 42)
				const todayVolumeLimit = Math.floor(cap * d / c.DAYS_TO_COMPLETE - pastDaysVolume + 1e-9);

				while (!stopped && volume < todayVolumeLimit) {
					const order = book[bookIndex];
					const costPerItem = order.price * (1 + c.HAULING_REWARD_FRACTION);

					//marginal stop: the book is ascending, so every later order is worse
					if (!c.isAlwaysShow && revenuePerItem / costPerItem < c.MIN_ROI) {
						stopped = true;
						break;
					}

					const affordableVol = Math.floor((c.COST_LIMIT - (cost + pastDaysCost)) / order.price);
					if (affordableVol <= 0) {
						stopped = true;
						break;
					}

					const vol = Math.min(order.volume_remain, todayVolumeLimit - volume, affordableVol);
					order.volume_remain -= vol;
					volume += vol;
					cost += vol * costPerItem;
					revenue += vol * revenuePerItem;

					if (order.volume_remain <= 0) {
						bookIndex++;
						if (bookIndex >= book.length) stopped = true;
					}
				}

				dayReports.push({ volume, cost, revenue });
			}

			const total = dayReports.reduce((acc, cur) => {
				acc.volume += cur.volume;
				acc.cost += cur.cost;
				acc.revenue += cur.revenue;
				return acc;
			}, { volume: 0, cost: 0, revenue: 0 });

			const daysToClearRaw = dailyDemand > 0 ? (total.volume + competingVolume) / dailyDemand : null;
			const daysOfSupplyRaw = dailyDemand > 0 && sellPrice !== null ? supplyVolume / dailyDemand : null;
			const common = {
				daysToClear: daysToClearRaw === null ? null : round2(daysToClearRaw),
				daysOfSupply: daysOfSupplyRaw === null ? null : round2(daysOfSupplyRaw),
				competingVolume,
				dailyDemand: round2(dailyDemand),
				activeSellers: destSellers.sellerCount,
				daysSinceSellerUpdate: destSellers.daysSinceSellerUpdate,
				activeDaysFraction: nonZeroNum(activeDays / c.DAYS_CONSIDERED)
			};

			let report;
			if (total.volume > 0) {
				const profit = total.revenue - total.cost;
				report = {
					volume: total.volume,
					costPerItemMil: milsNum(Math.ceil(total.cost / total.volume), 3),
					revenuePerItemMil: milsNum(Math.floor(total.revenue / total.volume), 3),
					profitPerItemMil: milsNum(profit / total.volume, 3),
					roi: round2(total.revenue / total.cost),
					dailyProfitMil: milsNum(profit / Math.max(daysToClearRaw, 1)),
					dailyProfitOldMil: milsNum(profit / c.DAYS_TO_COMPLETE),
					...common
				};
			} else {
				// Nothing worth buying: show the raw best prices, like the old page did. With no dest
				// orders fall back to what history says buyers paid (recent profitable-day average, else
				// the ordinary price) so ROI is still informative.
				const destBest = destBestSellPrice !== null
					? destBestSellPrice
					: (destRecentAverageSellPrice !== null ? destRecentAverageSellPrice : ordinaryPrice);
				report = {
					volume: 0,
					costPerItemMil: milsNum(Math.ceil(srcBestSellPrice), 3),
					revenuePerItemMil: milsNum(Math.floor(destBest), 3),
					profitPerItemMil: milsNum(destBest - srcBestSellPrice, 3),
					roi: round2(destBest / srcBestSellPrice),
					dailyProfitMil: 0,
					dailyProfitOldMil: 0,
					...common
				};
			}

			report.filteredReason = applyFilters(report, c);
			return report;
		} catch (reason) {
			console.warn(`estimate.computeItemReport failed (typeId: ${typeId})`, reason);
			return null;
		}
	};

	// Page-level filters. Returns a short reason string, or null when the item
	// passes (always-show items always pass).
	const applyFilters = (report, config = {}) => {
		const c = { ...defaultConfig, ...config };
		if (c.isAlwaysShow) return null;
		if (!report) return 'no report';

		if (report.dailyProfitMil < 1 || report.volume === 0) return 'not profitable';

		if (report.revenuePerItemMil < report.costPerItemMil * c.MIN_ROI) return 'margin too slim';

		if (report.activeDaysFraction < 0.2) return 'too slow';

		const hem = (min, val, max) => Math.min(Math.max(min, val), max);
		const profitRating = hem(0, report.dailyProfitMil * 0.1, 1);
		const tooRecentThresholdMin = 1 / 24;
		const tooRecentThresholdMax = 30 / 24;
		const tooRecentlyThreshold = Math.floor((tooRecentThresholdMax - (tooRecentThresholdMax - tooRecentThresholdMin) * profitRating) * 100) / 100;
		if (report.daysSinceSellerUpdate !== null && report.daysSinceSellerUpdate < tooRecentlyThreshold) {
			return 'seller updated too recently';
		}

		const adjustedActiveSellers = report.activeSellers * (0.1 + Math.pow(0.9, Math.max(1, report.daysSinceSellerUpdate)));
		if (
			adjustedActiveSellers + 1 > report.revenuePerItemMil / report.costPerItemMil //poor percentage profit (relative to competition)
			&& report.dailyProfitMil < adjustedActiveSellers * 3 //poor absolute profit (relative to competition)
		) {
			return 'too much competition';
		}

		return null;
	};

	return {
		defaultConfig,
		computeItemReport,
		applyFilters,
		getOrdinaryPrice,
		// exposed for tests
		_internal: { roundNonZero, roundMils, avg, dayAge, recencyWeight }
	};
});
