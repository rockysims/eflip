require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const moment = require('moment');
const fs = require('fs');
// const { scrapeRegion } = require('./scraper');

//express setup
const app = express();
app.use(bodyParser.json());

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

app.get('/file/:path', async (req, res) => {
	const path = 'cache/' + req.params.path;
	const hoursStaleLimit = +req.query.hoursStaleLimit;

	if (fs.existsSync(path)) {
		const hoursStale = moment().diff(fs.statSync(path).mtime, 'minutes') / 60;
		if (hoursStale >= hoursStaleLimit && hoursStaleLimit >= 0) {
			// console.log('found (stale) ' + path);
			res.sendStatus(404);
		} else {
			// console.log('found ' + path);
			res.json(JSON.parse(fs.readFileSync(path)));
		}
	} else {
		// console.log('not found ' + path);
		res.sendStatus(404);
	}
});

app.post('/file/:path', async (req, res) => {
	if (!fs.existsSync('cache')) fs.mkdirSync('cache');

	const path = 'cache/' + req.params.path;
	fs.writeFileSync(path, JSON.stringify(req.body), {flag: 'w'});
	res.sendStatus(200);
});

//---

const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`Listening on port ${port}...`));



// const csvToJson = require('convert-csv-to-json');
// let fileInputName = 'public/invTypes.csv'; 
// let fileOutputName = 'public/invTypes.json';
// csvToJson.fieldDelimiter(',').generateJsonFileFromCsv(fileInputName,fileOutputName);
