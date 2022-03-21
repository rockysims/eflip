//NOTE: this is unfinished code



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
		
		JITA_STATION_ID,
		AMARR_STATION_ID,
		DODIXIE_STATION_ID,
		RENS_STATION_ID,

		SELL_TAX,
		BUY_TAX
	}
} = util;

//*
const START_REGION_ID = JITA_REGION_ID;
const START_STATION_ID = JITA_STATION_ID;
const END_REGION_ID = AMARR_REGION_ID;
const END_STATION_ID = AMARR_STATION_ID;
// const END_REGION_ID = DODIXIE_REGION_ID;
// const END_STATION_ID = DODIXIE_STATION_ID;
/*/
// const START_REGION_ID = DODIXIE_REGION_ID;
// const START_STATION_ID = DODIXIE_STATION_ID;
const START_REGION_ID = AMARR_REGION_ID;
const START_STATION_ID = AMARR_STATION_ID;
const END_REGION_ID = JITA_REGION_ID;
const END_STATION_ID = JITA_STATION_ID;
//*/

const DAYS_CONSIDERED = 30;
const DAYS_TO_COMPLETE = 5;
const STEP_SIZE = 250;
const HAULING_REWARD_FRACTION = 0.05;
const COST_LIMIT = 1000 * Math.pow(10, 6);

const nowMoment = moment();
const getItemExportReport = async (srcRegionId, srcLocationId, destRegionId, destLocationId, typeId) => {
	try {
		const srcOrders = (await getOrders(srcRegionId, typeId)).filter(order => order.location_id === srcLocationId);
		const destDays = await getDays(destRegionId, typeId);
		const srcDays = await getDays(srcRegionId, typeId);

		//calc srcBestSellPrice
		const srcSellOrders = srcOrders.filter(order => order.is_buy_order === false);
		const srcBestSellOrder = srcSellOrders.reduce((order, bestSellOrder) => {
			if (order.price < bestSellOrder.price) bestSellOrder = order;
			return bestSellOrder;
		}, srcSellOrders[0] || null);
		const srcBestSellPrice = srcBestSellOrder?.price || Number.POSITIVE_INFINITY;







		//calc destTotalSellVolume and destActiveDays
		let destActiveDays = 0;
		let destTotalSellVolume = 0;
		const destSellPrices = [];
		const destPastDays = [];
		for (let day of destDays) {
			const age = nowMoment.diff(day.date, 'd');
			if (age > DAYS_CONSIDERED + 5) continue;
			destPastDays.push(day);
			if (age > DAYS_CONSIDERED) continue;

			//calc recentMiddlePrice (and skip day if crazy over priced || recent high/low prices are the same)
			const recentDays = destPastDays.slice(-5);
			const recentHighPrice = avg([...recentDays.map(day => day.highest)]);
			const recentLowPrice = avg([...recentDays.map(day => day.lowest)]);
			const recentMiddlePrice = recentLowPrice + (recentHighPrice - recentLowPrice) * 0.5;
			if (day.highest > recentMiddlePrice * 10) continue; //crazy over priced so skip day
			if (recentHighPrice === recentLowPrice) continue; //can't tell if buy or sell so skip day

			//calc highVolume
			const lowFrac = day.highest === day.lowest
				? (day.highest < recentMiddlePrice ? 1 : 0)
				: (day.highest - day.average) / (day.highest - day.lowest);
			const highFrac = 1 - lowFrac;
			const highVolume = highFrac * day.volume;

			//calc profitPerItem
			const sellRevenue = day.highest * (1 - SELL_TAX);
			const haulCost = HAULING_REWARD_FRACTION * srcBestSellPrice;
			const profitPerItem = sellRevenue - (srcBestSellPrice + haulCost);

			if (profitPerItem > 0) {
				destSellPrices.push(day.highest);
				destTotalSellVolume += highVolume;
				destActiveDays++;
			}
		}





		//calc srcTotalSellVolume
		let srcTotalSellVolume = 0;
		const pastDays = [];
		for (let day of srcDays) {
			const age = nowMoment.diff(day.date, 'd');
			if (age > DAYS_CONSIDERED + 5) continue;
			pastDays.push(day);
			if (age > DAYS_CONSIDERED) continue;

			//calc recentMiddlePrice (and skip day if crazy over priced || recent high/low prices are the same)
			const recentDays = pastDays.slice(-5);
			const recentHighPrice = avg([...recentDays.map(day => day.highest)]);
			const recentLowPrice = avg([...recentDays.map(day => day.lowest)]);
			const recentMiddlePrice = recentLowPrice + (recentHighPrice - recentLowPrice) * 0.5;
			if (day.highest > recentMiddlePrice * 10) continue; //crazy over priced so skip day
			if (recentHighPrice === recentLowPrice) continue; //can't tell if buy or sell so skip day

			//calc highVolume
			const lowFrac = day.highest === day.lowest
				? (day.highest < recentMiddlePrice ? 1 : 0)
				: (day.highest - day.average) / (day.highest - day.lowest);
			const highFrac = 1 - lowFrac;
			const highVolume = highFrac * day.volume;

			srcTotalSellVolume += highVolume;
		}

		//calc destActiveSellers
		const destActiveSellers = 0;

		//calc destDailySellVolume
		const destDailySellVolume = (srcTotalSellVolume * 0.3) / DAYS_CONSIDERED;

		const srcSellOrdersAsc = srcSellOrders.sort((a, b) => {
			return a.price - b.price;
		});

		const destRecentAverageSellPrice = avg(destSellPrices.slice(-1 * DAYS_TO_COMPLETE)) || null;
		const dayReports = [];
		for (let d = 1; d <= DAYS_TO_COMPLETE; d++) {
			let volume = 0;
			let cost = 0;
			let revenue = 0;

			const pastDaysVolume = dayReports.reduce((acc, cur) => acc + cur.volume, 0);
			const pastDaysCost = dayReports.reduce((acc, cur) => acc + cur.cost, 0);
			const todayVolumeLimit = Math.floor(destDailySellVolume * d - pastDaysVolume);

			let loopLimit = 100;
			while (true) {
				if (loopLimit-- <= 0) throw 'loopLimit exhausted';
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

				const sellPrice = destRecentAverageSellPrice > 0
					? destRecentAverageSellPrice
					: srcBestSellPrice * 2;
				const revenuePerItem = sellPrice * (1 - SELL_TAX);
	
				const profitPerItem = revenuePerItem - costPerItem;
				const profitPerDayEstimate = profitPerItem * destDailySellVolume;
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
			activeSellers: destActiveSellers,
			profitPerItemMil: roundMils((report.revenue - report.cost) / report.volume, 3),
			dailyProfitMil: roundMils((report.revenue - report.cost) / DAYS_TO_COMPLETE)
		};
	} catch (reason) {
		console.warn(reason);
		return null;
	}
};

document.addEventListener('DOMContentLoaded', async () => {
	const outputElem = document.querySelector('.outputDiv');

	outputElem.innerHTML = 'Starting...';



	const startTypeIds = (await getTypeIds(START_REGION_ID));
	const endTypeIds = (await getTypeIds(END_REGION_ID));
	const typeIds = startTypeIds.filter(typeId => !endTypeIds.includes(typeId));










	outputElem.innerHTML = `Processing`;

	const itemReportByTypeId = {};
	for (let step = 0; step * STEP_SIZE < typeIds.length; step++) {
		const promises = [];
		for (let typeId of typeIds.slice(step * STEP_SIZE, (step + 1) * STEP_SIZE)) {
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
		// if (itemReport.profitPerFlipNowMil < itemReport.profitPerFlipAvgMil * 0.8) {
		// 	console.log(`${typeId} margin crashed`);
		// 	continue;
		// }
		// if (itemReport.volume < 3) {
		// 	console.log(`${typeId} volume too low`);
		// 	continue;
		// }
		if (itemReport.revenuePerItemMil < itemReport.costPerItemMil * 1.5) {
			console.log('margin too slim');
			continue;
		}
		if (itemReport.activeSellers + 1 > itemReport.revenuePerItemMil / itemReport.costPerItemMil) {
			console.log('too much competition for the roi');
			continue;
		}
		
		const { volume, costPerItemMil, revenuePerItemMil } = itemReport;
		const costMil = roundNonZero(costPerItemMil * volume, 3);
		const revenueMil = roundNonZero(revenuePerItemMil * volume);
		const typeName = await getTypeName(typeId);
		const m3 = await getTypeM3(typeId);

		html += '<div>';
		html += 	`${typeName} (${typeId}) &nbsp; `;
		html += 	`<span class="dim">`;
		html += 		`${roundNonZero(Math.ceil(volume * m3) / 1000)}km3 (${roundNonZero(m3)}m3 * ${volume})`;
		html += 	`</span>`;
		html += '</div>';
		html += '<div>';
		html += 	`${itemReport.dailyProfitMil} &nbsp; `;
		html += 	`<span class="dim">`;
		html += 		`(-${costMil} + ${revenueMil}) / ${DAYS_TO_COMPLETE}`;
		html += 	`</span>`;
		html += '<div>';	
		html += '</div>';	
		html += 	`${JSON.stringify(itemReport)}`;
		html += '</div>';	
		html += '<div>&nbsp;</div>';
	}
	outputElem.innerHTML = html;
});

//TODO: consider that it may not always take DAYS_TO_COMPLETE to sell hauled volume (could change dailyProfit perhaps)






// const day = {
// 	average:6.74,
// 	date:"2021-01-04",
// 	highest:6.96,
// 	lowest:6.45,
// 	order_count:2177,
// 	volume:4974822193
// };
