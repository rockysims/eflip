const JITA_REGION_ID = 10000002; //The Forge
const AMARR_REGION_ID = 10000043; //Domain
const DODIXIE_REGION_ID = 10000032; //Sinq Laison
const RENS_REGION_ID = 10000030; //Heimatar
// const HEK_REGION_ID = 10000042; //Metropolis
const JITA_STATION_ID = 60003760;
const AMARR_STATION_ID = 60008494;
const DODIXIE_STATION_ID = 60011866;
const RENS_STATION_ID = 60004588;

//*
const START_REGION_ID = JITA_REGION_ID;
const START_STATION_ID = JITA_STATION_ID;
const END_REGION_ID = AMARR_REGION_ID;
const END_STATION_ID = AMARR_STATION_ID;
/*/
const END_REGION_ID = JITA_REGION_ID;
const END_STATION_ID = JITA_STATION_ID;
const START_REGION_ID = AMARR_REGION_ID;
const START_STATION_ID = AMARR_STATION_ID;
//*/

const DAYS_CONSIDERED = 30;
const DAYS_TO_COMPLETE = 5;
const STEP_SIZE = 250;
const SELL_TAX = 0.08 + 0.024;
const BUY_TAX = 0.01;
const HAULING_REWARD_FRACTION = 0.05;
const COST_LIMIT = 1000 * Math.pow(10, 6);

const ignoreOneActiveSellerForTypeIds = [
	//Max
	// 31484, //Small Energy Locus Coordinator II (31484)
	// 56066, //Glorification-5 'Devana' Filament (56066) 
	// 18797, //Coreli A-Type Thermal Coating (18797)
	// 61203, //Common Moon Mining Crystal Type B II (61203)

	//Taymor
	// 49099, //Zero-Point Mass Entangler (49099)
	// 34306, //Large Higgs Anchor I (34306)
	// 12221, //Medium Remote Capacitor Transmitter II (12221)
	// 34290, //Polarized Rocket Launcher (34290)
];

const saveJson = async (path, data) => {
	await fetch(`/file/${path}`, {
		method: 'POST',
		headers: {
		  'Accept': 'application/json',
		  'Content-Type': 'application/json'
		},
		body: JSON.stringify(data)
	});
};

const loadJson = async (path, hoursStaleLimit = -1) => {
	const url = `/file/${path}?hoursStaleLimit=${hoursStaleLimit}`
	return await fetch(url, {
		method: 'GET'
	}).then(
		res => res.json(),
		() => {}
	);
};

const fetchWithRetries = async (url) => {
	for (let retries = 0; retries < 5; retries++) {
		const fetchedData = await fetch(url, {
			method: 'get'
		}).then(res => {
			const data = res.json();
			if (data.error) {
				console.log('GET failed. data.error: ', data.error);
				return null;
			} else {
				return data;
			}
		}, async error => {
			console.log('GET failed. error.response.status: ', error.response.status);
			return null;
		});
		
		if (fetchedData !== null) {
			return fetchedData;
		} else {
			console.log(`retrying ${url}`);
		}
	}

	console.error('fetchWithRetries() exhausted retry limit');
	return null;
};

const getOrFetch = async (url, hoursStaleLimit = -1) => {
	const path = `${url.replace(/[^a-zA-Z0-9]+/g, '')}.json`;
	try {
		const cachedData = await loadJson(path, hoursStaleLimit);
		if (cachedData || cachedData === null) return cachedData;	
	} catch (reason) {
		console.log('getOrFetch caught reason: ', reason)
	}

	return fetchWithRetries(url).then(async data => {
		await saveJson(path, data);
		return data;
	}, async error => {
		console.log('GET failed because: ', error.response.status);
		await saveJson(path, null);
		return null;
	});
};

//---

const getTypeIds = async (regionId) => {
	const promises = [];
	for (let p = 1; p <= 16; p++) {
		const url = `https://esi.evetech.net/latest/markets/${regionId}/types/?datasource=tranquility&page=${p}`;
		promises.push(getOrFetch(url, 8));
	}
	return Promise.all(promises).then(results => {
		return results.flat()//.slice(0, 1000);
	});
};

const loadTypeNameById = async () => {
	const typeData = await fetch('invTypes.json', {
		method: 'get'
	}).then(res => res.json());

	const typeNameById = {};
	for (let typeDatum of typeData) {
		typeNameById[typeDatum.typeID] = typeDatum.typeName;
	}

	return typeNameById;
};

const getDays = async (regionId, typeId) => {
	const url = `https://esi.evetech.net/latest/markets/${regionId}/history/?datasource=tranquility&type_id=${typeId}`;
	const days = await getOrFetch(url, 24);
	return Array.isArray(days)
		? days
		: [];
};

const getOrders = async (regionId, typeId) => {
	const url = `https://esi.evetech.net/latest/markets/${regionId}/orders/?datasource=tranquility&type_id=${typeId}`;
	const orders = await getOrFetch(url, 0.2);
	return Array.isArray(orders)
		? orders
		: [];
};

//---

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

const roundMils = (amount, nonZeroDigits = 2) => {
	return roundNonZero(amount / 1000000, nonZeroDigits);
};

let typeNameById = null;
const getTypeName = async typeId => {
	if (typeNameById === null) {
		typeNameById = await loadTypeNameById(typeId);
	}

	if (!typeNameById[typeId]) {
		const url = `https://esi.evetech.net/latest/universe/types/${typeId}/?datasource=tranquility&language=en`;
		const type = await getOrFetch(url, 24*7);
		typeNameById[typeId] = type.name;
	}

	return typeNameById[typeId];
};

let typeM3ById = {};
const getTypeM3 = async typeId => {
	if (!typeM3ById[typeId]) {
		const url = `https://esi.evetech.net/latest/universe/types/${typeId}/?datasource=tranquility&language=en`;
		const type = await getOrFetch(url, 24*7);
		typeM3ById[typeId] = type.packaged_volume;
	}

	return typeM3ById[typeId];
};

//---

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
		const destBestSellPrice = destBestSellOrder?.price || 0;

		//calc totalSellVolume and activeDays
		let activeDays = 0;
		let totalSellVolume = 0;
		const destAveragePrices = [];
		for (let day of destDays) {
			if (nowMoment.diff(day.date, 'd') > DAYS_CONSIDERED) continue;

			//calc recentAveragePrice (and skip day if crazy over priced)
			const recentAveragePrices = [...destAveragePrices, day.average].slice(-10);
			const recentAveragePrice = recentAveragePrices.reduce((acc, cur) => acc + cur, 0) / recentAveragePrices.length;
			if (day.highest > recentAveragePrice * 10) continue; //crazy over priced so skip day
			destAveragePrices.push(day.average);

			//calc highVolume
			const lowFrac = day.highest === day.lowest
				? (day.highest < recentAveragePrice ? 1 : 0)
				: (day.highest - day.average) / (day.highest - day.lowest);
			const highFrac = 1 - lowFrac;
			const highVolume = highFrac * day.volume;

			//calc profitPerItem
			const sellRevenue = day.highest * (1 - SELL_TAX);
			const haulCost = HAULING_REWARD_FRACTION * srcBestSellPrice;
			const profitPerItem = sellRevenue - (srcBestSellPrice + haulCost);

			if (profitPerItem > 0) {
				totalSellVolume += highVolume;
				activeDays++;
			}
		}

		//calc destActiveSellers
		const daysPerSell = DAYS_CONSIDERED / totalSellVolume;
		const destRecentSellOrders = destSellOrders.filter(order => {
			const issued = moment(order.issued);
			const hoursOld = moment().diff(issued, 'hour');
			return hoursOld < 24 * Math.max(1, daysPerSell);
		});
		const destActiveSellers = Math.max(0, destRecentSellOrders.length - (ignoreOneActiveSellerForTypeIds.includes(typeId) ? 1 : 0));

		//calc destAvailableDailySellVolumeRaw
		const destDailySellVolumeRaw = totalSellVolume / DAYS_CONSIDERED;
		const destAvailableDailySellVolumeRaw = destDailySellVolumeRaw / (destActiveSellers + 1);

		const srcSellOrdersAsc = srcSellOrders.sort((a, b) => {
			return a.price - b.price;
		});

		const destAveragePricesSlice = destAveragePrices.slice(-1 * DAYS_TO_COMPLETE);
		const destRecentAverageSellPrice = destAveragePricesSlice.reduce((acc, cur) => acc + cur, 0) / destAveragePricesSlice.length;
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

				const destSellPrice = Math.min(destBestSellPrice, destRecentAverageSellPrice);
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
			activeSellers: destActiveSellers,
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
	const outputElem = document.querySelector('.outputDiv');

	outputElem.innerHTML = 'Starting...';



	const typeIds = (await getTypeIds(END_REGION_ID));
	// const typeIds = (await getTypeIds(END_REGION_ID)).slice(0, 1000);
	// const typeIds = [54754, 49099, 34306, 12221, 34290];



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
		if (itemReport.volume < 3) {
			console.log(`${typeId} volume too low`);
			continue;
		}
		// if (itemReport.sellRevenueAvgMil < itemReport.buyCostAvgMil * 1.25) {
		// 	console.log('margin too slim');
		// 	continue;
		// }
		if (itemReport.activeDaysFraction < 0.2) {
			console.log('too slow');
			continue;
		}
		// if (itemReport.cost / itemReport.volume > 100) {
		// 	console.log('price too high');
		// 	continue;
		// }
		
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