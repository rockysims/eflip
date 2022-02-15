//Note: This is a work in progress (and should not be expected to function)

const JITA_REGION_ID = 10000002; //The Forge
const AMARR_REGION_ID = 10000043; //Domain
const DODIXIE_REGION_ID = 10000032; //Sinq Laison;
const THE_REGION_ID = JITA_REGION_ID;
const DAYS_CONSIDERED = 30;
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
		if (cachedData || cachedData === null) {
			return cachedData;
		}
	} catch (reason) {
		console.log('getOrFetch caught reason: ', reason);
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

// const getDays = async (regionId, typeId) => {
// 	const url = `https://esi.evetech.net/latest/markets/${regionId}/history/?datasource=tranquility&type_id=${typeId}`;
// 	const days = await getOrFetch(url);
// 	return Array.isArray(days)
// 		? days
// 		: [];
// };

const getOrders = async (regionId, typeId) => {
	const url = `https://esi.evetech.net/latest/markets/${regionId}/orders/?datasource=tranquility&type_id=${typeId}`;
	const orders = await getOrFetch(url);
	return Array.isArray(orders)
		? orders
		: [];
};

const roundMils = (amount) => {
	return Math.round(amount / (1000000/100)) / 100;
};








//write code to look for items where a set of purchases would raise the price enough to make a profit selling at that new price (and calc how long it would take to sell all the bought stock)
const getJackReport = (orders) => {
	const sellOrders = orders
		.filter(order => order.is_buy_order === false)
		.sort((a, b) => a.price - b.price); //ASC

	let bestCost = 0;
	let bestStock = 0;
	let bestProfit = 0;
	let bestJackedPrice = 0;
	let cost = 0;
	let stock = 0;
	for (let i = 0; i < sellOrders.length; i++) {
		const sellOrder = sellOrders[i];
		if (sellOrder.duration > 90) break; //respawning NPC order

		const volume = sellOrder.volume_remain;
		cost += volume * sellOrder.price;
		stock += volume;

		const jackedPrice = sellOrders[i + 1]?.price || sellOrder.price * 1.1;
		const revenue = jackedPrice * stock * (1 - SELL_TAX);



		// const dailyVolume; //half the average daily volume
		// const normalPrice; //historical average
		// const dailyProfit = dailyVolume * (normalPrice + 0.5 * (jackedPrice - normalPrice));




		const profit = revenue - cost;
		if (profit > bestProfit) {
			bestCost = cost;
			bestStock = stock;
			bestProfit = profit;
			bestJackedPrice = jackedPrice;
		}
	}

	const jackedPrice = Math.round(bestJackedPrice);
	const avgPrice = Math.round(bestCost / bestStock);
	return {
		profitMil: roundMils(bestProfit),
		costMil: roundMils(bestCost),
		stock: bestStock,
		jackedPrice,
		avgPrice,
		jackFactor: jackedPrice / avgPrice
		// dailyProfitMil, //TODO: calc this
		// duration, //TODO: calc this
		// activeTraders //TODO: calc this
	};
};







document.addEventListener('DOMContentLoaded', async () => {
	const outputElem = document.querySelector('.outputDiv');

	outputElem.innerHTML = 'Starting...';
	const typeIds = (await getTypeIds(THE_REGION_ID)); //TODO: remove the ".slice(0, 100)" part
	outputElem.innerHTML = 'typeIds.length: ' + typeIds.length;

	const typeNameById = await getTypeNameById();

	outputElem.innerHTML = `Processing`;

	const jackReportByTypeId = {};
	for (let typeId of typeIds) {
		const jackReport = await getJackReport(await getOrders(THE_REGION_ID, typeId));
		jackReportByTypeId[typeId] = jackReport;
	}

	outputElem.innerHTML = `Sorting`;

	const typeIdsOrderedByProfitDesc = typeIds.sort((a, b) => {
		const aRep = jackReportByTypeId[a];
		const bRep = jackReportByTypeId[b];
		return (bRep?.profitMil || 0) - (aRep?.profitMil || 0);
	});

	outputElem.innerHTML = `Ready`;

	let html = '';
	for (let typeId of typeIdsOrderedByProfitDesc) {
		// const typeName = typeNameById[typeId];
		// if (typeName.includes('Men\'s') || typeName.includes('Women\'s') || typeName.includes('SKIN')) continue;

		const jackReport = jackReportByTypeId[typeId];
		if (!jackReport) continue;
		if (jackReport.profitMil < 1) {
			console.log(`${typeId} not profitable`);
			continue;
		}
		if (jackReport.costMil > 100) {
			console.log('cost too high');
			continue;
		}
		html += '<div>';
		html += 	`${typeNameById[typeId]} (${typeId})`;
		html += '</div>';
		html += '<div>';
		html += 	`${jackReport.profitMil}`;
		html += '<div>';	
		html += '</div>';	
		html += 	`${JSON.stringify(jackReport)}`;
		html += '</div>';	
		html += '<div>&nbsp;</div>';
	}
	outputElem.innerHTML = html;
});
