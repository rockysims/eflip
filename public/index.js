const JITA_REGION_ID = 10000002; //The Forge
const AMARR_REGION_ID = 10000043; //Domain
const DODIXIE_REGION_ID = 10000032; //Sinq Laison
const RENS_REGION_ID = 10000030; //Heimatar
// const HEK_REGION_ID = 10000042; //Metropolis
const THE_REGION_ID = JITA_REGION_ID;
const DAYS_CONSIDERED = 20//30;
const STEP_SIZE = 500;
const SELL_TAX = 0.08 + 0.0233;
const BUY_TAX = 0.01;

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

const roundMils = (amount) => {
	return Math.round(amount / (1000000/100)) / 100;
};

const nowMoment = moment();
const getItemReport = async (regionId, typeId) => {
	try {
		const days = await getDays(regionId, typeId);
		const orders = await getOrders(regionId, typeId);
		
		const overallAverage = days.map(day => day.average).reduce((a, c) => a + c, 0) / DAYS_CONSIDERED;
	
		let totalFlipProfit = 0;
		let totalFlipVolume = 0;
		let buyCosts = [];
		let sellRevenues = [];
		const profitPerFlipList = [];
		for (let day of days) {
			if (nowMoment.diff(day.date, 'd') > DAYS_CONSIDERED) continue;
			if (day.highest === day.lowest) continue;
			if (day.highest > overallAverage * 10) continue; //crazy over priced so ignore
			const lowFrac = (day.highest - day.average) / (day.highest - day.lowest);
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

let typeNameById = {};
const getTypeName = async typeId => {
	if (!typeNameById[typeId]) {
		const url = `https://esi.evetech.net/latest/universe/types/${typeId}/?datasource=tranquility&language=en`;
		const type = await getOrFetch(url, 24*7);
		typeNameById[typeId] = type.name;
	}

	return typeNameById[typeId];
};

document.addEventListener('DOMContentLoaded', async () => {
	const outputElem = document.querySelector('.outputDiv');

	outputElem.innerHTML = 'Starting...';
	
	
	
	const typeIds = (await getTypeIds(THE_REGION_ID)); //TODO: remove the ".slice(0, 1000)" part
	// const typeIds = [61869];



	outputElem.innerHTML = 'typeIds.length: ' + typeIds.length;

	// const typeNameById = await getTypeNameById();

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
		// const typeName = typeNameById[typeId];
		// if (typeName.includes('Men\'s') || typeName.includes('Women\'s') || typeName.includes('SKIN')) continue;

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
