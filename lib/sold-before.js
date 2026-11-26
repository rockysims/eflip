// sold-before.js: what the linked characters sold of each type at one station in the last N days,
// for the export page's "sold before" column (planning/2026-11-25-export-history-columns, M3). A fact
// about our own trades, not an estimate: it reads the ledger and calls no ESI.
//
// Three figures come from the wallet transactions alone, the same way for every type: the units sold,
// the number of sales and the time of the latest one. A sale is a sell transaction of a linked
// character at the station, inside the window, to someone outside the linked pool and not a
// corporation's (the scope of public/results-calc.js, "Profit accounting rules" 1).
//
// Two more come from results-calc.js `compute` run on the pooled ledgers, the same call the results
// page makes with the route source -> station and a window of the last N days: the realized net
// margin per unit (profit / units over the sales FIFO matched to a bought lot: sale price less sales
// tax, broker fees, haul and the buy fee, against the lot's price) and the median days on market
// (each matched sale's days since its unit was listed at the station, else since it arrived there,
// weighted by the units). When `compute` cannot run, or a type has no matched sale, they are null.
const resultsCalc = require('../public/results-calc.js');

const DAY_MS = 24 * 60 * 60 * 1000;
// results.html reads snapshots from this long before the window starts (results-shared.js)
const SNAPSHOT_MARGIN_DAYS = 7;

const isoSeconds = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const round = (value, digits) => {
	const k = 10 ** digits;
	return Math.round(value * k) / k;
};

// The median of [{value, weight}] by weight: the first value at which the running weight reaches half
// the total, or the middle of that one and the next when it lands exactly on half.
const weightedMedian = (items) => {
	const sorted = items.filter(item => item.weight > 0).sort((a, b) => a.value - b.value);
	if (sorted.length === 0) return null;
	const total = sorted.reduce((sum, item) => sum + item.weight, 0);
	let running = 0;
	for (let i = 0; i < sorted.length; i++) {
		running += sorted[i].weight;
		if (running > total / 2) return sorted[i].value;
		if (running === total / 2) return (sorted[i].value + sorted[i + 1].value) / 2;
	}
	return sorted[sorted.length - 1].value;
};

// Reads what `soldBeforeByType` needs: every character's ledger (all history: FIFO needs the buys the
// sales in the window drew on), their snapshots from a week before the window (the newest one when
// there is none), and the saved runs (their rows' packaged volumes split a courier's cost by volume).
// `ledger` is lib/ledger.js createLedger, `runs` lib/runs.js createRunStore.
const readInputs = ({ ledger, runs, characterIds, sinceMs }) => {
	const ledgers = {};
	const snapshots = {};
	for (const id of characterIds) {
		ledgers[id] = ledger.readAll(id);
		let snaps = ledger.readSnapshots(id, { since: sinceMs - SNAPSHOT_MARGIN_DAYS * DAY_MS });
		if (snaps.length === 0) {
			const newest = ledger.latestSnapshot(id);
			snaps = newest ? [newest] : [];
		}
		snapshots[id] = snaps;
	}
	const savedRuns = runs.list();
	const m3 = {};
	for (const run of savedRuns) {
		for (const row of run.rows || []) {
			if (typeof row.m3 === 'number' && row.m3 > 0 && m3[row.typeId] === undefined) m3[row.typeId] = row.m3;
		}
	}
	return { ledgers, snapshots, runs: savedRuns, m3 };
};

// {<typeId>: {units, sales, lastSoldAt, netMarginMilPerUnit, medianDaysOnMarket}} for every type the
// linked characters sold at `stationId` in the `days` days up to `nowMs`; a type with no sale is
// absent. `sourceStationId` (or null) is the route's start: with it the couriers that carried the
// stock to the station are found, so the haul cost is in the margin; without it the margin leaves the
// haul out. `log` (optional) takes one warning when `compute` fails: the two figures it makes are then
// null and the answer still stands.
const soldBeforeByType = ({ ledgers, snapshots = {}, runs = [], m3 = {}, stationId, sourceStationId = null, days, nowMs, log = null }) => {
	const ids = Object.keys(ledgers).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
	const pool = new Set(ids);
	const sinceMs = nowMs - days * DAY_MS;

	const answers = new Map();
	for (const id of ids) {
		const seen = new Set();
		for (const t of ledgers[id].transactions || []) {
			if (t.is_buy !== false || t.is_personal !== true || t.location_id !== stationId || pool.has(t.client_id)) continue;
			const ms = Date.parse(t.date);
			if (!Number.isFinite(ms) || ms < sinceMs || ms > nowMs) continue;
			if (seen.has(t.transaction_id)) continue;
			seen.add(t.transaction_id);
			let entry = answers.get(t.type_id);
			if (!entry) {
				answers.set(t.type_id, entry = { units: 0, sales: 0, lastSoldMs: -Infinity, margin: null, days: null });
			}
			entry.units += t.quantity;
			entry.sales += 1;
			if (ms > entry.lastSoldMs) entry.lastSoldMs = ms;
		}
	}
	if (answers.size === 0) return {};

	// the realized margin and days on market, from the same facts the results page charts
	try {
		const input = {
			characterIds: ids,
			ledgers: Object.fromEntries(ids.map(id => {
				const snaps = snapshots[id] || [];
				const newest = snaps.length > 0 ? snaps[snaps.length - 1] : null;
				return [id, { ...ledgers[id], orders: newest ? newest.orders || [] : [], snapshots: snaps }];
			})),
			route: { startStationId: sourceStationId, endStationId: stationId },
			runs,
			m3,
			window: { since: sinceMs },
			now: nowMs
		};
		const rowsByType = new Map();
		for (const row of resultsCalc.compute(input).facts.sells) {
			if (!answers.has(row.typeId)) continue;
			if (!rowsByType.has(row.typeId)) rowsByType.set(row.typeId, []);
			rowsByType.get(row.typeId).push(row);
		}
		for (const [typeId, rows] of rowsByType) {
			const entry = answers.get(typeId);
			const units = rows.reduce((sum, row) => sum + row.qty, 0);
			if (units > 0) entry.margin = rows.reduce((sum, row) => sum + row.profit, 0) / units;
			entry.days = weightedMedian(rows.map(row => ({
				value: row.daysSinceListed !== null ? row.daysSinceListed : row.daysSinceArrived,
				weight: row.qty
			})).filter(item => item.value !== null && item.value !== undefined));
		}
	} catch (e) {
		if (log) log.warn(`sold before: the net margin and days on market could not be worked out: ${e.message}`);
	}

	const out = {};
	for (const typeId of [...answers.keys()].sort((a, b) => a - b)) {
		const entry = answers.get(typeId);
		out[typeId] = {
			units: entry.units,
			sales: entry.sales,
			lastSoldAt: isoSeconds(entry.lastSoldMs),
			netMarginMilPerUnit: entry.margin === null ? null : round(entry.margin / 1e6, 6),
			medianDaysOnMarket: entry.days === null ? null : round(entry.days, 3)
		};
	}
	return out;
};

module.exports = { soldBeforeByType, readInputs, weightedMedian, SNAPSHOT_MARGIN_DAYS };
