const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server');
const { RUNS_MAX_BYTES } = require('../lib/runs');
const { tmpDataDir, makeLog } = require('../test-support/esi-fake');

// server.js as `npm start` wires it: the /file cache routes with their 5 MB parser, then the /api routes,
// each of which parses its own body with its own limit and answers its own errors. The other API tests
// mount mountApi alone, so only this one sees a parser of server.js standing in front of the routes.

const startApp = async (t) => {
	const dataDir = tmpDataDir(t, 'eflip-server-app-test-');
	const cacheDir = path.join(path.dirname(dataDir), 'cache');
	const app = createApp({
		cacheDir,
		dataDir,
		env: { EVE_CLIENT_ID: 'client-id', EVE_CLIENT_SECRET: 'client-secret', ESI_USER_AGENT: 'eflip-test/1.0' },
		fetch: async () => { throw new Error('no ESI in this test'); },
		log: makeLog(),
	});
	t.after(() => app.locals.regionBookScheduler.stop());
	const server = await new Promise(resolve => {
		const s = app.listen(0, '127.0.0.1', () => resolve(s));
	});
	t.after(() => new Promise(resolve => server.close(resolve)));
	const base = `http://127.0.0.1:${server.address().port}`;
	const post = (urlPath, text) => fetch(`${base}${urlPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
	return { base, cacheDir, post };
};

test('server app', async (t) => {
	const { base, cacheDir, post } = await startApp(t);

	await t.test('a /api/watch body over its 16 KB limit answers 413 from the route', async () => {
		const res = await post('/api/watch', JSON.stringify({ pad: 'x'.repeat(20 * 1024) }));
		assert.equal(res.status, 413);
		assert.deepEqual(await res.json(), { error: 'bad request' });
	});

	await t.test('malformed JSON to /api/sync answers 400 JSON from the route', async () => {
		const res = await post('/api/sync', '{');
		assert.equal(res.status, 400);
		assert.match(res.headers.get('content-type'), /application\/json/);
		assert.deepEqual(await res.json(), { error: 'bad request' });
	});

	await t.test('a run over RUNS_MAX_BYTES answers 413 too large from the route', async () => {
		const res = await post('/api/runs', JSON.stringify({ pad: 'x'.repeat(RUNS_MAX_BYTES + 512 * 1024) }));
		assert.equal(res.status, 413);
		assert.deepEqual(await res.json(), { error: 'too large' });
	});

	await t.test('the /file cache routes still take a JSON body', async () => {
		const posted = await post('/file/server-app-test.json', JSON.stringify([{ price: 1.5 }, { price: 2 }]));
		assert.equal(posted.status, 200);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cacheDir, 'server-app-test.json'), 'utf8')), [{ price: 1.5 }, { price: 2 }]);
		const got = await fetch(`${base}/file/server-app-test.json?hoursStaleLimit=-1`);
		assert.equal(got.status, 200);
		assert.deepEqual(await got.json(), [{ price: 1.5 }, { price: 2 }]);
	});

	await t.test('GET /api/health answers ok', async () => {
		const res = await fetch(`${base}/api/health`);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { ok: true });
	});

	await t.test('GET / redirects to the export page, with or without a query', async () => {
		for (const url of ['/', '/?from=bookmark']) {
			const res = await fetch(`${base}${url}`, { redirect: 'manual' });
			assert.equal(res.status, 302, url);
			assert.equal(res.headers.get('location'), '/export.html', url);
		}
	});

	await t.test('the pre-rework root page is gone, and the pages beside it still serve', async () => {
		// The page that was here fetched hundreds of Jita books from ESI on load. The 200s show public/
		// resolves from this working directory, so the 404 is the file missing and not the folder.
		const gone = await fetch(`${base}/index.html`);
		assert.equal(gone.status, 404);
		for (const page of ['export.html', 'orders.html', 'results.html', 'insights.html', 'util.js']) {
			const res = await fetch(`${base}/${page}`);
			assert.equal(res.status, 200, page);
		}
	});

	await t.test('the other retired pages and scripts answer 404 too', async () => {
		for (const file of ['index.js', 'jack.js', 'reprocess.js', 'missing.html', 'missing.js', 'resell.html', 'resell.js']) {
			const res = await fetch(`${base}/${file}`);
			assert.equal(res.status, 404, file);
		}
	});
});
