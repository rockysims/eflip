const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const bodyParser = require('body-parser');
const { safeCachePath, mountCacheRoutes } = require('../lib/cache-files');

test('safeCachePath accepts plain file names and resolves them inside the cache dir', () => {
	const dir = path.resolve(os.tmpdir(), 'some-cache');
	assert.equal(safeCachePath(dir, 'orders-10000002.json'), path.join(dir, 'orders-10000002.json'));
	assert.equal(safeCachePath(dir, 'marketOrdersPages10000002sell.json'), path.join(dir, 'marketOrdersPages10000002sell.json'));
});

test('safeCachePath rejects anything that is not a plain file name', () => {
	const dir = path.resolve(os.tmpdir(), 'some-cache');
	for (const name of ['..', '.', '../package.json', '.env', 'a/b.json', 'a\\b.json', '', 'a b.json', 'a\0b.json', undefined, null, 5]) {
		assert.equal(safeCachePath(dir, name), null, JSON.stringify(name));
	}
});

// Each test gets its own server; `parent` holds both the cache dir and a sibling used to detect escapes.
const startServer = async () => {
	const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-files-test-'));
	const cacheDir = path.join(parent, 'cache');
	fs.mkdirSync(cacheDir);
	const app = express();
	app.use(bodyParser.json({limit: '5mb'}));
	mountCacheRoutes(app, cacheDir);
	const server = await new Promise(resolve => {
		const s = app.listen(0, '127.0.0.1', () => resolve(s));
	});
	const base = `http://127.0.0.1:${server.address().port}`;
	const close = async () => {
		await new Promise(resolve => server.close(resolve));
		fs.rmSync(parent, { recursive: true, force: true });
	};
	return { parent, cacheDir, base, close };
};

const post = (base, name, body) => fetch(`${base}/file/${name}`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify(body)
});

test('cache routes', async (t) => {
	const ctx = await startServer();
	t.after(() => ctx.close());
	const { parent, cacheDir, base } = ctx;

	await t.test('POST then GET round-trips a valid name', async () => {
		const posted = await post(base, 'orders-10000002.json', [{ price: 1.5 }]);
		assert.equal(posted.status, 200);
		const got = await fetch(`${base}/file/orders-10000002.json?hoursStaleLimit=-1`);
		assert.equal(got.status, 200);
		assert.deepEqual(await got.json(), [{ price: 1.5 }]);
	});

	await t.test('POST creates the cache dir when it is missing', async () => {
		fs.rmSync(cacheDir, { recursive: true, force: true });
		const posted = await post(base, 'fresh.json', { ok: true });
		assert.equal(posted.status, 200);
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cacheDir, 'fresh.json'), 'utf8')), { ok: true });
	});

	await t.test('GET of a missing name is 404', async () => {
		const res = await fetch(`${base}/file/nothing.json?hoursStaleLimit=-1`);
		assert.equal(res.status, 404);
	});

	await t.test('GET with an escaping name is 400 and reads nothing outside the cache dir', async () => {
		fs.writeFileSync(path.join(parent, 'secret.json'), '{"secret":true}');
		const res = await fetch(`${base}/file/..%2Fsecret.json?hoursStaleLimit=-1`);
		assert.equal(res.status, 400);
		assert.equal(await res.text(), 'bad file name');
		const repoFile = await fetch(`${base}/file/..%2Fpackage.json?hoursStaleLimit=-1`);
		assert.equal(repoFile.status, 400);
		const dotFile = await fetch(`${base}/file/.env?hoursStaleLimit=-1`);
		assert.equal(dotFile.status, 400);
	});

	await t.test('POST with an escaping name is 400 and writes nothing outside the cache dir', async () => {
		const res = await post(base, '..%2Fpwned.json', { pwned: true });
		assert.equal(res.status, 400);
		assert.equal(await res.text(), 'bad file name');
		assert.equal(fs.existsSync(path.join(parent, 'pwned.json')), false);
		assert.equal(fs.existsSync(path.join(cacheDir, 'pwned.json')), false);
	});

	await t.test('stale files answer 404 only when older than the limit', async () => {
		await post(base, 'aged.json', { n: 1 });
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
		fs.utimesSync(path.join(cacheDir, 'aged.json'), twoHoursAgo, twoHoursAgo);
		assert.equal((await fetch(`${base}/file/aged.json?hoursStaleLimit=1`)).status, 404);
		const fresh = await fetch(`${base}/file/aged.json?hoursStaleLimit=3`);
		assert.equal(fresh.status, 200);
		assert.deepEqual(await fresh.json(), { n: 1 });
		assert.equal((await fetch(`${base}/file/aged.json?hoursStaleLimit=-1`)).status, 200);
	});
});
