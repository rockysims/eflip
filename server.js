require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
// const { scrapeRegion } = require('./scraper');

// The app `npm start` serves, built without listening so a test can put it on a port of its own.
// options: {cacheDir} (default: cache/ in the repo) plus mountApi's {env, dataDir, fetch, now, log,
// timers}, all for tests; the server passes none.
const createApp = (options = {}) => {
	const { cacheDir = path.join(__dirname, 'cache'), ...apiOptions } = options;

	//express setup
	const app = express();
	// Only the /file cache routes take a body this large. The /api routes parse their own bodies with
	// their own limits and errors (lib/api.js); a parser here for every path would parse them first and
	// theirs would never act.
	app.use('/file', bodyParser.json({limit: '5mb'}));

	// `/` is public/index.html, a page of links to the four pages that loads nothing from ESI (the static
	// middleware's index). The pre-rework root page fetched hundreds of Jita books from ESI on load, and an
	// accidental visit spent the market-order rate-limit bucket the sync shares; it is gone.
	//static setup
	app.use(express.static('public'));

	require('./lib/cache-files').mountCacheRoutes(app, cacheDir);
	require('./lib/api').mountApi(app, apiOptions);
	return app;
};

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

//---

if (require.main === module) {
	const port = process.env.PORT || 5001;
	const host = process.env.HOST || '127.0.0.1';
	createApp().listen(port, host, () => console.log(`Listening on http://${host}:${port}`));
}

module.exports = { createApp };

// const csvToJson = require('convert-csv-to-json');
// let fileInputName = 'public/invTypes.csv'; 
// let fileOutputName = 'public/invTypes.json';
// csvToJson.fieldDelimiter(',').generateJsonFileFromCsv(fileInputName,fileOutputName);
