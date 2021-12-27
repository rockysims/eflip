require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require("axios");
const fs = require('fs');

//express setup
const app = express();
app.use(bodyParser.json());

//static setup
app.use(express.static('public'));

//---

const axiosGet = async url => {
	return axios.get(url).then(res => {
		// console.log('GOT ' + url);
		return res.data;
	}, error => {
		console.log('GET failed because: ', error.response.status);
		return null;
	});
};
  
const getTypeIds = async (regionId) => {
	const promises = [];
	for (let p = 1; p <= 16; p++) {
		const url = `https://esi.evetech.net/latest/markets/${regionId}/types/?datasource=tranquility&page=${p}`;
		const promise = axiosGet(url);
		promises.push(promise);
	}
	return Promise.all(promises).then((results) => {
		return results.flat();
	});
};

const THE_FORGE_REGION_ID = 10000002;
app.get('/refresh', async (req, res) => {
	const regionId = THE_FORGE_REGION_ID;
	const typeIds = await getTypeIds(regionId);

	for (let i = 0; i * 100 < typeIds.length; i++) {
		console.log({i});
		const promises = [];
		for (let typeId of typeIds.slice(i * 100, (i + 1) * 100)) {
			const url = `https://esi.evetech.net/latest/markets/${regionId}/history/?datasource=tranquility&type_id=${typeId}`;
			const daysPromise = axiosGet(url);
			daysPromise.then(days => {
				fs.writeFileSync(`public/history/${typeId}.json`, JSON.stringify(days));
			}, reason => {
				console.log('did not get days for ' + typeId);
			});
			promises.push(daysPromise);
		}
		await Promise.all(promises).finally(() => {
			console.log({i, done: true});
		});
	}

	console.log('done refreshing');
	res.json({fresh: true});
});

app.get('/build', async (req, res) => {
	const regionId = THE_FORGE_REGION_ID;
	const typeIds = await getTypeIds(regionId);

	const daysByTypeId = {};
	for (let typeId of typeIds) {
		const days = JSON.parse(fs.readFileSync(`public/history/${typeId}.json`));
		daysByTypeId[typeId] = days;
	}

	console.log('writing daysByTypeId.json file...');
	fs.writeFileSync(`public/daysByTypeId.json`, JSON.stringify(daysByTypeId));

	console.log('done building');
	res.json({built: true});
});

//---

const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`Listening on port ${port}...`));

// const csvToJson = require('convert-csv-to-json');
// let fileInputName = 'public/invTypes.csv'; 
// let fileOutputName = 'public/invTypes.json';
// csvToJson.fieldDelimiter(',').generateJsonFileFromCsv(fileInputName,fileOutputName);
