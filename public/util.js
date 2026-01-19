const util = (() => {
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
	
	const fetchWithRetries = async (url, accessToken = null) => {
		for (let retries = 0; retries < 5; retries++) {
			const headers = {};
			if (accessToken) {
				headers['Authorization'] = `Bearer ${accessToken}`;
			}
			const fetchedData = await fetch(url, {
				method: 'get',
				headers
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
	
	const getOrFetch = async (url, hoursStaleLimit = -1, accessToken = null) => {
		const path = `${url.replace(/[^a-zA-Z0-9]+/g, '')}.json`;
		try {
			const cachedData = await loadJson(path, hoursStaleLimit);
			if (cachedData && cachedData.error) throw "cached data had error";
			if (cachedData || cachedData === null) return cachedData;	
		} catch (reason) {
			console.log('getOrFetch caught reason: ', reason)
		}
	
		return fetchWithRetries(url, accessToken).then(async data => {
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
			return results
				.filter(result => !result.error)
				.flat()//.slice(0, 1000);
		});
	};
	
	const getDays = async (regionId, typeId) => {
		// const url = `https://esi.evetech.net/latest/markets/${regionId}/history/?datasource=tranquility&type_id=${typeId}`;
		const url = `https://esi.evetech.net/markets/${regionId}/history?type_id=${typeId}`;
		const days = await getOrFetch(url, 24);
		return Array.isArray(days)
			? days
			: [];
	};
	
	const getOrders = async (regionId, typeId, hoursStaleLimit = 1) => {
		const url = `https://esi.evetech.net/latest/markets/${regionId}/orders/?datasource=tranquility&type_id=${typeId}`;
		const orders = await getOrFetch(url, hoursStaleLimit);
		return Array.isArray(orders)
			? orders
			: [];
	};
	
	const getCharacterWalletTransactions = async (characterId, accessToken, hoursStaleLimit = 0.05) => {
		const url = `https://esi.evetech.net/latest/characters/${characterId}/wallet/transactions/?datasource=tranquility`;
		const transactions = await getOrFetch(url, hoursStaleLimit, accessToken);
		return Array.isArray(transactions)
			? transactions
			: [];
	};
	
	const getCharacterWalletJournals = async (characterId, accessToken, hoursStaleLimit = 0.05) => {
		const url = `https://esi.evetech.net/latest/characters/${characterId}/wallet/journal/?datasource=tranquility`;
		const journals = await getOrFetch(url, hoursStaleLimit, accessToken);
		return Array.isArray(journals)
			? journals
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
	
	const avg = (list) => {
		return list.reduce((acc, cur) => acc + cur, 0) / list.length;
	};
	
	const typeNameById = {};
	const getTypeName = async typeId => {
		if (!typeNameById[typeId]) {
			const url = `https://esi.evetech.net/latest/universe/types/${typeId}/?datasource=tranquility&language=en`;
			const type = await getOrFetch(url, 24*7);
			typeNameById[typeId] = type.name;
		}
	
		return typeNameById[typeId];
	};
	
	const typeM3ById = {};
	const getTypeM3 = async typeId => {
		if (!typeM3ById[typeId]) {
			const url = `https://esi.evetech.net/latest/universe/types/${typeId}/?datasource=tranquility&language=en`;
			const type = await getOrFetch(url, 24*7);
			typeM3ById[typeId] = type.packaged_volume;
		}
	
		return typeM3ById[typeId];
	};
	
	return {
		getTypeIds,
		getDays,
		getOrders,
		getCharacterWalletTransactions,
		getCharacterWalletJournals,
		roundNonZero,
		roundMils,
		avg,
		getTypeName,
		getTypeM3,

		constants: {
			JITA_REGION_ID: 10000002, //The Forge
			AMARR_REGION_ID: 10000043, //Domain
			DODIXIE_REGION_ID: 10000032, //Sinq Laison
			RENS_REGION_ID: 10000030, //Heimatar
			STACMON_REGION_ID: 10000057, //Placid
			// HEK_REGION_ID: 10000042, //Metropolis
			
			JITA_STATION_ID: 60003760,
			AMARR_STATION_ID: 60008494,
			DODIXIE_STATION_ID: 60011866,
			RENS_STATION_ID: 60004588,
			STACMON_STATION_ID: 60011893,
	
			SELL_TAX: 0.08 + 0.024,
			BUY_TAX: 0.024
		}
	};
})();
