// cache-files.js: the /file/:path routes the browser uses as a local JSON cache.
//
// Express decodes percent-escapes in route params, so the name is untrusted: only plain
// file names are accepted and everything else answers 400.
//
// The cache holds JSON objects and arrays only (body-parser's strict mode refuses anything
// else). A body it refuses answers a short 400 here instead of Express's default stack trace,
// and a cached file that no longer parses counts as a miss (404) so the page fetches it again
// and overwrites it, instead of the parse error escaping the handler.
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

const mountCacheRoutes = (app, cacheDir, { log = console } = {}) => {
	app.get('/file/:path', (req, res) => {
		const filePath = safeCachePath(cacheDir, req.params.path);
		if (filePath === null) return res.status(400).send('bad file name');
		const hoursStaleLimit = +req.query.hoursStaleLimit;

		if (!fs.existsSync(filePath)) return res.sendStatus(404);
		const hoursStale = moment().diff(fs.statSync(filePath).mtime, 'minutes') / 60;
		if (hoursStale >= hoursStaleLimit && hoursStaleLimit >= 0) return res.sendStatus(404);

		let parsed;
		try {
			parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
		} catch (e) {
			// a half-written or foreign file: a miss, and the next save replaces it
			log.warn(`cache: ${path.basename(filePath)} is not valid JSON; answering 404 so it is fetched again`);
			return res.sendStatus(404);
		}
		res.json(parsed);
	});

	app.post('/file/:path', (req, res) => {
		const filePath = safeCachePath(cacheDir, req.params.path);
		if (filePath === null) return res.status(400).send('bad file name');
		if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);

		fs.writeFileSync(filePath, JSON.stringify(req.body), {flag: 'w'});
		res.sendStatus(200);
	});

	// body-parser's refusals on these routes (a body that is not a JSON object or array, or one over
	// the size limit) answer their status with one line, not Express's default stack trace.
	app.use('/file', (err, req, res, next) => {
		if (!err || typeof err.status !== 'number' || err.status < 400 || err.status >= 500) return next(err);
		const reason = err.type === 'entity.parse.failed' ? 'body is not a JSON object or array' : (err.type || 'bad request');
		res.status(err.status).json({ error: reason });
	});
};

module.exports = { safeCachePath, mountCacheRoutes };
