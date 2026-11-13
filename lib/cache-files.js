// cache-files.js: the /file/:path routes the browser uses as a local JSON cache.
//
// Express decodes percent-escapes in route params, so the name is untrusted: only plain
// file names are accepted and everything else answers 400.
const fs = require('fs');
const path = require('path');
const moment = require('moment');

const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Absolute path of `name` inside `cacheDir`, or null when `name` is not a plain file name.
const safeCachePath = (cacheDir, name) => {
	if (typeof name !== 'string' || !PLAIN_NAME.test(name)) return null;
	const root = path.resolve(cacheDir);
	const resolved = path.resolve(root, name);
	if (!resolved.startsWith(root + path.sep)) return null;
	return resolved;
};

const mountCacheRoutes = (app, cacheDir) => {
	app.get('/file/:path', async (req, res) => {
		const filePath = safeCachePath(cacheDir, req.params.path);
		if (filePath === null) return res.status(400).send('bad file name');
		const hoursStaleLimit = +req.query.hoursStaleLimit;

		if (fs.existsSync(filePath)) {
			const hoursStale = moment().diff(fs.statSync(filePath).mtime, 'minutes') / 60;
			if (hoursStale >= hoursStaleLimit && hoursStaleLimit >= 0) {
				// console.log('found (stale) ' + filePath);
				res.sendStatus(404);
			} else {
				// console.log('found ' + filePath);
				res.json(JSON.parse(fs.readFileSync(filePath)));
			}
		} else {
			// console.log('not found ' + filePath);
			res.sendStatus(404);
		}
	});

	app.post('/file/:path', async (req, res) => {
		const filePath = safeCachePath(cacheDir, req.params.path);
		if (filePath === null) return res.status(400).send('bad file name');
		if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

		fs.writeFileSync(filePath, JSON.stringify(req.body), {flag: 'w'});
		res.sendStatus(200);
	});
};

module.exports = { safeCachePath, mountCacheRoutes };
