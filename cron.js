require('dotenv').config();

const { default: axios } = require('axios');
const mongoose = require('mongoose');
const CachedResponse = require('./models/CachedResponse');

//mongo setup
mongoose.connect(process.env.MONGODB_URI, {
	useNewUrlParser: true,
});
mongoose.connection.on('error', err => console.error('MongoDB connection error:', err));

const main = async () => {
	console.log('cron start');
	await CachedResponse.deleteMany({}); //TODO: detele this line in favor of the line below
	// await CachedResponse.deleteMany({ createdAt: { $lt: Date.now() - 1000*60*60*24*10 } }); //Note: this line is untested

	const regionIds = (await getRegionIds());
	console.log('started');
	let i = 0;
	for (let regionId of regionIds) {
		console.log(`scraping ${regionId} (${++i}/${regionIds.length})`);
		await axios.get(`https://eflip.herokuapp.com/api/scrape/${regionId}`);
		console.log(`scraped (${regionId})`);
	}
	
	console.log('cron end');
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

module.exports = mongoose.model('CachedResponse', CachedResponseSchema);
