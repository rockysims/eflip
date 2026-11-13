require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
// const { scrapeRegion } = require('./scraper');

//express setup
const app = express();
app.use(bodyParser.json({limit: '5mb'}));

//static setup
app.use(express.static('public'));

//---

// app.get('/api/scrape/:regionId', async (req, res) => {
// 	const { regionId } = req.params;
// 	try {
// 		await scrapeRegion(regionId);
// 		res.json({done: true});
// 	} catch (reason) {
// 		res.status(500).json(reason);
// 	}
// });

require('./lib/cache-files').mountCacheRoutes(app, path.join(__dirname, 'cache'));

//---

const port = process.env.PORT || 5001;
app.listen(port, () => console.log(`Listening on port ${port}...`));

(() => {
	const host = 'localhost';
	const port = 4000;
	const cors_proxy = require('cors-anywhere');
	cors_proxy.createServer({
		originWhitelist: [], // Allow all origins
		requireHeader: [],
		removeHeaders: ['cookie', 'cookie2']
	}).listen(port, host, function() {
		console.log('Running CORS Anywhere on ' + host + ':' + port);
	});
})();

// const csvToJson = require('convert-csv-to-json');
// let fileInputName = 'public/invTypes.csv'; 
// let fileOutputName = 'public/invTypes.json';
// csvToJson.fieldDelimiter(',').generateJsonFileFromCsv(fileInputName,fileOutputName);
