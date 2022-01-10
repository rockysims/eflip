require('dotenv').config();

const { default: axios } = require('axios');
const mongoose = require('mongoose');
const CachedResponse = require('./models/CachedResponse');

//mongo setup
mongoose.connect(process.env.MONGODB_URI, {
	useNewUrlParser: true,
});
mongoose.connection.on('error', err => console.error('MongoDB connection error:', err));

// ---

const scrapedAt = Date.now();

const axiosGet = async (url, options = {}) => {
	return axios.get(url, options).then(res => res.data);
};

const localCache = {};
const fetchAndCache = async (url) => {
	if (localCache[url]) return localCache[url];

	const data = await axiosGet(url);
	localCache[url] = data;
	const newCachedResponse = new CachedResponse({
		url,
		data: JSON.stringify(data),
		scrapedAt
	});
	newCachedResponse.save();

	return data;
};

getRegionIds = async () => {
	const url = `https://esi.evetech.net/latest/universe/regions`;
	const regionIds = await fetchAndCache(url);
	return regionIds;
};

const getTypeIds = async (regionId) => {
	const typeIdsPagePromises = [];
	for (let page = 1; page <= 100; page++) {
		const url = `https://esi.evetech.net/latest/markets/${regionId}/types/?datasource=tranquility&page=${page}`;
		try {
			const typeIdsPagePromise = fetchAndCache(url);
			await typeIdsPagePromise;
			typeIdsPagePromises.push(typeIdsPagePromise);
		} catch (err) {
			if (err.response.status === 500) break;
			else throw err;
		}
	}
	return Promise.all(typeIdsPagePromises).then(typeIdsPages => {
		return typeIdsPages.flat();
	});
};

const getOrders = async (regionId, typeId) => {
	const url = `https://esi.evetech.net/latest/markets/${regionId}/orders/?datasource=tranquility&type_id=${typeId}`;
	return await fetchAndCache(url);
};

const STEP_SIZE = 100;
const main = async () => {
	await CachedResponse.deleteMany({}); //TODO: detele this line (if there is enough space in database...)

	const regionIds = (await getRegionIds()).slice(0, 2); //TODO: delete the ".slice(0, 2)" part
	for (let regionId of regionIds) {
		const typeIds = (await getTypeIds(regionId));
		for (let step = 0; step * STEP_SIZE < typeIds.length; step++) {
			const ordersPromises = [];
			for (let typeId of typeIds.slice(step * STEP_SIZE, (step + 1) * STEP_SIZE)) {
				ordersPromises.push(getOrders(regionId, typeId));
			}
			await Promise.all(ordersPromises);
			console.log(`Processing ${step * STEP_SIZE} / ${typeIds.length} (regionId: ${regionId})`);
		}
	}
};
main();





//order:
// {
// 	"duration":90,
// 	"is_buy_order":false,
// 	"issued":"2021-12-29T09:34:21Z",
// 	"location_id":60003760,
// 	"min_volume":1,
// 	"order_id":6160946530,
// 	"price":15230,
// 	"range":"region",
// 	"system_id":30000142,
// 	"type_id":31764,
// 	"volume_remain":193,
// 	"volume_total":200
// }