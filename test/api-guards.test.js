const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { mountApi } = require('../lib/api');

const startServer = async () => {
	const app = express();
	mountApi(app);
	const server = await new Promise(resolve => {
		const s = app.listen(0, '127.0.0.1', () => resolve(s));
	});
	const port = server.address().port;
	const close = () => new Promise(resolve => server.close(resolve));
	return { port, close };
};

// node:http rather than fetch: undici's fetch silently drops a custom Host header.
const get = (port, path, headers) => new Promise((resolve, reject) => {
	const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, res => {
		const chunks = [];
		res.on('data', chunk => chunks.push(chunk));
		res.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8');
			let json = null;
			try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
			resolve({ status: res.statusCode, headers: res.headers, text, json });
		});
	});
	req.on('error', reject);
	req.end();
});

test('api guards', async (t) => {
	const { port, close } = await startServer();
	t.after(close);

	await t.test('GET /api/health answers {ok:true} and sets no CORS header', async () => {
		const res = await get(port, '/api/health', { Host: `127.0.0.1:${port}` });
		assert.equal(res.status, 200);
		assert.deepEqual(res.json, { ok: true });
		assert.equal(res.headers['access-control-allow-origin'], undefined);
	});

	await t.test('Host guard accepts loopback names and rejects anything else', async () => {
		const local = await get(port, '/api/health', { Host: `localhost:${port}` });
		assert.equal(local.status, 200);
		const v6 = await get(port, '/api/health', { Host: `[::1]:${port}` });
		assert.equal(v6.status, 200);
		const evil = await get(port, '/api/health', { Host: 'evil.example' });
		assert.equal(evil.status, 403);
		assert.deepEqual(evil.json, { error: 'forbidden host' });
		const evilPort = await get(port, '/api/health', { Host: `evil.example:${port}` });
		assert.equal(evilPort.status, 403);
		assert.deepEqual(evilPort.json, { error: 'forbidden host' });
	});

	await t.test('Origin guard allows only the exact same origin', async () => {
		const host = `127.0.0.1:${port}`;
		const same = await get(port, '/api/health', { Host: host, Origin: `http://127.0.0.1:${port}` });
		assert.equal(same.status, 200);
		const evil = await get(port, '/api/health', { Host: host, Origin: 'http://evil.example' });
		assert.equal(evil.status, 403);
		assert.deepEqual(evil.json, { error: 'forbidden origin' });
		const otherName = await get(port, '/api/health', { Host: host, Origin: `http://localhost:${port}` });
		assert.equal(otherName.status, 403);
		assert.deepEqual(otherName.json, { error: 'forbidden origin' });
		const garbage = await get(port, '/api/health', { Host: host, Origin: 'garbage' });
		assert.equal(garbage.status, 403);
		assert.deepEqual(garbage.json, { error: 'forbidden origin' });
	});

	await t.test('/sso is guarded too', async () => {
		const foreign = await get(port, '/sso/anything', { Host: 'evil.example' });
		assert.equal(foreign.status, 403);
		assert.deepEqual(foreign.json, { error: 'forbidden host' });
		const local = await get(port, '/sso/anything', { Host: `127.0.0.1:${port}` });
		assert.equal(local.status, 404);
	});
});
