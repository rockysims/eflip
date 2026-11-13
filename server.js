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
require('./lib/api').mountApi(app);

//---

const port = process.env.PORT || 5001;
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => console.log(`Listening on http://${host}:${port}`));

// const csvToJson = require('convert-csv-to-json');
// let fileInputName = 'public/invTypes.csv'; 
// let fileOutputName = 'public/invTypes.json';
// csvToJson.fieldDelimiter(',').generateJsonFileFromCsv(fileInputName,fileOutputName);
