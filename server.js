require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');

//express setup
const app = express();
app.use(bodyParser.json());

//static setup
app.use(express.static('public'));

//---

app.get('/file/:path', async (req, res) => {
	const path = 'cache/' + req.params.path;
	// console.log('load ' + path);
	if (fs.existsSync(path)) {
		res.json(JSON.parse(fs.readFileSync(path)));
	} else {
		res.sendStatus(404);
	}
});

app.post('/file/:path', async (req, res) => {
	if (!fs.existsSync('cache')) fs.mkdirSync('cache');

	const path = 'cache/' + req.params.path;
	// console.log('save ' + path);
	fs.writeFileSync(path, JSON.stringify(req.body));
	res.sendStatus(200);
});

//---

const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`Listening on port ${port}...`));



// const csvToJson = require('convert-csv-to-json');
// let fileInputName = 'public/invTypes.csv'; 
// let fileOutputName = 'public/invTypes.json';
// csvToJson.fieldDelimiter(',').generateJsonFileFromCsv(fileInputName,fileOutputName);
