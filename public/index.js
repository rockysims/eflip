const THE_FORGE_REGION_ID = 10000002;
const DAYS_CONSIDERED = 30;
const STEP_SIZE = 500;
const SELL_TAX = 0.11;
const BUY_TAX = 0.6;

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

const loadJson = async (path) => {
	return await fetch(`/file/${path}`, {
		method: 'GET'
	}).then(
		res => res.json(),
		() => {}
	);
};

const getOrFetch = async url => {
	const path = `${url.replace(/[^a-zA-Z0-9]+/g, '')}.json`;
	try {
		const cachedData = await loadJson(path);
		if (cachedData || cachedData === null) return cachedData;	
	} catch (reason) {
		console.log('getOrFetch caught reason: ', reason)
	}

	return fetch(url, {
		method: 'get'
	}).then(async res => {
		const data = await res.json();
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
		promises.push(getOrFetch(url));
	}
	return Promise.all(promises).then(results => {
		return results.flat()//.slice(0, 1000);
	});
};

const getTypeNameById = async () => {
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
	const days = await getOrFetch(url);
	return Array.isArray(days)
		? days.slice(-1 * DAYS_CONSIDERED)
		: [];
};

const getOrders = async (regionId, typeId) => {
	const url = `https://esi.evetech.net/latest/markets/${regionId}/orders/?datasource=tranquility&type_id=${typeId}`;
	return await getOrFetch(url);
};

const getItemReport = async (regionId, typeId) => {
	try {
		const days = await getDays(regionId, typeId);
		const orders = await getOrders(regionId, typeId);
		
		const recentOrders = orders.filter(order => {
			const issued = moment(order.issued);
			const hoursOld = moment().diff(issued, 'hour');
			return hoursOld < 24;
		});
		const recentSellOrders = recentOrders.filter(order => order.is_buy_order === false);
		const recentBuyOrders = recentOrders.filter(order => order.is_buy_order === true);
		const activeFlippers = Math.max(recentSellOrders.length, recentBuyOrders.length);

		const overallAverage = days.map(day => day.average).reduce((a, c) => a + c, 0) / days.length;
	
		let totalFlipProfit = 0;
		let totalFlipVolume = 0;
		let buyCosts = [];
		let sellRevenues = [];
		const profitPerFlipList = [];
		for (let day of days) {
			if (days.length < DAYS_CONSIDERED) break;
			if (day.highest === day.lowest) continue;
			if (day.highest > overallAverage * 10) continue; //crazy over priced so ignore
			const lowFrac = (day.highest - day.average) / (day.highest - day.lowest);
			const highFrac = 1 - lowFrac;
			const lowVolume = lowFrac * day.volume;
			const highVolume = highFrac * day.volume;
			const flipVolume = Math.floor(Math.min(lowVolume, highVolume) / (activeFlippers + 1));
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

		const buyCostAvg = buyCosts.reduce((a, c) => a + c, 0) / buyCosts.length;
		const sellRevenueAvg = sellRevenues.reduce((a, c) => a + c, 0) / sellRevenues.length;
		const profitPerFlipAvg = profitPerFlipList.reduce((a, c) => a + c, 0) / profitPerFlipList.length;
		const dailyFlipProfit = totalFlipProfit / days.length;
		
		const buyCostAvgMil = Math.round(buyCostAvg / (1000000/100)) / 100;
		const sellRevenueAvgMil = Math.round(sellRevenueAvg / (1000000/100)) / 100;
		return {
			totalFlipVolume: Math.floor(totalFlipVolume),
			buyCostAvgMil,
			sellRevenueAvgMil,
			activeFlippers,
			profitPerFlipAvgMil: Math.round(profitPerFlipAvg / (1000000/100)) / 100,
			dailyFlipProfitMil: Math.round(dailyFlipProfit / (1000000/100)) / 100
		};
	} catch (reason) {
		console.warn(reason);
		return null;
	}
};

document.addEventListener('DOMContentLoaded', async () => {
	const outputElem = document.querySelector('.outputDiv');

	outputElem.innerHTML = 'Starting...';
	const typeIds = await getTypeIds(THE_FORGE_REGION_ID);
	outputElem.innerHTML = 'typeIds.length: ' + typeIds.length;

	const typeNameById = await getTypeNameById();

	outputElem.innerHTML = `Processing`;

	const itemReportByTypeId = {};
	for (let step = 0; step * STEP_SIZE < typeIds.length; step++) {
		const promises = [];
		for (let typeId of typeIds.slice(step * STEP_SIZE, (step + 1) * STEP_SIZE)) {
			const reportPromise = getItemReport(THE_FORGE_REGION_ID, typeId);
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
	for (let typeId of typeIdsOrderedByProfitDesc) {
		// const typeName = typeNameById[typeId];
		// if (typeName.includes('Men\'s') || typeName.includes('Women\'s') || typeName.includes('SKIN')) continue;

		const itemReport = itemReportByTypeId[typeId];
		if (!itemReport) continue;
		if (itemReport.dailyFlipProfitMil < 1 || itemReport.totalFlipVolume === 0) {
			console.log(`${typeId} not profitable`);
			continue;
		}
		if (itemReport.totalFlipVolume < 5) {
			console.log(`${typeId} volume too low`);
			continue;
		}
		if (itemReport.buyCostAvgMil > 100) {
			console.log('price too high');
			continue;
		}
		if (itemReport.sellRevenueAvgMil < itemReport.buyCostAvgMil * 2) {
			console.log('margin too slim');
			continue;
		}
		html += '<div>';
		html += 	`${typeNameById[typeId]} (${typeId})`;
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
