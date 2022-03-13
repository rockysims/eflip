const {
	getTypeIds,
	getDays,
	getOrders,
	roundNonZero,
	roundMils,
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
const THE_STATION_ID = JITA_STATION_ID;

const DAYS_CONSIDERED = 30;
const DAYS_TO_COMPLETE = 5;
const STEP_SIZE = 500;

const nowMoment = moment();
const getItemResellReport = async (regionId, locationId, typeId) => {
	try {
		const regionSellOrders = (await getOrders(regionId, typeId, 0.2))
			.filter(order => order.is_buy_order === false)
			.sort((a, b) => a.price - b.price);
		const localSellOrders = regionSellOrders
			.filter(order => order.location_id === locationId);
		const days = (await getDays(regionId, typeId))
			.filter(day => nowMoment.diff(day.date, 'd') <= DAYS_CONSIDERED);

		//calc avgPriceWithoutOutliers
		const trimCount = Math.floor(days.length * 0.05);
		const avgPriceWithoutOutliers = days
			.map(d => d.average)
			.sort((a, b) => a - b)
			.slice(trimCount, -1 * trimCount)
			.reduce((acc, cur) => acc + cur, 0)
			/ days.length;

		const bestLocalSellOrder = localSellOrders[0];
		const bestLocalSellPrice = localSellOrders[0]?.price || 0;
		const secondBestLocalSellPrice = localSellOrders[1]?.price || 0;

		//calc bestRegionSellPrice
		const bestRegionSellOrder = regionSellOrders.reduce((order, bestRegionSellOrder) => {
			if (order.price < bestRegionSellOrder.price) bestRegionSellOrder = order;
			return bestRegionSellOrder;
		}, regionSellOrders[0] || null);
		const bestRegionSellPrice = bestRegionSellOrder?.price || 0;

		//calc localActiveSellers
		const recentLocalSellOrders = localSellOrders.filter(order => {
			const issued = moment(order.issued);
			const hoursOld = moment().diff(issued, 'hour');
			return hoursOld < 24;
		});
		const localActiveSellers = recentLocalSellOrders.length;

		const timesRegionSellPrice = bestLocalSellPrice / bestRegionSellPrice;

		const dailyVolume = days
			.map(d => d.volume)
			.reduce((acc, cur) => acc + cur, 0)
			/ DAYS_CONSIDERED;

		const volume = Math.floor(Math.min(bestLocalSellOrder?.volume_remain || 0, dailyVolume * DAYS_TO_COMPLETE));
		const cost = bestLocalSellPrice * volume;


		const sellPrice = Math.min(avgPriceWithoutOutliers, secondBestLocalSellPrice);
		const revenue = (sellPrice * volume) * (1 - SELL_TAX);
		const profit = revenue - cost;

		return {
			quantity: volume,
			dailyVolume: roundNonZero(dailyVolume),
			costPerItemMil: roundMils(cost / volume),
			revenuePerItemMil: roundMils(revenue / volume),
			profitMil: roundMils(profit),
			activeSellers: localActiveSellers,
			roi: roundNonZero(revenue / cost),
			timesRegionSellPrice: roundNonZero(timesRegionSellPrice)
		};
	} catch (reason) {
		console.warn(reason);
		return null;
	}
};

document.addEventListener('DOMContentLoaded', async () => {
	const outputElem = document.querySelector('.outputDiv');

	outputElem.innerHTML = 'Starting...';
	
	const typeIds = (await getTypeIds(THE_REGION_ID));
	// const typeIds = (await getTypeIds(THE_REGION_ID)).slice(0, 1000);
	// const typeIds = [46234];
	
	outputElem.innerHTML = 'typeIds.length: ' + typeIds.length;
	outputElem.innerHTML = `Processing`;

	const itemReportByTypeId = {};
	for (let step = 0; step * STEP_SIZE < typeIds.length; step++) {
		const promises = [];
		for (let typeId of typeIds.slice(step * STEP_SIZE, (step + 1) * STEP_SIZE)) {
			const reportPromise = getItemResellReport(THE_REGION_ID, THE_STATION_ID, typeId);
			reportPromise.then(itemReport => itemReportByTypeId[typeId] = itemReport);
			promises.push(reportPromise);
			promises.push(getTypeName(typeId)); //preload typeName
		}
		await Promise.all(promises);
		outputElem.innerHTML = `Processing ${step * STEP_SIZE} / ${typeIds.length}`;
	}

	outputElem.innerHTML = `Sorting`;

	const typeIdsOrderedByProfitDesc = typeIds.sort((a, b) => {
		const aRep = itemReportByTypeId[a];
		const bRep = itemReportByTypeId[b];
		return (bRep?.profitMil || 0) - (aRep?.profitMil || 0);
	});

	outputElem.innerHTML = `Ready`;

	let html = '';
	html += `Region: ${THE_REGION_ID}<br/>`;
	html += `Station: ${THE_STATION_ID}<br/>`;
	html += '<br/>';
	for (let typeId of typeIdsOrderedByProfitDesc) {
		const typeName = await getTypeName(typeId);
		if (typeName.includes('Expired')) continue;

		const itemReport = itemReportByTypeId[typeId];
		if (!itemReport) continue;
		if (itemReport.profitMil < 1 || itemReport.volume === 0) {
			if (itemReport.profitMil > 0) {
				console.log(`${typeId} not profitable (profitMil: ${itemReport.profitMil})`);
			}
			continue;
		}
		if (itemReport.dailyVolume < 0.2) {
			console.log('too slow');
			continue;
		}
		if (itemReport.timesRegionSellPrice > 2) {
			console.log('excessive markup');
			continue;
		}
		if (itemReport.roi < 1.5) {
			console.log('low roi');
			continue;
		}
		html += '<div>';
		html += 	`${await getTypeName(typeId)} (${typeId})`;
		html += '</div>';
		html += '<div>';
		html += 	`${itemReport.profitMil}`;
		html += '<div>';	
		html += '</div>';
		html += 	`${JSON.stringify(itemReport)}`;
		html += '</div>';	
		html += '<div>&nbsp;</div>';
	}
	outputElem.innerHTML = html;
});
