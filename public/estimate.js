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
		SUPPLY_BAND: 0.75,
		BUY_SIDE_MARGIN: 0.10, // a day priced at or below best dest buy order * (1 + this) is a buy-order-fill day
		RIVAL_RECENCY_DECAY: 0.75, // a seller's chance of undercutting us multiplies by this per day since they touched their order
		RIVAL_PROXIMITY_POWER: 2,  // ...and falls off as 1 / (price multiple above the SUPPLY_BAND edge) ^ this
		ORDINARY_PRICE_DAYS: 90,
		RECENCY_HALF_LIFE_DAYS: 30,
		RECENT_THRESHOLD_DAYS: 10,
		ignoreOneActiveSeller: false,
		isAlwaysShow: false
	});

	//--- helpers (copied from util.js so this module has no runtime dependencies)

	// Returns a string, like util.roundNonZero.
	const roundNonZero = (num, nonZeroDigits = 2) => {
		if (num < 0) return '-' + roundNonZero(-num, nonZeroDigits);
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
	const calcDemand = (daysAsc, ordinaryPrice, srcBestSellPrice, destBestBuyPrice, now, c) => {
		//days priced no higher than the current best dest buy order (plus a margin) were buy-order fills
		const isBuySideDay = (d) => destBestBuyPrice !== null && d.highest <= destBestBuyPrice * (1 + c.BUY_SIDE_MARGIN);
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
			if (isBuySideDay(day)) continue; //buy-order fills: no sell-side demand that day

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
			const recentSellSideHighs = recentDays.filter(d => d.highest >= recentMiddlePrice && !isBuySideDay(d)).map(d => d.highest);
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

	// How many orders a day the destination region sees for a type: the recency-weighted mean of the
	// history's order_count over ages 1..DAYS_CONSIDERED, formed like calcDemand's demand (the same
	// weights; age 0, today's partial day, counts as age 1; a day missing from history counts 0, so
	// the denominator sums the weight of every calendar day in the window). Floored at 1 and rounded to
	// 2 decimals. The page sends it with each type to /api/market-stats, where it sets how close two
	// book-log samples must be to count as watching the book (half the typical interval between orders).
	const typicalOrdersPerDay = (destDays, now = new Date(), config = {}) => {
		const c = { ...defaultConfig, ...config };
		let weighted = 0;
		for (const day of Array.isArray(destDays) ? destDays : []) {
			const age = dayAge(day.date, now);
			if (age > c.DAYS_CONSIDERED) continue;
			const count = Number(day.order_count);
			if (Number.isFinite(count) && count > 0) weighted += recencyWeight(Math.max(1, age), c.RECENCY_HALF_LIFE_DAYS) * count;
		}
		let weightTotal = 0;
		for (let age = 1; age <= c.DAYS_CONSIDERED; age++) weightTotal += recencyWeight(age, c.RECENCY_HALF_LIFE_DAYS);
		return round2(Math.max(1, weightTotal > 0 ? weighted / weightTotal : 0));
	};

	// sellerCount = sell orders issued within 24h of the most recent one (minus one
	// if ignoreOneActiveSeller); daysSinceSellerUpdate = whole hours since the most
	// recent order / 24, to 2dp. Both are null when there are no orders. The caller
	// picks the order set: every dest sell order, or only the in-band ones.
	const calcDestSellers = (sellOrders, now, c) => {
		if (sellOrders.length === 0) return { sellerCount: null, daysSinceSellerUpdate: null };

		const issuedMs = sellOrders.map(order => new Date(order.issued).getTime());
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
	//   targetVolume: when a non-negative integer, the walk buys toward this many units instead of the
	//     demand cap, ignoring the ROI floor (the spend cap still applies). Used by the page for a factor
	//     other than 1. stopReason is then 'target' when the target was reached, else 'book' or 'cost'.
	//   observed: what the destination's book log saw for this type (public/market-stats.js computeMarketStats's
	//     answer; the page gets it from POST /api/market-stats), or null. It is blended in by covered time
	//     (plan: planning/2026-11-25-export-history-columns, decisions 1 and 4): daily demand =
	//     fV x fillsPerDay + (1 - fV) x the history model, rivals = fE x (undercutsPerDay x max(days to clear, 1))
	//     + (1 - fE) x the per-order model, where fV and fE are the volume and events coverage fractions. A null
	//     rate (nothing to blend) or a fraction of 0 leaves the model's figure; without `observed` every number
	//     is the model's. Never mutated.
	// Returns a report object, or null when there is nothing to buy (no source
	// sell orders) or the calculation fails (the reason is logged). A recommendation of 0 units is shown
	// as 1 unit from the cheapest source order (report.floored), filtered as 'nothing to buy'.
	const computeItemReport = ({ srcOrders = [], destOrders = [], destDays = [], typeId = null, now = new Date(), config = {}, targetVolume = null, observed = null } = {}) => {
		try {
			const c = { ...defaultConfig, ...config };

			const srcSellOrders = srcOrders.filter(order => order.is_buy_order !== true);
			const destSellOrders = destOrders.filter(order => order.is_buy_order !== true);
			const destBuyOrders = destOrders.filter(order => order.is_buy_order === true);
			if (srcSellOrders.length === 0) return null;
			const destBestBuyPrice = destBuyOrders.length > 0
				? Math.max(...destBuyOrders.map(order => order.price))
				: null;

			const srcBestSellPrice = Math.min(...srcSellOrders.map(order => order.price));
			const destBestSellPrice = destSellOrders.length > 0
				? Math.min(...destSellOrders.map(order => order.price))
				: null;

			const daysAsc = [...destDays].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
			const ordinaryDays = daysAsc.filter(day => dayAge(day.date, now) <= c.ORDINARY_PRICE_DAYS);
			const ordinaryPrice = getOrdinaryPrice(ordinaryDays) || 0;

			const { dailyDemand: dailyDemandModel, activeDays, destSellPrices } = calcDemand(daysAsc, ordinaryPrice, srcBestSellPrice, destBestBuyPrice, now, c);

			//observed figures (null when the type has no book log or none is passed): how much of the window
			//each kind of figure was observed over, and the observed rates. Demand blends here, so the cap,
			//the walk, days to clear, daily profit and days of supply all follow; rivals blend after the walk.
			const coverageFraction = (part) => {
				const f = observed && observed.coverage && observed.coverage[part] ? observed.coverage[part].fraction : 0;
				return Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0;
			};
			const fV = coverageFraction('volume');
			const fE = coverageFraction('events');
			const dailyDemandObserved = observed && Number.isFinite(observed.fillsPerDay) ? observed.fillsPerDay : null;
			const dailyDemand = dailyDemandObserved !== null && fV > 0
				? fV * dailyDemandObserved + (1 - fV) * dailyDemandModel
				: dailyDemandModel;

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

			//rivals: each dest sell order's chance of undercutting us = recency (decays per idle day: an
			//active seller notices quickly) × proximity (1 within SUPPLY_BAND above our sellPrice, then
			//1 / multiple^POWER beyond the band edge: a seller parked far above is unlikely to chase us).
			//Sums to an expected number of competitors; an active seller at 10x our price still counts a little.
			const rivalWeight = (order) => {
				if (sellPrice === null) return 0;
				const idleDays = Math.max(0, now.getTime() - new Date(order.issued).getTime()) / DAY_MS;
				const recency = Math.pow(c.RIVAL_RECENCY_DECAY, idleDays);
				const multiple = order.price / (sellPrice * (1 + c.SUPPLY_BAND));
				const proximity = multiple <= 1 ? 1 : Math.pow(1 / multiple, c.RIVAL_PROXIMITY_POWER);
				const weight = recency * proximity;
				return weight < 0.001 ? 0 : weight; // noise cutoff
			};
			const rivalsModel = destSellOrders.reduce((acc, order) => acc + rivalWeight(order), 0);

			//calc competingVolume: dest stock priced within COMPETE_BAND of our sellPrice sells before or
			//alongside ours whatever its age; stock priced above that joins in only if its seller undercuts
			//us, so it counts weighted by that chance (rivalWeight).
			const competingVolume = sellPrice === null
				? 0
				: destSellOrders.reduce((acc, order) => {
					const inBand = order.price <= sellPrice * (1 + c.COMPETE_BAND);
					return acc + order.volume_remain * (inBand ? 1 : rivalWeight(order));
				}, 0);

			//dest orders priced close enough to our sellPrice to matter (within SUPPLY_BAND above it). Sellers
			//parked far above the market are neither supply nor competition. Without a sellPrice, all orders.
			const inBandDestSellOrders = sellPrice === null
				? destSellOrders
				: destSellOrders.filter(order => order.price <= sellPrice * (1 + c.SUPPLY_BAND));

			//calc supplyVolume (dest stock we'd have to sell through, or alongside, before the price steps up)
			const supplyVolume = sellPrice === null
				? 0
				: inBandDestSellOrders.reduce((acc, order) => acc + order.volume_remain, 0);

			//calc active sellers / days idle over ALL dest sell orders (the displayed figures count every
			//seller at any price); the in-band idle figure (only sellers priced near our sell price) is
			//reported beside it for the "days idle" tooltip. Neither hides a row: the page used to filter
			//on the in-band figure, which made the list of best picks fluctuate.
			const destSellers = calcDestSellers(destSellOrders, now, c);
			const inBandSellers = calcDestSellers(inBandDestSellOrders, now, c);

			//calc buy cap over the horizon; a target volume replaces it as the walk's cap
			const targeting = Number.isFinite(targetVolume) && targetVolume >= 0;
			const demandCap = Math.max(0, dailyDemand * c.DAYS_TO_COMPLETE - competingVolume);
			const cap = targeting ? targetVolume : demandCap;

			//walk the source book cheapest first (copies, so the caller's orders aren't mutated)
			const book = srcSellOrders
				.map(order => ({ price: order.price, volume_remain: order.volume_remain }))
				.filter(order => order.volume_remain > 0)
				.sort((a, b) => a.price - b.price);
			let bookIndex = 0;
			let stopped = book.length === 0;
			//which limit ended the walk (the demand horizon / target is decided after the walk, see below)
			let stopReason = book.length === 0 ? 'book' : null;
			let stopPrice = null;
			let stopRoi = null;

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

					//marginal stop: the book is ascending, so every later order is worse (a target buys past it)
					if (!c.isAlwaysShow && !targeting && revenuePerItem / costPerItem < c.MIN_ROI) {
						stopped = true;
						stopReason = 'roi';
						stopPrice = order.price;
						stopRoi = revenuePerItem / costPerItem;
						break;
					}

					const affordableVol = Math.floor((c.COST_LIMIT - (cost + pastDaysCost)) / order.price);
					if (affordableVol <= 0) {
						stopped = true;
						stopReason = 'cost';
						stopPrice = order.price;
						break;
					}

					const vol = Math.min(order.volume_remain, todayVolumeLimit - volume, affordableVol);
					order.volume_remain -= vol;
					volume += vol;
					cost += vol * costPerItem;
					revenue += vol * revenuePerItem;

					if (order.volume_remain <= 0) {
						bookIndex++;
						if (bookIndex >= book.length) {
							stopped = true;
							stopReason = 'book';
						}
					}
				}

				dayReports.push({ volume, cost, revenue });
			}

			let total = dayReports.reduce((acc, cur) => {
				acc.volume += cur.volume;
				acc.cost += cur.cost;
				acc.revenue += cur.revenue;
				return acc;
			}, { volume: 0, cost: 0, revenue: 0 });

			//a recommendation of 0 units is shown as 1 unit from the cheapest source order, so the row still has
			//a real cost, ROI and days to clear. Only a recommendation is floored (a targeted walk buys what it
			//was asked for), and only when there is a sell price to value the unit at and the unit is affordable
			//(otherwise the raw-prices fallback below stays). The walk's own volume still decides the stop reason.
			const walkedVolume = total.volume;
			let floored = false;
			if (!targeting && total.volume === 0 && sellPrice !== null && book.length > 0 && book[0].price <= c.COST_LIMIT) {
				total = { volume: 1, cost: book[0].price * (1 + c.HAULING_REWARD_FRACTION), revenue: revenuePerItem };
				floored = true;
			}

			//the demand horizon (or the target) bound when the walk reached its cap (same epsilon as the daily
			//limit). That covers a cap of 0 from overhanging competing stock, and a book that ran out exactly
			//at the cap. horizonVolume is the demand cap in whole units, whatever the walk targeted.
			const horizonVolume = Math.floor(demandCap + 1e-9);
			if (targeting) {
				if (total.volume >= targetVolume) {
					stopReason = 'target';
					stopPrice = null;
					stopRoi = null;
				}
			} else if (walkedVolume >= horizonVolume) {
				stopReason = 'horizon';
				stopPrice = null;
				stopRoi = null;
			}
			if (stopReason === null) stopReason = targeting ? 'target' : 'horizon';

			const daysToClearRaw = dailyDemand > 0 ? (total.volume + competingVolume) / dailyDemand : null;
			const daysOfSupplyRaw = dailyDemand > 0 && sellPrice !== null ? supplyVolume / dailyDemand : null;

			//rivals: the observed undercuts per day over the days our units take to clear (at least a day),
			//blended with the per-order model by the share of the window the events were observed over
			const rivalsObserved = observed && Number.isFinite(observed.undercutsPerDay)
				? observed.undercutsPerDay * Math.max(daysToClearRaw ?? 1, 1)
				: null;
			const rivals = rivalsObserved !== null && fE > 0
				? fE * rivalsObserved + (1 - fE) * rivalsModel
				: rivalsModel;
			const common = {
				daysToClear: daysToClearRaw === null ? null : round2(daysToClearRaw),
				daysOfSupply: daysOfSupplyRaw === null ? null : round2(daysOfSupplyRaw),
				competingVolume: round2(competingVolume),
				rivals: round2(rivals),
				dailyDemand: round2(dailyDemand),
				//the blend's parts: the share of the window each kind of figure was observed over (0 without
				//observation), and each figure's model and observed value (observed null where there is none)
				observedFractionEvents: round2(fE),
				observedFractionVolume: round2(fV),
				dailyDemandModel: round2(dailyDemandModel),
				dailyDemandObserved: dailyDemandObserved === null ? null : round2(dailyDemandObserved),
				rivalsModel: round2(rivalsModel),
				rivalsObserved: rivalsObserved === null ? null : round2(rivalsObserved),
				//observed alone, never blended: mean days between price moves of the sellers within SUPPLY_BAND
				//of the best price (a lower bound when censored: nobody moved in the observed time), the in-band
				//stock's trend (units/day) and the coverage the observed figures stand on
				avgDaysIdle: observed && Number.isFinite(observed.avgDaysIdle) ? observed.avgDaysIdle : null,
				avgDaysIdleCensored: !!observed && observed.censored === true,
				stockTrendPerDay: observed && Number.isFinite(observed.stockTrendPerDay) ? observed.stockTrendPerDay : null,
				observedCoverage: observed && observed.coverage ? observed.coverage : null,
				activeSellers: destSellers.sellerCount,
				daysSinceSellerUpdate: destSellers.daysSinceSellerUpdate,
				daysSinceInBandSellerUpdate: inBandSellers.daysSinceSellerUpdate,
				activeDaysFraction: nonZeroNum(activeDays / c.DAYS_CONSIDERED),
				//context for tooltips
				activeDays,
				supplyVolume,
				sellPriceMil: sellPrice === null ? null : milsNum(sellPrice, 3),
				srcBestSellPriceMil: milsNum(srcBestSellPrice, 3),
				destBestSellPriceMil: destBestSellPrice === null ? null : milsNum(destBestSellPrice, 3),
				destBestBuyPriceMil: destBestBuyPrice === null ? null : milsNum(destBestBuyPrice, 3),
				destSellOrderCount: destSellOrders.length,
				//which limit bound the volume: 'horizon' (demand cap), 'roi', 'book' or 'cost'; 'target' when
				//the walk was given a targetVolume and reached it
				stopReason,
				stopPriceMil: stopPrice === null ? null : milsNum(stopPrice, 3),
				stopRoi: stopRoi === null ? null : round2(stopRoi),
				horizonVolume,
				targetVolume: targeting ? targetVolume : null,
				//true when nothing was worth buying and the figures are for 1 unit from the cheapest source order,
				//so the row still shows a real cost, ROI and days to clear
				floored
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
				// Nothing to show a unit of (an empty source book, no sell price, an unaffordable cheapest
				// order, or a target of 0): show the raw best prices, like the old page did. With no dest
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

			// (a targeted report is filtered like any other; the page replaces filteredReason with the recommendation's)
			report.filteredReason = applyFilters(report, c);
			return report;
		} catch (reason) {
			console.warn(`estimate.computeItemReport failed (typeId: ${typeId})`, reason);
			return null;
		}
	};

	// The limits behind the combined heuristic, shared by applyFilters (which names the first one a row
	// breaks) and limitBreaches (which names every figure that breaks one), so the two cannot drift.
	//rivals = expected number of sellers who will undercut us (recency × proximity weighted)
	const tooMuchCompetition = (report) => {
		const rivals = report.rivals || 0;
		return rivals + 1 > report.revenuePerItemMil / report.costPerItemMil //poor percentage profit (relative to competition)
			&& report.dailyProfitMil < rivals * 3; //poor absolute profit (relative to competition)
	};

	// Page-level filters. Returns a short reason string, or null when the item
	// passes (always-show items always pass). The single-column limits (daily profit, ROI, active days) are
	// not here: they are the page's min/max column filters now. What stays is what no one column can say:
	// nothing to buy, an empty source book, and the one heuristic that weighs several figures together
	// (too much competition).
	const applyFilters = (report, config = {}) => {
		const c = { ...defaultConfig, ...config };
		if (c.isAlwaysShow) return null;
		if (!report) return 'no report';

		//a floored report is 1 unit shown for the figures' sake: the recommendation was to buy nothing
		if (report.floored) return 'nothing to buy';

		if (report.volume === 0) return 'not profitable';
		if (tooMuchCompetition(report)) return 'too much competition';

		return null;
	};

	// The report fields whose value breaks a limit of the estimate, in column order: the competition
	// heuristic plus days to clear against the horizon (DAYS_TO_COMPLETE; not a filter, a limit the user set). The
	// column filters' limits (daily profit, ROI, active days) are the page's to check. It describes the
	// figures, not the row's filtered state, so isAlwaysShow and floored are ignored.
	const limitBreaches = (report, config = {}) => {
		const c = { ...defaultConfig, ...config };
		const breaches = [];
		if (!report) return breaches;
		if (tooMuchCompetition(report)) breaches.push('rivals');
		if (report.daysToClear > c.DAYS_TO_COMPLETE) breaches.push('daysToClear');
		return breaches;
	};

	return {
		defaultConfig,
		computeItemReport,
		applyFilters,
		limitBreaches,
		getOrdinaryPrice,
		typicalOrdersPerDay,
		// exposed for tests
		_internal: { roundNonZero, roundMils, avg, dayAge, recencyWeight }
	};
});
