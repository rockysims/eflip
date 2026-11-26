// sold-before-fixture.js: a hand-made ledger of two linked characters for the "sold before" tests
// (lib/sold-before.js, POST /api/sold-before). Shaped like lib/ledger.js readAll() and readSnapshots().
// Nothing here comes from data/. It lives outside test/ because a bare `node --test` runs every .js
// file under test/ as a test.
//
// The clock is 2026-11-20T12:00:00Z and the window 90 days, so it opens 2026-08-22T12:00:00Z.
// At the destination (AMARR), type 34:
//   - IVAN sold 3 units on 2026-07-01 (before the window), from a lot bought 2026-06-20 at 0.5M
//   - IVAN sold 10 units at 2.0M on 2026-11-18T10:00Z from his lot of 10 bought at 1.0M on 2026-10-25
//   - GRANT sold 5 units at 2.2M on 2026-11-19T10:00Z from his lot of 5 bought at 1.2M on 2026-10-26
//   - GRANT sold 7 units at another station (OTHER), which is not the destination
//   so the window holds 15 units in 2 sales, the last on 2026-11-19T10:00:00Z, and every sale pays
//   7.5 % sales tax: profit 20 - 1.5 - 10 = 8.5M and 11 - 0.825 - 6 = 4.175M, 12.675M over 15 units =
//   0.845M a unit. IVAN's snapshot of 2026-11-10T00:00Z has a sell order of type 34 at AMARR, so the
//   units were listed since then: 8.4167 days before the first sale, 9.4167 before the second, and the
//   median by units is 8.417 days.
// Type 36: IVAN sold 4 units at 3.0M on 2026-11-15T10:00Z with no lot behind them (no margin, no days).
// Type 35: IVAN bought 2 units at AMARR on 2026-11-01 (a buy is no sale), and nothing else.
// Type 37: IVAN sold 6 units at AMARR to GRANT (a trade inside the linked pool is no sale).
// Type 38: a sale of 9 units at AMARR by a corporation (is_personal false).
const IVAN = 90000001;
const GRANT = 90000002;
const OUTSIDER = 90000999;
const JITA = 60003760;
const AMARR = 60008494;
const OTHER = 60011866;
const NOW_MS = Date.UTC(2026, 10, 20, 12, 0, 0);
const DAYS = 90;
const SALES_TAX = 0.075;

const buildLedgers = () => {
	let nextTx = 5000;
	let nextJournal = 7000000;
	const empty = () => ({ transactions: [], journal: [], ordersHistory: [], contracts: [], contractItems: {} });
	const ledgers = { [IVAN]: empty(), [GRANT]: empty() };

	const buy = (character, { type, qty, price, date, location = JITA }) => {
		const tx = { client_id: OUTSIDER, date, is_buy: true, is_personal: true, journal_ref_id: 0, location_id: location, quantity: qty, transaction_id: ++nextTx, type_id: type, unit_price: price };
		const escrow = { id: ++nextJournal, amount: -price * qty, balance: 0, context_id: tx.transaction_id, context_id_type: 'market_transaction_id', date, description: 'Market escrow release', first_party_id: character, second_party_id: character, ref_type: 'market_escrow', reason: '' };
		tx.journal_ref_id = escrow.id;
		ledgers[character].transactions.push(tx);
		ledgers[character].journal.push(escrow);
		return tx;
	};
	// the sell, its market_transaction row and the transaction_tax row right after it
	const sell = (character, { type, qty, price, date, location = AMARR, client = OUTSIDER, personal = true }) => {
		const tx = { client_id: client, date, is_buy: false, is_personal: personal, journal_ref_id: 0, location_id: location, quantity: qty, transaction_id: ++nextTx, type_id: type, unit_price: price };
		const market = { id: (nextJournal += 10), amount: price * qty, balance: 0, context_id: tx.transaction_id, context_id_type: 'market_transaction_id', date, description: 'Market: someone bought stuff', first_party_id: client, second_party_id: character, ref_type: 'market_transaction', reason: '' };
		const tax = { id: market.id + 1, amount: -price * qty * SALES_TAX, balance: 0, date, description: 'Sales tax paid to the SCC', first_party_id: character, second_party_id: 1000132, ref_type: 'transaction_tax', reason: '' };
		tx.journal_ref_id = market.id + 2;
		ledgers[character].transactions.push(tx);
		ledgers[character].journal.push(market, tax);
		return tx;
	};

	buy(IVAN, { type: 34, qty: 3, price: 500000, date: '2026-06-20T10:00:00Z' });
	sell(IVAN, { type: 34, qty: 3, price: 900000, date: '2026-07-01T10:00:00Z' });
	buy(IVAN, { type: 34, qty: 10, price: 1000000, date: '2026-10-25T10:00:00Z' });
	buy(GRANT, { type: 34, qty: 5, price: 1200000, date: '2026-10-26T10:00:00Z' });
	sell(IVAN, { type: 34, qty: 10, price: 2000000, date: '2026-11-18T10:00:00Z' });
	sell(GRANT, { type: 34, qty: 5, price: 2200000, date: '2026-11-19T10:00:00Z' });
	sell(GRANT, { type: 34, qty: 7, price: 2100000, date: '2026-11-17T10:00:00Z', location: OTHER });
	sell(IVAN, { type: 36, qty: 4, price: 3000000, date: '2026-11-15T10:00:00Z' });
	buy(IVAN, { type: 35, qty: 2, price: 1000000, date: '2026-11-01T10:00:00Z', location: AMARR });
	sell(IVAN, { type: 37, qty: 6, price: 1000000, date: '2026-11-12T10:00:00Z', client: GRANT });
	sell(IVAN, { type: 38, qty: 9, price: 1000000, date: '2026-11-13T10:00:00Z', personal: false });

	const snapshots = {
		[IVAN]: [{
			syncedAt: '2026-11-10T00:00:00.000Z',
			orders: [{ duration: 90, is_corporation: false, issued: '2026-11-10T00:00:00Z', location_id: AMARR, order_id: 8001, price: 2000000, range: 'region', region_id: 10000043, type_id: 34, volume_remain: 15, volume_total: 15 }],
			assets: [],
			balance: 1000000
		}],
		[GRANT]: []
	};
	return { ledgers, snapshots };
};

// What the fixture's answer is, by hand (see the table above).
const EXPECTED = Object.freeze({
	34: { units: 15, sales: 2, lastSoldAt: '2026-11-19T10:00:00Z', netMarginMilPerUnit: 0.845, medianDaysOnMarket: 8.417 },
	36: { units: 4, sales: 1, lastSoldAt: '2026-11-15T10:00:00Z', netMarginMilPerUnit: null, medianDaysOnMarket: null }
});

module.exports = { buildLedgers, EXPECTED, IVAN, GRANT, OUTSIDER, JITA, AMARR, OTHER, NOW_MS, DAYS };
