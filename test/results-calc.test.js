// Phase 4 of docs/trade-results-plan.md: the pure profit accounting in public/results-calc.js.
// Fixtures are hand-written and anonymised, shaped like the live samples of 2026-11-19 (ESI field
// names and types per route, the journal/contract quirks listed under "Gotchas").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const resultsCalc = require('../public/results-calc.js');

const { compute } = resultsCalc;
const { pickBatchesByVolume, assignByGap } = resultsCalc._internal;

// Characters: the buyer (hands goods over at the source) and the seller (couriers and sells them).
const BUYER = 91000001;
const SELLER = 91000002;
const SELLER_2 = 91000003; // a second selling character, linked only where a test says so
const HAULER_A = 93000001;
const HAULER_B = 93000002;
const OUTSIDER = 93000009;
const CLIENT = 94000001; // market counterparty
const BROKER_NPC = 1000035;
const SCC = 1000132;
// Stations: source, destination, somewhere else; regions of the first two.
const S = 60003760;
const D = 60008494;
const ELSEWHERE = 60011866;
const S_REGION_STATION = 60003001; // another station in the source region
const REGION_S = 10000002;
const REGION_D = 10000043;
// Types, with packaged m3.
const T1 = 501;
const T2 = 502;
const T3 = 503;
const CONTAINER = 3465;
const M3 = { [T1]: 1, [T2]: 10, [T3]: 5 };
const ROUTE = { startStationId: S, endStationId: D, startRegionId: REGION_S, endRegionId: REGION_D };

const at = (s) => `2026-${s}Z`;
const NOW = at('11-25T00:00:00');
const DAY = 24 * 60 * 60 * 1000;
const approx = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} !== ${expected} (±${eps})`);
const plusMinutes = (iso, minutes) => new Date(Date.parse(iso) + minutes * 60000).toISOString().replace('.000Z', 'Z');

// Builds per-character ledgers the way lib/ledger.js readAll() returns them, plus snapshots.
// `extraLinked`: characters linked besides the buyer and the seller.
const makeFixture = ({ extraLinked = [] } = {}) => {
	const next = { tx: 7000000000, j: 26000000000, order: 7400000000, contract: 238000000, record: 5370000000, item: 1030000000000 };
	const ledgers = {};
	const led = (c) => ledgers[c] || (ledgers[c] = { transactions: [], journal: [], ordersHistory: [], contracts: [], contractItems: {}, snapshots: [] });
	led(BUYER);
	led(SELLER);
	for (const c of extraLinked) led(c);
	const linked = (c) => c === BUYER || c === SELLER || extraLinked.includes(c);
	const f = { ledgers, next, led };

	f.row = (c, row) => {
		const { id, ...rest } = row;
		const r = { id: id !== undefined ? id : (next.j += 10), balance: 0, description: '', reason: '', ...rest };
		if (r.id > next.j) next.j = r.id;
		led(c).journal.push(r);
		return r;
	};
	// A buy: the transaction, and its only journal footprint, a negative market_escrow row.
	f.buy = (c, { type, qty, price, date, loc = S, client = CLIENT, personal = true, escrowAmount }) => {
		const tx = { client_id: client, date, is_buy: true, is_personal: personal, journal_ref_id: 0, location_id: loc, quantity: qty, transaction_id: ++next.tx, type_id: type, unit_price: price };
		const esc = f.row(c, {
			amount: escrowAmount !== undefined ? escrowAmount : -price * qty, context_id: tx.transaction_id, context_id_type: 'market_transaction_id',
			date, description: 'Market escrow release', first_party_id: c, second_party_id: c, ref_type: 'market_escrow'
		});
		tx.journal_ref_id = esc.id;
		led(c).transactions.push(tx);
		return tx;
	};
	// A sell: the transaction, its market_transaction row (context_id = transaction_id) and its
	// transaction_tax row (no context_id; id = market row id + 1 unless told otherwise).
	f.sell = (c, { type, qty, price, date, loc = D, client = CLIENT, rate = 0.075, tax, taxDate, mtId, taxId, noTax = false, personal = true }) => {
		const tx = { client_id: client, date, is_buy: false, is_personal: personal, journal_ref_id: 0, location_id: loc, quantity: qty, transaction_id: ++next.tx, type_id: type, unit_price: price };
		const mt = f.row(c, {
			id: mtId, amount: price * qty, context_id: tx.transaction_id, context_id_type: 'market_transaction_id',
			date, description: 'Market: someone bought stuff', first_party_id: client, second_party_id: c, ref_type: 'market_transaction'
		});
		tx.journal_ref_id = mt.id + 2; // points two ids past its row, as for most live sells
		let taxRow = null;
		if (!noTax) {
			taxRow = f.row(c, {
				id: taxId !== undefined ? taxId : mt.id + 1, amount: -(tax !== undefined ? tax : price * qty * rate),
				date: taxDate || date, description: 'Sales tax paid to the SCC', first_party_id: c, second_party_id: SCC, ref_type: 'transaction_tax'
			});
		}
		led(c).transactions.push(tx);
		return { tx, mt, taxRow };
	};
	f.fee = (c, { date, amount }) => f.row(c, { amount: -amount, date, description: 'Market order commission', first_party_id: c, second_party_id: BROKER_NPC, ref_type: 'brokers_fee' });
	// Orders as ESI sends them: sell orders omit is_buy_order, escrow and min_volume.
	f.orderRow = ({ type, price, total, remain = 0, issued, duration = 90, buy = false, loc, region, range, orderId }) => {
		const o = {
			duration, is_corporation: false, issued, location_id: loc !== undefined ? loc : (buy ? S : D), order_id: orderId || ++next.order,
			price, range: range || (buy ? 'station' : 'region'), region_id: region || (buy ? REGION_S : REGION_D), type_id: type,
			volume_remain: remain, volume_total: total
		};
		if (buy) Object.assign(o, { escrow: 0, is_buy_order: true, min_volume: 1 });
		return o;
	};
	f.history = (c, spec) => {
		const o = { ...f.orderRow(spec), state: spec.state || 'expired' };
		led(c).ordersHistory.push(o);
		return o;
	};
	f.snapshot = (c, { syncedAt, orders = [], assets = [], balance = 0 }) => {
		led(c).snapshots.push({ syncedAt, orders, assets, balance });
	};
	f.asset = ({ type, qty, loc, locType = 'station', itemId }) => ({
		is_singleton: false, item_id: itemId || ++next.item, location_flag: 'Hangar', location_id: loc, location_type: locType, quantity: qty, type_id: type
	});
	const itemsOf = (list) => list.map(([type, qty, included = true]) => ({ is_included: included, is_singleton: false, quantity: qty, record_id: ++next.record, type_id: type }));
	const contractBase = (issued) => ({
		acceptor_id: 0, assignee_id: 0, availability: 'personal', collateral: 0, contract_id: ++next.contract,
		date_expired: plusMinutes(issued, 7 * 24 * 60), date_issued: issued, days_to_complete: 0, end_location_id: S,
		for_corporation: false, issuer_corporation_id: 1000115, issuer_id: 0, price: 0, reward: 0, start_location_id: S,
		status: 'finished', title: '', type: 'item_exchange', volume: 0
	});
	// The hand-off: an item exchange from the buyer to the seller, in both ledgers. The issuer pays
	// the broker fee; on acceptance the price moves from the assignee to the issuer (internal).
	f.handoff = ({ from = BUYER, to = SELLER, issued, status = 'finished', items, volume, price = 1000000, brokerFee = 10000, loc = S }) => {
		const finished = status === 'finished';
		const list = itemsOf(items);
		const c = {
			...contractBase(issued), issuer_id: from, assignee_id: to, acceptor_id: finished ? to : 0, price, status,
			start_location_id: loc, end_location_id: loc,
			volume: volume !== undefined ? volume : list.filter(i => i.is_included).reduce((acc, i) => acc + i.quantity * (M3[i.type_id] || 1), 0)
		};
		if (finished) Object.assign(c, { date_accepted: plusMinutes(issued, 1), date_completed: plusMinutes(issued, 1) });
		for (const who of [from, to]) {
			if (!linked(who)) continue;
			led(who).contracts.push(c);
			led(who).contractItems[String(c.contract_id)] = list;
		}
		if (brokerFee) f.row(from, { amount: -brokerFee, context_id: c.contract_id, context_id_type: 'contract_id', date: issued, first_party_id: from, second_party_id: SCC, ref_type: 'contract_brokers_fee' });
		if (finished) {
			const priceId = next.j += 10;
			f.row(from, { id: priceId, amount: price, context_id: c.contract_id, context_id_type: 'contract_id', date: c.date_accepted, first_party_id: to, second_party_id: from, ref_type: 'contract_price' });
			f.row(to, { id: priceId, amount: -price, context_id: c.contract_id, context_id_type: 'contract_id', date: c.date_accepted, first_party_id: to, second_party_id: from, ref_type: 'contract_price' });
		}
		return c;
	};
	// A courier issued by a linked character. Issuer-side rows: reward deposited, deposit and broker
	// fee at issue; the deposit comes back on delivery; the reward comes back on deletion.
	f.courier = ({ issuer = SELLER, issued, accepted, completed, status = 'finished', reward = 1000000, volume = 0, acceptor = HAULER_A, items = [], start = S, end = D, deposit = 10000, brokerFee = 11000, refundAt }) => {
		const c = {
			...contractBase(issued), type: 'courier', availability: 'public', issuer_id: issuer, acceptor_id: accepted ? acceptor : 0,
			collateral: 50000000, days_to_complete: 1, reward, volume, start_location_id: start, end_location_id: end, status
		};
		if (accepted) c.date_accepted = accepted;
		if (completed) c.date_completed = completed;
		led(issuer).contracts.push(c);
		led(issuer).contractItems[String(c.contract_id)] = itemsOf(items);
		const r = (ref, amount, date) => f.row(issuer, { amount, context_id: c.contract_id, context_id_type: 'contract_id', date, first_party_id: issuer, second_party_id: SCC, ref_type: ref });
		if (reward) r('contract_reward_deposited', -reward, issued);
		if (deposit) r('contract_deposit', -deposit, issued);
		if (brokerFee) r('contract_brokers_fee', -brokerFee, issued);
		if (status === 'finished' && deposit) r('contract_deposit_refund', deposit, completed);
		if (status === 'deleted' && reward) r('contract_reward_refund', reward, refundAt || plusMinutes(issued, 30));
		return c;
	};
	// player_donation: payer first_party_id, receiver second_party_id; negative for the payer,
	// positive for the receiver; the same row id in both journals when both are linked.
	f.donate = (payer, receiver, { amount, date }) => {
		const id = next.j += 10;
		const base = { id, date, description: 'deposited cash', first_party_id: payer, second_party_id: receiver, ref_type: 'player_donation' };
		const rows = {};
		if (linked(payer)) rows.payer = f.row(payer, { ...base, amount: -amount });
		if (linked(receiver)) rows.receiver = f.row(receiver, { ...base, amount });
		return rows.payer || rows.receiver;
	};
	f.run = ({ id, copiedAt, rows, route = { start: 'Jita', end: 'Amarr', startStationId: S, endStationId: D } }) => ({
		id, copiedAt, reportGeneratedAt: copiedAt, route, horizonDays: 5,
		config: { SELL_TAX: 0.104, SALES_TAX: 0.08, BROKER_FEE: 0.024, HAULING_REWARD_FRACTION: 0.1, MIN_ROI: 1.5 },
		rows: rows.map(([typeId, qty, extra = {}]) => ({ typeId, name: `type ${typeId}`, m3: M3[typeId], qty, factor: 1, recommended: qty, ...extra })),
		totals: { costMil: 0, revenueMil: 0, profitMil: 0, km3: 0 }, lastCopiedAt: copiedAt, copyCount: 1, context: {}
	});
	f.compute = (extra = {}) => compute({ characterIds: [BUYER, SELLER, ...extraLinked], ledgers, route: ROUTE, m3: M3, now: NOW, ...extra });
	return f;
};

const typeRow = (r, typeId) => r.types.find(t => t.typeId === typeId);
const lotOf = (r, lotId) => r.facts.lots.find(l => l.lotId === String(lotId));
const feeOf = (r, id) => r.facts.fees.filter(x => x.id === id);

//--- FIFO (rule 3)

test('FIFO is pooled across both characters, oldest lot first, and leftover sold units are uncovered', () => {
	const f = makeFixture();
	const sellerLot = f.buy(SELLER, { type: T1, qty: 5, price: 120, date: at('11-01T09:00:00') });
	const buyerLot = f.buy(BUYER, { type: T1, qty: 10, price: 100, date: at('11-01T10:00:00') });
	const first = f.sell(SELLER, { type: T1, qty: 12, price: 200, date: at('11-05T12:00:00') });
	const second = f.sell(SELLER, { type: T1, qty: 8, price: 210, date: at('11-06T12:00:00') });
	const r = f.compute();

	assert.deepEqual(r.facts.sells.map(s => [s.sellTxId, s.lotId, s.qty]), [
		[first.tx.transaction_id, String(sellerLot.transaction_id), 5],
		[first.tx.transaction_id, String(buyerLot.transaction_id), 7],
		[second.tx.transaction_id, String(buyerLot.transaction_id), 3]
	]);
	assert.deepEqual(r.uncoveredSells.map(u => [u.sellTxId, u.qty]), [[second.tx.transaction_id, 5]]);
	const t1 = typeRow(r, T1);
	assert.equal(t1.soldQty, 15);
	assert.equal(t1.uncoveredQty, 5);
	assert.equal(t1.uncoveredGross, 5 * 210);
	// Uncovered units stay out of realized profit: gross, tax and COGS cover the 15 covered units.
	assert.equal(t1.gross, 12 * 200 + 3 * 210);
	approx(t1.tax, 2400 * 0.075 + 8 * 210 * 0.075 * 3 / 8);
	assert.equal(t1.cogs, 5 * 120 + 7 * 100 + 3 * 100);
	approx(t1.realizedProfit, 3030 - 227.25 - 1600);
	assert.ok(t1.flags.includes('uncovered'));
	assert.ok(t1.flags.includes('unarrived'), 'no courier carried these lots');
	assert.equal(lotOf(r, sellerLot.transaction_id).remainingQty, 0);
	assert.equal(lotOf(r, buyerLot.transaction_id).soldQty, 10);
});

test('FIFO takes lots that had arrived by the sale first, then falls back to any lot bought by then, flagged unarrived', () => {
	const f = makeFixture();
	const old = f.buy(BUYER, { type: T1, qty: 10, price: 100, date: at('11-01T10:00:00') });
	const fresh = f.buy(BUYER, { type: T1, qty: 6, price: 150, date: at('11-02T10:00:00') });
	const later = f.buy(BUYER, { type: T1, qty: 50, price: 90, date: at('11-04T00:00:00') }); // bought after both sales
	f.handoff({ issued: at('11-02T11:00:00'), items: [[T1, 6]], brokerFee: 0 });
	const k = f.courier({ issued: at('11-02T11:10:00'), accepted: at('11-02T11:15:00'), completed: at('11-02T14:00:00'), volume: 6, reward: 6000, deposit: 0, brokerFee: 0 });
	const early = f.sell(SELLER, { type: T1, qty: 1, price: 300, date: at('11-02T13:00:00') }); // before delivery
	const after = f.sell(SELLER, { type: T1, qty: 8, price: 300, date: at('11-03T12:00:00') });
	const r = f.compute();

	assert.deepEqual(r.facts.sells.map(s => [s.sellTxId, s.lotId, s.qty, s.unarrived]), [
		[early.tx.transaction_id, String(old.transaction_id), 1, true],
		[after.tx.transaction_id, String(fresh.transaction_id), 6, false],
		[after.tx.transaction_id, String(old.transaction_id), 2, true]
	]);
	const freshLot = lotOf(r, fresh.transaction_id);
	assert.equal(freshLot.courierId, k.contract_id);
	assert.equal(freshLot.arrivedAt, at('11-02T14:00:00'));
	approx(freshLot.haulPerUnit, 1000);
	assert.equal(lotOf(r, later.transaction_id).soldQty, 0);
	assert.equal(typeRow(r, T1).unarrivedQty, 3);
	assert.ok(typeRow(r, T1).flags.includes('unarrived'));
});

//--- sales tax (rule 4)

test('sales tax: same-second match, id-gap pairing when sells share a second, ±2 s fallback, est rate from the nearest matched sale', () => {
	const f = makeFixture();
	f.buy(SELLER, { type: T1, qty: 100, price: 1, date: at('11-01T00:00:00') });
	const a = f.sell(SELLER, { type: T1, qty: 1, price: 1000000, date: at('11-05T10:00:00'), rate: 0.075 });
	// Two sells in one second, both tax rows at their market row's id + 2: smallest-gap-first would cross them.
	const b = f.sell(SELLER, { type: T1, qty: 1, price: 2000000, date: at('11-12T11:00:00'), rate: 0.0375, mtId: 26100000100, taxId: 26100000102 });
	const c = f.sell(SELLER, { type: T1, qty: 1, price: 1000000, date: at('11-12T11:00:00'), rate: 0.0375, mtId: 26100000101, taxId: 26100000103 });
	// Two sells in one second, interleaved +1 rows (the common live case).
	const d = f.sell(SELLER, { type: T1, qty: 1, price: 3000000, date: at('11-13T11:00:00'), rate: 0.0375, mtId: 26100000200, taxId: 26100000201 });
	const e = f.sell(SELLER, { type: T1, qty: 1, price: 1000000, date: at('11-13T11:00:00'), rate: 0.0375, mtId: 26100000202, taxId: 26100000203 });
	// Tax row one second late: matched by the ±2 s / 1 % fallback.
	const late = f.sell(SELLER, { type: T1, qty: 1, price: 1000000, date: at('11-16T09:00:00'), rate: 0.021, taxDate: at('11-16T09:00:01') });
	// No tax row at all: estimated at the nearest matched rate in time (2.1 %, not the 3.75 % median, not SALES_TAX).
	const none = f.sell(SELLER, { type: T1, qty: 1, price: 500000, date: at('11-17T09:00:00'), noTax: true });
	// A tax row with no sale anywhere near it.
	const stray = f.row(SELLER, { amount: -999, date: at('11-18T00:00:00'), first_party_id: SELLER, second_party_id: SCC, ref_type: 'transaction_tax' });
	const r = f.compute();

	const taxBySell = new Map(r.facts.sells.map(s => [s.sellTxId, s]));
	const expect = [[a, 75000, false], [b, 75000, false], [c, 37500, false], [d, 112500, false], [e, 37500, false], [late, 21000, false], [none, 10500, true]];
	for (const [sale, tax, est] of expect) {
		const row = taxBySell.get(sale.tx.transaction_id);
		approx(row.tax, tax);
		assert.equal(row.taxEst, est);
	}
	const taxFees = r.facts.fees.filter(x => x.kind === 'salesTax');
	assert.equal(taxFees.length, 7);
	assert.equal(feeOf(r, b.taxRow.id)[0].sellTxId, b.tx.transaction_id);
	assert.equal(feeOf(r, c.taxRow.id)[0].sellTxId, c.tx.transaction_id);
	assert.equal(feeOf(r, b.taxRow.id)[0].match, 'idGap');
	assert.equal(feeOf(r, a.taxRow.id)[0].match, 'second');
	assert.equal(feeOf(r, late.taxRow.id)[0].match, 'near');
	const strayFee = feeOf(r, stray.id)[0];
	assert.equal(strayFee.sellTxId, null);
	assert.equal(strayFee.attributed, false);
	assert.ok(typeRow(r, T1).flags.includes('est'));
	approx(typeRow(r, T1).tax, 75000 + 75000 + 37500 + 112500 + 37500 + 21000 + 10500);
	// The stray row is the only unattributed journal flow.
	approx(r.crossCheck.unattributed, -999);
	approx(r.observedTaxRate, 0.021);
});

test('sales tax fallback: a late tax row with two sales near it goes to the one whose implied rate fits the expected rate', () => {
	const f = makeFixture();
	f.buy(SELLER, { type: T1, qty: 100, price: 1, date: at('11-01T00:00:00') });
	f.sell(SELLER, { type: T1, qty: 1, price: 1000000, date: at('11-10T00:00:00'), rate: 0.0375 });
	const big = f.sell(SELLER, { type: T1, qty: 1, price: 2000000, date: at('11-11T00:00:00'), noTax: true });
	const small = f.sell(SELLER, { type: T1, qty: 1, price: 1000000, date: at('11-11T00:00:01'), noTax: true });
	const late = f.row(SELLER, { amount: -37500, date: at('11-11T00:00:02'), first_party_id: SELLER, second_party_id: SCC, ref_type: 'transaction_tax' });
	const r = f.compute();
	assert.equal(feeOf(r, late.id)[0].sellTxId, small.tx.transaction_id);
	assert.equal(feeOf(r, late.id)[0].match, 'near');
	const bigRow = r.facts.sells.find(s => s.sellTxId === big.tx.transaction_id);
	assert.equal(bigRow.taxEst, true);
	approx(bigRow.tax, 75000);
});

test('assignByGap prefers the most pairs, then the smallest total gap', () => {
	const taxes = [{ id: 102 }, { id: 103 }];
	const sells = [{ mt: 100 }, { mt: 101 }];
	const gapOf = (t, s) => (t.id - s.mt >= 1 && t.id - s.mt <= 2 ? t.id - s.mt : null);
	assert.deepEqual(assignByGap(taxes, sells, gapOf), [[0, 0], [1, 1]]);
	assert.deepEqual(assignByGap([{ id: 101 }], sells, gapOf), [[0, 0]]);
});

//--- broker fees (rule 5, decision 2) and order states

const brokerFixture = () => {
	const f = makeFixture();
	f.buy(SELLER, { type: T1, qty: 10, price: 100, date: at('11-01T00:00:00') });
	f.buy(SELLER, { type: T2, qty: 5, price: 150, date: at('11-01T00:00:00') });
	// O1: listed 11-03 15:00 at 200, modified 11-04 09:30 to 190, then sold out (expired, volume_remain 0).
	const o1 = f.orderRow({ type: T1, price: 200, total: 10, remain: 10, issued: at('11-03T15:00:00') });
	f.snapshot(SELLER, { syncedAt: at('11-03T16:00:00'), orders: [o1] });
	const o1b = { ...o1, issued: at('11-04T09:30:00'), price: 190 };
	f.snapshot(SELLER, { syncedAt: at('11-04T10:00:00'), orders: [o1b] });
	f.led(SELLER).ordersHistory.push({ ...o1b, volume_remain: 0, state: 'expired' });
	// O3 ran out of time (keeps volume_remain); O4 was cancelled. No fee near either.
	const o3 = f.history(SELLER, { type: T1, price: 400, total: 10, remain: 4, issued: at('10-20T00:00:00') });
	const o4 = f.history(SELLER, { type: T2, price: 900, total: 5, remain: 5, issued: at('10-21T00:00:00'), state: 'cancelled' });
	// O2: an immediate sell (duration 0) - no broker fee, never a relist.
	const o2 = f.history(SELLER, { type: T2, price: 400, total: 5, remain: 0, issued: at('11-04T12:00:00'), duration: 0 });
	const listing = f.fee(SELLER, { date: at('11-03T15:00:01'), amount: 1000 });
	const relist = f.fee(SELLER, { date: at('11-04T09:30:00'), amount: 300 });
	const lonely = f.fee(SELLER, { date: at('11-04T05:00:00'), amount: 500 });
	const atImmediate = f.fee(SELLER, { date: at('11-04T12:00:00'), amount: 400 }); // same second as the immediate order
	const tooLate = f.fee(SELLER, { date: at('11-04T09:30:03'), amount: 300 }); // 3 s after O1's modification
	f.sell(SELLER, { type: T1, qty: 10, price: 200, date: at('11-04T11:00:00') });
	f.sell(SELLER, { type: T2, qty: 5, price: 400, date: at('11-04T12:00:00') });
	// Buy side: B1 filled (4 units at 50), B2 cancelled unfilled, B3 an immediate buy.
	const b1 = f.history(BUYER, { type: T3, price: 50, total: 4, remain: 0, issued: at('11-02T08:00:00'), duration: 1, buy: true });
	const b2 = f.history(BUYER, { type: T3, price: 45, total: 3, remain: 3, issued: at('11-02T10:00:00'), buy: true, state: 'cancelled' });
	const b3 = f.history(BUYER, { type: T3, price: 48, total: 2, remain: 0, issued: at('11-02T09:30:00'), duration: 0, buy: true });
	const b1Fee = f.fee(BUYER, { date: at('11-02T08:00:00'), amount: 20 });
	const b2Fee = f.fee(BUYER, { date: at('11-02T10:00:01'), amount: 30 });
	const filled = f.buy(BUYER, { type: T3, qty: 4, price: 50, date: at('11-02T09:00:00') });
	const fromBook = f.buy(BUYER, { type: T3, qty: 2, price: 48, date: at('11-02T09:30:00') });
	return { f, o1, o2, o3, o4, b1, b2, b3, listing, relist, lonely, atImmediate, tooLate, b1Fee, b2Fee, filled, fromBook };
};

test('broker fees: time-matched listing and relist, buy-order fees per filled unit, unfilled buy orders, pro-rata remainder flagged est', () => {
	const x = brokerFixture();
	const r = x.f.compute();

	assert.equal(feeOf(r, x.listing.id)[0].kind, 'listing');
	assert.equal(feeOf(r, x.listing.id)[0].orderId, x.o1.order_id);
	assert.equal(feeOf(r, x.relist.id)[0].kind, 'relist');
	// Not matched: a fee near nothing; a fee in the very second of an immediate order (immediate orders
	// pay none); a fee 3 s from an order's `issued` (the window is 2 s, rule 5b).
	for (const row of [x.lonely, x.atImmediate, x.tooLate]) {
		const fee = feeOf(r, row.id)[0];
		assert.equal(fee.kind, 'brokerRemainder');
		assert.equal(fee.est, true);
	}
	// Remainder spread by gross sell value at D in the window: 2000 of T1 and 2000 of T2.
	assert.deepEqual(feeOf(r, x.lonely.id)[0].split, [{ typeId: T1, amount: 250 }, { typeId: T2, amount: 250 }]);
	const t1 = typeRow(r, T1);
	assert.equal(t1.brokerListing, 1000);
	assert.equal(t1.brokerRelist, 300);
	approx(t1.brokerEst, (500 + 400 + 300) / 2);
	approx(t1.broker, 1000 + 300 + 600);
	assert.ok(t1.flags.includes('est'));
	approx(typeRow(r, T2).brokerEst, 600);
	assert.equal(typeRow(r, T2).brokerListing, 0);

	// Buy side: the filled order's fee goes per unit onto the lots it filled; a buy from the book pays none.
	assert.equal(feeOf(r, x.b1Fee.id)[0].kind, 'buyOrder');
	approx(lotOf(r, x.filled.transaction_id).buyFeePerUnit, 5);
	assert.equal(lotOf(r, x.filled.transaction_id).buyOrderId, x.b1.order_id);
	assert.equal(lotOf(r, x.fromBook.transaction_id).buyFeePerUnit, 0);
	assert.equal(feeOf(r, x.b2Fee.id)[0].kind, 'buyOrderUnfilled');
	assert.equal(typeRow(r, T3).brokerBuyUnfilled, 30);

	// The sells rows carry the whole type broker cost.
	const t1Sells = r.facts.sells.filter(s => s.typeId === T1);
	approx(t1Sells.reduce((acc, s) => acc + s.brokerShare + s.relistShare, 0), 1900);
});

test('order states: filled = expired with volume_remain 0, ran out = keeps volume_remain, cancelled; immediate orders are skipped; missing is_buy_order means sell', () => {
	const x = brokerFixture();
	const r = x.f.compute();
	const relist = (o) => r.facts.relists.find(e => e.orderId === o.order_id);

	const o1 = relist(x.o1);
	assert.equal(o1.state, 'expired');
	assert.equal(o1.volumeRemain, 0);
	assert.equal(o1.isBuy, false);
	assert.equal('is_buy_order' in x.o1, false);
	assert.deepEqual(o1.pricePath.map(p => [p.at, p.price, p.volumeRemain, p.source]), [
		[at('11-03T16:00:00'), 200, 10, 'snapshot'],
		[at('11-04T10:00:00'), 190, 10, 'snapshot'],
		[null, 190, 0, 'history']
	]);
	assert.deepEqual(o1.fees.map(fee => [fee.id, fee.kind]), [[x.listing.id, 'listing'], [x.relist.id, 'relist']]);
	assert.equal(o1.relistCount, 1);
	assert.equal(o1.feeTotal, 1300);
	assert.equal(o1.firstSeenAt, at('11-03T16:00:00'));
	assert.equal(o1.outcome, 'filled');
	assert.equal(o1.filledQty, 10);
	assert.equal(relist(x.o3).state, 'expired');
	assert.equal(relist(x.o3).volumeRemain, 4);
	assert.equal(relist(x.o3).outcome, 'expired', 'ran out of time');
	assert.equal(relist(x.o3).filledQty, 6);
	assert.equal(relist(x.o4).state, 'cancelled');
	assert.equal(relist(x.o4).outcome, 'cancelled');
	assert.equal(relist(x.b1).outcome, 'filled');
	assert.equal(relist(x.b1).isBuy, true);
	assert.equal(relist(x.o2), undefined, 'immediate sell order');
	assert.equal(relist(x.b3), undefined, 'immediate buy order');
	// Orders placed: O1, O3, O4, B1, B2; the two immediate orders are not placements.
	assert.equal(r.totals.ordersPlaced, 5);
});

test('a broker fee refunded to the ISK by a GM transfer is void; the GM transfer itself is never profit', () => {
	const build = () => {
		const f = makeFixture();
		f.buy(SELLER, { type: T1, qty: 10, price: 100, date: at('11-01T00:00:00') });
		const typo = f.history(SELLER, { type: T2, price: 87980000, total: 947, remain: 947, issued: at('11-11T08:33:01'), state: 'cancelled' });
		const fee = f.fee(SELLER, { date: at('11-11T08:33:01'), amount: 999804720 });
		const gm = f.row(SELLER, { amount: 999804720, date: at('11-12T19:47:51'), first_party_id: 1000086, second_party_id: SELLER, ref_type: 'gm_cash_transfer' });
		f.sell(SELLER, { type: T1, qty: 10, price: 300, date: at('11-13T00:00:00') });
		return { f, typo, fee, gm };
	};
	const x = build();
	const r = x.f.compute();
	assert.equal(feeOf(r, x.fee.id)[0].kind, 'refundedFee');
	assert.equal(feeOf(r, x.gm.id)[0].kind, 'gmRefund');
	assert.equal(typeRow(r, T2), undefined, 'no broker cost left on the mistyped listing');
	assert.equal(r.facts.relists.find(e => e.orderId === x.typo.order_id).fees.length, 0);
	approx(r.crossCheck.journal.broker, 0);
	approx(r.crossCheck.unattributed, 0);
	approx(r.totals.realizedProfit, 3000 - 225 - 1000);

	const off = build().f.compute({ options: { netGmRefunds: false } });
	assert.equal(typeRow(off, T2).brokerListing, 999804720);
	assert.equal(off.facts.fees.filter(fee => fee.refType === 'gm_cash_transfer').length, 0);
});

//--- batches (rule 2) and runs (Comparison 2)

test('batches: newest unbatched lots first per type, a split lot, unsourced units, a deleted hand-off never happened', () => {
	const f = makeFixture();
	const l1 = f.buy(BUYER, { type: T1, qty: 10, price: 100, date: at('11-01T10:00:00') });
	const l2 = f.buy(BUYER, { type: T1, qty: 4, price: 110, date: at('11-02T08:00:00') });
	const l3 = f.buy(BUYER, { type: T1, qty: 3, price: 120, date: at('11-02T09:00:00') });
	const l4 = f.buy(BUYER, { type: T2, qty: 2, price: 1000, date: at('11-02T09:00:00') });
	const deleted = f.handoff({ issued: at('11-02T09:45:00'), status: 'deleted', items: [[T1, 9]] });
	const h = f.handoff({ issued: at('11-02T10:00:00'), items: [[T1, 9], [T2, 3], [T3, 1, false]] });
	const l5 = f.buy(BUYER, { type: T1, qty: 5, price: 130, date: at('11-02T12:00:00') }); // after the hand-off
	const r = f.compute();

	assert.equal(r.batches.length, 1, 'the deleted hand-off is not a batch');
	const batch = r.batches[0];
	assert.equal(batch.batchId, h.contract_id);
	assert.deepEqual(batch.items.map(it => [it.typeId, it.qty, it.sourcedQty, it.unsourcedQty]), [[T1, 9, 9, 0], [T2, 3, 2, 1]]);
	assert.equal(batch.unsourcedQty, 1);
	assert.equal(lotOf(r, l3.transaction_id).batchId, h.contract_id);
	assert.equal(lotOf(r, l2.transaction_id).batchId, h.contract_id);
	// The oldest lot is split: 2 units batched, 8 left unbatched as a new lot.
	assert.equal(lotOf(r, l1.transaction_id).qty, 2);
	assert.equal(lotOf(r, l1.transaction_id).batchId, h.contract_id);
	assert.equal(lotOf(r, `${l1.transaction_id}.2`).qty, 8);
	assert.equal(lotOf(r, `${l1.transaction_id}.2`).batchId, null);
	assert.equal(lotOf(r, l4.transaction_id).batchId, h.contract_id);
	assert.equal(lotOf(r, l5.transaction_id).batchId, null);
	assert.deepEqual(r.warnings.filter(w => w.kind === 'unsourced').map(w => [w.batchId, w.typeId, w.qty]), [[h.contract_id, T2, 1]]);
	assert.ok(typeRow(r, T2).flags.includes('unsourced'));
	// Hand-off fees (its own and the deleted one's) are haul cost split by m3: 9 x 1 + 3 x 10 = 39 m3.
	assert.equal(batch.handoffCost, 10000);
	assert.equal(batch.rolledIn, 10000);
	approx(lotOf(r, l2.transaction_id).haulPerUnit, 20000 / 39);
	approx(lotOf(r, l4.transaction_id).haulPerUnit, 200000 / 39);
	const deletedFee = r.facts.fees.find(x => x.contractId === deleted.contract_id);
	assert.equal(deletedFee.kind, 'deletedHandoff');
	assert.equal(deletedFee.batchId, h.contract_id);
	// contract_price within the pool is internal, on both sides.
	const internal = r.facts.fees.filter(x => x.refType === 'contract_price');
	assert.equal(internal.length, 2);
	assert.ok(internal.every(x => x.kind === 'internal' && x.counted === false));
	assert.equal(r.crossCheck.internal, 0);
	assert.equal(r.totals.unbatchedLots, 2);
});

test('two hand-offs back to back split the lots between them; no unit is counted twice (decision 10)', () => {
	const f = makeFixture();
	const older = f.buy(BUYER, { type: T1, qty: 3, price: 200, date: at('11-03T09:00:00') });
	const newer = f.buy(BUYER, { type: T1, qty: 3, price: 210, date: at('11-03T09:30:00') });
	const h2 = f.handoff({ issued: at('11-03T10:00:00'), items: [[T1, 3]] });
	const h3 = f.handoff({ issued: at('11-03T10:05:00'), items: [[T1, 3]] });
	const r = f.compute();
	assert.equal(lotOf(r, newer.transaction_id).batchId, h2.contract_id);
	assert.equal(lotOf(r, older.transaction_id).batchId, h3.contract_id);
	assert.equal(r.batches.reduce((acc, b) => acc + b.unsourcedQty, 0), 0);
});

test('batch to run: latest run within 7 days (edge included), two runs, an unplanned batch, a run waiting for its hand-off', () => {
	const f = makeFixture();
	const runs = [
		f.run({ id: 'r1', copiedAt: at('11-01T00:00:00'), rows: [[T1, 10, { costPerItemMil: 0.0001, sellPriceMil: 0.0003, revenuePerItemMil: 0.00027, profitPerItemMil: 0.00017, daysToClear: 4 }]] }),
		f.run({ id: 'r2', copiedAt: at('11-03T00:00:00'), rows: [[T1, 4, { costPerItemMil: 0.00011, sellPriceMil: 0.0003, revenuePerItemMil: 0.00027, profitPerItemMil: 0.00016, daysToClear: 3 }]] }),
		f.run({ id: 'other-route', copiedAt: at('11-03T12:00:00'), rows: [[T1, 1]], route: { startStationId: S, endStationId: ELSEWHERE } }),
		f.run({ id: 'r3', copiedAt: at('11-20T00:00:00'), rows: [[T2, 2]] })
	];
	const buy = (type, date) => f.buy(BUYER, { type, qty: 1, price: 100, date });
	buy(T1, at('11-01T12:00:00'));
	const b1 = f.handoff({ issued: at('11-02T00:00:00'), items: [[T1, 1]] });
	buy(T1, at('11-03T12:00:00'));
	buy(T2, at('11-03T12:00:00'));
	const b2 = f.handoff({ issued: at('11-04T00:00:00'), items: [[T1, 1], [T2, 1]] });
	buy(T1, at('11-09T00:00:00'));
	const b3 = f.handoff({ issued: at('11-10T00:00:00'), items: [[T1, 1]] }); // r2 + exactly 7 days
	buy(T1, at('11-10T00:00:00'));
	const b4 = f.handoff({ issued: at('11-10T00:00:01'), items: [[T1, 1]] }); // r2 + 7 days + 1 s
	const r = f.compute({ runs });

	const runOf = (b) => r.batches.find(x => x.batchId === b.contract_id).runId;
	assert.equal(runOf(b1), 'r1');
	assert.equal(runOf(b2), 'r2', 'a run for another route is not a candidate');
	assert.equal(runOf(b3), 'r2');
	assert.equal(runOf(b4), null, 'unplanned batch');
	assert.deepEqual(r.runs.map(x => [x.runId, x.batchIds, x.waiting]), [
		['r1', [b1.contract_id], false],
		['r2', [b2.contract_id, b3.contract_id], false],
		['r3', [], true]
	]);
	assert.deepEqual(r.runs.find(x => x.runId === 'r2').unplannedTypes, [T2]);
	assert.ok(r.batches.find(x => x.batchId === b2.contract_id).items.find(it => it.typeId === T2).unplanned);
	assert.ok(r.facts.lots.filter(l => l.batchId === b2.contract_id).every(l => l.runId === 'r2'));

	// Run mode: the run's lots only, with the prediction next to them.
	const rr = f.compute({ runs, window: { runId: 'r2' } });
	assert.equal(rr.window.mode, 'run');
	assert.deepEqual(rr.types.map(t => t.typeId), [T1, T2]);
	const t1 = typeRow(rr, T1);
	assert.equal(t1.boughtQty, 2);
	assert.equal(t1.predicted.qty, 4);
	assert.equal(t1.predicted.batchedQty, 2);
	approx(t1.predicted.fillPct, 0.5);
	approx(t1.predicted.costPerItem, 110);
	assert.equal(t1.predicted.daysToClear, 3);
	assert.ok(typeRow(rr, T2).flags.includes('unplanned'));
	assert.equal(typeRow(rr, T2).predicted.listed, false);
	// A run with no batch yet shows its predicted rows and no actuals.
	const waiting = f.compute({ runs, window: { runId: 'r3' } });
	assert.deepEqual(waiting.types.map(t => [t.typeId, t.boughtQty, t.soldQty, t.predicted.qty]), [[T2, 0, 0, 2]]);
});

test('run mode broker fees: the type\'s fees from copiedAt to the run\'s sell-out, times the run\'s share of the units on the market', () => {
	const f = makeFixture();
	const runs = [f.run({ id: 'r1', copiedAt: at('11-01T00:00:00'), rows: [[T1, 4]] }), f.run({ id: 'r2', copiedAt: at('11-05T00:00:00'), rows: [[T1, 4]] })];
	f.buy(BUYER, { type: T1, qty: 4, price: 100, date: at('11-01T00:30:00') });
	f.handoff({ issued: at('11-01T01:00:00'), items: [[T1, 4]], brokerFee: 0 });
	f.buy(BUYER, { type: T1, qty: 4, price: 100, date: at('11-05T00:30:00') });
	f.handoff({ issued: at('11-05T01:00:00'), items: [[T1, 4]], brokerFee: 0 });
	const first = f.orderRow({ type: T1, price: 300, total: 4, remain: 4, issued: at('11-02T00:00:00') });
	const second = f.orderRow({ type: T1, price: 300, total: 4, remain: 4, issued: at('11-05T12:00:00') });
	f.led(SELLER).ordersHistory.push({ ...first, volume_remain: 0, state: 'expired' }, { ...second, volume_remain: 3, state: 'cancelled' });
	f.fee(SELLER, { date: at('11-02T00:00:00'), amount: 400 });
	f.fee(SELLER, { date: at('11-05T12:00:01'), amount: 200 });
	f.sell(SELLER, { type: T1, qty: 3, price: 300, date: at('11-03T00:00:00') });
	f.sell(SELLER, { type: T1, qty: 2, price: 300, date: at('11-06T00:00:00') }); // r1's last unit and one of r2's
	const now = at('11-10T00:00:00');

	// r1 sold out on 11-06. In [11-01, 11-06]: 5 units sold, r2's 3 still held at the end: r1 had 4 of 8.
	const r1 = typeRow(f.compute({ runs, now, window: { runId: 'r1' } }), T1);
	assert.equal(r1.soldQty, 4);
	assert.equal(r1.soldOut, true);
	approx(r1.broker, (400 + 200) * 4 / 8);
	// r2 is still selling. In [11-05, now]: 2 units sold, 3 held: r2 had 1 + 3 of 5. Only the 200 fee is in its span.
	const r2 = typeRow(f.compute({ runs, now, window: { runId: 'r2' } }), T1);
	assert.equal(r2.soldQty, 1);
	approx(r2.broker, 200 * 4 / 5);
	approx(r2.remaining.qty, 3);
});

//--- transfers (rule 2, decision 21)

// The buyer hands 10 units to the seller, a courier carries them, the seller sells 7 and hands the
// last 3 to a second linked seller at the destination, who sells them. Options vary the case.
const transferFixture = ({ transfer = true, olderBuyerLot = false, sellerBuys = false, exchangeType = T1, laterCourier = false } = {}) => {
	const f = makeFixture({ extraLinked: [SELLER_2] });
	const runs = [f.run({ id: 'r1', copiedAt: at('11-02T00:00:00'), rows: [[T1, 10]] })];
	// Bought before the hand-off, but the hand-off's 10 units are covered by the newer lot.
	const older = olderBuyerLot ? f.buy(BUYER, { type: T1, qty: 5, price: 900000, date: at('11-01T09:00:00') }) : null;
	const lot = f.buy(BUYER, { type: T1, qty: 10, price: 1000000, date: at('11-02T09:00:00') });
	const handoff = f.handoff({ issued: at('11-02T10:00:00'), items: [[T1, 10]], price: 5000000, brokerFee: 10000 });
	const courier = f.courier({ issued: at('11-02T10:30:00'), accepted: at('11-02T10:40:00'), completed: at('11-02T14:00:00'), volume: 10, reward: 100000, items: [[T1, 10]] });
	f.sell(SELLER, { type: T1, qty: 7, price: 1500000, date: at('11-04T00:00:00'), rate: 0.0375 });
	const own = sellerBuys ? f.buy(SELLER, { type: T1, qty: 3, price: 1200000, date: at('11-05T00:00:00'), loc: D }) : null;
	const exchange = transfer
		? f.handoff({ from: SELLER, to: SELLER_2, issued: at('11-06T00:00:00'), items: [[exchangeType, 3]], price: 1000000, brokerFee: 10000, loc: D })
		: null;
	const later = laterCourier
		? f.courier({ issued: at('11-06T01:00:00'), accepted: at('11-06T01:10:00'), completed: at('11-06T05:00:00'), volume: 3, reward: 30000, items: [[T1, 3]] })
		: null;
	f.sell(SELLER_2, { type: T1, qty: 3, price: 1600000, date: at('11-07T00:00:00'), rate: 0.0375 });
	return { f, runs, older, lot, handoff, courier, own, exchange, later };
};

test('transfer: the seller hands the last units of a batch to a second seller; no new batch, no lot consumed, its broker fee is haul on the source batch', () => {
	const x = transferFixture();
	const r = x.f.compute({ runs: x.runs });

	assert.deepEqual(r.warnings.filter(w => w.kind === 'unsourced'), []);
	assert.equal(r.totals.unsourcedUnits, 0);
	assert.deepEqual(r.batches.map(b => b.batchId), [x.handoff.contract_id]);
	assert.deepEqual(r.runs.map(run => [run.runId, run.batchIds]), [['r1', [x.handoff.contract_id]]]);
	assert.deepEqual(r.couriers.map(k => [k.courierId, k.batchIds]), [[x.courier.contract_id, [x.handoff.contract_id]]]);
	assert.equal(r.facts.transfers.length, 1);
	assert.deepEqual(r.facts.transfers[0], {
		contractId: x.exchange.contract_id, issuerId: SELLER, receiverId: SELLER_2,
		issuedAt: at('11-06T00:00:00'), completedAt: at('11-06T00:01:00'),
		items: [{ typeId: T1, qty: 3, fromBatchIds: [x.handoff.contract_id] }], cost: 10000
	});
	assert.equal(r.totals.transfers, 1);
	assert.equal(r.totals.transferredUnits, 3);
	// The second seller's sale draws from the buyer's lot, carried and hauled as before.
	const lot = lotOf(r, x.lot.transaction_id);
	assert.equal(lot.batchId, x.handoff.contract_id);
	assert.equal(lot.soldQty, 10);
	const second = r.facts.sells.filter(s => s.characterId === SELLER_2);
	assert.deepEqual(second.map(s => [s.lotId, s.qty, s.batchId, s.courierId, s.unarrived]), [[lot.lotId, 3, x.handoff.contract_id, x.courier.contract_id, false]]);
	assert.ok(second.every(s => s.haulShare > 0));
	// Its price is internal on both sides; its broker fee is a transfer fee on the source batch.
	const priceRows = r.facts.fees.filter(fee => fee.contractId === x.exchange.contract_id && fee.refType === 'contract_price');
	assert.equal(priceRows.length, 2);
	assert.ok(priceRows.every(fee => fee.kind === 'internal' && fee.counted === false));
	const brokerRows = r.facts.fees.filter(fee => fee.contractId === x.exchange.contract_id && fee.refType === 'contract_brokers_fee');
	assert.deepEqual(brokerRows.map(fee => [fee.kind, fee.batchId, fee.cost, fee.counted, fee.attributed]), [['transfer', x.handoff.contract_id, 10000, true, true]]);
	assert.equal(r.crossCheck.internal, 0);
	approx(r.crossCheck.unattributed, 0);
	// Haul per unit: both hand-off broker fees over the batch's 10 units, plus the courier (reward
	// 100000 + broker 11000; the deposit came back) over the same 10 units.
	assert.equal(r.batches[0].handoffCost, 20000);
	approx(lot.haulPerUnit, 2000 + 11100);
	const base = transferFixture({ transfer: false }).f.compute({ runs: x.runs });
	approx(lot.haulPerUnit, lotOf(base, x.lot.transaction_id).haulPerUnit + 1000);
	approx(r.totals.haulPaid, 10000 + 10000 + 111000);
	// Realized: 7 sold at 1.5 M and 3 at 1.6 M, 3.75 % tax, no listing fees, the 10 units' landed cost.
	const gross = 7 * 1500000 + 3 * 1600000;
	approx(r.totals.realizedProfit, gross - gross * 0.0375 - 0 - 10 * (1000000 + 13100));
	approx(r.totals.realizedProfit, r.types.reduce((acc, t) => acc + t.realizedProfit, 0));

	// Window: dated by completion. A run counts the transfers that moved its batches, with their fees.
	assert.equal(x.f.compute({ runs: x.runs, window: { since: at('11-07T00:00:00') } }).totals.transfers, 0);
	const rr = x.f.compute({ runs: x.runs, window: { runId: 'r1' } });
	assert.equal(rr.totals.transfers, 1);
	assert.ok(rr.facts.fees.some(fee => fee.kind === 'transfer' && fee.contractId === x.exchange.contract_id));
	approx(rr.totals.haulPaid, 10000 + 10000 + 111000);
});

test('transfer: an older never-handed-off lot of the buyer stays unbatched', () => {
	const x = transferFixture({ olderBuyerLot: true });
	const r = x.f.compute();
	assert.equal(r.facts.transfers.length, 1);
	assert.equal(r.batches.length, 1);
	assert.equal(lotOf(r, x.lot.transaction_id).batchId, x.handoff.contract_id);
	const older = lotOf(r, x.older.transaction_id);
	assert.equal(older.batchId, null);
	assert.equal(older.qty, 5, 'not split');
	assert.equal(older.soldQty, 0);
	assert.equal(r.totals.unsourcedUnits, 0);
	assert.equal(r.totals.unbatchedLots, 1);
});

test('transfer: a seller who bought units of the type himself before the contract makes a batch, sourced from his purchase', () => {
	const x = transferFixture({ sellerBuys: true });
	const r = x.f.compute();
	assert.deepEqual(r.facts.transfers, []);
	assert.equal(r.totals.transfers, 0);
	const batch = r.batches.find(b => b.batchId === x.exchange.contract_id);
	assert.deepEqual(batch.items.map(it => [it.typeId, it.qty, it.sourcedQty, it.unsourcedQty]), [[T1, 3, 3, 0]]);
	assert.equal(lotOf(r, x.own.transaction_id).batchId, x.exchange.contract_id);
	assert.equal(lotOf(r, x.lot.transaction_id).batchId, x.handoff.contract_id);
	const brokerRows = r.facts.fees.filter(fee => fee.contractId === x.exchange.contract_id && fee.refType === 'contract_brokers_fee');
	assert.deepEqual(brokerRows.map(fee => [fee.kind, fee.batchId]), [['handoff', x.exchange.contract_id]]);
});

test('transfer: a contract of a type the seller never received nor bought is still a batch with unsourced units', () => {
	const x = transferFixture({ exchangeType: T2 });
	const r = x.f.compute();
	assert.deepEqual(r.facts.transfers, []);
	assert.equal(r.totals.transfers, 0);
	const batch = r.batches.find(b => b.batchId === x.exchange.contract_id);
	assert.deepEqual(batch.items.map(it => [it.typeId, it.qty, it.sourcedQty, it.unsourcedQty]), [[T2, 3, 0, 3]]);
	assert.deepEqual(r.warnings.filter(w => w.kind === 'unsourced').map(w => [w.batchId, w.typeId, w.qty]), [[x.exchange.contract_id, T2, 3]]);
	assert.equal(r.totals.unsourcedUnits, 3);
	assert.ok(typeRow(r, T2).flags.includes('unsourced'));
});

test('transfer: a courier issued after it, with overlapping items, does not claim it', () => {
	const x = transferFixture({ laterCourier: true });
	const r = x.f.compute();
	assert.equal(r.facts.transfers.length, 1);
	assert.deepEqual(r.batches.map(b => b.batchId), [x.handoff.contract_id]);
	const later = r.couriers.find(k => k.courierId === x.later.contract_id);
	assert.deepEqual(later.batchIds, []);
	assert.equal(later.unattributed, true, 'every lot of the type was carried already');
	assert.equal(lotOf(r, x.lot.transaction_id).courierId, x.courier.contract_id);
});

//--- hauling (rules 6 and 7)

const courierFixture = () => {
	const f = makeFixture();
	const orphanLot = f.buy(BUYER, { type: T3, qty: 1, price: 10, date: at('10-30T09:00:00') });
	const orphan = f.handoff({ issued: at('10-30T12:00:00'), items: [[T3, 1]], brokerFee: 0 }); // 5 m3, never couriered
	const t1Lot = f.buy(BUYER, { type: T1, qty: 10, price: 100, date: at('11-02T09:00:00') });
	const t2Lot = f.buy(BUYER, { type: T2, qty: 2, price: 1000, date: at('11-02T09:00:00') });
	const b1 = f.handoff({ issued: at('11-02T10:00:00'), items: [[T1, 10]], brokerFee: 0 }); // 10 m3
	const dead = f.courier({ issued: at('11-02T10:30:00'), status: 'deleted', volume: 10, reward: 500000 }); // loses deposit + broker fee
	const b2 = f.handoff({ issued: at('11-02T11:00:00'), items: [[T2, 2]], brokerFee: 0 }); // 20 m3
	const k = f.courier({ issued: at('11-02T11:30:00'), accepted: at('11-02T11:40:00'), completed: at('11-02T14:00:00'), volume: 30, reward: 1000000 });
	const bonus = f.donate(SELLER, HAULER_A, { amount: 200000, date: at('11-02T14:10:00') });
	return { f, orphanLot, orphan, t1Lot, t2Lot, b1, b2, dead, k, bonus };
};

test('a courier with an empty item list claims the batches whose volumes fit it, and splits its cost by m3 over both', () => {
	const x = courierFixture();
	const r = x.f.compute();
	const k = r.couriers.find(c => c.courierId === x.k.contract_id);
	assert.deepEqual(k.batchIds, [x.b1.contract_id, x.b2.contract_id]);
	assert.equal(k.itemSource, 'batches');
	assert.equal(k.contractCost, 1000000 + 11000, 'the deposit came back on delivery');
	assert.equal(k.rolledIn, 11000 + 10000, 'the deleted courier lost its broker fee and deposit');
	assert.deepEqual(k.rolledFrom, [x.dead.contract_id]);
	assert.equal(k.bonus, 200000);
	assert.equal(k.totalCost, 1232000);
	// 10 x 1 m3 + 2 x 10 m3 = 30 m3.
	approx(lotOf(r, x.t1Lot.transaction_id).haulPerUnit, 1232000 / 30);
	approx(lotOf(r, x.t2Lot.transaction_id).haulPerUnit, 1232000 * 10 / 30);
	assert.equal(lotOf(r, x.t1Lot.transaction_id).arrivedAt, at('11-02T14:00:00'));
	assert.equal(lotOf(r, x.orphanLot.transaction_id).courierId, null, 'the old 5 m3 batch does not fit');
	assert.equal(r.batches.find(b => b.batchId === x.orphan.contract_id).courierId, null);
	const dead = r.couriers.find(c => c.courierId === x.dead.contract_id);
	assert.equal(dead.dead, true);
	assert.equal(dead.rolledInto, x.k.contract_id);
	assert.deepEqual(dead.batchIds, []);
	assert.ok(r.facts.fees.filter(fee => fee.contractId === x.dead.contract_id).every(fee => fee.kind === 'deletedCourier' && fee.courierId === x.k.contract_id));
	assert.equal(feeOf(r, x.bonus.id)[0].kind, 'haulerBonus');
	assert.equal(feeOf(r, x.bonus.id)[0].counted, true);
});

test('a courier with an item list claims the batches whose types overlap it, and may start in the source\'s solar system', () => {
	const f = makeFixture();
	const SAME_SYSTEM = 60003999;
	const a = f.buy(BUYER, { type: T1, qty: 2, price: 100, date: at('11-01T00:00:00') });
	const b = f.buy(BUYER, { type: T2, qty: 1, price: 100, date: at('11-01T00:00:00') });
	const ba = f.handoff({ issued: at('11-01T01:00:00'), items: [[T1, 2]], brokerFee: 0 });
	const bb = f.handoff({ issued: at('11-01T02:00:00'), items: [[T2, 1]], brokerFee: 0 });
	const k = f.courier({ issued: at('11-01T03:00:00'), accepted: at('11-01T03:10:00'), completed: at('11-01T06:00:00'), items: [[T1, 2]], reward: 2000, brokerFee: 0, deposit: 0, start: SAME_SYSTEM, volume: 999 });
	const r = f.compute({ route: { ...ROUTE, startSystemId: 30000142 }, locations: { [SAME_SYSTEM]: { systemId: 30000142 } } });
	const out = r.couriers.find(c => c.courierId === k.contract_id);
	assert.deepEqual(out.batchIds, [ba.contract_id]);
	assert.equal(out.itemSource, 'items');
	approx(lotOf(r, a.transaction_id).haulPerUnit, 1000);
	assert.equal(r.batches.find(x => x.batchId === bb.contract_id).courierId, null);
	assert.equal(lotOf(r, b.transaction_id).courierId, null);
	// Without the system, the courier is off the route.
	assert.equal(f.compute().couriers.length, 0);
});

test('a type with no packaged volume: haul is split by units instead, flagged est', () => {
	const f = makeFixture();
	const a = f.buy(BUYER, { type: T1, qty: 3, price: 100, date: at('11-01T00:00:00') });
	const b = f.buy(BUYER, { type: T2, qty: 1, price: 100, date: at('11-01T00:00:00') });
	f.handoff({ issued: at('11-01T01:00:00'), items: [[T1, 3], [T2, 1]], brokerFee: 400, volume: 13 });
	f.sell(SELLER, { type: T1, qty: 1, price: 500, date: at('11-02T00:00:00') });
	const r = f.compute({ m3: { [T1]: 1 } });
	approx(lotOf(r, a.transaction_id).haulPerUnit, 100);
	approx(lotOf(r, b.transaction_id).haulPerUnit, 100);
	assert.equal(lotOf(r, a.transaction_id).est, true);
	assert.equal(r.batches[0].est, true);
	assert.ok(typeRow(r, T1).flags.includes('est'));
});

test('the "count hauler bonuses" toggle keeps the bonus off the courier cost', () => {
	const x = courierFixture();
	const r = x.f.compute({ options: { countHaulerBonuses: false } });
	const k = r.couriers.find(c => c.courierId === x.k.contract_id);
	assert.equal(k.bonus, 200000);
	assert.equal(k.totalCost, 1032000);
	approx(lotOf(r, x.t1Lot.transaction_id).haulPerUnit, 1032000 / 30);
	assert.equal(feeOf(r, x.bonus.id)[0].counted, false);
	assert.equal(r.otherDonations.length, 0, 'still a bonus, just not counted');
});

test('a courier with no batch but an item list hauls the oldest unhauled lots of each item type', () => {
	const f = makeFixture();
	const a = f.buy(BUYER, { type: T1, qty: 5, price: 100, date: at('11-01T00:00:00') });
	const b = f.buy(BUYER, { type: T1, qty: 5, price: 110, date: at('11-02T00:00:00') });
	const c = f.buy(BUYER, { type: T1, qty: 4, price: 120, date: at('11-04T00:00:00') });
	const k = f.courier({ issuer: BUYER, issued: at('11-03T00:00:00'), accepted: at('11-03T00:10:00'), completed: at('11-03T06:00:00'), reward: 60000, brokerFee: 10000, items: [[T1, 7]], volume: 7 });
	const r = f.compute();
	const out = r.couriers[0];
	assert.equal(out.courierId, k.contract_id);
	assert.equal(out.itemSource, 'items');
	assert.deepEqual(out.carried, [{ typeId: T1, qty: 7 }]);
	approx(lotOf(r, a.transaction_id).haulPerUnit, 10000);
	assert.equal(lotOf(r, b.transaction_id).qty, 2);
	approx(lotOf(r, b.transaction_id).haulPerUnit, 10000);
	assert.equal(lotOf(r, `${b.transaction_id}.2`).qty, 3);
	assert.equal(lotOf(r, `${b.transaction_id}.2`).courierId, null);
	assert.equal(lotOf(r, c.transaction_id).courierId, null, 'bought after the courier');
});

test('a courier with no batch and no item list spreads per m3 over the issuer\'s unhauled lots at the source', () => {
	const f = makeFixture();
	const a = f.buy(BUYER, { type: T1, qty: 2, price: 100, date: at('11-01T00:00:00') });
	const b = f.buy(BUYER, { type: T2, qty: 1, price: 1000, date: at('11-01T00:00:00') });
	const away = f.buy(BUYER, { type: T1, qty: 3, price: 100, date: at('11-01T00:00:00'), loc: ELSEWHERE });
	const otherChar = f.buy(SELLER, { type: T1, qty: 1, price: 100, date: at('11-01T00:00:00') });
	f.courier({ issuer: BUYER, issued: at('11-02T00:00:00'), accepted: at('11-02T00:10:00'), completed: at('11-02T06:00:00'), reward: 12000, brokerFee: 0, deposit: 0, volume: 12 });
	const r = f.compute();
	assert.equal(r.couriers[0].itemSource, 'lots');
	// 2 x 1 m3 + 1 x 10 m3 = 12 m3 for 12000 ISK.
	approx(lotOf(r, a.transaction_id).haulPerUnit, 1000);
	approx(lotOf(r, b.transaction_id).haulPerUnit, 10000);
	assert.equal(lotOf(r, away.transaction_id).courierId, null);
	assert.equal(lotOf(r, otherChar.transaction_id).courierId, null);
});

test('in-progress and failed couriers: the deposit is pending, nothing has arrived, a failed courier warns', () => {
	const f = makeFixture();
	const lot = f.buy(BUYER, { type: T1, qty: 4, price: 100, date: at('11-01T00:00:00') });
	f.handoff({ issued: at('11-01T01:00:00'), items: [[T1, 4]], brokerFee: 0 });
	const k = f.courier({ issued: at('11-01T02:00:00'), accepted: at('11-01T02:10:00'), status: 'in_progress', reward: 40000, volume: 4 });
	const lot2 = f.buy(BUYER, { type: T2, qty: 1, price: 100, date: at('11-03T00:00:00') });
	f.handoff({ issued: at('11-03T01:00:00'), items: [[T2, 1]], brokerFee: 0 });
	const failed = f.courier({ issued: at('11-03T02:00:00'), accepted: at('11-03T02:10:00'), status: 'failed', reward: 1000, volume: 10, deposit: 0, brokerFee: 0 });
	f.snapshot(SELLER, { syncedAt: at('11-04T00:00:00') });
	const r = f.compute();
	const out = r.couriers.find(c => c.courierId === k.contract_id);
	assert.equal(out.contractCost, 40000 + 11000);
	assert.equal(out.arrived, false);
	assert.equal(lotOf(r, lot.transaction_id).courierId, k.contract_id);
	assert.equal(lotOf(r, lot.transaction_id).arrivedAt, null);
	assert.equal(typeRow(r, T1).remaining.physical.inTransit, 4);
	assert.deepEqual(r.warnings.filter(w => w.kind === 'failedCourier').map(w => w.courierId), [failed.contract_id]);
	assert.equal(lotOf(r, lot2.transaction_id).arrivedAt, null);
});

test('hauler bonus: matched by acceptor from date_accepted to date_completed + 48 h (open-ended in progress), most recently accepted courier wins; other and internal donations', () => {
	const f = makeFixture();
	const kOld = f.courier({ issued: at('11-02T10:00:00'), accepted: at('11-02T11:00:00'), completed: at('11-02T14:00:00'), volume: 1 });
	const kNew = f.courier({ issued: at('11-04T10:00:00'), accepted: at('11-04T11:00:00'), completed: at('11-04T15:00:00'), volume: 1 });
	const kOpen = f.courier({ issued: at('11-05T00:00:00'), accepted: at('11-05T00:10:00'), status: 'in_progress', acceptor: HAULER_B, volume: 1 });
	const d1 = f.donate(SELLER, HAULER_A, { amount: 300000, date: at('11-02T14:04:00') }); // kNew not accepted yet: kOld
	const d2 = f.donate(SELLER, HAULER_A, { amount: 100000, date: at('11-04T12:00:00') }); // both qualify, before kNew completes: kNew
	const d3 = f.donate(SELLER, HAULER_A, { amount: 70000, date: at('11-06T15:00:01') }); // kNew completed + 48 h + 1 s
	const d4 = f.donate(SELLER, HAULER_A, { amount: 60000, date: at('11-02T10:59:00') }); // before kOld was accepted
	const d5 = f.donate(SELLER, BUYER, { amount: 1000000000, date: at('11-02T16:30:00') }); // internal
	const d6 = f.donate(SELLER, OUTSIDER, { amount: 50000, date: at('11-02T16:00:00') });
	const d7 = f.donate(OUTSIDER, SELLER, { amount: 5000, date: at('11-02T17:00:00') }); // received: ignored
	const d8 = f.donate(BUYER, HAULER_B, { amount: 80000, date: at('11-20T00:00:00') }); // in progress: open-ended
	const r = f.compute();

	assert.equal(r.couriers.find(c => c.courierId === kOld.contract_id).bonus, 300000);
	assert.equal(r.couriers.find(c => c.courierId === kNew.contract_id).bonus, 100000);
	assert.equal(r.couriers.find(c => c.courierId === kOpen.contract_id).bonus, 80000);
	assert.equal(feeOf(r, d1.id)[0].courierId, kOld.contract_id);
	assert.equal(feeOf(r, d2.id)[0].courierId, kNew.contract_id);
	assert.equal(feeOf(r, d8.id)[0].kind, 'haulerBonus');
	assert.deepEqual(r.otherDonations.map(d => d.id), [d4.id, d6.id, d3.id]);
	assert.equal(r.totals.otherDonations, 3);
	assert.equal(r.totals.otherDonationsAmount, 60000 + 50000 + 70000);
	assert.ok(feeOf(r, d5.id).every(x => x.kind === 'internal' && x.counted === false));
	assert.equal(feeOf(r, d5.id).length, 2, 'the internal donation is in both journals');
	assert.deepEqual(feeOf(r, d7.id), []);
	assert.equal(r.crossCheck.internal, 0);
	// Just inside the window: completed + 48 h exactly.
	const edge = makeFixture();
	edge.courier({ issued: at('11-02T10:00:00'), accepted: at('11-02T11:00:00'), completed: at('11-02T14:00:00'), volume: 1 });
	const late = edge.donate(SELLER, HAULER_A, { amount: 1000, date: at('11-04T14:00:00') });
	assert.equal(feeOf(edge.compute(), late.id)[0].kind, 'haulerBonus');
});

//--- remaining, pace and the cross-check (rules 9-11)

const remainingFixture = ({ sellOut = false, destQty = 1 } = {}) => {
	const f = makeFixture();
	const lot = f.buy(BUYER, { type: T1, qty: 10, price: 100, date: at('11-01T10:00:00') });
	f.handoff({ issued: at('11-01T11:00:00'), items: [[T1, 10]] });
	f.courier({ issued: at('11-01T11:30:00'), accepted: at('11-01T11:40:00'), completed: at('11-02T00:00:00'), volume: 10, reward: 100000 });
	f.sell(SELLER, { type: T1, qty: 4, price: 300, date: at('11-04T00:00:00'), rate: 0.0375 });
	if (sellOut) f.sell(SELLER, { type: T1, qty: 6, price: 300, date: at('11-06T00:00:00'), rate: 0.0375 });
	// Sold somewhere else: a count, outside P&L, unattributed in the cross-check.
	f.buy(SELLER, { type: T2, qty: 1, price: 100, date: at('11-01T00:00:00') });
	const away = f.sell(SELLER, { type: T2, qty: 1, price: 500, date: at('11-05T00:00:00'), loc: ELSEWHERE, rate: 0.0375 });
	// Ref types the accounting ignores.
	f.row(SELLER, { amount: 999804720, date: at('11-03T00:00:00'), first_party_id: 1000086, second_party_id: SELLER, ref_type: 'gm_cash_transfer' });
	f.row(BUYER, { amount: -6500000, context_id: 12204, context_id_type: 'type_id', date: at('11-03T00:00:00'), first_party_id: BUYER, second_party_id: 1000125, ref_type: 'skill_purchase' });
	f.row(BUYER, { amount: -1000, date: at('11-03T00:00:00'), first_party_id: BUYER, second_party_id: 1000132, ref_type: 'insurance' });
	f.row(BUYER, { amount: 1, date: at('11-03T00:00:00'), first_party_id: BUYER, second_party_id: BUYER, ref_type: 'some_future_ref_type' });
	// An older snapshot that must not be used, then the latest: one unit in the hangar at D, two in a
	// container there, three listed.
	f.snapshot(SELLER, { syncedAt: at('11-03T00:00:00'), assets: [f.asset({ type: T1, qty: 6, loc: D })] });
	if (!sellOut) {
		const box = f.asset({ type: CONTAINER, qty: 1, loc: D });
		const order = f.orderRow({ type: T1, price: 300, total: 7, remain: 3, issued: at('11-02T01:00:00') });
		f.snapshot(SELLER, {
			syncedAt: at('11-11T00:00:00'),
			orders: [order],
			assets: [box, f.asset({ type: T1, qty: 2, loc: box.item_id, locType: 'item' }), f.asset({ type: T1, qty: destQty, loc: D })]
		});
	} else {
		f.snapshot(SELLER, { syncedAt: at('11-11T00:00:00') });
	}
	f.snapshot(BUYER, { syncedAt: at('11-11T00:00:00'), assets: [f.asset({ type: T3, qty: 5, loc: S })] });
	return { f, lot, away };
};

test('remaining in both views, unrealized at cost and at market, days on market and the projection', () => {
	const { f } = remainingFixture();
	const r = f.compute({ now: at('11-12T00:00:00'), market: { [T1]: 280 } });
	const t1 = typeRow(r, T1);
	assert.equal(t1.remaining.qty, 6);
	// Haul per unit: hand-off broker 10000 + courier reward 100000 + broker 11000, over 10 units.
	approx(t1.remaining.atCost, 6 * (100 + 12100));
	approx(r.observedTaxRate, 0.0375);
	approx(t1.remaining.marketNetPerUnit, (280 - 0.01) * (1 - 0.0375 - 0.024));
	approx(t1.unrealizedAtMarket, 6 * (280 - 0.01) * (1 - 0.0375 - 0.024));
	assert.deepEqual(t1.remaining.physical, { atSource: 0, inTransit: 0, atDest: 3, listed: 3, total: 6, known: true });
	assert.equal(t1.remaining.mismatch, false);
	assert.equal(t1.listedAt, at('11-02T00:00:00'));
	assert.equal(t1.soldOut, false);
	approx(t1.daysOnMarket, 10);
	approx(t1.sellRate, 0.4);
	approx(t1.soldFraction, 0.4);
	approx(t1.projectedDaysToClear, 25);
	assert.equal(r.totals.otherSells, 1);
	assert.equal(typeRow(r, T2), undefined, 'a sale elsewhere stays out of P&L');

	const short = remainingFixture({ destQty: 0 }).f.compute({ now: at('11-12T00:00:00') });
	assert.equal(typeRow(short, T1).remaining.physical.total, 5);
	assert.equal(typeRow(short, T1).remaining.mismatch, true);
	assert.ok(typeRow(short, T1).flags.includes('mismatch'));
	assert.equal(typeRow(short, T1).unrealizedAtMarket, null, 'no market price given');
});

test('a sold-out type: days on market end at the last sale', () => {
	const { f } = remainingFixture({ sellOut: true });
	const t1 = typeRow(f.compute({ now: at('11-12T00:00:00') }), T1);
	assert.equal(t1.soldOut, true);
	assert.equal(t1.remaining.qty, 0);
	approx(t1.daysOnMarket, 4);
	approx(t1.sellRate, 10 / 4);
	approx(t1.projectedDaysToClear, 4);
});

test('cross-check: journal flows against what the rules attributed; ignored ref types never count and never throw', () => {
	const { f, away } = remainingFixture();
	const r = f.compute({ now: at('11-12T00:00:00') });
	const cc = r.crossCheck;
	assert.equal(cc.journal.market, 1200 + 500);
	assert.equal(cc.attributed.market, 1200);
	approx(cc.journal.tax, -45 - 18.75);
	approx(cc.attributed.tax, -45);
	assert.equal(cc.journal.contract, -10000 - 100000 - 10000 - 11000 + 10000);
	assert.equal(cc.attributed.contract, cc.journal.contract);
	approx(cc.unattributed, 500 - 18.75);
	assert.equal(cc.internal, 0);
	assert.ok(!r.facts.fees.some(x => ['gm_cash_transfer', 'skill_purchase', 'insurance', 'some_future_ref_type'].includes(x.refType)));
	assert.equal(feeOf(r, away.taxRow.id)[0].attributed, false);
	// Profit is the same with the odd rows removed.
	const plain = remainingFixture();
	for (const c of [BUYER, SELLER]) plain.f.ledgers[c].journal = plain.f.ledgers[c].journal.filter(j => !['gm_cash_transfer', 'skill_purchase', 'insurance', 'some_future_ref_type'].includes(j.ref_type));
	assert.equal(plain.f.compute({ now: at('11-12T00:00:00') }).totals.realizedProfit, r.totals.realizedProfit);
});

//--- the fact table (rule 12)

const factFixture = () => {
	const f = makeFixture();
	const t1Lot = f.buy(BUYER, { type: T1, qty: 10, price: 100, date: at('11-02T09:00:00') });
	const t2Lot = f.buy(BUYER, { type: T2, qty: 2, price: 1000, date: at('11-02T09:00:00') });
	f.handoff({ issued: at('11-02T10:00:00'), items: [[T1, 10]] });
	f.handoff({ issued: at('11-02T11:00:00'), items: [[T2, 2]] });
	f.courier({ issued: at('11-02T11:30:00'), accepted: at('11-02T11:40:00'), completed: at('11-02T14:00:00'), volume: 30, reward: 300000, brokerFee: 0, deposit: 0 });
	const o1 = f.orderRow({ type: T1, price: 500, total: 10, remain: 10, issued: at('11-02T17:00:00') });
	f.snapshot(SELLER, { syncedAt: at('11-02T13:00:00') });
	f.snapshot(SELLER, { syncedAt: at('11-02T18:00:00'), orders: [o1] });
	f.snapshot(SELLER, { syncedAt: at('11-03T18:00:00'), orders: [{ ...o1, issued: at('11-03T09:00:00'), price: 450, volume_remain: 6 }] });
	f.fee(SELLER, { date: at('11-02T17:00:00'), amount: 1500 });
	f.fee(SELLER, { date: at('11-03T09:00:01'), amount: 400 });
	const s1 = f.sell(SELLER, { type: T1, qty: 4, price: 500, date: at('11-03T08:00:00'), rate: 0.0375 });
	const s2 = f.sell(SELLER, { type: T1, qty: 3, price: 450, date: at('11-04T20:00:00'), rate: 0.0375 });
	const s3 = f.sell(SELLER, { type: T2, qty: 1, price: 150000, date: at('11-03T21:00:00'), rate: 0.0375 });
	return { f, o1, t1Lot, t2Lot, s1, s2, s3 };
};

test('fact table: every sells row ties back to a lot and a sell, and the sells sums equal the per-type rows', () => {
	const x = factFixture();
	const r = x.f.compute({ now: at('11-10T00:00:00') });
	const lotIds = new Set(r.facts.lots.map(l => l.lotId));
	const sellIds = new Set(Object.values(x.f.ledgers).flatMap(l => l.transactions).filter(t => !t.is_buy).map(t => t.transaction_id));
	assert.equal(r.facts.sells.length, 3);
	for (const s of r.facts.sells) {
		assert.ok(lotIds.has(s.lotId), `lot ${s.lotId}`);
		assert.ok(sellIds.has(s.sellTxId), `sell ${s.sellTxId}`);
	}
	for (const t of r.types) {
		const rows = r.facts.sells.filter(s => s.typeId === t.typeId);
		const total = (key) => rows.reduce((acc, s) => acc + s[key], 0);
		assert.equal(total('qty'), t.soldQty);
		approx(total('gross'), t.gross);
		approx(total('tax'), t.tax);
		approx(total('brokerShare') + total('relistShare'), t.broker);
		approx(total('haulShare'), t.haul);
		approx(total('buyFeeShare'), t.buyFee);
		approx(total('buyCost'), t.buyCost);
		approx(total('profit'), t.realizedProfit);
	}
	const t1 = typeRow(r, T1);
	assert.equal(t1.brokerListing, 1500);
	assert.equal(t1.brokerRelist, 400);
	// Haul: courier 300000 over 30 m3 = 10000 per T1 unit, plus the hand-off's 10000 over 10 units.
	approx(lotOf(r, x.t1Lot.transaction_id).haulPerUnit, 11000);
	approx(lotOf(r, x.t2Lot.transaction_id).haulPerUnit, 100000 + 5000);
	approx(r.totals.realizedProfit, r.types.reduce((acc, t) => acc + t.realizedProfit, 0));
	assert.equal(r.totals.soldQty, 8);
});

test('fact table: firstListedAt from the snapshots, days since listed and arrived, EVE hour and weekday, one relists entry with its price path', () => {
	const x = factFixture();
	const r = x.f.compute({ now: at('11-10T00:00:00') });
	const lot = lotOf(r, x.t1Lot.transaction_id);
	assert.equal(lot.arrivedAt, at('11-02T14:00:00'));
	assert.equal(lot.firstListedAt, at('11-02T18:00:00'), 'the first snapshot that saw the sell order');
	assert.equal(lot.soldQty, 7);
	assert.equal(lot.lastSoldAt, at('11-04T20:00:00'));
	assert.equal(lotOf(r, x.t2Lot.transaction_id).firstListedAt, null, 'never seen listed');
	const first = r.facts.sells.find(s => s.sellTxId === x.s1.tx.transaction_id);
	approx(first.daysSinceListed, 14 / 24);
	approx(first.daysSinceArrived, 18 / 24);
	assert.equal(first.eveHour, 8);
	assert.equal(first.weekday, new Date(Date.UTC(2026, 10, 3)).getUTCDay());
	assert.equal(first.journalId, x.s1.mt.id);
	assert.equal(first.batchId, lot.batchId);
	assert.equal(first.courierId, lot.courierId);
	const relists = r.facts.relists.filter(e => e.orderId === x.o1.order_id);
	assert.equal(relists.length, 1);
	assert.deepEqual(relists[0].pricePath.map(p => [p.at, p.price, p.volumeRemain]), [
		[at('11-02T18:00:00'), 500, 10],
		[at('11-03T18:00:00'), 450, 6]
	]);
	assert.deepEqual(relists[0].fees.map(fee => [fee.amount, fee.kind]), [[-1500, 'listing'], [-400, 'relist']]);
	assert.equal(relists[0].state, 'open');
});

//--- scope, links and the module contract

test('scope: corporation trades and trades between linked characters are excluded; lots keep an elsewhere tag', () => {
	const f = makeFixture();
	const corp = f.buy(BUYER, { type: T1, qty: 5, price: 100, date: at('11-01T00:00:00'), personal: false });
	const internalBuy = f.buy(BUYER, { type: T1, qty: 3, price: 100, date: at('11-01T01:00:00'), client: SELLER });
	f.sell(SELLER, { type: T1, qty: 3, price: 100, date: at('11-01T01:00:00'), client: BUYER, loc: S });
	const atS = f.buy(BUYER, { type: T1, qty: 1, price: 100, date: at('11-01T02:00:00') });
	const inRegion = f.buy(BUYER, { type: T1, qty: 1, price: 100, date: at('11-01T03:00:00'), loc: S_REGION_STATION });
	const away = f.buy(BUYER, { type: T1, qty: 1, price: 100, date: at('11-01T04:00:00'), loc: ELSEWHERE });
	const r = f.compute({ locations: { [S_REGION_STATION]: { regionId: REGION_S } } });
	const ids = r.facts.lots.map(l => l.transactionId);
	assert.ok(!ids.includes(corp.transaction_id));
	assert.ok(!ids.includes(internalBuy.transaction_id));
	assert.equal(lotOf(r, atS.transaction_id).where, 'source');
	assert.equal(lotOf(r, inRegion.transaction_id).where, 'region');
	assert.equal(lotOf(r, away.transaction_id).where, 'other');
	assert.equal(r.totals.otherSells, 0, 'the internal sale is not a sale');
});

test('links: a sell joins its market_transaction row by context_id (not journal_ref_id); a buy\'s cost comes from the transaction, not its escrow row', () => {
	const f = makeFixture();
	const lot = f.buy(BUYER, { type: T1, qty: 2, price: 100, date: at('11-01T00:00:00'), escrowAmount: -150 });
	const sale = f.sell(SELLER, { type: T1, qty: 2, price: 300, date: at('11-02T00:00:00') });
	const r = f.compute();
	const row = r.facts.sells[0];
	assert.equal(row.journalId, sale.mt.id);
	assert.notEqual(row.journalId, sale.tx.journal_ref_id);
	assert.equal(row.buyCost, 200);
	assert.equal(lotOf(r, lot.transaction_id).journalId, lot.journal_ref_id);
	assert.equal(lotOf(r, lot.transaction_id).unitPrice, 100);
});

test('since window: only sells and fees dated in it are summed, FIFO still runs over the whole ledger', () => {
	const x = factFixture();
	const r = x.f.compute({ now: at('11-10T00:00:00'), window: { since: at('11-04T00:00:00') } });
	assert.deepEqual(r.facts.sells.map(s => s.sellTxId), [x.s2.tx.transaction_id]);
	// FIFO over the whole ledger: the 11-04 sale takes units after the four sold on 11-03.
	assert.equal(r.facts.sells[0].lotId, String(x.t1Lot.transaction_id));
	assert.equal(typeRow(r, T1).soldQty, 3);
	assert.equal(typeRow(r, T1).broker, 0, 'both fees are dated before the window');
	assert.ok(r.facts.fees.every(fee => fee.date >= at('11-04T00:00:00')));
	assert.equal(r.window.start, at('11-04T00:00:00'));
});

test('pickBatchesByVolume picks the subset closest to the courier volume, preferring the newest on a tie', () => {
	const b = (id, volume) => ({ batchId: id, volume });
	assert.deepEqual(pickBatchesByVolume([b(3, 20), b(2, 10), b(1, 5)], 30, 0.01).map(x => x.batchId), [3, 2]);
	assert.deepEqual(pickBatchesByVolume([b(2, 10), b(1, 10)], 10, 0.01).map(x => x.batchId), [2]);
	assert.deepEqual(pickBatchesByVolume([b(1, 50)], 10, 0.01), []);
});

test('deterministic and pure: the same input gives the same output and is never mutated; now is required', () => {
	const x = courierFixture();
	x.f.sell(SELLER, { type: T1, qty: 3, price: 300, date: at('11-03T00:00:00') });
	const input = { characterIds: [BUYER, SELLER], ledgers: x.f.ledgers, route: ROUTE, m3: M3, now: NOW };
	const before = JSON.stringify(input);
	const one = compute(input);
	const two = compute(JSON.parse(before));
	assert.equal(JSON.stringify(input), before);
	assert.deepEqual(one, two);
	assert.throws(() => compute({ ...input, now: undefined }), /now/);
	assert.doesNotThrow(() => compute({ now: NOW }));
});

test('UMD: loads as a browser global with no require', () => {
	const file = path.join(__dirname, '..', 'public', 'results-calc.js');
	const source = fs.readFileSync(file, 'utf8');
	const code = source.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
	assert.ok(!/\brequire\s*\(/.test(code), 'no require in the browser module');
	const sandbox = { self: {} };
	vm.runInNewContext(source, sandbox);
	assert.equal(typeof sandbox.self.resultsCalc.compute, 'function');
	const r = sandbox.self.resultsCalc.compute({ now: NOW });
	assert.equal(r.types.length, 0);
});
