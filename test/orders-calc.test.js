// Phase 2 of docs/order-monitor-plan.md: the pure order-monitor analysis in public/orders-calc.js.
// Fixtures are hand-written, shaped like the live samples of 2026-11-19..25 (ESI field names and
// types per route; the order-log and book-log shapes of the plan's "Data model").
const test = require('node:test');
const assert = require('node:assert/strict');
const ordersCalc = require('../public/orders-calc.js');
const estimate = require('../public/estimate.js');
const resultsCalc = require('../public/results-calc.js');

const { compute, defaultThresholds } = ordersCalc;
const { median, recencyWeight, priceAt, episodesOf, compareRows, windowDays } = ordersCalc._internal;

const GRANT = 91000002; // sells at Amarr
const IVAN = 91000001;  // buys at Jita
const D = 60008494;     // Amarr VIII (Oris) - Emperor Family Academy
const ELSEWHERE = 60008950; // another station of the region
const REGION = 10000043;    // Domain
const SYSTEM = 30002187;
const T = 47771;  // the item of Grant's order 7467834499
const T2 = 501;
const T3 = 502;
const M = 1e6;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = '2026-11-25T12:00:00Z';
const NOW_MS = Date.parse(NOW);
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const ago = (ms) => iso(NOW_MS - ms);
const dayOf = (ageDays) => new Date(NOW_MS - ageDays * DAY).toISOString().slice(0, 10);
const approx = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) <= eps, `${actual} !== ${expected} (±${eps})`);

//--- builders

// /characters/{id}/orders: a sell order omits is_buy_order, escrow and min_volume.
const mine = ({ id, type = T, price, remain, total = remain, issued, loc = D, region = REGION }) => ({
	duration: 90, is_corporation: false, issued, location_id: loc, order_id: id, price, range: 'region',
	region_id: region, type_id: type, volume_remain: remain, volume_total: total
});
// /markets/{region}/orders
const theirs = ({ id, type = T, price, remain = 1, total = remain, issued, loc = D, buy = false }) => ({
	duration: 90, is_buy_order: buy, issued, location_id: loc, min_volume: 1, order_id: id, price,
	range: buy ? 'station' : 'region', system_id: SYSTEM, type_id: type, volume_remain: remain, volume_total: total
});
// path rows: [at, price, volumeRemain, issued]
const pathOf = (rows) => rows.map(([at, price, volumeRemain, issued]) => ({ at, price, volumeRemain, issued }));
const logEntry = ({ type = T, loc = D, region = REGION, total, path, end = null, isBuy = false }) => {
	const p = pathOf(path);
	return {
		typeId: type, locationId: loc, regionId: region, isBuy, volumeTotal: total !== undefined ? total : p[0].volumeRemain,
		duration: 90, firstSeen: p[0].at, lastSeen: end ? p[p.length - 1].at : ago(10 * MIN), path: p, end
	};
};
const bookLogOrder = ({ loc = D, path, isBuy = false }) => {
	const p = pathOf(path);
	return {
		isBuy, locationId: loc, systemId: SYSTEM, volumeTotal: p[0].volumeRemain, duration: 90, minVolume: 1, range: 'region',
		firstSeen: p[0].at, lastSeen: p[p.length - 1].at, path: p
	};
};
const bookOf = (orders, fetchedAt = ago(5 * MIN)) => ({ fetchedAt, orders });
const historyDay = (ageDays, volume, orderCount = 4, price = 100) => ({ date: dayOf(ageDays), average: price, highest: price, lowest: price, order_count: orderCount, volume });
const flatHistory = (volume, days = 30) => Array.from({ length: days }, (_, i) => historyDay(days - i, volume));
let nextTx = 7000000000;
// A results-calc facts.sells row (one per lot a sale drew from).
const sellFact = ({ date, type = T, char = GRANT, qty = 1, price, txId, profit = 0, tax = 0, broker = 0, relist = 0, lotId = 'L1', daysSinceListed = null }) => ({
	date, eveHour: new Date(date).getUTCHours(), typeId: type, characterId: char, sellTxId: txId !== undefined ? txId : ++nextTx,
	qty, unitPrice: price, gross: qty * price, tax, brokerShare: broker, relistShare: relist, profit, lotId, daysSinceListed
});
const lotFact = ({ type = T, qty, sold = 0, unitPrice, haul = 0, fee = 0, withRemaining = true }) => {
	const l = { lotId: `L${type}-${unitPrice}`, typeId: type, qty, soldQty: sold, unitPrice, haulPerUnit: haul, buyFeePerUnit: fee };
	if (withRemaining) l.remainingQty = qty - sold;
	return l;
};
// fees: [[date, cost]], the first being the listing
const relistFact = ({ orderId, char = GRANT, type = T, isBuy = false, fees, firstSeenAt = null }) => ({
	orderId, characterId: char, typeId: type, locationId: D, isBuy, firstSeenAt,
	fees: fees.map(([date, cost], i) => ({ id: 26000000000 + orderId * 10 + i, date, amount: -cost, kind: i === 0 ? 'listing' : 'relist' })),
	feeTotal: fees.reduce((acc, [, cost]) => acc + cost, 0), relistCount: Math.max(0, fees.length - 1)
});

const baseInput = () => ({
	characterIds: [GRANT], openOrders: {}, orderLogs: {}, books: {}, bookLogs: {}, history: {},
	facts: { sells: [], lots: [], relists: [] }, observedTaxRate: 0.0337, stations: {}, thresholds: {}, now: NOW
});
const run = (over = {}) => compute({ ...baseInput(), ...over });
const rowOf = (out, orderId) => out.rows.find(r => r.orderId === orderId);

//--- thresholds

test('default thresholds copy estimate.js for the shared ones', () => {
	assert.equal(defaultThresholds.minRoi, estimate.defaultConfig.MIN_ROI);
	assert.equal(defaultThresholds.halfLifeDays, estimate.defaultConfig.RECENCY_HALF_LIFE_DAYS);
	assert.equal(defaultThresholds.daysConsidered, estimate.defaultConfig.DAYS_CONSIDERED);
	assert.equal(defaultThresholds.leaveHours, 8);
	assert.equal(defaultThresholds.undercutDays, 2);
	assert.equal(defaultThresholds.scope, 'station');
	assert.equal(defaultThresholds.clusterGapMs, 10 * MIN);
	assert.equal(defaultThresholds.windowMs, 7 * DAY);
	const out = run({ thresholds: { scope: 'galaxy', leaveHours: null, undercutDays: 3 } });
	assert.equal(out.thresholds.scope, 'station');
	assert.equal(out.thresholds.leaveHours, 8);
	assert.equal(out.thresholds.undercutDays, 3);
	assert.ok(out.warnings.some(w => w.includes('galaxy')));
});

//--- position (rule 2)

test("Grant's order 7467834499 at 21.12 M behind no one is on top", () => {
	const order = mine({ id: 7467834499, price: 21120000, remain: 3, issued: ago(6 * HOUR) });
	const out = run({
		openOrders: { [GRANT]: [order] },
		books: { [T]: { [REGION]: bookOf([
			theirs({ id: 7467834499, price: 21120000, remain: 3, issued: ago(6 * HOUR) }), // ours, matched by order_id
			theirs({ id: 7460000001, price: 21940000, remain: 2, issued: ago(30 * HOUR) }),
			theirs({ id: 7460000002, price: 22500000, remain: 1, issued: ago(3 * HOUR) }),
			theirs({ id: 7460000003, price: 18000000, remain: 5, issued: ago(1 * HOUR), buy: true })
		]) } },
		stations: { [D]: { name: 'Amarr VIII (Oris) - Emperor Family Academy', regionId: REGION, systemId: SYSTEM } }
	});
	const r = rowOf(out, 7467834499);
	assert.equal(r.stationName, 'Amarr VIII (Oris) - Emperor Family Academy');
	assert.equal(r.unitsAhead, 0);
	assert.equal(r.ordersAhead, 0);
	assert.equal(r.rank, 1);
	assert.equal(r.bestPrice, 21120000);
	assert.equal(r.gapToBest, 0);
	assert.deepEqual(r.cheaperElsewhere, { orders: 0, units: 0 });
	assert.equal(r.undercutAt, null);
	assert.equal(r.matchPrice, null);
	assert.equal(r.marginIfMatch, null);
	assert.equal(r.onTopFor, 6 * HOUR);
	assert.equal(r.verdict, 'top');
	assert.equal(r.reason, '');
	assert.equal(r.reasonText, 'nothing is priced below this order');
	assert.equal(r.bookFetchedAt, ago(5 * MIN));
});

// Our order at 100 M issued 10 h ago, against: a cheaper one (A), an equal older one (B), an equal
// newer one (C), an equal one issued the same second (E), a dearer one (F), a cheaper (G) and an equal
// older (H) one at another station, our own other order below us (Ivan's), and our order itself.
const positionFixture = () => ({
	openOrders: {
		[GRANT]: [mine({ id: 1, price: 100 * M, remain: 5, issued: ago(10 * HOUR) })],
		[IVAN]: [mine({ id: 2, price: 99.5 * M, remain: 2, issued: ago(9 * HOUR) })]
	},
	books: { [T]: { [REGION]: bookOf([
		theirs({ id: 1, price: 100 * M, remain: 5, issued: ago(10 * HOUR) }),
		theirs({ id: 2, price: 99.5 * M, remain: 2, issued: ago(9 * HOUR) }),
		theirs({ id: 101, price: 99 * M, remain: 3, issued: ago(20 * HOUR) }),
		theirs({ id: 102, price: 100 * M, remain: 4, issued: ago(12 * HOUR) }),
		theirs({ id: 103, price: 100 * M, remain: 7, issued: ago(2 * HOUR) }),
		theirs({ id: 104, price: 100 * M, remain: 6, issued: ago(10 * HOUR) }),
		theirs({ id: 105, price: 101 * M, remain: 1, issued: ago(30 * HOUR) }),
		theirs({ id: 106, price: 98 * M, remain: 9, issued: ago(40 * HOUR), loc: ELSEWHERE }),
		theirs({ id: 107, price: 100 * M, remain: 2, issued: ago(20 * HOUR), loc: ELSEWHERE }),
		theirs({ id: 108, price: 90 * M, remain: 50, issued: ago(1 * HOUR), buy: true })
	]) } }
});

test('position at the station: strictly cheaper, plus equal-priced orders issued before ours', () => {
	const r = rowOf(run(positionFixture()), 1);
	assert.equal(r.unitsAhead, 3 + 4);
	assert.equal(r.ordersAhead, 2);
	assert.equal(r.rank, 3);
	assert.equal(r.bestPrice, 99 * M);
	approx(r.gapToBest, (100 - 99) / 99, 1e-12);
	assert.deepEqual(r.cheaperElsewhere, { orders: 1, units: 9 }); // equal-priced 107 is not cheaper
	assert.deepEqual(r.ownAhead, { orders: 1, units: 2 }); // Ivan's order is ours, never competition
	assert.equal(r.undercutAt, null); // both orders ahead predate ours: we chose to list behind them
	assert.equal(r.undercutBy, null);
	assert.equal(r.matchPrice, 99 * M - 0.01);

	// with only Ivan's order below us we are on top
	const fixture = positionFixture();
	fixture.books[T][REGION].orders = fixture.books[T][REGION].orders.filter(b => [1, 2, 105].includes(b.order_id));
	const alone = rowOf(run(fixture), 1);
	assert.equal(alone.verdict, 'top');
	assert.equal(alone.reason, 'own ahead');
	assert.equal(alone.reasonText, 'only our own orders are ahead, which do not count');
	assert.equal(alone.bestPrice, 100 * M);
});

test('position over the region: every station counts, no cheaper-elsewhere note', () => {
	const r = rowOf(run({ ...positionFixture(), thresholds: { scope: 'region' } }), 1);
	assert.equal(r.unitsAhead, 3 + 4 + 9 + 2);
	assert.equal(r.ordersAhead, 4);
	assert.equal(r.rank, 5);
	assert.equal(r.bestPrice, 98 * M);
	assert.equal(r.cheaperElsewhere, null);
});

//--- undercut (rule 3)

test('undercutAt: the earliest order ahead issued after ours, dated by the book log; re-undercuts make a price war', () => {
	const order = mine({ id: 1, price: 100 * M, remain: 5, issued: ago(10 * HOUR) });
	const book = bookOf([
		theirs({ id: 201, price: 99 * M, remain: 1, issued: ago(20 * HOUR) }),    // ahead, predates ours
		theirs({ id: 202, price: 98.5 * M, remain: 2, issued: ago(4 * HOUR) }),   // ahead, re-priced 4 h ago
		theirs({ id: 203, price: 99.9 * M, remain: 1, issued: ago(2 * HOUR) })    // ahead, placed 2 h ago
	]);
	const input = { openOrders: { [GRANT]: [order] }, books: { [T]: { [REGION]: book } } };

	// Without a book log the current issued is all there is: 202 at 4 h.
	const plain = rowOf(run(input), 1);
	assert.equal(plain.undercutAt, ago(4 * HOUR));
	assert.equal(plain.undercutBy.orderId, 202);
	assert.equal(plain.undercutBy.price, 98.5 * M);
	assert.equal(plain.undercutBy.volumeRemain, 2);
	assert.equal(plain.undercutBy.issued, ago(4 * HOUR));
	approx(plain.undercutBy.gap, (100 - 98.5) / 98.5, 1e-12);
	assert.equal(plain.reUndercuts, null);
	assert.equal(plain.priceWar, false);
	assert.ok(plain.badges.includes('nobooklog'));

	// The log shows 202 above us at first, below us 8 h ago, lower again 4 h ago.
	const bookLog = { samples: [{ at: ago(29 * HOUR), stored: true }, { at: ago(3 * HOUR), stored: true }], orders: {
		202: bookLogOrder({ path: [
			[ago(29 * HOUR), 101 * M, 2, ago(30 * HOUR)],
			[ago(7 * HOUR), 99.5 * M, 2, ago(8 * HOUR)],
			[ago(3 * HOUR), 98.5 * M, 2, ago(4 * HOUR)]
		] }),
		203: bookLogOrder({ path: [[ago(1 * HOUR), 99.9 * M, 1, ago(2 * HOUR)]] })
	} };
	const logged = rowOf(run({ ...input, bookLogs: { [T]: { [REGION]: bookLog } } }), 1);
	assert.equal(logged.undercutAt, ago(8 * HOUR));
	assert.equal(logged.undercutBy.orderId, 202);
	assert.equal(logged.undercutBy.issued, ago(4 * HOUR));
	assert.equal(logged.reUndercuts, 2); // 8 h and 4 h ago, both leaving it below us
	assert.equal(logged.priceWar, true);
	assert.ok(logged.badges.includes('priceWar'));
});

test('two re-undercuts more than 24 h apart are no price war; a change before our issued does not count', () => {
	const order = mine({ id: 1, price: 100 * M, remain: 5, issued: ago(60 * HOUR) });
	const bookLog = { samples: [], orders: {
		301: bookLogOrder({ path: [
			[ago(70 * HOUR), 102 * M, 1, ago(70 * HOUR)],
			[ago(64 * HOUR), 100.5 * M, 1, ago(65 * HOUR)], // before our issued, still above us
			[ago(49 * HOUR), 99.7 * M, 1, ago(50 * HOUR)],
			[ago(19 * HOUR), 99.6 * M, 1, ago(20 * HOUR)]
		] })
	} };
	// a change below us before our issued is not counted either (such an order was ahead when we
	// listed, so rule 3 never names it the undercutter; see the re-issue test below)
	const early = pathOf([[ago(70 * HOUR), 102 * M, 1, ago(70 * HOUR)], [ago(64 * HOUR), 99.8 * M, 1, ago(65 * HOUR)], [ago(49 * HOUR), 99.7 * M, 1, ago(50 * HOUR)]])
		.map(e => ({ atMs: Date.parse(e.at), price: e.price, volumeRemain: e.volumeRemain, issuedMs: Date.parse(e.issued) }));
	assert.deepEqual(ordersCalc._internal.reUndercutsOf(early, 100 * M, NOW_MS - 60 * HOUR), { count: 1, priceWar: false });
	const r = rowOf(run({
		openOrders: { [GRANT]: [order] },
		books: { [T]: { [REGION]: bookOf([theirs({ id: 301, price: 99.6 * M, issued: ago(20 * HOUR) })]) } },
		bookLogs: { [T]: { [REGION]: bookLog } }
	}), 1);
	assert.equal(r.undercutAt, ago(50 * HOUR));
	assert.equal(r.reUndercuts, 2);
	assert.equal(r.priceWar, false);
});

//--- time on top (rule 5)

// Grant's order 7 held 105 M (70 h ago), 102 M (40 h ago) and holds 100 M (10 h ago). Competitor X
// was placed at 104 M 65 h ago but first sampled at 60 h (hourly samples); Y undercut 102 M with
// several changes, the first one sampled being issued 37 h ago. Order 9 ended (filled) uncut; order 8
// is older than 90 days. Ivan's order below us does not count. Type T2 has one 1 h episode.
const episodeFixture = () => ({
	characterIds: [GRANT, IVAN],
	openOrders: { [GRANT]: [mine({ id: 7, price: 100 * M, remain: 3, issued: ago(10 * HOUR) })] },
	orderLogs: {
		[GRANT]: {
			7: logEntry({ path: [
				[ago(70 * HOUR), 105 * M, 3, ago(70 * HOUR)],
				[ago(40 * HOUR), 102 * M, 3, ago(40 * HOUR)],
				[ago(10 * HOUR), 100 * M, 3, ago(10 * HOUR)]
			] }),
			9: logEntry({ path: [[ago(80 * HOUR), 103 * M, 2, ago(80 * HOUR)]], end: { state: 'expired', volumeRemain: 0, at: ago(75 * HOUR) } }),
			8: logEntry({ path: [[ago(100 * DAY), 110 * M, 1, ago(100 * DAY)]], end: { state: 'expired', volumeRemain: 0, at: ago(99 * DAY) } }),
			11: logEntry({ type: T2, path: [[ago(30 * HOUR), 50 * M, 1, ago(30 * HOUR)]], end: { state: 'expired', volumeRemain: 0, at: ago(20 * HOUR) } })
		},
		[IVAN]: { 12: logEntry({ path: [[ago(5 * HOUR), 90 * M, 1, ago(5 * HOUR)]] }) }
	},
	books: { [T]: { [REGION]: bookOf([
		theirs({ id: 401, price: 104 * M, issued: ago(65 * HOUR) }),
		theirs({ id: 402, price: 100.5 * M, issued: ago(34.5 * HOUR) })
	]) } },
	bookLogs: {
		[T]: { [REGION]: { samples: [{ at: ago(72 * HOUR), stored: true }, { at: ago(1 * HOUR), stored: false }], orders: {
			401: bookLogOrder({ path: [[ago(60 * HOUR), 104 * M, 1, ago(65 * HOUR)]] }),
			402: bookLogOrder({ path: [
				[ago(36 * HOUR), 101.5 * M, 1, ago(37 * HOUR)],
				[ago(35 * HOUR), 101 * M, 1, ago(35.5 * HOUR)],
				[ago(34 * HOUR), 100.5 * M, 1, ago(34.5 * HOUR)]
			] }),
			12: bookLogOrder({ path: [[ago(4 * HOUR), 90 * M, 1, ago(5 * HOUR)]] }), // Ivan's
			403: bookLogOrder({ loc: ELSEWHERE, path: [[ago(8 * HOUR), 95 * M, 1, ago(9 * HOUR)]] })
		} } },
		[T2]: { [REGION]: { samples: [], orders: {
			501: bookLogOrder({ path: [[ago(28 * HOUR), 49 * M, 1, ago(29 * HOUR)]] })
		} } }
	}
});

test('time on top: undercut episodes by issued, a censored current one, the 90-day limit, the pooled median', () => {
	const out = run(episodeFixture());
	const byT = out.timeOnTop.byType[T];
	assert.equal(byT.episodes, 5); // 7 (three prices), 9 and Ivan's 12 (pooled); 8 is older than 90 days
	assert.equal(byT.undercutEpisodes, 2);
	const list = byT.list.filter(e => e.orderId === 7);
	// X's issued (65 h) dates the undercut, though it was first seen at 60 h: 5 h, not 10 h
	assert.equal(list[0].undercutAt, ago(65 * HOUR));
	assert.equal(list[0].undercutBy, 401);
	assert.equal(list[0].timeOnTop, 5 * HOUR);
	// Y's first sampled price below 102 M was issued 37 h ago: 3 h (a change between samples is missed)
	assert.equal(list[1].timeOnTop, 3 * HOUR);
	assert.equal(list[1].undercutPrice, 101.5 * M);
	// the current episode: nobody below 100 M since (Ivan's order is ours; 403 is at another station)
	assert.equal(list[2].current, true);
	assert.equal(list[2].undercut, false);
	assert.equal(list[2].timeOnTop, 10 * HOUR);
	const nine = byT.list.find(e => e.orderId === 9);
	assert.equal(nine.undercut, false);
	assert.equal(nine.timeOnTop, 5 * HOUR); // censored at its end
	const ivans = byT.list.find(e => e.orderId === 12);
	assert.equal(ivans.characterId, IVAN);
	assert.equal(ivans.undercut, false);
	assert.equal(ivans.timeOnTop, 5 * HOUR); // censored at now
	assert.equal(byT.medianTimeOnTop, 4 * HOUR);
	assert.equal(byT.est, true);
	assert.equal(byT.onTopFor, 10 * HOUR);
	assert.equal(byT.bookLogSince, ago(72 * HOUR));

	const r = rowOf(out, 7);
	assert.equal(r.verdict, 'top');
	assert.equal(r.onTopFor, 10 * HOUR);
	assert.equal(r.episodes, 5);
	assert.equal(r.medianTimeOnTop, 4 * HOUR);
	assert.ok(r.badges.includes('est'));
	assert.equal(r.relistCount, 2);

	assert.equal(out.timeOnTop.byType[T2].medianTimeOnTop, 1 * HOUR);
	assert.deepEqual(out.timeOnTop.overall, { episodes: 6, undercutEpisodes: 3, medianTimeOnTop: 3 * HOUR, est: false });
});

test('time on top over the region counts a cheaper order at another station', () => {
	const out = run({ ...episodeFixture(), thresholds: { scope: 'region' } });
	const current = out.timeOnTop.byType[T].list.find(e => e.orderId === 7 && e.current);
	assert.equal(current.undercut, true);
	assert.equal(current.undercutBy, 403);
	assert.equal(current.timeOnTop, 1 * HOUR);
});

test('episodes: one per issued, ending at the next issued, the order end or now', () => {
	const rec = {
		path: [
			{ atMs: 1000, price: 10, volumeRemain: 5, issuedMs: 500 },
			{ atMs: 2000, price: 10, volumeRemain: 4, issuedMs: 500 },
			{ atMs: 3000, price: 9, volumeRemain: 4, issuedMs: 2500 }
		],
		end: null
	};
	assert.deepEqual(episodesOf(rec, 9000), [
		{ start: 500, price: 10, end: 2500, current: false },
		{ start: 2500, price: 9, end: 9000, current: true }
	]);
	assert.deepEqual(episodesOf({ ...rec, end: { atMs: 4000 } }, 9000)[1], { start: 2500, price: 9, end: 4000, current: false });
});

//--- demand (rule 4)

test('daily volume: recency-weighted over every calendar day of the window; null without history', () => {
	const order = mine({ id: 1, price: 100 * M, remain: 1, issued: ago(HOUR) });
	const volumeOf = (rows) => rowOf(run({ openOrders: { [GRANT]: [order] }, history: { [T]: rows } }), 1).dailyVolume;
	assert.equal(volumeOf(flatHistory(8)), 8);
	let weightTotal = 0;
	for (let age = 1; age <= 30; age++) weightTotal += recencyWeight(age, 30);
	approx(volumeOf([historyDay(30, 1000)]), 1000 * 0.5 / weightTotal);
	approx(volumeOf([historyDay(0, 10)]), 10 * recencyWeight(1, 30) / weightTotal); // today counts as age 1
	assert.equal(volumeOf([historyDay(31, 1000)]), 0);
	assert.equal(volumeOf([]), null);
	assert.equal(volumeOf(undefined), null);
});

test('typical trade: the median of our own sales (a split sale counts once), else the history fallback', () => {
	const order = mine({ id: 1, price: 100 * M, remain: 1, issued: ago(HOUR) });
	const own = [
		sellFact({ date: ago(2 * DAY), qty: 1, price: 100 * M }),
		sellFact({ date: ago(3 * DAY), qty: 1, price: 100 * M, txId: 42, lotId: 'a' }), // one sale of 2 from two lots
		sellFact({ date: ago(3 * DAY), qty: 1, price: 100 * M, txId: 42, lotId: 'b' }),
		sellFact({ date: ago(10 * DAY), qty: 5, price: 100 * M }),
		sellFact({ date: ago(40 * DAY), qty: 9, price: 100 * M }),
		sellFact({ date: ago(89 * DAY), qty: 2, price: 100 * M }),
		sellFact({ date: ago(100 * DAY), qty: 50, price: 100 * M }), // older than 90 days
		sellFact({ date: ago(1 * DAY), qty: 70, price: 100 * M, char: IVAN }) // not a pooled character here
	];
	const history = [historyDay(1, 10, 5), historyDay(2, 9, 3)];
	const fromSales = rowOf(run({ openOrders: { [GRANT]: [order] }, history: { [T]: history }, facts: { sells: own, lots: [], relists: [] } }), 1);
	assert.equal(fromSales.typicalTrade, 2); // median of 1, 2, 5, 9, 2
	assert.equal(fromSales.typicalTradeFrom, 'sales');
	approx(fromSales.myRate7d, 3 / 7);

	const fewer = own.slice(0, 5); // four sales
	const fallback = rowOf(run({ openOrders: { [GRANT]: [order] }, history: { [T]: history }, facts: { sells: fewer, lots: [], relists: [] } }), 1);
	const w1 = recencyWeight(1, 30);
	const w2 = recencyWeight(2, 30);
	approx(fallback.typicalTrade, (w1 * 10 / 5 + w2 * 9 / 3) / (w1 + w2));
	assert.equal(fallback.typicalTradeFrom, 'history');

	const none = rowOf(run({ openOrders: { [GRANT]: [order] }, facts: { sells: fewer, lots: [], relists: [] } }), 1);
	assert.equal(none.typicalTrade, null);
	assert.equal(none.typicalTradeFrom, null);
});

//--- economics (rule 6)

test('landed cost over the FIFO remainder of the type, qty-weighted; nocost when nothing remains', () => {
	const order = mine({ id: 1, price: 200, remain: 4, issued: ago(HOUR) });
	const lots = [
		lotFact({ qty: 3, sold: 3, unitPrice: 50 }),                                   // sold out
		lotFact({ qty: 4, sold: 2, unitPrice: 100, haul: 10, fee: 1 }),                // 2 left at 111
		lotFact({ qty: 2, sold: 0, unitPrice: 120, haul: 10, fee: 1, withRemaining: false }), // 2 left at 131
		lotFact({ type: T2, qty: 9, unitPrice: 1 })
	];
	const r = rowOf(run({ openOrders: { [GRANT]: [order] }, observedTaxRate: 0.04, facts: { sells: [], lots, relists: [] } }), 1);
	assert.equal(r.landedCost, (111 * 2 + 131 * 2) / 4);
	assert.equal(r.landedUnits, 4);
	assert.equal(r.marginNow, 200 * (1 - 0.04) - 121);
	assert.ok(!r.badges.includes('nocost'));

	const soldOut = rowOf(run({ openOrders: { [GRANT]: [order] }, facts: { sells: [], lots: lots.slice(0, 1), relists: [] } }), 1);
	assert.equal(soldOut.landedCost, null);
	assert.equal(soldOut.marginNow, null);
	assert.ok(soldOut.badges.includes('nocost'));
});

test('fee estimate: this order\'s relist fees, else the character\'s on the type, else nofee', () => {
	const orders = [
		mine({ id: 80, price: 100 * M, remain: 1, issued: ago(HOUR) }),
		mine({ id: 81, price: 100 * M, remain: 1, issued: ago(HOUR) }),
		mine({ id: 83, type: T2, price: 100 * M, remain: 1, issued: ago(HOUR) })
	];
	const relists = [
		relistFact({ orderId: 80, fees: [[ago(5 * DAY), 100], [ago(4 * DAY), 30], [ago(3 * DAY), 50], [ago(2 * DAY), 10]] }),
		relistFact({ orderId: 81, fees: [[ago(5 * DAY), 900]] }),                    // a listing only
		relistFact({ orderId: 82, fees: [[ago(9 * DAY), 100], [ago(8 * DAY), 70]] }), // ended, same type
		relistFact({ orderId: 84, char: IVAN, fees: [[ago(9 * DAY), 100], [ago(8 * DAY), 5000]] }), // another character
		relistFact({ orderId: 85, type: T2, isBuy: true, fees: [[ago(9 * DAY), 100], [ago(8 * DAY), 5000]] }) // a buy order
	];
	const out = run({ openOrders: { [GRANT]: orders }, facts: { sells: [], lots: [], relists } });
	const r80 = rowOf(out, 80);
	assert.equal(r80.feeEstimate, 30);
	assert.equal(r80.feeEstimateFrom, 'order');
	assert.equal(r80.relistFees, 90);
	assert.equal(r80.listingFee, 100);
	assert.equal(r80.feeTotal, 190);
	const r81 = rowOf(out, 81);
	assert.equal(r81.feeEstimate, 40); // median of 30, 50, 10, 70
	assert.equal(r81.feeEstimateFrom, 'type');
	assert.equal(r81.relistFees, 0);
	const r83 = rowOf(out, 83);
	assert.equal(r83.feeEstimate, null);
	assert.equal(r83.feeEstimateFrom, null);
	assert.ok(r83.badges.includes('nofee'));
	assert.equal(r83.relistFees, null);
});

//--- the relist-fee rate (rule 6, decision 15)

// One of our sell orders cut from price + 10 (price - 10 with `rise`) to `price`, `cutAgo` before now,
// with its listing fee and the fee row of that cut `feeLag` after its issued: `rate` of price × remain
// unless `fee` is given. Its path is in the order log, or only in the relist facts' pricePath.
const cutOrder = ({ id, char = GRANT, type = T2, loc = D, cutAgo, rate, price = 1000, remain = 10, fee, rise = false, logged = true, feeLag = 1000 }) => {
	const path = [
		[ago(cutAgo + 2 * HOUR), rise ? price - 10 : price + 10, remain, ago(cutAgo + 3 * HOUR)],
		[ago(cutAgo - 10 * MIN), price, remain, ago(cutAgo)]
	];
	const relist = { ...relistFact({ orderId: id, char, type, fees: [[ago(cutAgo + 3 * HOUR), 99], [iso(NOW_MS - cutAgo + feeLag), fee !== undefined ? fee : rate * price * remain]] }), locationId: loc };
	if (!logged) relist.pricePath = pathOf(path);
	return { id, char, log: logged ? logEntry({ type, loc, path }) : null, relist };
};
const feeInput = (cuts, open = [], books = {}) => {
	const orderLogs = { [GRANT]: {} };
	for (const c of cuts) if (c.log) (orderLogs[c.char] = orderLogs[c.char] || {})[c.id] = c.log;
	return { characterIds: [GRANT, IVAN], openOrders: { [GRANT]: open }, orderLogs, books, facts: { sells: [], lots: [], relists: cuts.map(c => c.relist) } };
};
// Our order alone in the book, or behind `ahead` at `aheadPrice`.
const bookFor = (order, ahead = 0, aheadPrice = null) => ({ [order.type_id]: { [REGION]: bookOf([
	theirs({ id: order.order_id, type: order.type_id, price: order.price, remain: order.volume_remain, issued: order.issued, loc: order.location_id }),
	...(ahead > 0 ? [theirs({ id: 990000, type: order.type_id, price: aheadPrice, remain: ahead, issued: ago(50 * HOUR), loc: order.location_id })] : [])
]) } });

test("fee rate on Grant's real numbers: 135,879 for a cut to 37,190 with 695 left is 0.525 %", () => {
	const order = mine({ id: 7471777610, type: SKIN, price: 37190, remain: 652, total: 1000, issued: '2026-11-25T07:55:00Z' });
	const relist = { ...relistFact({ orderId: 7471777610, type: SKIN, fees: [['2026-11-21T09:00:01Z', 140000], ['2026-11-25T07:55:01Z', 135879]] }), locationId: D };
	const input = {
		openOrders: { [GRANT]: [order] },
		orderLogs: { [GRANT]: { 7471777610: logEntry({ type: SKIN, total: 1000, path: [
			['2026-11-24T12:00:00Z', 37240, 695, '2026-11-21T09:00:00Z'],
			['2026-11-25T08:00:00Z', 37190, 695, '2026-11-25T07:55:00Z']
		] }) } },
		facts: { sells: [], lots: [], relists: [relist] }
	};
	const rate = 135879 / (37190 * 695);
	approx(rate, 0.00525, 1e-5);
	const top = run({ ...input, books: bookFor(order) });
	const r = rowOf(top, 7471777610);
	assert.equal(r.verdict, 'top');
	assert.equal(r.feeRate, rate);
	assert.equal(r.feeRateRows, 1);
	assert.equal(r.feeRateSince, '2026-11-25T07:55:01Z');
	assert.equal(r.feeRateScope, 'station');
	assert.equal(r.feeRateEst, true);
	assert.equal(r.feeEstimateFrom, 'rate');
	assert.equal(r.feeEstimate, rate * 37190 * 652); // a top row: its own price, what is left now
	assert.deepEqual(top.feeRates, { [GRANT]: { [D]: {
		rate, rows: 1, since: '2026-11-25T07:55:01Z', est: true,
		observations: [{ date: '2026-11-25T07:55:01Z', rate, orderId: 7471777610, typeId: SKIN }]
	} } });

	const behind = rowOf(run({ ...input, books: bookFor(order, 3, 37100) }), 7471777610);
	assert.equal(behind.matchPrice, 37100 - 0.01);
	assert.equal(behind.feeEstimate, rate * (37100 - 0.01) * 652);
});

test('fee rate: the median of the newest five follows a step (0.525 % to 0.600 %) rather than averaging it', () => {
	const older = [4, 5, 6, 7, 8, 9, 10, 11].map((days, i) => cutOrder({ id: 300 + i, type: 700 + i, cutAgo: days * DAY, rate: 0.00525 }));
	const newer = [2, 4, 8, 12].map((hours, i) => cutOrder({ id: 400 + i, type: 800 + i, cutAgo: hours * HOUR, rate: 0.006 }));
	const order = mine({ id: 500, type: T2, price: 1000, remain: 10, issued: ago(DAY) });
	const out = run(feeInput([...older, ...newer], [order], bookFor(order)));
	const atD = out.feeRates[GRANT][D];
	assert.equal(atD.rate, 0.006); // 0.006 × 4 and the newest 0.00525
	assert.equal(atD.rows, 5);
	assert.equal(atD.est, false);
	assert.equal(atD.since, iso(NOW_MS - 4 * DAY + 1000));
	assert.equal(atD.observations.length, 12);
	assert.deepEqual(atD.observations.slice(0, 5).map(o => o.rate), [0.006, 0.006, 0.006, 0.006, 0.00525]);
	const r = rowOf(out, 500);
	assert.equal(r.feeRate, 0.006);
	assert.equal(r.feeRateEst, false);
	approx(r.feeEstimate, 60, 1e-9);

	// four observations: est
	const few = run(feeInput(newer, [order], bookFor(order)));
	assert.equal(few.feeRates[GRANT][D].est, true);
	assert.equal(rowOf(few, 500).feeRateRows, 4);
	assert.equal(rowOf(few, 500).feeRateEst, true);
});

test('fee rate: a price rise, a fee more than 2.5 s off and a rate over 5 % are not observations', () => {
	const cuts = [
		cutOrder({ id: 601, cutAgo: 2 * HOUR, rate: 0.006 }),                     // the one observation
		cutOrder({ id: 602, cutAgo: 3 * HOUR, rate: 0.006, rise: true }),         // matched in time, but a rise
		cutOrder({ id: 603, cutAgo: 4 * HOUR, rate: 0.006, feeLag: 3000 }),       // 3 s after the issued
		cutOrder({ id: 604, cutAgo: 5 * HOUR, rate: 0.06 }),                      // 6 %: a mismatch
		cutOrder({ id: 605, cutAgo: 6 * HOUR, rate: 0.00525, logged: false })     // known from its pricePath only
	];
	const out = run(feeInput(cuts));
	assert.deepEqual(out.feeRates[GRANT][D].observations.map(o => o.orderId), [601, 605]);
	assert.equal(out.feeRates[GRANT][D].rate, (0.006 + 0.00525) / 2);
});

test('fee rate: a relist\'s pricePath keeps results-calc\'s at-null states last: a raise after the last snapshot is no cut, a cut is one', () => {
	// Built through results-calc compute so the pricePath has its real shape: the open and final states
	// carry `at: null` and come after the snapshot entries. Our 77, no order log: listed at 1,000,000 x 10
	// 32 h ago (a 2 % listing fee), seen by the 30 h snapshot, re-priced 20 h ago (its fee row a second
	// later) and expired at that price.
	const factsOf = (laterPrice, laterFee) => resultsCalc.compute({
		characterIds: [GRANT], route: { endStationId: D, endRegionId: REGION }, m3: {}, now: NOW,
		ledgers: { [GRANT]: {
			transactions: [], contracts: [], contractItems: {},
			journal: [[26000000001, ago(32 * HOUR), 200000], [26000000002, iso(NOW_MS - 20 * HOUR + 1000), laterFee]].map(([id, date, fee]) => ({
				id, amount: -fee, balance: 0, date, description: 'Market order commission', first_party_id: GRANT, second_party_id: 1000035, reason: '', ref_type: 'brokers_fee'
			})),
			ordersHistory: [{ ...mine({ id: 77, price: laterPrice, remain: 10, issued: ago(20 * HOUR) }), state: 'expired' }],
			snapshots: [{ syncedAt: ago(30 * HOUR), orders: [mine({ id: 77, price: 1e6, remain: 10, issued: ago(32 * HOUR) })], assets: [], balance: 0 }]
		} }
	}).facts;
	const raised = factsOf(1.2e6, 60000);
	assert.deepEqual(raised.relists.find(r => r.orderId === 77).pricePath.map(p => [p.at, p.price, p.source]), [[ago(30 * HOUR), 1e6, 'snapshot'], [null, 1.2e6, 'history']]);
	assert.deepEqual(run({ facts: raised }).feeRates, {}); // not the 2 % listing fee as a relist rate

	const cut = run({ facts: factsOf(0.9e6, 45000) }).feeRates[GRANT][D].observations;
	assert.deepEqual(cut.map(o => [o.date, o.rate, o.orderId]), [[iso(NOW_MS - 20 * HOUR + 1000), 0.005, 77]]);
});

test('fee rate: a station without observations borrows the character\'s; fee scales with what is left; medians only without a rate', () => {
	const cuts = [
		cutOrder({ id: 701, cutAgo: 2 * HOUR, rate: 0.006 }),
		cutOrder({ id: 702, char: IVAN, cutAgo: 2 * HOUR, rate: 0.01 }) // Ivan's rate is his own
	];
	const full = mine({ id: 710, price: 1000, remain: 10, issued: ago(DAY) });
	const half = mine({ id: 711, price: 1000, remain: 5, total: 10, issued: ago(DAY) });
	const away = mine({ id: 712, price: 1000, remain: 10, issued: ago(DAY), loc: ELSEWHERE });
	const input = feeInput(cuts, [full, half, away]);
	input.facts.relists.push(relistFact({ orderId: 710, fees: [[ago(30 * HOUR), 100], [ago(20 * HOUR), 77]] })); // its own relist fee
	const out = run(input);
	const rFull = rowOf(out, 710);
	const rHalf = rowOf(out, 711);
	const rAway = rowOf(out, 712);
	assert.equal(rFull.feeEstimateFrom, 'rate'); // its own median (77) is only a fallback
	approx(rFull.feeEstimate, 0.006 * 1000 * 10, 1e-9);
	assert.equal(rHalf.feeEstimate, rFull.feeEstimate / 2); // a half-sold order pays half
	assert.equal(rAway.feeRateScope, 'character');
	assert.equal(rAway.feeRate, 0.006);
	assert.equal(rAway.feeEstimateFrom, 'rate');
	assert.deepEqual(Object.keys(out.feeRates).map(Number).sort(), [IVAN, GRANT].sort());
	assert.equal(out.feeRates[IVAN][D].rate, 0.01);

	// no observed rate anywhere: the old medians, then nofee
	const none = run({ ...feeInput([], [full, half]), facts: { sells: [], lots: [], relists: [relistFact({ orderId: 710, fees: [[ago(30 * HOUR), 100], [ago(20 * HOUR), 77]] })] } });
	assert.deepEqual(none.feeRates, {});
	assert.equal(rowOf(none, 710).feeEstimateFrom, 'order');
	assert.equal(rowOf(none, 710).feeEstimate, 77);
	assert.equal(rowOf(none, 710).feeRate, null);
	assert.equal(rowOf(none, 710).feeRateScope, null);
	assert.equal(rowOf(none, 710).feeRateRows, 0);
	assert.equal(rowOf(none, 711).feeEstimateFrom, 'type');
});

//--- verdict (rule 7)

// One open order of `type` at 210 behind a competitor at 200.01 holding `ahead` units (issued before
// ours), 8 units a day of history (dailyVolume exactly 8), five own sales of `trade` units 20 days ago,
// a tax of 25 % (so matching at 200 nets 150) and, unless `landed` is null, one unit left at `landed`.
// `episode` adds an ended order undercut after that many ms (the type's time on top); `fees` are this
// order's fee rows.
const verdictPieces = ({ type = T2, orderId = 50, ahead, trade = 1, landed = 100, remain = 5, episode = null, fees = null, history = flatHistory(8) }) => {
	const issued = ago(10 * HOUR);
	const pieces = {
		openOrders: [mine({ id: orderId, type, price: 210, remain, issued })],
		books: { [type]: { [REGION]: bookOf([
			theirs({ id: orderId, type, price: 210, remain, issued }),
			...(ahead > 0 ? [theirs({ id: orderId * 100 + 1, type, price: 200.01, remain: ahead, issued: ago(20 * HOUR) })] : [])
		]) } },
		history: { [type]: history },
		sells: Array.from({ length: 5 }, () => sellFact({ type, date: ago(20 * DAY), qty: trade, price: 205 })),
		lots: landed === null ? [] : [lotFact({ type, qty: 1, unitPrice: landed })],
		relists: fees === null ? [] : [relistFact({ orderId, type, fees })],
		orderLogs: {},
		bookLogs: {}
	};
	if (episode !== null) {
		pieces.orderLogs[orderId * 100 + 2] = logEntry({ type, path: [[ago(50 * HOUR), 205, 1, ago(50 * HOUR)]], end: { state: 'expired', volumeRemain: 0, at: ago(40 * HOUR) } });
		pieces.bookLogs[type] = { [REGION]: { samples: [], orders: {
			[orderId * 100 + 3]: bookLogOrder({ path: [[ago(45 * HOUR), 204, 1, iso(NOW_MS - 50 * HOUR + episode)]] })
		} } };
	}
	return pieces;
};
const runPieces = (list, over = {}) => {
	const input = baseInput();
	input.observedTaxRate = 0.25;
	input.openOrders[GRANT] = [];
	input.orderLogs[GRANT] = {};
	for (const p of list) {
		input.openOrders[GRANT].push(...p.openOrders);
		Object.assign(input.orderLogs[GRANT], p.orderLogs);
		Object.assign(input.books, p.books);
		Object.assign(input.bookLogs, p.bookLogs);
		Object.assign(input.history, p.history);
		input.facts.sells.push(...p.sells);
		input.facts.lots.push(...p.lots);
		input.facts.relists.push(...p.relists);
	}
	return compute({ ...input, ...over, thresholds: { ...(over.thresholds || {}) } });
};
const verdictRow = (spec, over) => runPieces([verdictPieces(spec)], over).rows[0];

test('verdict leave: the queue clears within leaveHours (strictly), or no more ahead than a typical trade', () => {
	const r = verdictRow({ ahead: 2 }); // 2 / 8 days = 6 h
	assert.equal(r.daysBehind, 0.25);
	assert.equal(r.verdict, 'leave');
	assert.equal(r.reason, '6h');
	assert.equal(r.reasonText, '2 units ahead at 8 a day: the queue ahead clears in about 6 hours');

	const atLimit = verdictRow({ ahead: 2 }, { thresholds: { leaveHours: 6 } });
	assert.equal(atLimit.verdict, 'maybe');
	assert.equal(atLimit.reason, '6h');
	assert.equal(atLimit.reasonText, '2 units ahead at 8 a day: 6 hours behind');

	const typical = verdictRow({ ahead: 3, trade: 3 }); // 9 h behind, 3 ahead = one typical trade
	assert.equal(typical.typicalTrade, 3);
	assert.equal(typical.verdict, 'leave');
	assert.equal(typical.reason, '100%');
	assert.equal(typical.reasonText, '3 units ahead are 100 % of a typical trade of 3 units');
	assert.equal(verdictRow({ ahead: 4, trade: 3 }).verdict, 'maybe');
});

test('verdict leave by the typical trade only while less than undercutDays behind (decision 14)', () => {
	// the SKIN case: one unit ahead, typical trade 1, a sale every four or five days
	const sparse = [1, 6, 11, 16, 21, 26].map(age => historyDay(age, 1, 1));
	const r = verdictRow({ ahead: 1, trade: 1, history: sparse });
	assert.equal(r.unitsAhead, 1);
	assert.equal(r.typicalTrade, 1);
	assert.ok(r.dailyVolume > 0.2 && r.dailyVolume < 0.25, String(r.dailyVolume));
	assert.ok(r.daysBehind > 4, String(r.daysBehind));
	assert.equal(r.verdict, 'undercut'); // no fee estimate, no time on top
	const demoted = verdictRow({ ahead: 1, trade: 1, history: sparse, episode: 3 * HOUR, fees: [[ago(30 * HOUR), 100], [ago(20 * HOUR), 60]] });
	assert.equal(demoted.verdict, 'maybe');
	assert.equal(demoted.reason, `fee ${(60 / demoted.expectedGainBeforeUndercut).toFixed(1)}× gain`);
	assert.match(demoted.reason, /^fee \d+\.\d× gain$/);
	// no volume at all: days behind unknown, so not leave either
	assert.equal(verdictRow({ ahead: 1, trade: 1, history: [historyDay(40, 1, 1)] }).verdict, 'maybe');
});

test('verdict reconsider: matching nets no more than the landed cost, or under the ROI floor; skipped without a cost', () => {
	const belowCost = verdictRow({ ahead: 4, trade: 3, landed: 150 }); // 200 * 0.75 = 150 <= 150
	assert.equal(belowCost.matchPrice, 200);
	assert.equal(belowCost.marginIfMatch, 0);
	assert.equal(belowCost.verdict, 'reconsider');
	assert.equal(belowCost.reason, '1.00x');
	assert.equal(belowCost.reasonText, 'matching returns 1.00x the landed cost, at or below cost');

	const belowFloor = verdictRow({ ahead: 4, trade: 3, landed: 100.01 }); // 150 / 100.01 < 1.5
	assert.equal(belowFloor.verdict, 'reconsider');
	assert.equal(belowFloor.reason, '1.49x'); // 1.49985, cut rather than rounded up to the floor
	assert.equal(belowFloor.reasonText, 'matching returns 1.49x the landed cost, under the 1.5x floor');

	const atFloor = verdictRow({ ahead: 4, trade: 3, landed: 100 }); // 150 / 100 = 1.5: not below
	assert.equal(atFloor.roiIfMatch, 0.5);
	assert.equal(atFloor.verdict, 'maybe');

	const noCost = verdictRow({ ahead: 16, trade: 3, landed: null });
	assert.equal(noCost.landedCost, null);
	assert.equal(noCost.roiIfMatch, null);
	assert.ok(noCost.badges.includes('nocost'));
	assert.equal(noCost.verdict, 'undercut');
});

test('verdict undercut from undercutDays behind (inclusive); maybe below it', () => {
	const at = verdictRow({ ahead: 16, trade: 3 });
	assert.equal(at.daysBehind, 2);
	assert.equal(at.verdict, 'undercut');
	assert.equal(at.reason, '2d');
	assert.equal(at.reasonText, '16 units ahead at 8 a day: 2 days behind');
	const below = verdictRow({ ahead: 15, trade: 3 });
	assert.equal(below.daysBehind, 15 / 8);
	assert.equal(below.verdict, 'maybe');
	assert.equal(below.reason, '1.9d');
	assert.equal(below.reasonText, '15 units ahead at 8 a day: 1.9 days behind');
});

test('verdict undercut is demoted to maybe when the expected gain before the next undercut is below the fee', () => {
	// time on top 3 h: 8 a day * 3 h = 1 unit before the next undercut, at a margin of 150 - 100 = 50
	const spec = { ahead: 16, trade: 3, episode: 3 * HOUR };
	const demoted = verdictRow({ ...spec, fees: [[ago(30 * HOUR), 100], [ago(20 * HOUR), 60]] });
	assert.equal(demoted.medianTimeOnTop, 3 * HOUR);
	assert.ok(demoted.badges.includes('est'));
	assert.equal(demoted.expectedSalesBeforeUndercut, 1);
	assert.equal(demoted.expectedGainBeforeUndercut, 50);
	assert.equal(demoted.feeEstimate, 60);
	assert.equal(demoted.verdict, 'maybe');
	assert.equal(demoted.reason, 'fee 1.2× gain');
	assert.equal(demoted.reasonText, 'about 1 unit sells in the ~3 hours before others undercut again, worth ~50 ISK against a ~60 ISK fee');

	const kept = verdictRow({ ...spec, fees: [[ago(30 * HOUR), 100], [ago(20 * HOUR), 40]] });
	assert.equal(kept.verdict, 'undercut');
	const noFee = verdictRow(spec);
	assert.ok(noFee.badges.includes('nofee'));
	assert.equal(noFee.verdict, 'undercut');

	// expected sales never exceed what is listed: 8 a day * 6 h = 2, capped at the 1 unit remaining
	const capped = verdictRow({ ...spec, episode: 6 * HOUR, remain: 1 });
	assert.equal(capped.expectedSalesBeforeUndercut, 1);
});

test('rows sort undercut, maybe, reconsider, leave, top, then days behind descending, nulls last', () => {
	const out = runPieces([
		verdictPieces({ type: 601, orderId: 61, ahead: 0 }),                // top
		verdictPieces({ type: 602, orderId: 62, ahead: 2 }),                // leave
		verdictPieces({ type: 603, orderId: 63, ahead: 4, trade: 3, landed: 150 }), // reconsider
		verdictPieces({ type: 604, orderId: 64, ahead: 4, trade: 3 }),      // maybe, 0.5 d
		verdictPieces({ type: 605, orderId: 65, ahead: 12, trade: 3 }),     // maybe, 1.5 d
		verdictPieces({ type: 606, orderId: 66, ahead: 16, trade: 3 }),     // undercut, 2 d
		verdictPieces({ type: 607, orderId: 67, ahead: 40, trade: 3 })      // undercut, 5 d
	]);
	assert.deepEqual(out.rows.map(r => [r.orderId, r.verdict]), [
		[67, 'undercut'], [66, 'undercut'], [65, 'maybe'], [64, 'maybe'], [63, 'reconsider'], [62, 'leave'], [61, 'top']
	]);
	const byDays = [{ verdict: 'maybe', daysBehind: null, orderId: 1 }, { verdict: 'maybe', daysBehind: 0.5, orderId: 2 }, { verdict: 'maybe', daysBehind: 3, orderId: 3 }];
	assert.deepEqual(byDays.sort(compareRows).map(r => r.orderId), [3, 2, 1]);
});

//--- sold recently (rule 8)

const matchFixture = () => ({
	openOrders: { [GRANT]: [] },
	orderLogs: { [GRANT]: {
		70: logEntry({ path: [[ago(30 * HOUR), 100 * M, 5, ago(30 * HOUR)], [ago(20 * HOUR), 99 * M, 5, ago(21 * HOUR)]] }),
		71: logEntry({ path: [[ago(24 * HOUR), 99 * M, 3, ago(25 * HOUR)]] }),
		72: logEntry({ loc: ELSEWHERE, path: [[ago(30 * HOUR), 97 * M, 3, ago(30 * HOUR)]] }),
		73: logEntry({ type: T2, path: [[ago(30 * HOUR), 98 * M, 3, ago(30 * HOUR)]] })
	} }
});

test('sale-to-order matching: unique by the logged price at the sale time, null when none or several', () => {
	const sells = [
		sellFact({ date: ago(26 * HOUR), qty: 1, price: 100 * M, txId: 1 }), // 70 asked 100 M then; 71 not issued yet
		sellFact({ date: ago(10 * HOUR), qty: 1, price: 99 * M, txId: 2 }),  // 70 and 71 both asked 99 M
		sellFact({ date: ago(10 * HOUR), qty: 1, price: 98 * M, txId: 3 }),  // nobody of type T asked 98 M
		sellFact({ date: ago(31 * HOUR), qty: 1, price: 100 * M, txId: 4 }), // before any logged issued
		sellFact({ date: ago(5 * HOUR), qty: 1, price: 97 * M, txId: 5 }),   // the only 97 M order, at another station
		sellFact({ type: T2, date: ago(10 * HOUR), qty: 1, price: 96 * M, txId: 6 }) // no logged 96 M; 73 the only T2 order open
	];
	const out = run({ ...matchFixture(), facts: { sells, lots: [], relists: [] } });
	const by = Object.fromEntries(out.sales.map(s => [s.sellTxId, [s.orderId, s.orderMatch]]));
	assert.deepEqual(by[1], [70, 'unique']);
	assert.deepEqual(by[2], [null, 'ambiguous']);
	assert.deepEqual(by[3], [null, 'none']); // no price matches and three type-T orders were open
	assert.deepEqual(by[4], [null, 'none']); // no price matches and no order was open yet
	assert.deepEqual(by[5], [72, 'unique']); // results-calc sell rows carry no location
	assert.deepEqual(by[6], [73, 'byTime']);
	assert.ok(out.warnings.some(w => w.startsWith('1 sale(s) match more than one order')));

	// a sale row that does carry its location is held to it
	const located = run({ ...matchFixture(), facts: { sells: [{ ...sells[4], locationId: D }], lots: [], relists: [] } });
	assert.equal(located.sales[0].orderId, null);
	assert.equal(located.sales[0].orderMatch, 'none'); // 70 and 71 were both open at the station
});

test('sales in the window: one per transaction, net = gross - tax - broker - relist, newest first', () => {
	const sells = [
		sellFact({ date: ago(2 * HOUR), qty: 2, price: 100, txId: 11, tax: 8, broker: 3, relist: 1, profit: 40, lotId: 'x', daysSinceListed: 1.5 }),
		sellFact({ date: ago(2 * HOUR), qty: 1, price: 100, txId: 11, tax: 4, broker: 1.5, relist: 0.5, profit: -5, lotId: 'y', daysSinceListed: 0.5 }),
		sellFact({ date: ago(30 * HOUR), qty: 1, price: 100, txId: 12, profit: 10 }),
		sellFact({ date: ago(8 * DAY), qty: 1, price: 100, txId: 13 }) // outside the 7-day window
	];
	const out = run({ facts: { sells, lots: [], relists: [] } });
	assert.deepEqual(out.sales.map(s => s.sellTxId), [11, 12]);
	const s = out.sales[0];
	assert.equal(s.qty, 3);
	assert.equal(s.gross, 300);
	assert.equal(s.net, 300 - 12 - 4.5 - 1.5);
	assert.equal(s.profit, 35);
	assert.equal(s.daysSinceListed, 1.5);
	assert.deepEqual(s.lotIds, ['x', 'y']);
	assert.equal(s.date, ago(2 * HOUR));
	assert.equal(out.totals.count, 2);
	assert.equal(out.totals.units, 4);
	assert.equal(out.totals.profit, 45);
	const day = run({ facts: { sells, lots: [], relists: [] }, thresholds: { windowMs: DAY } });
	assert.deepEqual(day.sales.map(x => x.sellTxId), [11]);
});

// Shaped like Grant's 7464705828: 31 listed, first logged with 6 left after a relist we never saw,
// then fills of 2 and 2.
const pendingFixture = () => ({
	openOrders: { [GRANT]: [mine({ id: 7464705828, type: T3, price: 50 * M, remain: 2, total: 31, issued: ago(48 * HOUR) })] },
	orderLogs: { [GRANT]: { 7464705828: logEntry({ type: T3, total: 31, path: [
		[ago(30 * HOUR), 50 * M, 6, ago(48 * HOUR)],
		[ago(5 * HOUR), 50 * M, 4, ago(48 * HOUR)],
		[ago(2 * HOUR), 50 * M, 2, ago(48 * HOUR)]
	] }) } }
});

test('pending fill: units the log saw go that no matched transaction covers yet; a later transaction absorbs it', () => {
	const sells = [
		sellFact({ type: T3, date: ago(60 * HOUR), qty: 25, price: 52 * M }), // at a price we never logged: unmatched
		sellFact({ type: T3, date: ago(40 * HOUR), qty: 0, price: 50 * M }),   // before the first sighting: in neither count
		sellFact({ type: T3, date: ago(5.5 * HOUR), qty: 2, price: 50 * M })
	];
	const out = run({ ...pendingFixture(), observedTaxRate: 0.04, facts: { sells, lots: [lotFact({ type: T3, qty: 2, unitPrice: 30 * M })], relists: [] } });
	// the last fill is the one the wallet has not caught up with: its observation time
	assert.equal(rowOf(out, 7464705828).lastFillAt, ago(2 * HOUR));
	assert.equal(rowOf(out, 7464705828).lastFillObserved, true);
	assert.deepEqual(out.pending, [{
		orderId: 7464705828, characterId: GRANT, typeId: T3, locationId: D, date: ago(2 * HOUR), observed: true,
		qty: 2, unitPrice: 50 * M, gross: 100 * M, filledPerLog: 4, filledPerTx: 2, allocated: 0,
		estNet: 2 * 50 * M * 0.96, estProfit: 2 * (50 * M * 0.96 - 30 * M)
	}]);
	assert.equal(out.totals.pendingUnits, 2);

	const caught = run({ ...pendingFixture(), facts: { sells: [...sells, sellFact({ type: T3, date: ago(2.2 * HOUR), qty: 2, price: 50 * M })], lots: [], relists: [] } });
	assert.deepEqual(caught.pending, []);
	assert.equal(caught.totals.pendingUnits, 0);
	// now every fill is in the wallet: the newest matched sale's own time
	assert.equal(rowOf(caught, 7464705828).lastFillAt, ago(2.2 * HOUR));
	assert.equal(rowOf(caught, 7464705828).lastFillObserved, false);
});

// Grant's 7471777610 (type 85398): logged at 37,240 (issued 11-21) and next at 37,190 (issued 11-25),
// 348 units gone between the two sightings; the wallet sold them at 37,210, a price the log never saw.
const SKIN = 85398;
const skinFixture = () => ({
	openOrders: { [GRANT]: [mine({ id: 7471777610, type: SKIN, price: 37190, remain: 652, total: 1000, issued: '2026-11-25T07:55:00Z' })] },
	orderLogs: { [GRANT]: {
		7400000001: logEntry({ path: [['2026-11-20T00:00:00Z', 100 * M, 1, '2026-11-19T00:00:00Z']] }), // logging began 11-20
		7471777610: logEntry({ type: SKIN, total: 1000, path: [
			['2026-11-21T10:00:00Z', 37240, 1000, '2026-11-21T09:00:00Z'],
			['2026-11-25T08:00:00Z', 37190, 652, '2026-11-25T07:55:00Z']
		] })
	} }
});
const skinSales = () => [
	sellFact({ type: SKIN, date: '2026-11-24T15:00:00Z', qty: 200, price: 37210, txId: 41 }),
	sellFact({ type: SKIN, date: '2026-11-24T15:20:00Z', qty: 148, price: 37210, txId: 42 })
];

test('a sale at a price the log never saw matches the one order open then (byTime) and is not pending too', () => {
	const out = run({ ...skinFixture(), facts: { sells: skinSales(), lots: [], relists: [] } });
	assert.deepEqual(out.sales.map(s => [s.sellTxId, s.orderId, s.orderMatch]), [[42, 7471777610, 'byTime'], [41, 7471777610, 'byTime']]);
	assert.deepEqual(out.pending, []);
	assert.equal(out.totals.pendingUnits, 0);
	const r = rowOf(out, 7471777610);
	assert.equal(r.lastFillAt, '2026-11-24T15:20:00Z'); // the sale, not the sighting of 11-25 08:00
	assert.equal(r.lastFillObserved, false);
});

test('pending never double counts: unmatched sales are taken from the type\'s orders, oldest drop first', () => {
	// a second SKIN order open at the time: the fallback is not unique, the sales stay unmatched
	const fixture = skinFixture();
	fixture.openOrders[GRANT].push(mine({ id: 7471777611, type: SKIN, price: 37300, remain: 5, issued: '2026-11-22T00:00:00Z' }));
	fixture.orderLogs[GRANT][7471777611] = logEntry({ type: SKIN, path: [['2026-11-22T01:00:00Z', 37300, 5, '2026-11-22T00:00:00Z']] });
	const out = run({ ...fixture, facts: { sells: skinSales(), lots: [], relists: [] } });
	assert.deepEqual(out.sales.map(s => s.orderMatch), ['none', 'none']);
	assert.deepEqual(out.pending, []);
	const r = rowOf(out, 7471777610);
	assert.equal(r.lastFillAt, '2026-11-25T08:00:00Z'); // no sale of its own: the observed drop
	assert.equal(r.lastFillObserved, true);

	// two orders of T2 with drops of 2 (older) and 3; 4 units sold at a price neither logged
	const two = {
		openOrders: { [GRANT]: [
			mine({ id: 81, type: T2, price: 100, remain: 3, total: 5, issued: ago(40 * HOUR) }),
			mine({ id: 82, type: T2, price: 110, remain: 2, total: 5, issued: ago(40 * HOUR) })
		] },
		orderLogs: { [GRANT]: {
			81: logEntry({ type: T2, total: 5, path: [[ago(30 * HOUR), 100, 5, ago(40 * HOUR)], [ago(10 * HOUR), 100, 3, ago(40 * HOUR)]] }),
			82: logEntry({ type: T2, total: 5, path: [[ago(30 * HOUR), 110, 5, ago(40 * HOUR)], [ago(5 * HOUR), 110, 2, ago(40 * HOUR)]] })
		} }
	};
	const sold = [sellFact({ type: T2, date: ago(12 * HOUR), qty: 4, price: 105 })];
	const split = run({ ...two, facts: { sells: sold, lots: [], relists: [] } });
	assert.equal(split.sales[0].orderMatch, 'none');
	assert.deepEqual(split.pending.map(p => [p.orderId, p.qty, p.filledPerLog, p.filledPerTx, p.allocated]), [[82, 1, 3, 0, 2]]);
	assert.equal(split.totals.pendingUnits, (2 + 3) - 4); // drops since logging began less every sale since

	// 4 units matched to 81, which the log saw drop by only 2: the excess comes off 82 as well
	const over = run({ ...two, facts: { sells: [sellFact({ type: T2, date: ago(12 * HOUR), qty: 4, price: 100 })], lots: [], relists: [] } });
	assert.equal(over.sales[0].orderMatch, 'unique');
	assert.deepEqual(over.pending.map(p => [p.orderId, p.qty]), [[82, 1]]);
});

test('sale clusters: inside the gap they merge, outside a new one starts, signs are kept, types never mix', () => {
	const sells = [
		sellFact({ date: ago(60 * MIN), qty: 2, price: 100, profit: 500, txId: 21 }),
		sellFact({ date: ago(50 * MIN), qty: 1, price: 100, profit: -200, txId: 22 }), // exactly 10 min later: merges
		sellFact({ date: ago(30 * MIN), qty: 1, price: 100, profit: 100, txId: 23 }),  // 20 min later: a new cluster
		sellFact({ type: T2, date: ago(55 * MIN), qty: 1, price: 7, profit: 1, txId: 24 })
	];
	const out = run({ facts: { sells, lots: [], relists: [] } });
	// newest last sale first: 30 min, 50 min (the pair), 55 min
	assert.deepEqual(out.salesClusters.map(c => [c.typeId, c.count, c.profit]), [[T, 1, 100], [T, 2, 300], [T2, 1, 1]]);
	const pair = out.salesClusters[1];
	assert.equal(pair.start, ago(60 * MIN));
	assert.equal(pair.end, ago(50 * MIN));
	assert.equal(pair.at, ago(55 * MIN));
	assert.equal(pair.qty, 3);
	assert.equal(pair.gross, 300);
	assert.equal(pair.net, 300);
	assert.deepEqual(pair.sales.map(s => s.sellTxId), [21, 22]);
	assert.equal(pair.sales[0], out.sales.find(s => s.sellTxId === 21)); // the same sale objects

	const tighter = run({ facts: { sells, lots: [], relists: [] }, thresholds: { clusterGapMs: 10 * MIN - 1000 } });
	assert.equal(tighter.salesClusters.filter(c => c.typeId === T).length, 3);
});

test('relist fees paid in the window: fee rows after each order\'s first, sell orders of the pooled characters', () => {
	const relists = [
		relistFact({ orderId: 90, fees: [[ago(10 * DAY), 100], [ago(3 * DAY), 50], [ago(12 * HOUR), 40]] }),
		relistFact({ orderId: 91, fees: [[ago(1 * DAY), 70], [ago(2 * HOUR), 30]] }),       // its listing is in the window too
		relistFact({ orderId: 92, isBuy: true, fees: [[ago(1 * DAY), 70], [ago(2 * HOUR), 500]] }),
		relistFact({ orderId: 93, char: IVAN, fees: [[ago(1 * DAY), 70], [ago(2 * HOUR), 500]] }),
		relistFact({ orderId: 94, fees: [[ago(20 * DAY), 70], [ago(8 * DAY), 500]] })       // before the window
	];
	assert.equal(run({ facts: { sells: [], lots: [], relists } }).totals.relistFees, 50 + 40 + 30);
});

//--- share (rule 9)

test('share of Domain volume over the window\'s days that have history, whole days on both sides; null without history', () => {
	// window 2 days back from 11-25 12:00: the days 11-23, 11-24 and 11-25 (not in the history yet)
	const sells = [
		sellFact({ date: '2026-11-23T08:00:00Z', qty: 1, price: 100, txId: 31 }), // before the window, same UTC day
		sellFact({ date: '2026-11-23T13:00:00Z', qty: 1, price: 100, txId: 32 }),
		sellFact({ date: '2026-11-24T10:00:00Z', qty: 2, price: 100, txId: 33 }),
		sellFact({ date: '2026-11-25T09:00:00Z', qty: 1, price: 100, txId: 34 }),
		sellFact({ type: T2, date: '2026-11-25T09:00:00Z', qty: 1, price: 100, txId: 35 })
	];
	const history = { [T]: [{ date: '2026-11-22', average: 100, highest: 100, lowest: 100, order_count: 3, volume: 99 },
		{ date: '2026-11-23', average: 100, highest: 100, lowest: 100, order_count: 3, volume: 10 },
		{ date: '2026-11-24', average: 100, highest: 100, lowest: 100, order_count: 3, volume: 10 }] };
	// a listed type that sold nothing in the window
	history[T3] = [{ date: '2026-11-24', average: 100, highest: 100, lowest: 100, order_count: 9, volume: 50 }];
	const listed = { [GRANT]: [mine({ id: 9, type: T3, price: 100, remain: 1, issued: ago(HOUR) })] };
	const out = run({ openOrders: listed, facts: { sells, lots: [], relists: [] }, history, thresholds: { windowMs: 2 * DAY } });
	assert.deepEqual(windowDays(NOW_MS, 2 * DAY), ['2026-11-23', '2026-11-24', '2026-11-25']);
	assert.deepEqual(out.share.byType[T], { share: 4 / 20, qty: 4, volume: 20, days: ['2026-11-23', '2026-11-24'] });
	assert.deepEqual(out.share.byType[T2], { share: null, qty: null, volume: null, days: [] });
	assert.deepEqual(out.share.byType[T3], { share: 0, qty: 0, volume: 50, days: ['2026-11-24'] });
	// overall is the table's: exactly the type-day rows that have a volume
	const rowsWithVolume = out.salesByTypeDay.filter(r => r.volume !== null);
	const tableShare = rowsWithVolume.reduce((acc, r) => acc + r.dayQty, 0) / rowsWithVolume.reduce((acc, r) => acc + r.volume, 0);
	assert.equal(out.share.overall.share, tableShare);
	assert.deepEqual(out.share.overall, { share: 4 / 20, qty: 4, volume: 20 });
	assert.equal(out.totals.share, 0.2);
	// window: every history day of the window for every listed or sold type, days without our sales too
	assert.deepEqual(out.share.window, { share: 4 / 70, qty: 4, volume: 70 });
	assert.equal(out.totals.units, 5); // the window's sales: 32, 33, 34, 35
	assert.deepEqual(out.salesByTypeDay.map(r => [r.day, r.typeId, r.qty, r.dayQty, r.volume, r.share]), [
		['2026-11-25', T2, 1, 1, null, null],
		['2026-11-25', T, 1, 1, null, null],
		['2026-11-24', T, 2, 2, 10, 0.2],
		['2026-11-23', T, 1, 2, 10, 0.2]
	]);

	const noHistory = run({ facts: { sells, lots: [], relists: [] }, thresholds: { windowMs: 2 * DAY } });
	assert.equal(noHistory.share.byType[T].share, null);
	assert.equal(noHistory.share.overall.share, null);
	assert.equal(noHistory.totals.share, null);
});

//--- asOf

test('asOf: newest orders fetch or log lastSeen, newest book fetch or book-log sample, newest sale', () => {
	const order = mine({ id: 1, price: 100 * M, remain: 1, issued: ago(5 * HOUR) });
	const input = {
		orderLogs: { [GRANT]: { 1: { ...logEntry({ path: [[ago(5 * HOUR), 100 * M, 1, ago(5 * HOUR)]] }), lastSeen: ago(8 * MIN) } } },
		books: { [T]: { [REGION]: bookOf([], ago(5 * MIN)) }, [T2]: { [REGION]: bookOf([], ago(20 * MIN)) } },
		bookLogs: { [T]: { [REGION]: { samples: [{ at: ago(30 * MIN), stored: true }, { at: ago(1 * MIN), stored: false }], orders: {} } } },
		facts: { sells: [sellFact({ date: ago(70 * MIN), price: 100 }), sellFact({ date: ago(9 * DAY), price: 100 })], lots: [], relists: [] }
	};
	const asArray = run({ ...input, openOrders: { [GRANT]: [order] } });
	assert.deepEqual(asArray.asOf, { orders: ago(8 * MIN), books: ago(1 * MIN), transactions: ago(70 * MIN) });
	const asObject = run({ ...input, openOrders: { [GRANT]: { fetchedAt: ago(3 * MIN), orders: [order] } } });
	assert.equal(asObject.asOf.orders, ago(3 * MIN));
	assert.equal(asObject.rows.length, 1);
	assert.equal(run({ ...input, bookLogs: {} }).asOf.books, ago(5 * MIN));
});

//--- empty and partial input

test('empty input: empty output, never a throw; now is required', () => {
	const out = compute({ now: NOW });
	assert.deepEqual(out.rows, []);
	assert.deepEqual(out.sales, []);
	assert.deepEqual(out.salesClusters, []);
	assert.deepEqual(out.pending, []);
	assert.deepEqual(out.salesByTypeDay, []);
	assert.deepEqual(out.share, { overall: { share: null, qty: 0, volume: 0 }, window: { share: null, qty: 0, volume: 0 }, byType: {} });
	assert.deepEqual(out.timeOnTop, { overall: { episodes: 0, undercutEpisodes: 0, medianTimeOnTop: null, est: false }, byType: {} });
	assert.deepEqual(out.totals, { count: 0, units: 0, gross: 0, net: 0, profit: 0, relistFees: 0, pendingUnits: 0, share: null });
	assert.deepEqual(out.asOf, { orders: null, books: null, transactions: null });
	assert.equal(out.taxRate, 0.08);
	assert.ok(out.warnings.some(w => w.includes('no observed tax rate')));
	assert.throws(() => compute({}), /now is required/);
	assert.throws(() => compute(), /now is required/);
	assert.doesNotThrow(() => compute({
		now: NOW, characterIds: [GRANT], openOrders: { [GRANT]: null, [IVAN]: [null, 7] }, orderLogs: { [GRANT]: { 5: null, x: {} } },
		books: { [T]: { [REGION]: { fetchedAt: null, orders: null } } }, bookLogs: { [T]: { [REGION]: { orders: null } } },
		history: { [T]: [null, { date: 7 }] }, facts: { sells: [null, {}], lots: [null], relists: [{ fees: null }] }, thresholds: null
	}));
});

test('a type with no book, history, log, lots or fees still gets its row, with nulls and badges', () => {
	const order = mine({ id: 1, price: 21120000, remain: 3, issued: ago(6 * HOUR) });
	const out = run({ openOrders: { [GRANT]: [order, { ...order, order_id: 2, is_buy_order: true }] } });
	assert.equal(out.rows.length, 1); // the buy order is carried in the logs, never shown (decision 1)
	const r = out.rows[0];
	for (const key of ['firstSeen', 'relistCount', 'relistFees', 'lastFillAt', 'bookFetchedAt', 'unitsAhead', 'ordersAhead', 'rank', 'bestPrice',
		'gapToBest', 'cheaperElsewhere', 'undercutAt', 'undercutBy', 'reUndercuts', 'dailyVolume', 'typicalTrade', 'daysBehind',
		'medianTimeOnTop', 'onTopFor', 'landedCost', 'marginNow', 'matchPrice', 'marginIfMatch', 'roiIfMatch', 'feeEstimate',
		'expectedSalesBeforeUndercut', 'expectedGainBeforeUndercut']) {
		assert.equal(r[key], null, key);
	}
	assert.equal(r.listedFor, 6 * HOUR); // from its issued when nothing else is known
	assert.equal(r.verdict, 'maybe');
	assert.equal(r.reason, 'no book');
	assert.deepEqual(r.badges, ['nolog', 'nobook', 'nobooklog', 'nohistory', 'nocost', 'nofee']);
	assert.ok(out.warnings.some(w => w.includes('no order log')));
});

test('rows: listedFor from the earliest of firstSeen, the first logged issued and the fee facts; a row newer than its log', () => {
	const order = mine({ id: 1, price: 98 * M, remain: 2, total: 3, issued: ago(1 * HOUR) });
	const out = run({
		openOrders: { [GRANT]: { fetchedAt: ago(2 * MIN), orders: [order] } },
		orderLogs: { [GRANT]: { 1: logEntry({ total: 3, path: [[ago(20 * HOUR), 100 * M, 3, ago(26 * HOUR)], [ago(3 * HOUR), 100 * M, 2, ago(26 * HOUR)]] }) } },
		facts: { sells: [], lots: [], relists: [relistFact({ orderId: 1, fees: [[ago(26 * HOUR), 10]], firstSeenAt: ago(25 * HOUR) })] }
	});
	const r = out.rows[0];
	assert.equal(r.firstSeen, ago(20 * HOUR));
	assert.equal(r.listedSince, ago(26 * HOUR));
	assert.equal(r.listedFor, 26 * HOUR);
	assert.equal(r.relistCount, 1); // the row's newer price counts as a change
	assert.equal(r.lastFillAt, ago(3 * HOUR));
});

//--- helpers

test('helpers: median, priceAt', () => {
	assert.equal(median([]), null);
	assert.equal(median([3, 1, 2]), 2);
	assert.equal(median([4, 1, 3, 2]), 2.5);
	const rec = { path: [{ atMs: 100, price: 10, issuedMs: 50 }, { atMs: 300, price: 9, issuedMs: 250 }], end: { atMs: 400 } };
	assert.equal(priceAt(rec, 40), null);
	assert.equal(priceAt(rec, 50), 10);
	assert.equal(priceAt(rec, 260), 9); // issued dates the price, though it was seen only at 300
	assert.equal(priceAt(rec, 401), null);
});

//--- Phase 5: own-order state from the book (decision 16)

// Our order 21 at 110 from 20 h ago, 5 left, as the orders feed (fetched 15 min ago) and its log say.
const stateInput = ({ bookRow = null, bookAt = ago(3 * MIN), feedAt = ago(15 * MIN), loc = D, extra = [] } = {}) => {
	const feedRow = mine({ id: 21, price: 110, remain: 5, issued: ago(20 * HOUR), loc });
	return {
		openOrders: { [GRANT]: feedAt === null ? [feedRow] : { fetchedAt: feedAt, orders: [feedRow] } },
		orderLogs: { [GRANT]: { 21: { ...logEntry({ loc, path: [[ago(19 * HOUR), 110, 5, ago(20 * HOUR)]] }), lastSeen: ago(15 * MIN) } } },
		books: { [T]: { [REGION]: bookOf([...(bookRow === null ? [] : [theirs({ id: 21, total: 5, loc, ...bookRow })]), ...extra], bookAt) } }
	};
};

test('book state: a later issued in the book gives the row its price, remain and issued; the feed is kept beside it', () => {
	const ahead = theirs({ id: 601, price: 105, remain: 2, issued: ago(30 * HOUR) });
	const out = run(stateInput({ bookRow: { price: 100, remain: 4, issued: ago(5 * MIN) }, extra: [ahead] }));
	const r = rowOf(out, 21);
	assert.equal(r.stateFrom, 'book');
	assert.equal(r.stateAt, ago(3 * MIN));
	assert.deepEqual(r.feed, { price: 110, volumeRemain: 5, issued: ago(20 * HOUR), fetchedAt: ago(15 * MIN) });
	assert.equal(r.price, 100);
	assert.equal(r.volumeRemain, 4);
	assert.equal(r.volumeTotal, 5);
	assert.equal(r.issued, ago(5 * MIN));
	// every later rule reads the merged state: at the feed's 110 the order at 105 was ahead
	assert.equal(r.ordersAhead, 0);
	assert.equal(r.verdict, 'top');
	assert.equal(r.onTopFor, 5 * MIN);
	assert.equal(r.relistCount, 1);
	assert.ok(!r.badges.includes('notInBook'));
	// the unit gone since the log's last entry is a pending fill, seen at the book's fetch
	assert.deepEqual(out.pending.map(p => [p.orderId, p.qty, p.date, p.unitPrice]), [[21, 1, ago(3 * MIN), 100]]);
	assert.equal(out.asOf.orders, ago(15 * MIN)); // asOf is the feed's still

	const feedOnly = rowOf(run({ ...stateInput(), books: {} }), 21);
	assert.equal(feedOnly.stateFrom, 'orders');
	assert.equal(feedOnly.stateAt, ago(15 * MIN));
	assert.equal(feedOnly.feed, null);
	assert.equal(feedOnly.price, 110);
	assert.equal(feedOnly.issued, ago(20 * HOUR));
});

test('book state: at the same issued a lower remain from a later fetch is a fill; the pending drop is dated at the book', () => {
	const sameIssued = { price: 110, remain: 3, issued: iso(NOW_MS - 20 * HOUR + 1000) }; // the book's 1 s jitter
	const out = run(stateInput({ bookRow: sameIssued }));
	const r = rowOf(out, 21);
	assert.equal(r.stateFrom, 'book');
	assert.equal(r.stateAt, ago(3 * MIN));
	assert.equal(r.volumeRemain, 3);
	assert.equal(r.price, 110);
	assert.equal(r.issued, ago(20 * HOUR)); // the feed's: the same issued
	assert.deepEqual(r.feed, { price: 110, volumeRemain: 5, issued: ago(20 * HOUR), fetchedAt: ago(15 * MIN) });
	assert.equal(r.relistCount, 0);
	// dated at the book's fetch, not at the feed's (15 min ago)
	assert.deepEqual(out.pending.map(p => [p.qty, p.date]), [[2, ago(3 * MIN)]]);
	assert.equal(r.lastFillAt, ago(3 * MIN));

	// a book fetched before the feed: the feed's state
	const older = rowOf(run(stateInput({ bookRow: sameIssued, bookAt: ago(20 * MIN) })), 21);
	assert.equal(older.stateFrom, 'orders');
	assert.equal(older.volumeRemain, 5);
	assert.equal(older.stateAt, ago(15 * MIN));
	assert.equal(older.feed, null);

	// no feed time: the log's lastSeen (15 min ago) stands in for it; stateAt of a feed row is null
	assert.equal(rowOf(run(stateInput({ bookRow: sameIssued, feedAt: null })), 21).stateFrom, 'book');
	const noTime = rowOf(run(stateInput({ bookRow: sameIssued, feedAt: null, bookAt: ago(20 * MIN) })), 21);
	assert.equal(noTime.stateFrom, 'orders');
	assert.equal(noTime.stateAt, null);
});

test('book state: the feed stands when the book is older, the same or only jittered by a second', () => {
	// the book still shows the price before ours (an earlier issued)
	const stale = rowOf(run(stateInput({ bookRow: { price: 120, remain: 5, issued: ago(30 * HOUR) } })), 21);
	assert.equal(stale.stateFrom, 'orders');
	assert.equal(stale.price, 110);
	// the same state, the issued 1 s later: the same issued (ISSUED_EPS), nothing newer
	const jitter = rowOf(run(stateInput({ bookRow: { price: 110, remain: 5, issued: iso(NOW_MS - 20 * HOUR + 1000) } })), 21);
	assert.equal(jitter.stateFrom, 'orders');
	assert.equal(jitter.feed, null);
	assert.equal(jitter.issued, ago(20 * HOUR));
	assert.equal(jitter.relistCount, 0);
	// a higher remain in the book at the same issued is never newer (decision 13)
	assert.equal(rowOf(run(stateInput({ bookRow: { price: 110, remain: 6, issued: ago(20 * HOUR) } })), 21).stateFrom, 'orders');
	// more than 2 s later is a new issued
	assert.equal(rowOf(run(stateInput({ bookRow: { price: 110, remain: 5, issued: iso(NOW_MS - 20 * HOUR + 3000) } })), 21).stateFrom, 'book');
});

test('notInBook: a book a minute newer than the feed row that no longer lists the order, at an NPC station only', () => {
	const other = theirs({ id: 602, price: 100, remain: 2, issued: ago(30 * HOUR) });
	const gone = rowOf(run(stateInput({ extra: [other] })), 21);
	assert.ok(gone.badges.includes('notInBook'));
	assert.equal(gone.stateFrom, 'orders');
	assert.equal(gone.price, 110); // figures on the feed
	const listed = rowOf(run(stateInput({ bookRow: { price: 110, remain: 5, issued: ago(20 * HOUR) }, extra: [other] })), 21);
	assert.equal(gone.verdict, listed.verdict);
	assert.equal(gone.unitsAhead, listed.unitsAhead);
	assert.ok(!listed.badges.includes('notInBook'));

	// a structure's book is not public: an absent order says nothing
	const citadel = 1035466617946;
	const structure = rowOf(run(stateInput({ loc: citadel, extra: [theirs({ id: 602, price: 100, remain: 2, issued: ago(30 * HOUR), loc: citadel })] })), 21);
	assert.ok(!structure.badges.includes('notInBook'));
	// a book only 30 s newer than the feed row may predate the order's listing
	assert.ok(!rowOf(run(stateInput({ feedAt: ago(3 * MIN), bookAt: ago(2.5 * MIN), extra: [other] })), 21).badges.includes('notInBook'));
	// without a feed time, the log's lastSeen (15 min ago) dates the row
	assert.ok(rowOf(run(stateInput({ feedAt: null, extra: [other] })), 21).badges.includes('notInBook'));
	// no book at all: nobook, not notInBook
	const noBook = rowOf(run({ ...stateInput(), books: {} }), 21);
	assert.ok(noBook.badges.includes('nobook'));
	assert.ok(!noBook.badges.includes('notInBook'));
});

//--- Phase 5: rule 3 and rule 5 against re-issued orders (a competitor's issued moves at the same price)

test('undercut: a competitor below us since before our issued, re-issued at the same price after it, is no undercutter', () => {
	const order = mine({ id: 1, price: 100 * M, remain: 5, issued: ago(10 * HOUR) });
	const input = { openOrders: { [GRANT]: [order] }, books: { [T]: { [REGION]: bookOf([theirs({ id: 311, price: 99 * M, remain: 1, issued: ago(2 * HOUR) })]) } } };
	// without a book-log record of it, its current issued decides
	assert.equal(rowOf(run(input), 1).undercutAt, ago(2 * HOUR));

	const samples = [{ at: ago(30 * HOUR), stored: true }, { at: ago(1 * HOUR), stored: true }];
	const reissued = { samples, orders: { 311: bookLogOrder({ path: [[ago(30 * HOUR), 99 * M, 1, ago(31 * HOUR)], [ago(1 * HOUR), 99 * M, 1, ago(2 * HOUR)]] }) } };
	const r = rowOf(run({ ...input, bookLogs: { [T]: { [REGION]: reissued } } }), 1);
	assert.equal(r.ordersAhead, 1);
	assert.equal(r.undercutAt, null);
	assert.equal(r.undercutBy, null);
	assert.equal(r.reUndercuts, null);

	// below us when we listed, above us at 9 h, below again 2 h ago: an undercut after all
	const back = { samples, orders: { 311: bookLogOrder({ path: [
		[ago(30 * HOUR), 99 * M, 1, ago(31 * HOUR)], [ago(8 * HOUR), 101 * M, 1, ago(9 * HOUR)], [ago(1 * HOUR), 99 * M, 1, ago(2 * HOUR)]
	] }) } };
	const r2 = rowOf(run({ ...input, bookLogs: { [T]: { [REGION]: back } } }), 1);
	assert.equal(r2.undercutAt, ago(2 * HOUR));
	assert.equal(r2.undercutBy.orderId, 311);
});

test('time on top: an episode listed behind a cheaper competitor never was on top; a same-price re-issue is no undercut', () => {
	// our 15: 100 M from 30 h ago behind 316 at 95 M (there since 40 h), 94 M from 20 h ago; 316 re-issued at 95 M 5 h ago
	const input = {
		openOrders: { [GRANT]: [mine({ id: 15, price: 94 * M, remain: 1, issued: ago(20 * HOUR) })] },
		orderLogs: { [GRANT]: { 15: logEntry({ path: [[ago(29 * HOUR), 100 * M, 1, ago(30 * HOUR)], [ago(19 * HOUR), 94 * M, 1, ago(20 * HOUR)]] }) } },
		books: { [T]: { [REGION]: bookOf([theirs({ id: 316, price: 95 * M, issued: ago(5 * HOUR) })]) } },
		bookLogs: { [T]: { [REGION]: { samples: [{ at: ago(40 * HOUR), stored: true }, { at: ago(1 * HOUR), stored: true }], orders: {
			316: bookLogOrder({ path: [[ago(39 * HOUR), 95 * M, 1, ago(40 * HOUR)], [ago(4 * HOUR), 95 * M, 1, ago(5 * HOUR)]] })
		} } } }
	};
	const out = run(input);
	const byT = out.timeOnTop.byType[T];
	const [behind, onTop] = byT.list;
	assert.equal(behind.price, 100 * M);
	assert.equal(behind.startedBehind, true);
	assert.equal(behind.timeOnTop, 0);
	assert.equal(behind.undercut, false);
	assert.equal(behind.undercutAt, null);
	assert.equal(onTop.startedBehind, false);
	assert.equal(onTop.undercut, false); // 95 M is above 94 M, re-issued or not
	assert.equal(onTop.timeOnTop, 20 * HOUR);
	assert.equal(byT.episodes, 1); // the stats leave the startedBehind episode out
	assert.deepEqual(out.timeOnTop.overall, { episodes: 1, undercutEpisodes: 0, medianTimeOnTop: null, est: false });
	assert.equal(rowOf(out, 15).episodes, 1);
	assert.equal(rowOf(out, 15).onTopFor, 20 * HOUR);

	// firstUndercut takes a price change (or an order's first entry) below us, never a same-price re-issue
	const { firstUndercut } = ordersCalc._internal;
	const ep = { start: 100, price: 10, end: 1000 };
	const comp = (path) => ({ orderId: 9, path: path.map(([issuedMs, price]) => ({ atMs: issuedMs, price, volumeRemain: 1, issuedMs })) });
	assert.equal(firstUndercut(ep, [comp([[50, 9], [300, 9]])]), null);
	assert.deepEqual(firstUndercut(ep, [comp([[50, 11], [300, 9], [400, 9]])]), { at: 300, orderId: 9, price: 9 });
	assert.deepEqual(firstUndercut(ep, [comp([[300, 9]])]), { at: 300, orderId: 9, price: 9 });
	assert.equal(firstUndercut(ep, [comp([[50, 11], [300, 11]])]), null);
});

test('onTopFor: an order listed behind a cheaper one is on top since that order left the book, not since its issued', () => {
	// our 17 at 100 M from 30 h ago behind 317 at 95 M (there since 40 h); 317 last seen 6 h ago, gone by the 5 h sample
	const out = run({
		openOrders: { [GRANT]: { fetchedAt: ago(5 * MIN), orders: [mine({ id: 17, price: 100 * M, remain: 1, issued: ago(30 * HOUR) })] } },
		orderLogs: { [GRANT]: { 17: logEntry({ path: [[ago(29 * HOUR), 100 * M, 1, ago(30 * HOUR)]] }) } },
		books: { [T]: { [REGION]: bookOf([theirs({ id: 17, price: 100 * M, remain: 1, issued: ago(30 * HOUR) })], ago(4 * MIN)) } },
		bookLogs: { [T]: { [REGION]: { samples: [ago(40 * HOUR), ago(6 * HOUR), ago(5 * HOUR)].map(at => ({ at, stored: true })), orders: {
			317: bookLogOrder({ path: [[ago(39 * HOUR), 95 * M, 1, ago(40 * HOUR)], [ago(6 * HOUR), 95 * M, 1, ago(40 * HOUR)]] })
		} } } }
	});
	const r = rowOf(out, 17);
	assert.equal(r.verdict, 'top');
	assert.equal(out.timeOnTop.byType[T].list[0].startedBehind, true);
	assert.equal(r.onTopFor, 5 * HOUR); // now less 317's goneMs, not now less our issued (30 h)
	assert.equal(out.timeOnTop.byType[T].onTopFor, 5 * HOUR);
	assert.deepEqual(out.presence[T].segments.slice(-1).map(g => [g.from, g.to, g.state]), [[ago(5 * HOUR), NOW, 'top']]);
});

//--- Phase 5: presence (decision 18)

// Type T over a 2-day window (hours ago): our 12 at 120 M, open from 50 h until filled at 44 h; no order
// of ours from 44 h to 40 h; our 11 at 100 M from 40 h and at 94 M from 10 h. The book log starts at
// 46 h. 901 sits at 130 M throughout; 902 comes in at 99 M at 30 h, re-issues at the same price at 25 h,
// drops to 93 M at 5 h and is gone by the 2 h sample (last seen 3 h ago); 903 comes in at 98 M at 20 h;
// 904 sits at 90 M at another station from 35 h. Our 13 (type T2) ended 72 h ago.
const presenceFixture = () => {
	const later = (rec, lastSeen) => ({ ...rec, lastSeen });
	return {
		openOrders: { [GRANT]: { fetchedAt: ago(5 * MIN), orders: [mine({ id: 11, price: 94 * M, remain: 1, issued: ago(10 * HOUR) })] } },
		orderLogs: { [GRANT]: {
			11: logEntry({ path: [[ago(39 * HOUR), 100 * M, 1, ago(40 * HOUR)], [ago(9 * HOUR), 94 * M, 1, ago(10 * HOUR)]] }),
			12: logEntry({ path: [[ago(49 * HOUR), 120 * M, 1, ago(50 * HOUR)]], end: { state: 'expired', volumeRemain: 0, at: ago(44 * HOUR) } }),
			13: logEntry({ type: T2, path: [[ago(80 * HOUR), 50 * M, 1, ago(80 * HOUR)]], end: { state: 'expired', volumeRemain: 0, at: ago(72 * HOUR) } })
		} },
		bookLogs: { [T]: { [REGION]: { samples: [ago(46 * HOUR), ago(2 * HOUR), ago(1 * HOUR)].map(at => ({ at, stored: true })), orders: {
			11: bookLogOrder({ path: [[ago(39 * HOUR), 100 * M, 1, ago(40 * HOUR)], [ago(9 * HOUR), 94 * M, 1, ago(10 * HOUR)]] }), // ours
			901: later(bookLogOrder({ path: [[ago(46 * HOUR), 130 * M, 1, ago(70 * HOUR)]] }), ago(1 * HOUR)),
			902: later(bookLogOrder({ path: [
				[ago(29 * HOUR), 99 * M, 1, ago(30 * HOUR)], [ago(24 * HOUR), 99 * M, 1, ago(25 * HOUR)], [ago(4 * HOUR), 93 * M, 1, ago(5 * HOUR)]
			] }), ago(3 * HOUR)),
			903: later(bookLogOrder({ path: [[ago(19 * HOUR), 98 * M, 1, ago(20 * HOUR)]] }), ago(1 * HOUR)),
			904: later(bookLogOrder({ loc: ELSEWHERE, path: [[ago(34 * HOUR), 90 * M, 1, ago(35 * HOUR)]] }), ago(1 * HOUR))
		} } } },
		thresholds: { windowMs: 2 * DAY }
	};
};
const segRow = (g) => [g.from, g.to, g.state, g.known, g.orderIds, g.below, g.lowestBelow, g.cause];

test('presence: listed, undercut, re-priced on top, undercut and cleared; unknown before the book log; a gap with no order', () => {
	const out = run(presenceFixture());
	assert.deepEqual(Object.keys(out.presence).map(Number), [T]); // 13 ended before the window
	assert.equal(out.presence[T].bookLogSince, ago(46 * HOUR));
	assert.deepEqual(out.presence[T].segments.map(segRow), [
		[ago(48 * HOUR), ago(46 * HOUR), 'listed', false, [12], null, null, 'unknown'],  // the window's edge, before the book log
		[ago(46 * HOUR), ago(44 * HOUR), 'top', true, [12], 0, null, 'unknown'],         // the book log's first sample
		// 44 h to 40 h: a gap, no sell order of ours
		[ago(40 * HOUR), ago(30 * HOUR), 'top', true, [11], 0, null, 'listed'],
		[ago(30 * HOUR), ago(20 * HOUR), 'listed', true, [11], 1, 99 * M, 'undercut'],   // 902's re-issue at 25 h merges in
		[ago(20 * HOUR), ago(10 * HOUR), 'listed', true, [11], 2, 98 * M, 'undercut'],
		[ago(10 * HOUR), ago(5 * HOUR), 'top', true, [11], 0, null, 'ourPrice'],
		[ago(5 * HOUR), ago(2 * HOUR), 'listed', true, [11], 1, 93 * M, 'undercut'],
		[ago(2 * HOUR), NOW, 'top', true, [11], 0, null, 'cleared']
	]);
});

test('presence: region scope counts the cheaper order at another station; a wider window reaches back further', () => {
	const region = run({ ...presenceFixture(), thresholds: { windowMs: 2 * DAY, scope: 'region' } });
	assert.deepEqual(region.presence[T].segments.map(g => [g.from, g.state, g.below, g.lowestBelow, g.cause]), [
		[ago(48 * HOUR), 'listed', null, null, 'unknown'],
		[ago(46 * HOUR), 'top', 0, null, 'unknown'],
		[ago(40 * HOUR), 'top', 0, null, 'listed'],
		[ago(35 * HOUR), 'listed', 1, 90 * M, 'undercut'],
		[ago(30 * HOUR), 'listed', 2, 90 * M, 'undercut'],
		[ago(20 * HOUR), 'listed', 3, 90 * M, 'undercut'],
		[ago(10 * HOUR), 'listed', 1, 90 * M, 'ourPrice'],
		[ago(5 * HOUR), 'listed', 2, 90 * M, 'undercut'],
		[ago(2 * HOUR), 'listed', 1, 90 * M, 'cleared']
	]);

	// a 7-day window: 12 from its opening at 50 h; 13 (no book log of T2) unknown over its whole span
	const wide = run({ ...presenceFixture(), thresholds: { windowMs: 7 * DAY } });
	assert.deepEqual(segRow(wide.presence[T].segments[0]), [ago(50 * HOUR), ago(46 * HOUR), 'listed', false, [12], null, null, 'listed']);
	assert.deepEqual(wide.presence[T2], {
		segments: [{ from: ago(80 * HOUR), to: ago(72 * HOUR), state: 'listed', known: false, orderIds: [13], below: null, lowestBelow: null, cause: 'listed' }],
		bookLogSince: null
	});
	// an order of ours while another is open: 'listed' when it comes in, 'ended' when one of two goes
	const two = presenceFixture();
	two.orderLogs[GRANT][14] = logEntry({ path: [[ago(14 * HOUR), 97 * M, 1, ago(15 * HOUR)]], end: { state: 'cancelled', volumeRemain: 1, at: ago(12 * HOUR) } });
	const withTwo = run(two).presence[T].segments.map(g => [g.from, g.state, g.orderIds, g.below, g.cause]);
	assert.deepEqual(withTwo.slice(5, 8), [
		[ago(15 * HOUR), 'top', [11, 14], 0, 'listed'],   // 14 at 97 M is under 902 (99 M) and 903 (98 M)
		[ago(12 * HOUR), 'listed', [11], 2, 'ended'],    // 11 at 100 M is left behind both
		[ago(10 * HOUR), 'top', [11], 0, 'ourPrice']
	]);
});

test('presence: a 304 after a competitor\'s last stored sighting still lists it; only a stored sample can end it', () => {
	// 9 at 90 listed since 3 days ago, last seen by the stored check 2 days ago and still in the book; the
	// two checks since were 304s (the book had not changed). Our 1 at 100 came in 30 minutes ago, behind it.
	const samples = [{ at: ago(3 * DAY), stored: true }, { at: ago(2 * DAY), stored: true }, { at: ago(1 * DAY), stored: false }, { at: ago(1 * HOUR), stored: false }];
	const comp = { ...bookLogOrder({ path: [[ago(3 * DAY), 90, 4, ago(3 * DAY + HOUR)]] }), lastSeen: ago(2 * DAY) };
	const out = run({
		openOrders: { [GRANT]: { fetchedAt: ago(5 * MIN), orders: [mine({ id: 1, price: 100, remain: 5, issued: ago(30 * MIN) })] } },
		orderLogs: { [GRANT]: { 1: logEntry({ path: [[ago(10 * MIN), 100, 5, ago(30 * MIN)]] }) } },
		books: { [T]: { [REGION]: bookOf([theirs({ id: 9, price: 90, remain: 4, issued: ago(3 * DAY + HOUR) })]) } },
		bookLogs: { [T]: { [REGION]: { samples, orders: { 9: comp } } } },
		history: { [T]: flatHistory(1) }
	});
	const last = out.presence[T].segments.slice(-1)[0];
	assert.deepEqual([last.state, last.below], ['listed', 1]);
	assert.equal(out.timeOnTop.byType[T].list.slice(-1)[0].startedBehind, true);
	assert.equal(out.timeOnTop.byType[T].episodes, 0);
});

//--- Phase 5: reason tokens (decision 21)

test('fmtCompactDuration: minutes, hours and days, one decimal under 10, no space', () => {
	const f = ordersCalc.fmtCompactDuration;
	assert.equal(f(0), '<1min');
	assert.equal(f(MIN - 1), '<1min');
	assert.equal(f(MIN), '1min');
	assert.equal(f(35 * MIN), '35min');
	assert.equal(f(59.4 * MIN), '59min');
	assert.equal(f(HOUR), '1h');
	assert.equal(f(1.1 * HOUR), '1.1h');
	assert.equal(f(9.94 * HOUR), '9.9h');
	assert.equal(f(12 * HOUR), '12h');
	assert.equal(f(23.4 * HOUR), '23h');
	assert.equal(f(DAY), '1d');
	assert.equal(f(2.6 * DAY), '2.6d');
	assert.equal(f(14 * DAY), '14d');
	assert.equal(f(null), '');
	assert.equal(f(NaN), '');
});

test('fmtCompactDuration rounds before it picks the unit: 59.6 minutes is 1h and 23.6 hours 1d, in the sentence too', () => {
	const f = ordersCalc.fmtCompactDuration;
	assert.equal(f(59.6 * MIN), '1h');
	assert.equal(f(23.6 * HOUR), '1d');
	// 149 units at 3,600 a day: 59.6 minutes behind; 59 units at 60 a day: 23.6 hours behind
	const minutes = verdictRow({ ahead: 149, history: flatHistory(3600) });
	assert.deepEqual([minutes.verdict, minutes.reason, minutes.reasonText], ['leave', '1h', '149 units ahead at 3,600 a day: the queue ahead clears in about 1 hour']);
	const hours = verdictRow({ ahead: 59, history: flatHistory(60) }, { thresholds: { leaveHours: 24 } });
	assert.deepEqual([hours.verdict, hours.reason, hours.reasonText], ['leave', '1d', '59 units ahead at 60 a day: the queue ahead clears in about 1 day']);
});

test('reason tokens and their sentences for every verdict branch', () => {
	const cases = [
		[{ ahead: 13, trade: 3, history: flatHistory(5) }, {}, 'undercut', '2.6d', '13 units ahead at 5 a day: 2.6 days behind'],
		[{ ahead: 1, trade: 1 }, {}, 'leave', '3h', '1 unit ahead at 8 a day: the queue ahead clears in about 3 hours'],
		[{ ahead: 1, trade: 2 }, { thresholds: { leaveHours: 1 } }, 'leave', '50%', '1 unit ahead is 50 % of a typical trade of 2 units'],
		[{ ahead: 4, trade: 3, landed: 120 }, {}, 'reconsider', '1.25x', 'matching returns 1.25x the landed cost, under the 1.5x floor'],
		[{ ahead: 4, trade: 3, landed: 161 }, {}, 'reconsider', '0.93x', 'matching returns 0.93x the landed cost, at or below cost'],
		[{ ahead: 16, trade: 3, episode: 3 * HOUR, fees: [[ago(30 * HOUR), 100], [ago(20 * HOUR), 165]] }, {}, 'maybe', 'fee 3.3× gain',
			'about 1 unit sells in the ~3 hours before others undercut again, worth ~50 ISK against a ~165 ISK fee'],
		[{ ahead: 12, trade: 3 }, {}, 'maybe', '1.5d', '12 units ahead at 8 a day: 1.5 days behind'],
		[{ ahead: 16, trade: 3, history: [] }, {}, 'maybe', 'no history', 'no market history of this item, so how long the queue ahead takes is unknown'],
		[{ ahead: 16, trade: 3, history: [historyDay(40, 1, 1)] }, {}, 'maybe', 'no volume', 'no volume in the history window, so the queue ahead may never clear'],
		[{ ahead: 0 }, {}, 'top', '', 'nothing is priced below this order']
	];
	for (const [spec, over, verdict, reason, reasonText] of cases) {
		const r = verdictRow(spec, over);
		assert.deepEqual([r.verdict, r.reason, r.reasonText], [verdict, reason, reasonText], JSON.stringify(spec));
	}
	const noBook = rowOf(run({ openOrders: { [GRANT]: [mine({ id: 1, price: 100, remain: 1, issued: ago(HOUR) })] } }), 1);
	assert.deepEqual([noBook.verdict, noBook.reason, noBook.reasonText], ['maybe', 'no book', 'no book of this item yet, so its place in the queue is unknown']);
	// larger figures are grouped, ISK to three significant figures
	const { verdictOf } = ordersCalc._internal;
	const big = verdictOf({
		ordersAhead: 3, unitsAhead: 1234, dailyVolume: 100, daysBehind: 12.34, typicalTrade: 5, landedCost: null, matchPrice: 99,
		taxRate: 0.04, expectedSalesBeforeUndercut: 0.2, expectedGainBeforeUndercut: 50123, feeEstimate: 165843, medianTimeOnTop: 3 * HOUR
	}, defaultThresholds);
	assert.deepEqual(big, { verdict: 'maybe', reason: 'fee 3.3× gain', reasonText: 'about 0.2 units sell in the ~3 hours before others undercut again, worth ~50,100 ISK against a ~166,000 ISK fee' });
	const behind = verdictOf({ ordersAhead: 3, unitsAhead: 1234, dailyVolume: 100, daysBehind: 12.34, typicalTrade: 5, landedCost: null, matchPrice: 99, expectedGainBeforeUndercut: null, feeEstimate: null }, defaultThresholds);
	assert.deepEqual(behind, { verdict: 'undercut', reason: '12d', reasonText: '1,234 units ahead at 100 a day: 12 days behind' });
});

//--- Phase 5: the lots behind a row (decision 22)

test('row.lots: the type\'s lots with units left, newest first, as facts.lots gives them', () => {
	const lots = [
		{ lotId: 'a', runId: 'r1', typeId: T, qty: 3, soldQty: 3, remainingQty: 0, unitPrice: 50, date: ago(5 * DAY) }, // sold out
		{ lotId: 'b', runId: 'r1', typeId: T, qty: 4, soldQty: 1, remainingQty: 3, unitPrice: 60, date: ago(4 * DAY) },
		{ lotId: 'c', typeId: T, qty: 2, soldQty: 0, unitPrice: 70, date: ago(1 * DAY) },                                // no run, no remainingQty
		{ lotId: 'd', runId: 'r2', typeId: T, qty: 1, soldQty: 0, remainingQty: 1, unitPrice: 80, date: ago(2 * DAY) },
		{ lotId: 'e', runId: 'r3', typeId: T2, qty: 9, soldQty: 0, remainingQty: 9, unitPrice: 1, date: ago(0.5 * DAY) }
	];
	const out = run({
		openOrders: { [GRANT]: [mine({ id: 1, price: 100, remain: 1, issued: ago(HOUR) }), mine({ id: 2, type: T3, price: 100, remain: 1, issued: ago(HOUR) })] },
		facts: { sells: [], lots, relists: [] }
	});
	const r = rowOf(out, 1);
	assert.deepEqual(r.lots, [
		{ lotId: 'c', runId: null, remainingQty: 2, date: ago(1 * DAY) },
		{ lotId: 'd', runId: 'r2', remainingQty: 1, date: ago(2 * DAY) },
		{ lotId: 'b', runId: 'r1', remainingQty: 3, date: ago(4 * DAY) }
	]);
	assert.equal(r.landedUnits, 6); // the same remainder the landed cost is taken over
	assert.deepEqual(rowOf(out, 2).lots, []);
});
