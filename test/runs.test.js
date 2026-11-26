const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { mountApi } = require('../lib/api');
const { createRunStore, RunError, RUNS_MAX_BYTES, MAX_ROWS } = require('../lib/runs');
const { marketRegions } = require('../lib/sync');
const exportPersist = require('../public/export-persist.js');
const resultsCalc = require('../public/results-calc.js');
const { tmpDataDir, makeLog } = require('../test-support/esi-fake');

// Phase 5 of docs/trade-results-plan.md: POST|GET /api/runs (lib/runs.js) and the pure helper the
// export page shares with the server (public/export-persist.js).

const T1 = '2026-11-19T10:00:00.000Z';
const T2 = '2026-11-19T10:05:00.000Z';
const T3 = '2026-11-19T10:09:00.000Z';
const G1 = '2026-11-19T09:30:00.000Z'; // report generated
const G2 = '2026-11-19T11:00:00.000Z';
const NOW = new Date('2026-11-19T12:00:00.000Z');
const MINUTE = 60 * 1000;

const ROUTE = { start: 'Jita', end: 'Amarr', startStationId: 60003760, endStationId: 60008494, startRegionId: 10000002, endRegionId: 10000043 };
const CONFIG = { SELL_TAX: 0.104, SALES_TAX: 0.0375, BROKER_FEE: 0.03, HAULING_REWARD_FRACTION: 0.1, MIN_ROI: 1.5 };

// node:http rather than fetch: undici's fetch silently drops a custom Host header.
const request = (port, method, urlPath, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
	const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
	const h = { Host: `localhost:${port}`, ...headers };
	if (payload !== undefined) {
		h['Content-Type'] = h['Content-Type'] || 'application/json';
		h['Content-Length'] = Buffer.byteLength(payload);
	}
	const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: h }, res => {
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
	if (payload !== undefined) req.write(payload);
	req.end();
});

// No EVE SSO credentials unless asked: the run routes must work without them.
const startApp = async (t, { configured = false } = {}) => {
	const dataDir = tmpDataDir(t);
	const app = express();
	const server = await new Promise(resolve => {
		const s = app.listen(0, '127.0.0.1', () => resolve(s));
	});
	t.after(() => new Promise(resolve => server.close(resolve)));
	const port = server.address().port;
	const env = configured ? { EVE_CLIENT_ID: 'client-id', EVE_CLIENT_SECRET: 'client-secret' } : {};
	const log = makeLog();
	mountApi(app, { env, dataDir, log });
	const runsDir = path.join(dataDir, 'runs');
	return {
		port, dataDir, runsDir, log,
		get: (p, o) => request(port, 'GET', p, o),
		post: (p, body, o = {}) => request(port, 'POST', p, { ...o, body }),
		files: () => (fs.existsSync(runsDir) ? fs.readdirSync(runsDir).sort() : []),
		read: (id) => JSON.parse(fs.readFileSync(path.join(runsDir, `${id}.json`), 'utf8')),
	};
};

// ---- fixtures: an order as ESI sends it, and a copied row as the page hands it to buildRun

const ord = (i, price, { buy = false } = {}) => ({
	order_id: 5000 + i, price, volume_remain: 10 + i, volume_total: 50, issued: '2026-11-18T08:00:00Z', duration: 90,
	range: buy ? 'station' : 'region', min_volume: 1, is_buy_order: buy, type_id: 34, location_id: 60003760, system_id: 30000142,
});
const day = (date) => ({ date, average: 100, highest: 110, lowest: 90, order_count: 12, volume: 400 });
const context = () => exportPersist.marketContext({
	srcOrders: [ord(1, 100), ord(2, 101)],
	destOrders: [ord(3, 150), ord(4, 160), ord(5, 40, { buy: true })],
	destDays: [day('2026-11-17'), day('2026-11-18'), day('2025-01-01')],
	now: NOW,
});
// base is the factor-1 estimate, report the estimate for the copied quantity: the same object at factor 1
const copiedRow = (typeId, qty, over = {}) => {
	const report = over.report || { volume: qty, costPerItemMil: 1.1, revenuePerItemMil: 1.9, sellPriceMil: 2.1, profitPerItemMil: 0.8, dailyProfitMil: 16, daysToClear: 5, dailyDemand: 20, competingVolume: 3, floored: false, stopReason: 'horizon', horizonVolume: qty };
	return {
		typeId, name: `Item ${typeId}`, m3: 2.5, qty, factor: 1,
		base: report, report,
		context: context(),
		orderCostMil: 1.1 * qty, orderRevenueMil: 1.9 * qty, km3: Math.ceil(qty * 2.5) / 1000,
		...over,
	};
};
const makeBody = ({ rows = [copiedRow(34, 100), copiedRow(35, 40)], copiedAt = T1, reportGeneratedAt = G1, route = ROUTE } = {}) =>
	exportPersist.withId(exportPersist.buildRun({ copiedAt, reportGeneratedAt, route, horizonDays: 5, config: CONFIG, rows }));

// ---- public/export-persist.js

test('the content hash covers typeId and qty only, in type id order', async () => {
	const rows = [{ typeId: 34, qty: 5 }, { typeId: 12, qty: 7 }];
	assert.equal(exportPersist.contentKey(rows), '12:7,34:5');
	const expected = crypto.createHash('sha256').update('12:7,34:5').digest('hex').slice(0, 16);
	assert.equal(await exportPersist.contentHash(rows), expected);

	const noisy = [
		{ typeId: 12, qty: 7, name: 'x', factor: 2, report: { volume: 99 } },
		{ typeId: 34, qty: 5, name: 'y' },
	];
	assert.equal(await exportPersist.contentHash(noisy), expected, 'other fields and the row order do not matter');
	assert.notEqual(await exportPersist.contentHash([{ typeId: 34, qty: 6 }, { typeId: 12, qty: 7 }]), expected, 'a quantity');
	assert.notEqual(await exportPersist.contentHash([{ typeId: 35, qty: 5 }, { typeId: 12, qty: 7 }]), expected, 'a type');
	assert.notEqual(await exportPersist.contentHash([{ typeId: 12, qty: 7 }]), expected, 'a missing row');
	assert.match(expected, /^[0-9a-f]{16}$/);
});

test('the run id is <route>-<reportGeneratedAt>-<content hash>', async () => {
	const rows = [{ typeId: 34, qty: 5 }];
	const id = await exportPersist.runId({ route: ROUTE, reportGeneratedAt: G1, rows });
	assert.equal(id, `Jita-Amarr-${G1}-${await exportPersist.contentHash(rows)}`);
	assert.notEqual(await exportPersist.runId({ route: ROUTE, reportGeneratedAt: G2, rows }), id, 'a new Run is a new id');
	assert.notEqual(await exportPersist.runId({ route: { ...ROUTE, end: 'Dodixie' }, reportGeneratedAt: G1, rows }), id);
});

test('marketContext keeps the best 20 of each book side, the listed fields, and the history the estimator reads', () => {
	const perm = (i) => (i * 7) % 25; // a shuffle of 0..24
	const sells = Array.from({ length: 25 }, (_, i) => ord(i, 100 + perm(i)));
	const buys = Array.from({ length: 25 }, (_, i) => ord(100 + i, 50 + perm(i), { buy: true }));
	const before = JSON.stringify([sells, buys]);
	// the destination book holds both sides in one array; the source here only sells
	const ctx = exportPersist.marketContext({
		srcOrders: sells,
		destOrders: [...buys, ...sells],
		destDays: [day('2026-08-21'), day('2026-08-20'), day('2026-11-19'), day('2026-11-01'), { date: 5 }, null],
		now: NOW,
	});
	assert.equal(JSON.stringify([sells, buys]), before, 'the caller\'s orders are not reordered');

	assert.deepEqual(ctx.src.sell.map(o => o.price), Array.from({ length: 20 }, (_, i) => 100 + i), 'cheapest sells first');
	assert.deepEqual(ctx.src.buy, []);
	assert.deepEqual(ctx.dest.buy.map(o => o.price), Array.from({ length: 20 }, (_, i) => 74 - i), 'dearest buys first');
	assert.equal(ctx.dest.sell.length, 20);
	assert.deepEqual(Object.keys(ctx.src.sell[0]).sort(), ['duration', 'issued', 'min_volume', 'order_id', 'price', 'range', 'volume_remain', 'volume_total'], 'no type_id, location_id or is_buy_order');

	// aged 90 whole days at NOW is kept, 91 is not; oldest first
	assert.deepEqual(ctx.history.map(d => d.date), ['2026-08-21', '2026-11-01', '2026-11-19']);
	assert.deepEqual(ctx.history[0], day('2026-08-21'));
	assert.deepEqual(exportPersist.marketContext({ srcOrders: undefined, destOrders: null, destDays: undefined, now: NOW }), { src: { sell: [], buy: [] }, dest: { sell: [], buy: [] }, history: [] });
	const short = exportPersist.marketContext({ srcOrders: [], destOrders: [], destDays: [day('2026-11-10'), day('2026-11-12')], now: NOW, historyDays: 7 });
	assert.deepEqual(short.history.map(d => d.date), ['2026-11-12'], 'the page passes the span its estimator reads');
});

test('buildRun: the run as saved, rows of quantity 0 left out, totals summed from the page\'s own figures', () => {
	// the factor-0.7 row: its report is the re-estimate for the 40 copied units, its base the factor-1 estimate of 55
	// the observed figures are the row's report's (the copied quantity's), not the base's: base35 carries others to show it
	const base35 = { volume: 55, costPerItemMil: 2.5, revenuePerItemMil: 3.5, sellPriceMil: 3.9, profitPerItemMil: 1, dailyProfitMil: 9, daysToClear: 7.5, dailyDemand: 4, competingVolume: 1, floored: false, stopReason: 'roi', horizonVolume: 80, extra: 'x', observedFractionEvents: 0.1, rivalsObserved: 9 };
	const report35 = { volume: 40, costPerItemMil: 2, revenuePerItemMil: 3, sellPriceMil: null, profitPerItemMil: 1, dailyProfitMil: 8, daysToClear: null, dailyDemand: 4, competingVolume: 0, floored: false, stopReason: 'target', horizonVolume: 80, observedFractionEvents: 0.62, observedFractionVolume: 0.8, avgDaysIdle: 2.1, dailyDemandObserved: 23.5, rivalsObserved: 1.9, observedCoverage: { windowDays: 3 }, avgDaysIdleCensored: true };
	const rows = [copiedRow(34, 100), copiedRow(36, 0), copiedRow(35, 40, { m3: undefined, base: base35, report: report35, factor: 0.7, orderCostMil: 80, orderRevenueMil: 120, km3: 0.05 })];
	rows[0].orderCostMil = 110;
	rows[0].orderRevenueMil = 190;
	rows[0].km3 = 0.25;
	const frozen = JSON.stringify(rows);
	const run = exportPersist.buildRun({ copiedAt: T1, reportGeneratedAt: G1, route: { ...ROUTE, extra: 1 }, horizonDays: 5, config: { ...CONFIG, other: 2 }, rows });
	assert.equal(JSON.stringify(rows), frozen, 'inputs are not modified');

	assert.deepEqual(Object.keys(run), ['copiedAt', 'reportGeneratedAt', 'route', 'horizonDays', 'config', 'rows', 'totals', 'context']);
	assert.deepEqual(run.route, ROUTE);
	assert.deepEqual(run.config, CONFIG);
	assert.deepEqual(run.rows.map(r => r.typeId), [34, 35]);
	assert.deepEqual(Object.keys(run.rows[0]), ['typeId', 'name', 'm3', 'qty', 'factor', 'recommended', 'recommendation', 'costPerItemMil', 'revenuePerItemMil', 'sellPriceMil', 'profitPerItemMil', 'dailyProfitMil', 'daysToClear', 'dailyDemand', 'competingVolume', 'observedFractionEvents', 'observedFractionVolume', 'avgDaysIdle', 'dailyDemandObserved', 'rivalsObserved']);
	assert.deepEqual(exportPersist.OBSERVED_FIELDS, ['observedFractionEvents', 'observedFractionVolume', 'avgDaysIdle', 'dailyDemandObserved', 'rivalsObserved']);
	assert.deepEqual(Object.keys(run.rows[0].recommendation), ['volume', 'floored', 'stopReason', 'horizonVolume', ...exportPersist.PREDICTION_FIELDS]);
	// the prediction fields are the copied quantity's (report); recommended and recommendation are the factor-1 estimate's (base)
	assert.deepEqual(run.rows[1], {
		typeId: 35, name: 'Item 35', m3: null, qty: 40, factor: 0.7, recommended: 55,
		recommendation: {
			volume: 55, floored: false, stopReason: 'roi', horizonVolume: 80,
			costPerItemMil: 2.5, revenuePerItemMil: 3.5, sellPriceMil: 3.9, profitPerItemMil: 1, dailyProfitMil: 9, daysToClear: 7.5, dailyDemand: 4, competingVolume: 1,
		},
		costPerItemMil: 2, revenuePerItemMil: 3,
		sellPriceMil: null, profitPerItemMil: 1, dailyProfitMil: 8, daysToClear: null, dailyDemand: 4, competingVolume: 0,
		observedFractionEvents: 0.62, observedFractionVolume: 0.8, avgDaysIdle: 2.1, dailyDemandObserved: 23.5, rivalsObserved: 1.9,
	});
	// a report without observation (or with a figure that is not a finite number) saves null for each
	assert.deepEqual(exportPersist.OBSERVED_FIELDS.map(key => run.rows[0][key]), [null, null, null, null, null]);
	const [odd] = exportPersist.buildRun({ copiedAt: T1, reportGeneratedAt: G1, route: ROUTE, horizonDays: 5, config: CONFIG, rows: [copiedRow(38, 5, { report: { ...report35, avgDaysIdle: NaN, rivalsObserved: Infinity, dailyDemandObserved: '3', observedFractionEvents: 0 } })] }).rows;
	assert.deepEqual(exportPersist.OBSERVED_FIELDS.map(key => odd[key]), [0, 0.8, null, null, null]);
	assert.equal(run.rows[1].recommended, run.rows[1].recommendation.volume);
	assert.equal('observedFractionEvents' in run.rows[1].recommendation, false, 'the recommendation keeps the prediction fields only');
	assert.notEqual(run.rows[1].recommended, report35.volume, 'not the re-estimate\'s volume');
	assert.deepEqual(run.rows[0].recommendation, { volume: 100, floored: false, stopReason: 'horizon', horizonVolume: 100, costPerItemMil: 1.1, revenuePerItemMil: 1.9, sellPriceMil: 2.1, profitPerItemMil: 0.8, dailyProfitMil: 16, daysToClear: 5, dailyDemand: 20, competingVolume: 3 });
	assert.deepEqual(run.totals, { costMil: 190, revenueMil: 310, profitMil: 120, km3: 0.3 });
	assert.deepEqual(Object.keys(run.context), ['34', '35']);
	assert.deepEqual(run.context[34], rows[0].context);

	// a floored 1 unit is a recommendation of nothing, shown for its figures; a row passed without base falls back to its report
	const floored = { volume: 1, floored: true, stopReason: 'roi', horizonVolume: 12, costPerItemMil: 8.8, revenuePerItemMil: 8.06, sellPriceMil: 9, profitPerItemMil: -0.74, dailyProfitMil: -0.9, daysToClear: 0.8, dailyDemand: 10, competingVolume: 7 };
	const [noBase] = exportPersist.buildRun({ copiedAt: T1, reportGeneratedAt: G1, route: ROUTE, horizonDays: 5, config: CONFIG, rows: [{ ...copiedRow(37, 1, { report: floored }), base: undefined }] }).rows;
	assert.deepEqual(noBase.recommendation, floored);
	assert.equal(noBase.recommended, 1);
	assert.equal(noBase.recommendation.floored, true);

	assert.equal(exportPersist.buildRun({ copiedAt: T1, reportGeneratedAt: G1, route: ROUTE, horizonDays: 5, config: CONFIG, rows: [copiedRow(36, 0)] }), null, 'nothing to save');
	assert.equal(exportPersist.buildRun({ copiedAt: T1, reportGeneratedAt: G1, route: ROUTE, horizonDays: 5, config: CONFIG, rows: [] }), null);
});

test('withId puts the id first and matches runId', async () => {
	const run = exportPersist.buildRun({ copiedAt: T1, reportGeneratedAt: G1, route: ROUTE, horizonDays: 5, config: CONFIG, rows: [copiedRow(34, 100)] });
	const body = await exportPersist.withId(run);
	assert.equal(Object.keys(body)[0], 'id');
	assert.equal(body.id, await exportPersist.runId(run));
	assert.equal('id' in run, false, 'the run itself is not modified');
});

test('syncIsStale: some linked character never synced or synced over an hour ago', () => {
	const now = Date.parse('2026-11-19T12:00:00.000Z');
	const at = (minutesAgo) => new Date(now - minutesAgo * MINUTE).toISOString();
	const status = (...characters) => ({ characters: Object.fromEntries(characters.map((c, i) => [90000001 + i, c])), market: {} });
	assert.equal(exportPersist.SYNC_MAX_AGE_MS, 60 * MINUTE);
	assert.equal(exportPersist.syncIsStale(status({ syncedAt: at(5) }), now), false);
	assert.equal(exportPersist.syncIsStale(status({ syncedAt: at(59) }), now), false);
	assert.equal(exportPersist.syncIsStale(status({ syncedAt: at(61) }), now), true);
	assert.equal(exportPersist.syncIsStale(status({ syncedAt: null }), now), true, 'never synced');
	assert.equal(exportPersist.syncIsStale(status({}), now), true, 'no syncedAt at all');
	assert.equal(exportPersist.syncIsStale(status({ syncedAt: 'garbage' }), now), true);
	assert.equal(exportPersist.syncIsStale(status({ syncedAt: at(5) }, { syncedAt: at(300) }), now), true, 'one stale character is enough');
	assert.equal(exportPersist.syncIsStale(status({ syncedAt: at(5) }, { syncedAt: at(6) }), now), false);
	assert.equal(exportPersist.syncIsStale(status({ syncedAt: at(300), running: true }), now), false, 'already syncing');
	assert.equal(exportPersist.syncIsStale(status(), now), false, 'no characters linked: nothing to sync');
	for (const odd of [null, undefined, {}, { error: 'not configured' }, [], 'x']) assert.equal(exportPersist.syncIsStale(odd, now), false, JSON.stringify(odd));
	assert.equal(exportPersist.syncIsStale(status({ syncedAt: at(30) }), now, 10 * MINUTE), true, 'the age is a parameter');
});

// ---- POST /api/runs

test('three identical posts leave one file with copyCount 3, and nothing else in it changes', async (t) => {
	const app = await startApp(t);
	const body = await makeBody();
	assert.match(body.id, /^Jita-Amarr-2026-11-19T09:30:00\.000Z-[0-9a-f]{16}$/);

	const first = await app.post('/api/runs', body);
	assert.equal(first.status, 201);
	assert.deepEqual(first.json, { id: body.id, created: true, copyCount: 1, lastCopiedAt: T1 });
	const afterFirst = app.read(body.id);

	const second = await app.post('/api/runs', { ...body, copiedAt: T2 });
	assert.equal(second.status, 200);
	assert.deepEqual(second.json, { id: body.id, created: false, copyCount: 2, lastCopiedAt: T2 });
	const third = await app.post('/api/runs', { ...body, copiedAt: T3, rows: [...body.rows].reverse() });
	assert.deepEqual(third.json, { id: body.id, created: false, copyCount: 3, lastCopiedAt: T3 });

	const names = app.files();
	assert.deepEqual(names, [`${body.id}.json`], 'one file, no temp files');
	const saved = app.read(body.id);
	assert.equal(saved.copyCount, 3);
	assert.equal(saved.lastCopiedAt, T3);
	assert.equal(saved.copiedAt, T1, 'the first copy stays the run\'s copiedAt');
	assert.deepEqual({ ...saved, lastCopiedAt: T1, copyCount: 1 }, afterFirst, 'rows, totals and context are the first copy\'s');

	// a duplicate that arrives late does not move lastCopiedAt back
	const late = await app.post('/api/runs', { ...body, copiedAt: T1 });
	assert.deepEqual(late.json, { id: body.id, created: false, copyCount: 4, lastCopiedAt: T3 });
});

test('the saved file: exact shape, the context of every copied row, private modes', async (t) => {
	const app = await startApp(t);
	const body = await makeBody();
	await app.post('/api/runs', body);
	const saved = app.read(body.id);

	assert.deepEqual(Object.keys(saved), ['id', 'copiedAt', 'reportGeneratedAt', 'route', 'horizonDays', 'config', 'rows', 'totals', 'lastCopiedAt', 'copyCount', 'context']);
	assert.equal(saved.id, body.id);
	assert.equal(saved.copiedAt, T1);
	assert.equal(saved.reportGeneratedAt, G1);
	assert.deepEqual(saved.route, ROUTE);
	assert.equal(saved.horizonDays, 5);
	assert.deepEqual(saved.config, CONFIG);
	assert.deepEqual(saved.rows, body.rows);
	assert.deepEqual(saved.totals, body.totals);
	assert.equal(saved.lastCopiedAt, T1);
	assert.equal(saved.copyCount, 1);
	assert.deepEqual(Object.keys(saved.context).sort(), ['34', '35'], 'a context for every copied row');
	for (const typeId of ['34', '35']) {
		const entry = saved.context[typeId];
		assert.deepEqual(Object.keys(entry), ['src', 'dest', 'history']);
		assert.deepEqual(entry.src.sell.map(o => o.price), [100, 101]);
		assert.deepEqual(entry.dest.sell.map(o => o.price), [150, 160]);
		assert.deepEqual(entry.dest.buy.map(o => o.price), [40]);
		assert.deepEqual(entry.history.map(d => d.date), ['2026-11-17', '2026-11-18']);
	}

	const file = path.join(app.runsDir, `${body.id}.json`);
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.equal(fs.statSync(app.runsDir).mode & 0o777, 0o700);
	// a bump keeps the modes
	await app.post('/api/runs', { ...body, copiedAt: T2 });
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a changed quantity is a second file, a new reportGeneratedAt a third; the same orders in another order are one', async (t) => {
	const app = await startApp(t);
	const first = await makeBody();
	const changed = await makeBody({ rows: [copiedRow(34, 100), copiedRow(35, 41)], copiedAt: T2 });
	const newRun = await makeBody({ reportGeneratedAt: G2, copiedAt: T3 });
	const reordered = await makeBody({ rows: [copiedRow(35, 40), copiedRow(34, 100)], copiedAt: T3 });
	assert.equal(new Set([first.id, changed.id, newRun.id]).size, 3);
	assert.equal(reordered.id, first.id);

	assert.equal((await app.post('/api/runs', first)).status, 201);
	assert.equal((await app.post('/api/runs', changed)).status, 201);
	assert.equal((await app.post('/api/runs', newRun)).status, 201);
	assert.equal(app.files().length, 3);
	const again = await app.post('/api/runs', reordered);
	assert.deepEqual(again.json, { id: first.id, created: false, copyCount: 2, lastCopiedAt: T3 });
	assert.equal(app.files().length, 3);
	assert.equal(app.read(changed.id).copyCount, 1);
	assert.equal(app.read(newRun.id).copyCount, 1);
});

test('concurrent identical posts count every copy exactly once', async (t) => {
	const app = await startApp(t);
	const body = await makeBody();
	const results = await Promise.all(Array.from({ length: 6 }, () => app.post('/api/runs', body)));
	assert.equal(results.filter(r => r.status === 201).length, 1);
	assert.equal(results.filter(r => r.status === 200).length, 5);
	assert.deepEqual(app.files(), [`${body.id}.json`]);
	assert.equal(app.read(body.id).copyCount, 6);
});

test('only the known fields are saved; id, lastCopiedAt and copyCount are the server\'s', async (t) => {
	const app = await startApp(t);
	const body = await makeBody();
	body.copyCount = 99;
	body.lastCopiedAt = '2030-01-01T00:00:00.000Z';
	body.evil = { nested: true };
	body.rows[0].extra = 'x';
	body.route.extra = 'x';
	body.context[34].src.sell[0].type_id = 34;
	body.context[34].extra = [];
	const res = await app.post('/api/runs', body);
	assert.equal(res.status, 201);
	const saved = app.read(body.id);
	assert.equal(saved.copyCount, 1);
	assert.equal(saved.lastCopiedAt, T1);
	assert.equal('evil' in saved, false);
	assert.equal('extra' in saved.rows[0], false);
	assert.equal('extra' in saved.route, false);
	assert.equal('type_id' in saved.context[34].src.sell[0], false);
	assert.equal('extra' in saved.context[34], false);
});

test('a row\'s recommendation (the factor-1 estimate) is saved with it, only its known keys', async (t) => {
	const app = await startApp(t);
	const body = await makeBody();
	const recommendation = body.rows[0].recommendation;
	assert.deepEqual(Object.keys(recommendation), ['volume', 'floored', 'stopReason', 'horizonVolume', ...exportPersist.PREDICTION_FIELDS]);
	assert.deepEqual(recommendation, { volume: 100, floored: false, stopReason: 'horizon', horizonVolume: 100, costPerItemMil: 1.1, revenuePerItemMil: 1.9, sellPriceMil: 2.1, profitPerItemMil: 0.8, dailyProfitMil: 16, daysToClear: 5, dailyDemand: 20, competingVolume: 3 });
	body.rows[0].recommendation = { ...recommendation, floored: true, stopReason: null, horizonVolume: null, sellPriceMil: null, extra: 'x' };
	body.rows[1].recommendation.stopReason = 'target';
	const res = await app.post('/api/runs', body);
	assert.equal(res.status, 201, res.text);
	const saved = app.read(body.id);
	assert.deepEqual(Object.keys(saved.rows[0]).slice(5, 7), ['recommended', 'recommendation']);
	assert.deepEqual(saved.rows[0].recommendation, { ...recommendation, floored: true, stopReason: null, horizonVolume: null, sellPriceMil: null });
	assert.deepEqual(Object.keys(saved.rows[0].recommendation), ['volume', 'floored', 'stopReason', 'horizonVolume', ...exportPersist.PREDICTION_FIELDS], 'in the page\'s order, without the extra key');
	assert.equal(saved.rows[1].recommendation.stopReason, 'target');
	const listed = (await app.get('/api/runs')).json;
	assert.deepEqual(listed[0].rows[0].recommendation, saved.rows[0].recommendation, 'GET answers it too');
});

test('a row without a recommendation (an older page) is accepted and saved with recommendation null', async (t) => {
	const app = await startApp(t);
	const body = await makeBody();
	delete body.rows[0].recommendation;
	body.rows[1].recommendation = null;
	const res = await app.post('/api/runs', body);
	assert.equal(res.status, 201, res.text);
	const saved = app.read(body.id);
	assert.equal(saved.rows[0].recommendation, null);
	assert.equal(saved.rows[1].recommendation, null);
	assert.deepEqual(Object.keys(saved.rows[0]).slice(5, 7), ['recommended', 'recommendation']);
	assert.equal(saved.rows[0].recommended, 100);
});

test('a row\'s observed figures are saved with it, in order; a row without them (an older page) saves nulls', async (t) => {
	const app = await startApp(t);
	const observed = { observedFractionEvents: 0.62, observedFractionVolume: 0.8, avgDaysIdle: 2.1, dailyDemandObserved: 23.5, rivalsObserved: 1.9 };
	const body = await makeBody({ rows: [copiedRow(34, 100, { report: { ...copiedRow(34, 100).report, ...observed, observedCoverage: { windowDays: 3 }, avgDaysIdleCensored: true } }), copiedRow(35, 40)] });
	assert.deepEqual(exportPersist.OBSERVED_FIELDS.map(key => body.rows[0][key]), Object.values(observed));
	body.rows[0].extra = 'x';
	// the second row as an older page posts it: no observed keys at all
	for (const key of exportPersist.OBSERVED_FIELDS) delete body.rows[1][key];
	const res = await app.post('/api/runs', body);
	assert.equal(res.status, 201, res.text);
	const saved = app.read(body.id);
	assert.deepEqual(Object.keys(saved.rows[0]).slice(-5), exportPersist.OBSERVED_FIELDS, 'after the prediction fields, in the page\'s order');
	assert.deepEqual(exportPersist.OBSERVED_FIELDS.map(key => saved.rows[0][key]), [0.62, 0.8, 2.1, 23.5, 1.9]);
	assert.equal('extra' in saved.rows[0], false);
	assert.deepEqual(exportPersist.OBSERVED_FIELDS.map(key => saved.rows[1][key]), [null, null, null, null, null]);
	assert.deepEqual(Object.keys(saved.rows[1]).slice(-5), exportPersist.OBSERVED_FIELDS);
	const listed = (await app.get('/api/runs')).json;
	assert.equal(listed[0].rows[0].avgDaysIdle, 2.1, 'GET answers them too');
});

// ---- validation

const bodyCases = [
	['copiedAt that is not a time', b => { b.copiedAt = 'yesterday'; }, /copiedAt/],
	['copiedAt with no milliseconds', b => { b.copiedAt = '2026-11-19T10:00:00Z'; }, /copiedAt/],
	['copiedAt on a day that does not exist', b => { b.copiedAt = '2026-02-31T00:00:00.000Z'; }, /copiedAt/],
	['missing reportGeneratedAt', b => { delete b.reportGeneratedAt; }, /reportGeneratedAt/],
	['missing route', b => { delete b.route; }, /route/],
	['a route name that is a path', b => { b.route.start = '../evil'; }, /route\.start/],
	['a route name with a dash', b => { b.route.end = 'Jita-Amarr'; }, /route\.end/],
	['a route name that is a number', b => { b.route.end = 5; }, /route\.end/],
	['a missing route name', b => { delete b.route.start; }, /route\.start/],
	['a station id that is text', b => { b.route.startStationId = '60003760'; }, /startStationId/],
	['a region id of zero', b => { b.route.endRegionId = 0; }, /endRegionId/],
	['horizonDays of 0', b => { b.horizonDays = 0; }, /horizonDays/],
	['horizonDays of 2.5', b => { b.horizonDays = 2.5; }, /horizonDays/],
	['a config key missing', b => { delete b.config.MIN_ROI; }, /config\.MIN_ROI/],
	['a config value that is text', b => { b.config.SELL_TAX = '0.1'; }, /config\.SELL_TAX/],
	['rows that are not an array', b => { b.rows = {}; }, /rows/],
	['no rows', b => { b.rows = []; }, /rows must not be empty/],
	['a row that is not an object', b => { b.rows[0] = 5; }, /rows\[0\]/],
	['a type listed twice', b => { b.rows[1].typeId = b.rows[0].typeId; }, /listed twice/],
	['a typeId of 0', b => { b.rows[0].typeId = 0; }, /rows\[0\]\.typeId/],
	['qty 0', b => { b.rows[0].qty = 0; }, /rows\[0\]\.qty/],
	['qty 1.5', b => { b.rows[0].qty = 1.5; }, /rows\[0\]\.qty/],
	['qty as text', b => { b.rows[0].qty = '10'; }, /rows\[0\]\.qty/],
	['an empty name', b => { b.rows[0].name = ''; }, /rows\[0\]\.name/],
	['a negative factor', b => { b.rows[0].factor = -1; }, /rows\[0\]\.factor/],
	['a prediction field missing', b => { delete b.rows[0].costPerItemMil; }, /rows\[0\]\.costPerItemMil/],
	['a prediction field as text', b => { b.rows[1].daysToClear = '5'; }, /rows\[1\]\.daysToClear/],
	['an observed fraction as text', b => { b.rows[0].observedFractionEvents = '0.5'; }, /rows\[0\]\.observedFractionEvents/],
	['an observed demand that is not finite', b => { b.rows[1].dailyDemandObserved = 'Infinity'; }, /rows\[1\]\.dailyDemandObserved/],
	['an avgDaysIdle that is an object', b => { b.rows[0].avgDaysIdle = {}; }, /rows\[0\]\.avgDaysIdle/],
	['a recommendation that is not an object', b => { b.rows[0].recommendation = 5; }, /rows\[0\]\.recommendation/],
	['a recommendation floored as text', b => { b.rows[0].recommendation.floored = 'yes'; }, /rows\[0\]\.recommendation\.floored/],
	['a recommendation without floored', b => { delete b.rows[0].recommendation.floored; }, /recommendation\.floored/],
	['a recommendation stopReason that is not one', b => { b.rows[1].recommendation.stopReason = 'maybe'; }, /rows\[1\]\.recommendation\.stopReason/],
	['a recommendation without stopReason', b => { delete b.rows[0].recommendation.stopReason; }, /recommendation\.stopReason/],
	['a recommendation volume that is negative', b => { b.rows[0].recommendation.volume = -1; }, /recommendation\.volume/],
	['a recommendation volume of 2.5', b => { b.rows[0].recommendation.volume = 2.5; }, /recommendation\.volume/],
	['a recommendation horizonVolume as text', b => { b.rows[0].recommendation.horizonVolume = '5'; }, /recommendation\.horizonVolume/],
	['a recommendation prediction field as text', b => { b.rows[0].recommendation.dailyProfitMil = '16'; }, /recommendation\.dailyProfitMil/],
	['missing totals', b => { delete b.totals; }, /totals/],
	['a totals value that is null', b => { b.totals.profitMil = null; }, /totals\.profitMil/],
	['missing context', b => { delete b.context; }, /context/],
	['context missing for a copied row', b => { delete b.context[35]; }, /context\.35/],
	['context for a row that was not copied', b => { b.context[999] = structuredClone(b.context[34]); }, /context\.999/],
	['a context key that is not a type id', b => { b.context.abc = {}; }, /context\.abc/],
	['a book side with no list', b => { delete b.context[34].dest.buy; }, /context\.34\.dest\.buy/],
	['a book side 21 deep', b => { b.context[34].src.sell = Array.from({ length: 21 }, (_, i) => ord(i, 100 + i)); }, /more than 20/],
	['an order price as text', b => { b.context[34].src.sell[0].price = '100'; }, /price/],
	['an order that is not an object', b => { b.context[34].src.sell[0] = 3; }, /src\.sell\[0\]/],
	['history that is not a list', b => { b.context[34].history = 'x'; }, /history/],
	['history of 401 days', b => { b.context[34].history = Array.from({ length: 401 }, () => day('2026-11-18')); }, /more than 400/],
	['a history date that is a number', b => { b.context[34].history[0].date = 20261118; }, /date/],
];
for (const [label, mutate, detail] of bodyCases) {
	test(`POST /api/runs refuses ${label} with 400 and saves nothing`, async (t) => {
		const app = await startApp(t);
		const body = structuredClone(await makeBody());
		mutate(body);
		const res = await app.post('/api/runs', body);
		assert.equal(res.status, 400, res.text);
		assert.equal(res.json.error, 'bad request');
		assert.match(res.json.detail, detail);
		assert.deepEqual(app.files(), []);
	});
}

test('POST /api/runs refuses a wrong or missing id (and writes nowhere else)', async (t) => {
	const app = await startApp(t);
	const body = await makeBody();
	const other = await makeBody({ rows: [copiedRow(34, 999)] });
	const cases = [
		['missing', (() => { const b = { ...body }; delete b.id; return b; })()],
		['from other content', { ...body, id: other.id }],
		['not a string', { ...body, id: 7 }],
		['a path', { ...body, id: '../../evil' }],
		['the right id with a suffix', { ...body, id: `${body.id}x` }],
	];
	for (const [label, b] of cases) {
		const res = await app.post('/api/runs', b);
		assert.equal(res.status, 400, label);
		assert.match(res.json.detail, /id does not match the content/, label);
	}
	assert.deepEqual(app.files(), []);
	assert.deepEqual(fs.readdirSync(path.dirname(app.dataDir)).filter(name => name !== 'data'), [], 'nothing outside the data directory');
	// and the one with the right id is accepted
	assert.equal((await app.post('/api/runs', body)).status, 201);
});

test('POST /api/runs refuses bodies that are not objects', async (t) => {
	const app = await startApp(t);
	const body = await makeBody();
	const cases = [
		['an array', '[]'],
		['null', 'null'],
		['a bare string', '"run"'],
		['broken JSON', '{"id": '],
		['a number', '5'],
	];
	for (const [label, text] of cases) {
		const res = await app.post('/api/runs', text);
		assert.equal(res.status, 400, label);
		assert.equal(res.json.error, 'bad request', label);
	}
	const plain = await app.post('/api/runs', JSON.stringify(body), { headers: { 'Content-Type': 'text/plain' } });
	assert.equal(plain.status, 400, 'JSON sent as another content type is not parsed');
	const empty = await request(app.port, 'POST', '/api/runs', { headers: { 'Content-Length': '0' } });
	assert.equal(empty.status, 400);
	assert.deepEqual(app.files(), []);
});

test('size limits: a body over the limit is 413, as are too many rows (400) and a run too big to keep (413)', async (t) => {
	const app = await startApp(t);
	const body = await makeBody();
	const huge = await app.post('/api/runs', { ...body, padding: 'x'.repeat(RUNS_MAX_BYTES + 1024) });
	assert.equal(huge.status, 413);
	assert.equal(huge.json.error, 'too large');
	assert.deepEqual(app.files(), []);

	const many = structuredClone(body);
	many.rows = Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ ...many.rows[0], typeId: i + 1 }));
	const tooMany = await app.post('/api/runs', many);
	assert.equal(tooMany.status, 400);
	assert.match(tooMany.json.detail, /more than 2000/);

	// Under the body limit as sent, over it once saved: the store checks the file it would write too
	// (server.js's own 5 MB parser lets bodies up to 5 MB through before the route sees them).
	const deepOrder = (i) => ({ ...ord(i, 100 + i), range: 'region' });
	const fat = (typeId) => ({
		src: { sell: Array.from({ length: 20 }, (_, i) => deepOrder(i)), buy: Array.from({ length: 20 }, (_, i) => deepOrder(i)) },
		dest: { sell: Array.from({ length: 20 }, (_, i) => deepOrder(i)), buy: Array.from({ length: 20 }, (_, i) => deepOrder(i)) },
		history: Array.from({ length: 400 }, (_, i) => ({ ...day('2026-11-18'), volume: i })),
	});
	const rows = Array.from({ length: 90 }, (_, i) => copiedRow(1000 + i, 10, { context: fat(1000 + i) }));
	const big = await makeBody({ rows });
	assert.ok(JSON.stringify(big).length > RUNS_MAX_BYTES * 0.9, 'the fixture is near the limit');
	const store = createRunStore({ dataDir: app.dataDir, log: makeLog() });
	await assert.rejects(() => store.save(big), (e) => e instanceof RunError && e.status === 413);
	assert.deepEqual(app.files(), []);
});

// ---- GET /api/runs, and the guards

test('GET /api/runs lists the runs most recently copied first, without the context unless asked', async (t) => {
	const app = await startApp(t);
	assert.deepEqual((await app.get('/api/runs')).json, [], 'no runs yet, no directory yet');

	const a = await makeBody({ copiedAt: T1 });
	const b = await makeBody({ rows: [copiedRow(34, 50)], copiedAt: T2, reportGeneratedAt: G2 });
	await app.post('/api/runs', a);
	await app.post('/api/runs', b);
	let list = (await app.get('/api/runs')).json;
	assert.deepEqual(list.map(r => r.id), [b.id, a.id]);
	assert.equal('context' in list[0], false);
	assert.deepEqual(Object.keys(list[0]), ['id', 'copiedAt', 'reportGeneratedAt', 'route', 'horizonDays', 'config', 'rows', 'totals', 'lastCopiedAt', 'copyCount']);
	assert.equal(list[1].copyCount, 1);

	// copying the older run's orders again makes it the newest
	await app.post('/api/runs', { ...a, copiedAt: T3 });
	list = (await app.get('/api/runs')).json;
	assert.deepEqual(list.map(r => [r.id, r.copyCount, r.lastCopiedAt]), [[a.id, 2, T3], [b.id, 1, T2]]);

	const withContext = (await app.get('/api/runs?context=1')).json;
	assert.deepEqual(Object.keys(withContext[0].context), ['34', '35']);
	assert.equal(withContext[0].context[34].src.sell.length, 2);
	assert.equal('context' in (await app.get('/api/runs?context=0')).json[0], false);
});

test('GET /api/runs skips files that are not runs, and says so for a broken one', async (t) => {
	const app = await startApp(t);
	const body = await makeBody();
	await app.post('/api/runs', body);
	const broken = `Jita-Amarr-${G2}-0123456789abcdef`;
	fs.writeFileSync(path.join(app.runsDir, `${broken}.json`), '{"id": ');
	fs.writeFileSync(path.join(app.runsDir, 'notes.json'), '{"id": "notes"}');
	fs.writeFileSync(path.join(app.runsDir, `.${body.id}.json.123.abc.tmp`), '{}');
	fs.writeFileSync(path.join(app.runsDir, `Jita-Amarr-${G1}-ffffffffffffffff.json`), '[]');
	const res = await app.get('/api/runs');
	assert.equal(res.status, 200);
	assert.deepEqual(res.json.map(r => r.id), [body.id]);
	assert.ok(app.log.lines.some(line => line.includes('warn:') && line.includes(broken)), app.log.lines.join('\n'));
});

test('the run routes work without EVE SSO and with it, and keep the Host and Origin guards', async (t) => {
	for (const configured of [false, true]) {
		const app = await startApp(t, { configured });
		const body = await makeBody();
		assert.equal((await app.post('/api/runs', body)).status, 201, `configured: ${configured}`);
		assert.equal((await app.get('/api/runs')).json.length, 1);
		assert.equal((await app.get('/api/config')).json.configured, configured);

		const fresh = await makeBody({ copiedAt: T2, rows: [copiedRow(34, 7)] });
		for (const [method, headers] of [['GET', { Host: 'evil.example' }], ['GET', { Origin: 'http://evil.example' }], ['POST', { Host: 'evil.example' }], ['POST', { Origin: 'http://evil.example' }]]) {
			const res = await request(app.port, method, '/api/runs', { headers, body: method === 'POST' ? fresh : undefined });
			assert.equal(res.status, 403, `${method} ${JSON.stringify(headers)}`);
			assert.equal(res.headers['access-control-allow-origin'], undefined);
		}
		assert.equal(app.files().length, 1, 'a refused post saves nothing');
		const sameOrigin = await app.post('/api/runs', fresh, { headers: { Origin: `http://localhost:${app.port}` } });
		assert.equal(sameOrigin.status, 201, 'the page\'s own Origin is let through');
	}
});

// ---- the saved files meet their readers

test('a saved run is what sync.js (the market region) and results-calc (the comparison) read', async (t) => {
	const app = await startApp(t);
	const older = await makeBody({ copiedAt: T1 });
	const newer = await makeBody({ copiedAt: T2, reportGeneratedAt: G2, route: { ...ROUTE, end: 'Dodixie', endStationId: 60011866, endRegionId: 10000032 } });
	await app.post('/api/runs', older);
	assert.deepEqual(marketRegions({ dataDir: app.dataDir, ledger: null, characterIds: [], now: Date.parse(T3) }), [10000043]);
	await app.post('/api/runs', newer);
	assert.deepEqual(marketRegions({ dataDir: app.dataDir, ledger: null, characterIds: [], now: Date.parse(T3) }), [10000032], 'the newest run\'s end region');
	await app.post('/api/runs', { ...older, copiedAt: T3 });
	assert.deepEqual(marketRegions({ dataDir: app.dataDir, ledger: null, characterIds: [], now: Date.parse(T3) }), [10000043], 'lastCopiedAt counts');

	const runs = (await app.get('/api/runs')).json;
	const calc = resultsCalc.compute({ now: '2026-11-20T00:00:00Z', runs, window: { runId: older.id } });
	assert.deepEqual(calc.runs.map(r => [r.runId, Date.parse(r.copiedAt), r.typeCount, r.waiting]), [
		[older.id, Date.parse(T1), 2, true],
		[newer.id, Date.parse(T2), 2, true],
	]);
	assert.equal(calc.runs[0].route.endRegionId, 10000043);
	assert.ok(Math.abs(calc.totals.predictedProfit - (older.totals.profitMil * 1e6)) < 1e-3, 'predicted profit is the run\'s totals.profitMil in ISK');
});

test('the storage budget reads each run\'s context size and can drop a context, keeping the rest of the run', async (t) => {
	const dataDir = tmpDataDir(t);
	const store = createRunStore({ dataDir, log: makeLog() });
	assert.deepEqual(store.contexts(), []);
	const first = await makeBody();
	await store.save(first);
	const second = await makeBody({ copiedAt: T2, reportGeneratedAt: G2 });
	await store.save(second);
	const sizes = store.contexts();
	assert.deepEqual(sizes.map(run => run.id), [first.id, second.id], 'oldest copy first');
	for (const run of sizes) assert.equal(run.bytes, Buffer.byteLength(JSON.stringify(store.list({ context: true }).find(saved => saved.id === run.id).context)));
	assert.equal(store.contexts()[0], sizes[0], 'an unchanged file is not read again');

	const freed = store.trimContext(first.id, { at: '2026-11-25T12:00:00.000Z' });
	assert.equal(freed, sizes[0].bytes);
	const trimmed = store.list({ context: true }).find(run => run.id === first.id);
	assert.deepEqual(trimmed.context, {});
	assert.equal(trimmed.contextTrimmedAt, '2026-11-25T12:00:00.000Z');
	assert.equal(trimmed.rows.length, first.rows.length, 'the rows stay');
	assert.deepEqual(store.contexts().map(run => run.id), [second.id], 'a run without a context is not counted');
	assert.equal(store.trimContext(first.id, { at: '2026-11-25T13:00:00.000Z' }), 0, 'nothing left to drop');
	// copied again later: the counters move, the context stays dropped
	assert.equal((await store.save({ ...first, copiedAt: T3 })).copyCount, 2);
	assert.deepEqual(store.list({ context: true }).find(run => run.id === first.id).context, {});
});
