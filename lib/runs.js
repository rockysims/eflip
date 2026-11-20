// runs.js: the export runs the export page saves when "Copy orders" is pressed
// (docs/trade-results-plan.md, Comparison 1), one file each under <dataDir>/runs/<id>.json.
//
// A run is the report as it stood at the copy: the prediction rows, the settings and the market
// context (top of every order book and the destination history behind each row). It is the plan,
// not the truth, so nothing here reaches ESI or needs EVE SSO: these are local files.
//
// The id is `<route>-<reportGeneratedAt ISO>-<content hash>`; the content hash covers the copied
// rows' typeId and qty only (public/export-persist.js, shared with the page). The server derives
// the id from the body and refuses a body whose id disagrees, so a file name never comes from
// anything but a validated route name, an ISO stamp and 16 hex digits. Saving the same id again
// (the same orders copied twice) only bumps `copyCount` and `lastCopiedAt`.
//
// Files are written atomically, 0600 in a 0700 directory (lib/dataFiles.js).
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, readJsonFile } = require('./dataFiles');
const exportPersist = require('../public/export-persist');

// A saved run is mostly market context, about 20 KB a row. server.js also parses JSON bodies up to
// 5 MB before any route sees them, so this stays below that.
const RUNS_MAX_BYTES = 4 * 1024 * 1024;
const MAX_ROWS = 2000;
const MAX_HISTORY_ROWS = 400;

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STATION_NAME = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const RUN_ID = /^[A-Za-z][A-Za-z0-9]{0,31}-[A-Za-z][A-Za-z0-9]{0,31}-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[0-9a-f]{16}$/;

// An error that carries the HTTP status the route answers with.
class RunError extends Error {
	constructor(status, message) {
		super(message);
		this.name = 'RunError';
		this.status = status;
	}
}
const bad = (detail) => new RunError(400, detail);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const needObject = (value, at) => {
	if (!isObject(value)) throw bad(`${at} must be an object`);
	return value;
};
const needArray = (value, at, max) => {
	if (!Array.isArray(value)) throw bad(`${at} must be an array`);
	if (value.length > max) throw bad(`${at} has more than ${max} entries`);
	return value;
};
const needNumber = (value, at) => {
	if (!isNumber(value)) throw bad(`${at} must be a number`);
	return value;
};
const needNumberOrNull = (value, at) => {
	if (value !== null && !isNumber(value)) throw bad(`${at} must be a number or null`);
	return value;
};
const needInt = (value, at, min, max = Number.MAX_SAFE_INTEGER) => {
	if (!Number.isSafeInteger(value) || value < min || value > max) throw bad(`${at} must be an integer from ${min} to ${max}`);
	return value;
};
const needText = (value, at, max) => {
	if (typeof value !== 'string' || value === '' || value.length > max) throw bad(`${at} must be a text of 1 to ${max} characters`);
	return value;
};
// toISOString() output, and a real date (not 2026-02-31).
const needStamp = (value, at) => {
	if (typeof value !== 'string' || !STAMP.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
		throw bad(`${at} must be an ISO time stamp like 2026-11-19T12:00:00.000Z`);
	}
	return value;
};

// A station name as the page's route selector spells it (Jita, Amarr, ...): it goes into the id.
const needStation = (value, at) => {
	if (typeof value !== 'string' || !STATION_NAME.test(value)) throw bad(`${at} must be a name of letters and digits`);
	return value;
};

// Fields of one order or history row: those named in `fields` that are present, typed.
const needFields = (value, at, fields) => {
	needObject(value, at);
	const out = {};
	for (const [key, type] of Object.entries(fields)) {
		if (value[key] === undefined) continue;
		if (type === 'number') out[key] = needNumber(value[key], `${at}.${key}`);
		else out[key] = needText(value[key], `${at}.${key}`, 64);
	}
	return out;
};
const needBookSide = (value, at) => needArray(value, at, exportPersist.BOOK_DEPTH)
	.map((order, i) => needFields(order, `${at}[${i}]`, exportPersist.ORDER_FIELDS));
const needBook = (value, at) => {
	needObject(value, at);
	return { sell: needBookSide(value.sell, `${at}.sell`), buy: needBookSide(value.buy, `${at}.buy`) };
};

// The body of a POST as the run it describes, or a RunError (400). Only the known fields come
// through; `id`, `lastCopiedAt` and `copyCount` are the server's to set.
const sanitizeRun = (body) => {
	needObject(body, 'body');
	const copiedAt = needStamp(body.copiedAt, 'copiedAt');
	const reportGeneratedAt = needStamp(body.reportGeneratedAt, 'reportGeneratedAt');

	const route = needObject(body.route, 'route');
	const cleanRoute = {
		start: needStation(route.start, 'route.start'),
		end: needStation(route.end, 'route.end'),
	};
	for (const key of exportPersist.ROUTE_ID_FIELDS) cleanRoute[key] = needInt(route[key], `route.${key}`, 1);

	const horizonDays = needInt(body.horizonDays, 'horizonDays', 1, 3650);
	const config = needObject(body.config, 'config');
	const cleanConfig = {};
	for (const key of exportPersist.CONFIG_FIELDS) cleanConfig[key] = needNumber(config[key], `config.${key}`);

	const rows = needArray(body.rows, 'rows', MAX_ROWS);
	if (rows.length === 0) throw bad('rows must not be empty');
	const seen = new Set();
	const cleanRows = rows.map((row, i) => {
		const at = `rows[${i}]`;
		needObject(row, at);
		const typeId = needInt(row.typeId, `${at}.typeId`, 1);
		if (seen.has(typeId)) throw bad(`${at}.typeId ${typeId} is listed twice`);
		seen.add(typeId);
		const clean = {
			typeId,
			name: needText(row.name, `${at}.name`, 200),
			m3: needNumberOrNull(row.m3, `${at}.m3`),
			qty: needInt(row.qty, `${at}.qty`, 1),
			factor: needNumber(row.factor, `${at}.factor`),
			recommended: needInt(row.recommended, `${at}.recommended`, 0),
		};
		if (clean.factor < 0) throw bad(`${at}.factor must not be negative`);
		for (const key of exportPersist.PREDICTION_FIELDS) clean[key] = needNumberOrNull(row[key], `${at}.${key}`);
		return clean;
	});

	const totals = needObject(body.totals, 'totals');
	const cleanTotals = {};
	for (const key of ['costMil', 'revenueMil', 'profitMil', 'km3']) cleanTotals[key] = needNumber(totals[key], `totals.${key}`);

	// The market context of every copied row, and of nothing else.
	const context = needObject(body.context, 'context');
	for (const key of Object.keys(context)) {
		if (!seen.has(Number(key)) || String(Number(key)) !== key) throw bad(`context.${key} is not a copied row`);
	}
	const cleanContext = {};
	for (const row of cleanRows) {
		const at = `context.${row.typeId}`;
		const entry = needObject(context[row.typeId], at);
		cleanContext[row.typeId] = {
			src: needBook(entry.src, `${at}.src`),
			dest: needBook(entry.dest, `${at}.dest`),
			history: needArray(entry.history, `${at}.history`, MAX_HISTORY_ROWS)
				.map((day, i) => needFields(day, `${at}.history[${i}]`, exportPersist.HISTORY_FIELDS)),
		};
	}

	return { copiedAt, reportGeneratedAt, route: cleanRoute, horizonDays, config: cleanConfig, rows: cleanRows, totals: cleanTotals, context: cleanContext };
};

const laterOf = (a, b) => (Date.parse(b) > Date.parse(a) ? b : a);

// options: {dataDir, log}. Nothing touches the disk until a save or a list.
const createRunStore = ({ dataDir, log = console }) => {
	const dir = path.join(path.resolve(dataDir), 'runs');
	const fileOf = (id) => {
		if (!RUN_ID.test(id)) throw new Error('run store: bad run id');
		return path.join(dir, `${id}.json`);
	};

	// Saves the run a POST describes. Answers {id, created, copyCount, lastCopiedAt}: `created` is
	// false when the same orders were copied before (the file only has its counters bumped).
	// Throws RunError for a body that is not a run (400) or is too big (413), anything else for
	// a disk problem.
	const save = async (body) => {
		const run = sanitizeRun(body);
		const id = await exportPersist.runId(run);
		if (body.id !== id) throw bad(`id does not match the content (expected ${id})`);
		const file = fileOf(id);

		// From here on nothing awaits, so two posts of one id cannot interleave their read and write.
		const existing = readJsonFile(file);
		if (existing !== null) {
			const copyCount = Number.isSafeInteger(existing.copyCount) && existing.copyCount >= 1 ? existing.copyCount + 1 : 2;
			const lastCopiedAt = laterOf(existing.lastCopiedAt || existing.copiedAt, run.copiedAt);
			writeFileAtomic(file, JSON.stringify({ ...existing, lastCopiedAt, copyCount }) + '\n');
			return { id, created: false, copyCount, lastCopiedAt };
		}
		const saved = {
			id,
			copiedAt: run.copiedAt,
			reportGeneratedAt: run.reportGeneratedAt,
			route: run.route,
			horizonDays: run.horizonDays,
			config: run.config,
			rows: run.rows,
			totals: run.totals,
			lastCopiedAt: run.copiedAt,
			copyCount: 1,
			context: run.context,
		};
		const text = JSON.stringify(saved) + '\n';
		if (Buffer.byteLength(text) > RUNS_MAX_BYTES) throw new RunError(413, 'run too large');
		writeFileAtomic(file, text);
		return { id, created: true, copyCount: 1, lastCopiedAt: run.copiedAt };
	};

	// Every saved run, the most recently copied first. `context` (the market books, the bulk of a
	// file) is left out unless asked for. A file that does not parse is logged and skipped.
	const list = ({ context = false } = {}) => {
		let names = [];
		try {
			names = fs.readdirSync(dir);
		} catch (e) {
			if (e.code !== 'ENOENT') throw e;
		}
		const runs = [];
		for (const name of names) {
			if (!name.endsWith('.json') || !RUN_ID.test(name.slice(0, -'.json'.length))) continue;
			let run = null;
			try {
				run = readJsonFile(path.join(dir, name));
			} catch (e) {
				log.warn(`runs: ${name} is unreadable (${e.message}); skipped`);
				continue;
			}
			if (!isObject(run) || typeof run.id !== 'string') continue;
			if (!context) {
				const { context: omitted, ...rest } = run;
				run = rest;
			}
			runs.push(run);
		}
		const copied = (run) => Date.parse(run.lastCopiedAt || run.copiedAt) || 0;
		return runs.sort((a, b) => copied(b) - copied(a) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
	};

	return { dir, save, list };
};

module.exports = { createRunStore, sanitizeRun, RunError, RUNS_MAX_BYTES, MAX_ROWS };
