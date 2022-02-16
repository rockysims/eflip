const JITA_REGION_ID = 10000002; //The Forge
const AMARR_REGION_ID = 10000043; //Domain
const DODIXIE_REGION_ID = 10000032; //Sinq Laison
const RENS_REGION_ID = 10000030; //Heimatar
// const HEK_REGION_ID = 10000042; //Metropolis
const JITA_STATION_ID = 60003760;
const AMARR_STATION_ID = 60008494;
const DODIXIE_STATION_ID = 60011866;
const RENS_STATION_ID = 60004588;

const THE_REGION_ID = JITA_REGION_ID;
const THE_STATION_ID = JITA_STATION_ID;

const DAYS_CONSIDERED = 30;
const DAYS_TO_COMPLETE = 5;
const STEP_SIZE = 500;
const SELL_TAX = 0.08 + 0.024;

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

const getOrFetch = async url => {
	const path = `${url.replace(/[^a-zA-Z0-9]+/g, '')}.json`;
	try {
		const cachedData = await loadJson(path);
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
		promises.push(getOrFetch(url));
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

const getOrders = async (regionId, typeId) => {
	const url = `https://esi.evetech.net/latest/markets/${regionId}/orders/?datasource=tranquility&type_id=${typeId}`;
	const orders = await getOrFetch(url);
	return Array.isArray(orders)
		? orders
		: [];
};

const getDays = async (regionId, typeId) => {
	const url = `https://esi.evetech.net/latest/markets/${regionId}/history/?datasource=tranquility&type_id=${typeId}`;
	const days = await getOrFetch(url);
	return Array.isArray(days)
		? days
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
		: dotIndex + (num < 10 ? 2 : 0)
	);
	return +numStr.substring(0, end);
};

const roundMils = amount => {
	return roundNonZero(amount / 1000000, 4);
};

let typeNameById = null;
const getTypeName = async typeId => {
	if (typeNameById === null) {
		typeNameById = await loadTypeNameById(typeId);
	}

	if (!typeNameById[typeId]) {
		const url = `https://esi.evetech.net/latest/universe/types/${typeId}/?datasource=tranquility&language=en`;
		const type = await getOrFetch(url);
		typeNameById[typeId] = type.name;
	}

	return typeNameById[typeId];
};

//---

const nowMoment = moment();
const getItemResellReport = async (regionId, locationId, typeId) => {
	try {
		const regionSellOrders = (await getOrders(regionId, typeId))
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
