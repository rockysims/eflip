const {
	getTypeIds,
	getDays,
	getOrders,
	roundNonZero,
	roundMils,
	avg,
	getTypeName,
	getTypeM3,

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
		BUY_TAX
	}
} = util;

//*
const START_REGION_ID = JITA_REGION_ID;
const START_STATION_ID = JITA_STATION_ID;
const END_REGION_ID = AMARR_REGION_ID;
const END_STATION_ID = AMARR_STATION_ID;
// const END_REGION_ID = STACMON_REGION_ID;
// const END_STATION_ID = STACMON_STATION_ID;
// const END_REGION_ID = DODIXIE_REGION_ID;
// const END_STATION_ID = DODIXIE_STATION_ID;
/*/
// const START_REGION_ID = DODIXIE_REGION_ID;
// const START_STATION_ID = DODIXIE_STATION_ID;
const START_REGION_ID = STACMON_REGION_ID;
const START_STATION_ID = STACMON_STATION_ID;
// const START_REGION_ID = AMARR_REGION_ID;
// const START_STATION_ID = AMARR_STATION_ID;
const END_REGION_ID = JITA_REGION_ID;
const END_STATION_ID = JITA_STATION_ID;
//*/

const DAYS_CONSIDERED = 30;
const DAYS_TO_COMPLETE = 5;
const STEP_SIZE = 250;
const HAULING_REWARD_FRACTION = 0.05;
const COST_LIMIT = 10 * Math.pow(10, 9);

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

const nowMoment = moment();
const getItemExportReport = async (srcRegionId, srcLocationId, destRegionId, destLocationId, typeId) => {
	try {
		const srcOrders = (await getOrders(srcRegionId, typeId)).filter(order => order.location_id === srcLocationId);
		const destOrders = (await getOrders(destRegionId, typeId)).filter(order => order.location_id === destLocationId);
		const destDays = await getDays(destRegionId, typeId);

		//calc srcBestSellPrice
		const srcSellOrders = srcOrders.filter(order => order.is_buy_order === false);
		const srcBestSellOrder = srcSellOrders.reduce((order, bestSellOrder) => {
			if (order.price < bestSellOrder.price) bestSellOrder = order;
			return bestSellOrder;
		}, srcSellOrders[0] || null);
		const srcBestSellPrice = srcBestSellOrder?.price || Number.POSITIVE_INFINITY;

		//calc destBestSellPrice
		const destSellOrders = destOrders.filter(order => order.is_buy_order === false);
		const destBestSellOrder = destSellOrders.reduce((order, bestSellOrder) => {
			if (order.price < bestSellOrder.price) bestSellOrder = order;
			return bestSellOrder;
		}, destSellOrders[0] || null);
		const destBestSellPrice = destBestSellOrder?.price || null;

		const ordinaryPrice = getOrdinaryPrice(destDays) || 0;

		//calc totalSellVolume and activeDays
		let activeDays = 0;
		let totalSellVolume = 0;
		const destSellPrices = [];
		const pastDays = [];
		const RECENT_THRESHOLD_DAYS = 10;
		for (let day of destDays) {
			const age = nowMoment.diff(day.date, 'd');
			if (age > DAYS_CONSIDERED + RECENT_THRESHOLD_DAYS) continue;
			pastDays.push(day);
			if (age > DAYS_CONSIDERED) continue;

			//calc recentMiddlePrice (and skip day if crazy over priced || recent high/low prices are the same)
			const recentDays = pastDays.slice(-1 * RECENT_THRESHOLD_DAYS);
			const recentHighPrice = avg([...recentDays.map(day => day.highest)]);
			const recentLowPrice = avg([...recentDays.map(day => day.lowest)]);
			
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

			//calc profitPerItem
			const sellPrice = Math.min(day.highest, ordinaryPrice);
			const sellRevenue = sellPrice * (1 - SELL_TAX);
			const haulCost = HAULING_REWARD_FRACTION * srcBestSellPrice;
			const profitPerItem = sellRevenue - (srcBestSellPrice + haulCost);

			if (profitPerItem > 0) {
				destSellPrices.push(sellPrice);
				totalSellVolume += highVolume;
				activeDays++;
			}
		}

		function calcDestSellersReport() {
			const mostRecentOrder = destSellOrders.reduce((newestOrder, cur) => {
				if (!newestOrder) return cur;
				const curIsNewer = moment(cur.issued).isAfter(moment(newestOrder.issued));
				return curIsNewer ? cur : newestOrder;
			}, null);
			if (mostRecentOrder) {
				const mostRecentOrderIssuedMoment = moment(mostRecentOrder.issued);

				//calc sellerCount
				const destRecentSellOrders = destSellOrders.filter(order => {
					const issued = moment(order.issued);
					const hoursOlderThanMostRecent = mostRecentOrderIssuedMoment.diff(issued, 'hour');
					return hoursOlderThanMostRecent < 24;
				});
				const sellerCount = Math.max(0, destRecentSellOrders.length - (ignoreOneActiveSellerForTypeIds.includes(typeId) ? 1 : 0));

				const daysSinceSellerUpdateExact = nowMoment.diff(mostRecentOrderIssuedMoment, 'hour') / 24;
				const daysSinceSellerUpdate = Math.round(daysSinceSellerUpdateExact * 100) / 100;

				return {
					sellerCount,
					daysSinceSellerUpdate
				}
			} else {
				return {
					sellerCount: null,
					daysSinceSellerUpdate: null
				}
			}
		}
		const destSellersReport = calcDestSellersReport();

		//calc destAvailableDailySellVolumeRaw
		const destDailySellVolumeRaw = totalSellVolume / DAYS_CONSIDERED;
		const destAvailableDailySellVolumeRaw = destDailySellVolumeRaw / (destSellersReport.sellerCount + 1);

		const srcSellOrdersAsc = srcSellOrders.sort((a, b) => {
			return a.price - b.price;
		});

		const destRecentAverageSellPrice = avg(destSellPrices.slice(-1 * DAYS_TO_COMPLETE));
		const dayReports = [];
		for (let d = 1; d <= DAYS_TO_COMPLETE; d++) {
			let volume = 0;
			let cost = 0;
			let revenue = 0;

			const pastDaysVolume = dayReports.reduce((acc, cur) => acc + cur.volume, 0);
			const pastDaysCost = dayReports.reduce((acc, cur) => acc + cur.cost, 0);
			const todayVolumeLimit = Math.floor(destAvailableDailySellVolumeRaw * d - pastDaysVolume);

			let loopLimit = 100;
			while (true) {
				if (loopLimit-- <= 0) throw `loopLimit exhausted (typeId: ${typeId})`;
				if (volume >= todayVolumeLimit) break;
	
				//calc vol
				const costSoFar = cost + pastDaysCost;
				const affordableVol = Math.floor((COST_LIMIT - costSoFar) / srcSellOrdersAsc[0].price);
				const vol = Math.min(
					srcSellOrdersAsc[0].volume_remain,
					todayVolumeLimit - volume,
					affordableVol
				);

				srcSellOrdersAsc[0].volume_remain -= vol;
				const haulCost = srcSellOrdersAsc[0].price * HAULING_REWARD_FRACTION;
				const costPerItem = srcSellOrdersAsc[0].price + haulCost;

				const destSellPrice = destBestSellPrice === null
					? destRecentAverageSellPrice
					: Math.min(destBestSellPrice, destRecentAverageSellPrice);
				const revenuePerItem = destSellPrice * (1 - SELL_TAX);
	
				const profitPerItem = revenuePerItem - costPerItem;
				const profitPerDayEstimate = profitPerItem * destAvailableDailySellVolumeRaw;
				if (profitPerDayEstimate < 2000000) break;

				volume += vol;
				cost += vol * costPerItem;
				revenue += vol * revenuePerItem;

				//remove empty orders from srcSellOrdersAsc
				for (let i = 0; i < srcSellOrdersAsc.length; i++) {
					const srcBestSellOrder = srcSellOrdersAsc[0];
					if (srcBestSellOrder.volume_remain > 0) break;
					else srcSellOrdersAsc.shift(); //remove first
				}

				if (srcSellOrdersAsc.length <= 0) break;
			}

			dayReports.push({
				volume,
				cost,
				revenue
			});
		}

		const report = dayReports.reduce((acc, cur) => {
			acc.volume += cur.volume;
			acc.cost += cur.cost;
			acc.revenue += cur.revenue;
			return acc;
		}, {
			volume: 0,
			cost: 0,
			revenue: 0
		});

		return {
			volume: report.volume,
			costPerItemMil: roundMils(Math.ceil(report.cost / report.volume), 3),
			revenuePerItemMil: roundMils(Math.floor(report.revenue / report.volume), 3),
			activeSellers: destSellersReport.sellerCount,
			daysSinceSellerUpdate: destSellersReport.daysSinceSellerUpdate,
			profitPerItemMil: roundMils((report.revenue - report.cost) / report.volume, 3),
			dailyProfitMil: roundMils((report.revenue - report.cost) / DAYS_TO_COMPLETE),
			activeDaysFraction: roundNonZero(activeDays / DAYS_CONSIDERED)
		};
	} catch (reason) {
		console.warn(reason);
		return null;
	}
};

document.addEventListener('DOMContentLoaded', async () => {
	const outputElem = document.querySelector('#outputDiv');

	outputElem.innerHTML = 'Starting...';



	const typeIds = (await getTypeIds(END_REGION_ID));
	// const typeIds = (await getTypeIds(END_REGION_ID)).slice(0, 1000);
	// const typeIds = [35947, 61207, 90459, 54754, 49099, 34306, 12221, 34290, 4348, 16272];
	// const typeIds = [62630];



	outputElem.innerHTML = `Processing`;

	const itemReportByTypeId = {};
	for (let step = 0; step * STEP_SIZE < typeIds.length; step++) {
		const promises = [];
		const typeIdsSlice = typeIds.slice(step * STEP_SIZE, (step + 1) * STEP_SIZE);
		for (let typeId of typeIdsSlice) {
			const reportPromise = getItemExportReport(START_REGION_ID, START_STATION_ID, END_REGION_ID, END_STATION_ID, typeId);
			reportPromise.then(itemReport => itemReportByTypeId[typeId] = itemReport);
			promises.push(reportPromise);
			promises.push(getTypeM3(typeId)); //preload m3
		}
		await Promise.all(promises);
		outputElem.innerHTML = `Processing ${step * STEP_SIZE} / ${typeIds.length}`;
	}

	outputElem.innerHTML = `Sorting`;

	const typeIdsOrderedByProfitDesc = typeIds.sort((a, b) => {
		const aRep = itemReportByTypeId[a];
		const bRep = itemReportByTypeId[b];
		return (bRep?.dailyProfitMil || 0) - (aRep?.dailyProfitMil || 0);
	});

	outputElem.innerHTML = `Ready`;

	let html = '';
	html += `Start Region: ${START_REGION_ID}<br/>`;
	html += `End Region: ${END_REGION_ID}<br/>`;
	html += '<br/>';
	for (let typeId of typeIdsOrderedByProfitDesc) {
		const itemReport = itemReportByTypeId[typeId];
		if (!itemReport) continue;
		if (itemReport.dailyProfitMil < 1 || itemReport.volume === 0) {
			if (itemReport.dailyProfitMil > 0) {
				console.log(`${typeId} not profitable (dailyProfitMil: ${itemReport.dailyProfitMil})`);
			}
			continue;
		}
		if (itemReport.profitPerFlipNowMil < itemReport.profitPerFlipAvgMil * 0.8) {
			console.log(`${typeId} margin crashed`);
			continue;
		}
		// if (itemReport.volume < 3) {
		// 	console.log(`${typeId} volume too low`);
		// 	continue;
		// }
		if (itemReport.revenuePerItemMil < itemReport.costPerItemMil * 1.5) {
			console.log(`${typeId} margin too slim (${Math.round(100 * itemReport.revenuePerItemMil / itemReport.costPerItemMil) / 100}x`);
			continue;
		}
		if (itemReport.activeDaysFraction < 0.2) {
			console.log(`${typeId} too slow`);
			continue;
		}
		const hem = (min, val, max) => Math.min(Math.max(min, val), max);
		const profitRating = hem(0, itemReport.dailyProfitMil * 0.1, 1);
		const tooRecentThresholdMin = 1 / 24;
		const tooRecentThresholdMax = 30 / 24;
		const tooRecentlyThreshold = Math.floor((tooRecentThresholdMax - (tooRecentThresholdMax - tooRecentThresholdMin) * profitRating) * 100) / 100;
		if (itemReport.daysSinceSellerUpdate !== null && itemReport.daysSinceSellerUpdate < tooRecentlyThreshold) {
			console.log(`${typeId} seller updated too recently (${itemReport.daysSinceSellerUpdate} days ago < ${tooRecentlyThreshold}) vs daily profits (${itemReport.dailyProfitMil})`);
			continue;
		}
		const adjustedActiveSellers = itemReport.activeSellers * (0.1 + Math.pow(0.9, Math.max(1, itemReport.daysSinceSellerUpdate)));
		if (
			adjustedActiveSellers + 1 > itemReport.revenuePerItemMil / itemReport.costPerItemMil //poor percentage profit (relative to competition)
			&& itemReport.dailyProfitMil < adjustedActiveSellers * 3 //poor absolute profit (relative to competition)
		) {
			console.log(`${typeId} too much competition for the return`);
			continue;
		}
		
		const { volume, costPerItemMil, revenuePerItemMil } = itemReport;
		const costMil = roundNonZero(costPerItemMil * volume, 3);
		const revenueMil = roundNonZero(revenuePerItemMil * volume);
		const typeName = await getTypeName(typeId);
		const m3 = await getTypeM3(typeId);

		const itemReportStr = Object.entries(itemReport).map(([key, val]) => key + ': ' + val).join(' &nbsp; ');

		html += '<div class="item">';
		html += 	'<div>';
		html += 		`${typeName} (${typeId}) &nbsp; `;
		html += 		`<span class="dim">`;
		html += 			`${roundNonZero(Math.ceil(volume * m3) / 1000)}km3 (${roundNonZero(m3)}m3 * ${volume})`;
		html += 		`</span>`;
		html += 	'</div>';
		html += 	'<div>';
		html += 		`${itemReport.dailyProfitMil} &nbsp; `;
		html += 		`<span class="dim">`;
		html += 			`(-${costMil} + ${revenueMil}) / ${DAYS_TO_COMPLETE}`;
		html += 		`</span>`;
		html += 	'<div>';	
		html += 	'</div>';
		html += 		itemReportStr;
		html += 	'</div>';	
		html += 	'<div>&nbsp;</div>';
		html += '</div>';	
	}
	outputElem.innerHTML = html;
	updateMarked(); //defined in export.html
});

// Takes days and buckets them into volume weighted price buckets then returns the price from the dominant bucket
function getOrdinaryPrice(days, priceBucketPercent = 0.2 ) {
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
}



//TODO: consider that it may not always take DAYS_TO_COMPLETE to sell hauled volume (could change dailyProfit perhaps)






// const day = {
// 	average:6.74,
// 	date:"2021-01-04",
// 	highest:6.96,
// 	lowest:6.45,
// 	order_count:2177,
// 	volume:4974822193
// };
