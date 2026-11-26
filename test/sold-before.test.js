const test = require('node:test');
const assert = require('node:assert/strict');
const { soldBeforeByType, weightedMedian } = require('../lib/sold-before');
const resultsCalc = require('../public/results-calc.js');
const { buildLedgers, EXPECTED, IVAN, GRANT, JITA, AMARR, NOW_MS, DAYS } = require('../test-support/sold-before-fixture');

// planning/2026-11-25-export-history-columns, M3: what the linked characters sold at one station in the
// last N days (lib/sold-before.js). The fixture and its hand-worked figures are in
// test-support/sold-before-fixture.js.

const DAY = 24 * 60 * 60 * 1000;
const makeLog = () => {
	const warnings = [];
	return { warnings, warn: (line) => warnings.push(line) };
};
const answer = (over = {}) => {
	const { ledgers, snapshots } = buildLedgers();
	return soldBeforeByType({ ledgers, snapshots, stationId: AMARR, sourceStationId: JITA, days: DAYS, nowMs: NOW_MS, ...over });
};

test('the fixture: units, sales and the last sale from the transactions, margin and days on market from the results accounting', () => {
	const log = makeLog();
	const out = answer({ log });
	assert.deepEqual(out, EXPECTED);
	assert.deepEqual(Object.keys(out), ['34', '36'], 'no type with only a buy, a sale elsewhere, a sale inside the pool or a corporation sale');
	assert.deepEqual(Object.keys(out[34]), ['units', 'sales', 'lastSoldAt', 'netMarginMilPerUnit', 'medianDaysOnMarket']);
	assert.deepEqual(log.warnings, []);
});

test('the margin and the days are the facts the results page charts: results-calc over the same ledgers, window and route', () => {
	const { ledgers, snapshots } = buildLedgers();
	const result = resultsCalc.compute({
		characterIds: [IVAN, GRANT],
		ledgers: Object.fromEntries(Object.entries(ledgers).map(([id, led]) => [id, { ...led, orders: snapshots[id].length > 0 ? snapshots[id][0].orders : [], snapshots: snapshots[id] }])),
		route: { startStationId: JITA, endStationId: AMARR },
		window: { since: NOW_MS - DAYS * DAY },
		now: NOW_MS
	});
	const rows = result.facts.sells.filter(row => row.typeId === 34);
	assert.equal(rows.reduce((sum, row) => sum + row.qty, 0), EXPECTED[34].units, 'every unit was matched to a lot');
	assert.equal(rows.reduce((sum, row) => sum + row.profit, 0) / 15 / 1e6, EXPECTED[34].netMarginMilPerUnit);
	assert.deepEqual(result.uncoveredSells.map(u => [u.typeId, u.qty]), [[36, 4]], 'the unmatched sale is what the transactions alone count');
	assert.equal(answer()[36].units, 4);
});

test('the window: a sale at its opening second and at now count, one second before or after does not; days narrow it', () => {
	const sale = (date, over = {}) => ({ client_id: 1, date, is_buy: false, is_personal: true, journal_ref_id: 0, location_id: AMARR, quantity: 1, transaction_id: Math.round(Date.parse(date) / 1000), type_id: 34, unit_price: 100, ...over });
	const since = new Date(NOW_MS - 10 * DAY).toISOString().replace('.000Z', 'Z');
	const now = new Date(NOW_MS).toISOString().replace('.000Z', 'Z');
	const early = new Date(NOW_MS - 10 * DAY - 1000).toISOString().replace('.000Z', 'Z');
	const late = new Date(NOW_MS + 1000).toISOString().replace('.000Z', 'Z');
	const ledgers = { [IVAN]: { transactions: [sale(since), sale(now), sale(early), sale(late)] } };
	const out = soldBeforeByType({ ledgers, stationId: AMARR, days: 10, nowMs: NOW_MS });
	assert.equal(out[34].units, 2);
	assert.equal(out[34].lastSoldAt, now);
	assert.equal(soldBeforeByType({ ledgers, stationId: AMARR, days: 9, nowMs: NOW_MS })[34].units, 1);
	assert.deepEqual(soldBeforeByType({ ledgers, stationId: JITA, days: 10, nowMs: NOW_MS }), {}, 'another station');
	assert.deepEqual(soldBeforeByType({ ledgers: {}, stationId: AMARR, days: 10, nowMs: NOW_MS }), {}, 'no characters');
	assert.deepEqual(soldBeforeByType({ ledgers: { [IVAN]: {} }, stationId: AMARR, days: 10, nowMs: NOW_MS }), {}, 'a ledger with no rows');
});

test('the same sale in a character\'s ledger twice counts once; the same transaction id of two characters counts for each', () => {
	const sale = (id) => ({ client_id: 1, date: '2026-11-19T10:00:00Z', is_buy: false, is_personal: true, journal_ref_id: 0, location_id: AMARR, quantity: 2, transaction_id: id, type_id: 34, unit_price: 100 });
	const out = soldBeforeByType({ ledgers: { [IVAN]: { transactions: [sale(1), sale(1)] }, [GRANT]: { transactions: [sale(1)] } }, stationId: AMARR, days: 5, nowMs: NOW_MS });
	assert.equal(out[34].units, 4);
	assert.equal(out[34].sales, 2);
});

test('the haul: with the route\'s source station the courier\'s cost is in the margin and its arrival dates the days on market; without it neither', () => {
	const issued = '2026-11-02T11:00:00Z';
	const ledgers = {
		[IVAN]: {
			transactions: [
				{ client_id: 1, date: '2026-11-02T10:00:00Z', is_buy: true, is_personal: true, journal_ref_id: 0, location_id: JITA, quantity: 6, transaction_id: 1, type_id: 34, unit_price: 100 },
				{ client_id: 2, date: '2026-11-10T10:00:00Z', is_buy: false, is_personal: true, journal_ref_id: 0, location_id: AMARR, quantity: 6, transaction_id: 2, type_id: 34, unit_price: 3000 }
			],
			journal: [
				{ id: 10, amount: -600, date: '2026-11-02T10:00:00Z', context_id: 1, context_id_type: 'market_transaction_id', ref_type: 'market_escrow', first_party_id: IVAN, second_party_id: IVAN },
				{ id: 20, amount: 18000, date: '2026-11-10T10:00:00Z', context_id: 2, context_id_type: 'market_transaction_id', ref_type: 'market_transaction', first_party_id: 2, second_party_id: IVAN },
				{ id: 21, amount: -1350, date: '2026-11-10T10:00:00Z', ref_type: 'transaction_tax', first_party_id: IVAN, second_party_id: 1000132 },
				{ id: 30, amount: -6000, date: issued, context_id: 500, context_id_type: 'contract_id', ref_type: 'contract_reward_deposited', first_party_id: IVAN, second_party_id: 1000132 }
			],
			ordersHistory: [],
			contracts: [{
				acceptor_id: 3, assignee_id: 0, availability: 'public', collateral: 0, contract_id: 500, date_accepted: '2026-11-02T11:05:00Z', date_completed: '2026-11-02T14:00:00Z',
				date_expired: '2026-11-09T11:00:00Z', date_issued: issued, days_to_complete: 1, end_location_id: AMARR, for_corporation: false, issuer_corporation_id: 1, issuer_id: IVAN,
				price: 0, reward: 6000, start_location_id: JITA, status: 'finished', title: '', type: 'courier', volume: 6
			}],
			contractItems: { 500: [{ is_included: true, is_singleton: false, quantity: 6, record_id: 1, type_id: 34 }] }
		}
	};
	const base = { ledgers, stationId: AMARR, days: DAYS, nowMs: NOW_MS };
	const withSource = soldBeforeByType({ ...base, sourceStationId: JITA })[34];
	// 3000 - 7.5% tax (225) - 100 bought - 1000 haul (6000 over 6 units); on the market since the courier arrived: 7 days 20 hours
	assert.equal(withSource.netMarginMilPerUnit, 0.001675);
	assert.equal(withSource.medianDaysOnMarket, 7.833);
	const without = soldBeforeByType({ ...base, sourceStationId: null })[34];
	assert.equal(without.netMarginMilPerUnit, 0.002675, 'no source station: no courier found, no haul in the margin');
	assert.equal(without.medianDaysOnMarket, null);
	assert.deepEqual([without.units, without.sales], [withSource.units, withSource.sales]);
});

test('when the results accounting cannot run, the transactions\' figures stand, the other two are null, and one warning says so', () => {
	const log = makeLog();
	const { ledgers } = buildLedgers();
	ledgers[IVAN].contracts = [null]; // compute() cannot read this
	const out = soldBeforeByType({ ledgers, stationId: AMARR, sourceStationId: JITA, days: DAYS, nowMs: NOW_MS, log });
	assert.deepEqual(out[34], { units: 15, sales: 2, lastSoldAt: '2026-11-19T10:00:00Z', netMarginMilPerUnit: null, medianDaysOnMarket: null });
	assert.equal(out[36].units, 4);
	assert.equal(log.warnings.length, 1);
	assert.match(log.warnings[0], /^sold before: the net margin and days on market could not be worked out: /);
	assert.doesNotThrow(() => soldBeforeByType({ ledgers, stationId: AMARR, days: DAYS, nowMs: NOW_MS }), 'with no log to warn to');
});

test('weightedMedian: by weight, the middle of two at exactly half, null for nothing', () => {
	assert.equal(weightedMedian([]), null);
	assert.equal(weightedMedian([{ value: 5, weight: 0 }]), null);
	assert.equal(weightedMedian([{ value: 5, weight: 1 }]), 5);
	assert.equal(weightedMedian([{ value: 9, weight: 5 }, { value: 8, weight: 10 }]), 8, 'ten units at 8 days outweigh five at 9');
	assert.equal(weightedMedian([{ value: 1, weight: 1 }, { value: 3, weight: 1 }]), 2, 'exactly half: the middle of the two');
	assert.equal(weightedMedian([{ value: 1, weight: 1 }, { value: 2, weight: 1 }, { value: 10, weight: 1 }]), 2);
	assert.equal(weightedMedian([{ value: 7, weight: 3 }, { value: 1, weight: 1 }, { value: 4, weight: 1 }]), 7);
});
