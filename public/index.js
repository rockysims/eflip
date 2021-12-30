const THE_FORGE_REGION_ID = 10000002;
const STEP_SIZE = 100;
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
	return ((await getOrFetch(url)) || []).slice(-90);
};

const centerAverage = values => {
	if (values.length === 0) throw new Error("No inputs");

	values.sort((a, b) => {
		return a - b;
	});

	const start = Math.floor(0.25 * values.length);
	const end = Math.floor(0.75 * values.length);
	const centerValues = values.slice(start, end + 1);
	
	return centerValues.reduce((a, c) => a + c, 0) / centerValues.length;
}

const getItemReport = async (regionId, typeId) => {
	try {
		const days = await getDays(regionId, typeId);

		const overallAverage = days.map(day => day.average).reduce((a, c) => a + c, 0) / days.length;
	
		let totalFlipProfit = 0;
		let totalFlipVolume = 0;
		let buyCosts = [];
		let sellProfits = [];
		const profitPerFlipList = [];
		for (let day of days) {
			if (days.length < 30) break;
			if (day.highest === day.lowest) continue;
			if (day.highest > overallAverage * 3) continue; //crazy over priced so ignore
			const lowFrac = (day.highest - day.average) / (day.highest - day.lowest);
			const highFrac = 1 - lowFrac;
			const lowVolume = lowFrac * day.volume;
			const highVolume = highFrac * day.volume;
			const flipVolume = Math.min(lowVolume, highVolume);
			const sellProfit = day.highest * (1 - SELL_TAX);
			const buyCost = day.lowest * (1 + BUY_TAX);
			const profitPerFlip = sellProfit - buyCost;
			if (profitPerFlip > 0) {
				totalFlipProfit += profitPerFlip * flipVolume;
				totalFlipVolume += flipVolume;
				profitPerFlipList.push(profitPerFlip);
				buyCosts.push(buyCost);
				sellProfits.push(sellProfit);
			}
		}

		const buyCostAvgMil = (buyCosts.reduce((a, c) => a + c, 0) / 1000000) / buyCosts.length;
		const sellProfitAvgMil = (sellProfits.reduce((a, c) => a + c, 0) / 1000000) / sellProfits.length;

		if (buyCostAvgMil > 100) throw 'too high a price';
	
		return {
			totalFlipVolume: Math.floor(totalFlipVolume),
			buyCostAvgMil,
			sellProfitAvgMil,
			profitPerFlipAvgMil: (profitPerFlipList.reduce((a, c) => a + c, 0) / 1000000) / profitPerFlipList.length,
			dailyFlipProfitMil: (totalFlipProfit / 1000000) / days.length
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

	// const daysByTypeId = {};
	// for (let i = 0; i * STEP_SIZE < typeIds.length; i++) {
	// 	const promises = [];
	// 	for (let typeId of typeIds.slice(i * STEP_SIZE, (i + 1) * STEP_SIZE)) {
	// 		const promise = getDays(THE_FORGE_REGION_ID, typeId);
	// 		promise.then(days => {
	// 			daysByTypeId[typeId] = days;
	// 		});
	// 		promises.push(promise);
	// 	}
	// 	await Promise.all(promises);

	// 	outputElem.innerHTML = `${i * STEP_SIZE} / ${typeIds.length}`;
	// }

	const typeNameById = await getTypeNameById();

	outputElem.innerHTML = `Processing`;

	let i = 0;
	const itemReportByTypeId = {};
	for (let typeId of typeIds) {
		itemReportByTypeId[typeId] = await getItemReport(THE_FORGE_REGION_ID, typeId);
		if (++i % 100 === 0) outputElem.innerHTML = `Processing ${i} / ${typeIds.length}`;
	}

	const typeIdsOrderedByProfitDesc = typeIds.sort((a, b) => {
		const aRep = itemReportByTypeId[a];
		const bRep = itemReportByTypeId[b];
		return (bRep?.dailyFlipProfitMil || 0) - (aRep?.dailyFlipProfitMil || 0);
	});

	outputElem.innerHTML = `Ready`;

	let html = '';
	for (let typeId of typeIdsOrderedByProfitDesc) {
		const typeName = typeNameById[typeId];
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
