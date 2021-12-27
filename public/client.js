console.log('start');

const THE_FORGE_REGION_ID = 10000002;
const SELL_TAX = 0.11;
const BUY_TAX = 0.6;

const getTypeIds = async (regionId) => {
	const promises = [];
	for (let p = 1; p <= 16; p++) {
		const url = `https://esi.evetech.net/latest/markets/${regionId}/types/?datasource=tranquility&page=${p}`;
		const promise = fetch(url, {
			method: 'get'
		}).then(res => res.json());
		promises.push(promise);
	}
	return Promise.all(promises).then((results) => {
		return results.flat();
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

const getItemReport = async (regionId, typeId) => {
	try {
		const url = `https://esi.evetech.net/latest/markets/${regionId}/history/?datasource=tranquility&type_id=${typeId}`;
		const days = await fetch(url, {
			method: 'get'
		}).then(res => {
			if (res.ok) {
				return res.json();
			} else {
				throw `Failed to get history for typeId ${typeId}`;
			}
		});

		const overallAverage = days.map(day => day.average).reduce((a, c) => a + c, 0) / days.length;
	
		let totalFlipProfit = 0;
		let totalFlipVolume = 0;
		const profitPerFlipList = [];
		for (let day of days) {
			if (day.highest === day.lowest) continue;
			if (day.highest > overallAverage * 10) continue; //crazy over priced so ignore
			const lowFrac = (day.highest - day.average) / (day.highest - day.lowest);
			const highFrac = 1 - lowFrac;
			const lowVolume = lowFrac * day.volume;
			const highVolume = highFrac * day.volume;
			const flipVolume = Math.min(lowVolume, highVolume);
			const profitPerFlip = (day.highest * (1 - SELL_TAX) - day.lowest * (1 + BUY_TAX));
			if (profitPerFlip > 0) {
				totalFlipProfit += profitPerFlip * flipVolume;
				totalFlipVolume += flipVolume;
				profitPerFlipList.push(profitPerFlip);
			}
		}
	
		return {
			dailyFlipProfitMil: (totalFlipProfit / 1000000) / days.length,
			totalFlipVolume,
			profitPerFlipAvgMil: (profitPerFlipList.reduce((a, c) => a + c, 0) / 1000000) / profitPerFlipList.length
		};
	} catch (reason) {
		console.warn(reason);
		return null;
	}
};

document.addEventListener('DOMContentLoaded', async () => {
	const outputElem = document.querySelector('.outputDiv');

	const regionId = THE_FORGE_REGION_ID;
	const typeIds = await getTypeIds(regionId);
	const typeNameById = await getTypeNameById();

	const itemReportByTypeId = {};
	// const promises = [];
	// for (let typeId of typeIds) {
	// 	const promise = getItemReport(regionId, typeId);
	// 	promise.then(itemReport => {
	// 		if (itemReport) itemReportByTypeId[typeId] = itemReport;
	// 	});
	// 	promises.push(promise);
	// }

	for (let i = 0; i * 1000 < typeIds.length; i++) {
		const promises = [];
		for (let typeId of typeIds.slice(i * 1000, (i + 1) * 1000)) {
			const promise = getItemReport(regionId, typeId);
			promise.then(itemReport => {
				if (itemReport) itemReportByTypeId[typeId] = itemReport;
			});
			promises.push(promise);
		}
		await Promise.all(promises).finally(() => {});

		outputElem.innerHTML = i;
	}

	// await Promise.all(promises).finally(() => {});

	const typeIdsOrderedByProfitDesc = typeIds.sort((a, b) => {
		const aRep = itemReportByTypeId[a];
		const bRep = itemReportByTypeId[b];
		return (bRep?.dailyFlipProfitMil || 0) - (aRep?.dailyFlipProfitMil || 0);
	});

	let html = '';
	for (let typeId of typeIdsOrderedByProfitDesc) {
		const typeName = typeNameById[typeId];
		if (typeName.includes('Men\'s') || typeName.includes('Women\'s') || typeName.includes('SKIN')) continue;

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

console.log('end');
