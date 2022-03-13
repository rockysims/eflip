const {
	getTypeIds,
	getDays,
	getOrders,
	roundMils,
	avg,
	getTypeName,

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

const THE_REGION_ID = JITA_REGION_ID;
const DAYS_CONSIDERED = 20//30;
const STEP_SIZE = 500;

const nowMoment = moment();
const getItemReport = async (regionId, typeId) => {
	try {
		const days = await getDays(regionId, typeId);
		const orders = await getOrders(regionId, typeId);
		
		let totalFlipProfit = 0;
		let totalFlipVolume = 0;
		let buyCosts = [];
		let sellRevenues = [];
		const profitPerFlipList = [];
		const pastDays = [];
		for (let day of days) {
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

			//calc flipVolume
			const lowFrac = day.highest === day.lowest
				? (day.highest < recentMiddlePrice ? 1 : 0)
				: (day.highest - day.average) / (day.highest - day.lowest);
			const highFrac = 1 - lowFrac;
			const lowVolume = lowFrac * day.volume;
			const highVolume = highFrac * day.volume;
			const flipVolume = Math.floor(Math.min(lowVolume, highVolume));
			
			const sellRevenue = day.highest * (1 - SELL_TAX);
			const buyCost = day.lowest * (1 + BUY_TAX);
			const profitPerFlip = sellRevenue - buyCost;
			if (profitPerFlip > 0) {
				totalFlipProfit += profitPerFlip * flipVolume;
				totalFlipVolume += flipVolume;
				profitPerFlipList.push(profitPerFlip);
				buyCosts.push(buyCost);
				sellRevenues.push(sellRevenue);
			}
		}

		//calc profitPerFlipNow
		const buyOrders = orders.filter(order => order.is_buy_order === true);
		const bestBuyOrder = buyOrders.reduce((order, bestBuyOrder) => {
			if (order.price > bestBuyOrder.price) bestBuyOrder = order;
			return bestBuyOrder;
		}, buyOrders[0] || null);
		const sellOrders = orders.filter(order => order.is_buy_order === false);
		const bestSellOrder = sellOrders.reduce((order, bestSellOrder) => {
			if (order.price < bestSellOrder.price) bestSellOrder = order;
			return bestSellOrder;
		}, sellOrders[0] || null);
		const buyCostNow = (bestBuyOrder?.price || 0) * (1 + BUY_TAX);
		const sellRevenueNow = (bestSellOrder?.price || 0) * (1 - SELL_TAX);
		const profitPerFlipNow = sellRevenueNow - buyCostNow;

		//calc activeFlippers
		const daysPerFlip = DAYS_CONSIDERED / totalFlipVolume;
		const recentOrders = orders.filter(order => {
			const issued = moment(order.issued);
			const hoursOld = moment().diff(issued, 'hour');
			return hoursOld < 24 * Math.max(1, daysPerFlip);
		});
		const recentSellOrders = recentOrders.filter(order => order.is_buy_order === false);
		const recentBuyOrders = recentOrders.filter(order => order.is_buy_order === true);
		const activeFlippers = Math.max(recentSellOrders.length, recentBuyOrders.length);

		const buyCostAvg = buyCosts.reduce((a, c) => a + c, 0) / buyCosts.length;
		const sellRevenueAvg = sellRevenues.reduce((a, c) => a + c, 0) / sellRevenues.length;
		const profitPerFlipAvg = profitPerFlipList.reduce((a, c) => a + c, 0) / profitPerFlipList.length;
		const totalDailyFlipProfit = totalFlipProfit / DAYS_CONSIDERED;
		const dailyFlipProfit = totalDailyFlipProfit / (activeFlippers + 1);
		
		const buyCostAvgMil = buyCostAvg < 10000 ? buyCostAvg : Math.round(buyCostAvg / (1000000/100)) / 100;
		const sellRevenueAvgMil = sellRevenueAvg < 10000 ? sellRevenueAvg : Math.round(sellRevenueAvg / (1000000/100)) / 100;
		return {
			dailyFlipVolume: totalFlipVolume / DAYS_CONSIDERED,
			// availableFlipVolume: Math.floor(totalFlipVolume / (activeFlippers + 1)),
			buyCostAvgMil,
			sellRevenueAvgMil,
			activeFlippers,
			profitPerFlipNowMil: roundMils(profitPerFlipNow),
			profitPerFlipAvgMil: roundMils(profitPerFlipAvg),
			dailyFlipProfitMil: roundMils(dailyFlipProfit)
		};
	} catch (reason) {
		console.warn(reason);
		return null;
	}
};

document.addEventListener('DOMContentLoaded', async () => {
	const outputElem = document.querySelector('.outputDiv');

	outputElem.innerHTML = 'Starting...';
	
	
	
	const typeIds = (await getTypeIds(THE_REGION_ID)); //TODO: remove the ".slice(0, 1000)" part
	// const typeIds = [61869];



	outputElem.innerHTML = 'typeIds.length: ' + typeIds.length;

	outputElem.innerHTML = `Processing`;

	const itemReportByTypeId = {};
	for (let step = 0; step * STEP_SIZE < typeIds.length; step++) {
		const promises = [];
		for (let typeId of typeIds.slice(step * STEP_SIZE, (step + 1) * STEP_SIZE)) {
			const reportPromise = getItemReport(THE_REGION_ID, typeId);
			reportPromise.then(itemReport => itemReportByTypeId[typeId] = itemReport);
			promises.push(reportPromise);
		}
		await Promise.all(promises);
		outputElem.innerHTML = `Processing ${step * STEP_SIZE} / ${typeIds.length}`;
	}

	outputElem.innerHTML = `Sorting`;

	const typeIdsOrderedByProfitDesc = typeIds.sort((a, b) => {
		const aRep = itemReportByTypeId[a];
		const bRep = itemReportByTypeId[b];
		return (bRep?.dailyFlipProfitMil || 0) - (aRep?.dailyFlipProfitMil || 0);
	});

	outputElem.innerHTML = `Ready`;

	let html = '';
	html += `Region: ${THE_REGION_ID}<br/>`;
	html += '<br/>';
	for (let typeId of typeIdsOrderedByProfitDesc) {
		const itemReport = itemReportByTypeId[typeId];
		if (!itemReport) continue;
		if (itemReport.dailyFlipProfitMil < 1 || itemReport.totalFlipVolume === 0) {
			// console.log(`${typeId} not profitable`);
			continue;
		}
		if (itemReport.profitPerFlipNowMil < itemReport.profitPerFlipAvgMil * 0.8) {
			console.log(`${typeId} margin crashed`);
			continue;
		}
		if (itemReport.totalFlipVolume < 3) {
			console.log(`${typeId} volume too low`);
			continue;
		}
		if (itemReport.sellRevenueAvgMil < itemReport.buyCostAvgMil * 1.25) {
			console.log(`${typeId} margin too slim`);
			continue;
		}
		if (itemReport.buyCostAvgMil > 100) {
			console.log(`${typeId} price too high`);
			continue;
		}
		html += '<div>';
		html += 	`${await getTypeName(typeId)} (${typeId})`;
		html += '</div>';
		html += '<div>';
		html += 	`${itemReport.dailyFlipProfitMil}`;
		html += '<div>';	
		html += '</div>';	
		html += 	`${JSON.stringify(itemReport)}`;
		html += '</div>';	
		html += '<div>&nbsp;</div>';
	}
	outputElem.innerHTML = html;
});
