// Phase 2 of docs/order-monitor-plan.md: the pure order-monitor analysis in public/orders-calc.js.
// Fixtures are hand-written, shaped like the live samples of 2026-11-19..25 (ESI field names and
// types per route; the order-log and book-log shapes of the plan's "Data model").
const test = require('node:test');
const assert = require('node:assert/strict');
const ordersCalc = require('../public/orders-calc.js');
const estimate = require('../public/estimate.js');

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
	assert.equal(r.reason, 'nothing ahead');
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
	assert.equal(alone.reason, 'only our own orders ahead');
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
			[ago(64 * HOUR), 99.8 * M, 1, ago(65 * HOUR)], // before our issued
			[ago(49 * HOUR), 99.7 * M, 1, ago(50 * HOUR)],
			[ago(19 * HOUR), 99.6 * M, 1, ago(20 * HOUR)]
		] })
	} };
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

//--- verdict (rule 7)

// One open order of `type` at 210 behind a competitor at 200.01 holding `ahead` units (issued before
// ours), 8 units a day of history (dailyVolume exactly 8), five own sales of `trade` units 20 days ago,
// a tax of 25 % (so matching at 200 nets 150) and, unless `landed` is null, one unit left at `landed`.
// `episode` adds an ended order undercut after that many ms (the type's time on top); `fees` are this
// order's fee rows.
const verdictPieces = ({ type = T2, orderId = 50, ahead, trade = 1, landed = 100, remain = 5, episode = null, fees = null }) => {
	const issued = ago(10 * HOUR);
	const pieces = {
		openOrders: [mine({ id: orderId, type, price: 210, remain, issued })],
		books: { [type]: { [REGION]: bookOf([
			theirs({ id: orderId, type, price: 210, remain, issued }),
			...(ahead > 0 ? [theirs({ id: orderId * 100 + 1, type, price: 200.01, remain: ahead, issued: ago(20 * HOUR) })] : [])
		]) } },
		history: { [type]: flatHistory(8) },
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
	assert.equal(r.reason, 'the queue ahead clears in ~6 h');

	const atLimit = verdictRow({ ahead: 2 }, { thresholds: { leaveHours: 6 } });
	assert.equal(atLimit.verdict, 'maybe');
	assert.equal(atLimit.reason, '6 h behind');

	const typical = verdictRow({ ahead: 3, trade: 3 }); // 9 h behind, 3 ahead = one typical trade
	assert.equal(typical.typicalTrade, 3);
	assert.equal(typical.verdict, 'leave');
	assert.equal(typical.reason, 'no more ahead than a typical trade');
	assert.equal(verdictRow({ ahead: 4, trade: 3 }).verdict, 'maybe');
});

test('verdict reconsider: matching nets no more than the landed cost, or under the ROI floor; skipped without a cost', () => {
	const belowCost = verdictRow({ ahead: 4, trade: 3, landed: 150 }); // 200 * 0.75 = 150 <= 150
	assert.equal(belowCost.matchPrice, 200);
	assert.equal(belowCost.marginIfMatch, 0);
	assert.equal(belowCost.verdict, 'reconsider');
	assert.equal(belowCost.reason, 'below cost');

	const belowFloor = verdictRow({ ahead: 4, trade: 3, landed: 100.01 }); // 150 / 100.01 < 1.5
	assert.equal(belowFloor.verdict, 'reconsider');
	assert.equal(belowFloor.reason, 'below the ROI floor');

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
	assert.equal(at.reason, '2 d behind');
	const below = verdictRow({ ahead: 15, trade: 3 });
	assert.equal(below.daysBehind, 15 / 8);
	assert.equal(below.verdict, 'maybe');
	assert.equal(below.reason, '1.9 d behind');
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
	assert.equal(demoted.reason, 'others undercut within ~3 h; the fee outweighs the expected sales');

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
		71: logEntry({ path: [[ago(30 * HOUR), 99 * M, 3, ago(25 * HOUR)]] }),
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
		sellFact({ date: ago(5 * HOUR), qty: 1, price: 97 * M, txId: 5 })    // the only 97 M order, at another station
	];
	const out = run({ ...matchFixture(), facts: { sells, lots: [], relists: [] } });
	const by = Object.fromEntries(out.sales.map(s => [s.sellTxId, [s.orderId, s.orderMatch]]));
	assert.deepEqual(by[1], [70, 'unique']);
	assert.deepEqual(by[2], [null, 'ambiguous']);
	assert.deepEqual(by[3], [null, 'none']);
	assert.deepEqual(by[4], [null, 'none']);
	assert.deepEqual(by[5], [72, 'unique']); // results-calc sell rows carry no location
	assert.ok(out.warnings.some(w => w.startsWith('1 sale(s) match more than one order')));

	// a sale row that does carry its location is held to it
	const located = run({ ...matchFixture(), facts: { sells: [{ ...sells[4], locationId: D }], lots: [], relists: [] } });
	assert.equal(located.sales[0].orderId, null);
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
	assert.equal(rowOf(out, 7464705828).lastFillAt, ago(2 * HOUR));
	assert.deepEqual(out.pending, [{
		orderId: 7464705828, characterId: GRANT, typeId: T3, locationId: D, date: ago(2 * HOUR),
		qty: 2, unitPrice: 50 * M, gross: 100 * M, filledPerLog: 4, filledPerTx: 2,
		estNet: 2 * 50 * M * 0.96, estProfit: 2 * (50 * M * 0.96 - 30 * M)
	}]);
	assert.equal(out.totals.pendingUnits, 2);

	const caught = run({ ...pendingFixture(), facts: { sells: [...sells, sellFact({ type: T3, date: ago(2.2 * HOUR), qty: 2, price: 50 * M })], lots: [], relists: [] } });
	assert.deepEqual(caught.pending, []);
	assert.equal(caught.totals.pendingUnits, 0);
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
	const out = run({ facts: { sells, lots: [], relists: [] }, history, thresholds: { windowMs: 2 * DAY } });
	assert.deepEqual(windowDays(NOW_MS, 2 * DAY), ['2026-11-23', '2026-11-24', '2026-11-25']);
	assert.deepEqual(out.share.byType[T], { share: 4 / 20, qty: 4, volume: 20, days: ['2026-11-23', '2026-11-24'] });
	assert.deepEqual(out.share.byType[T2], { share: null, qty: null, volume: null, days: [] });
	assert.deepEqual(out.share.overall, { share: 4 / 20, qty: 4, volume: 20 });
	assert.equal(out.totals.share, 0.2);
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
	assert.deepEqual(out.share, { overall: { share: null, qty: 0, volume: 0 }, byType: {} });
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
	assert.equal(r.reason, 'no book yet');
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
