const test = require('node:test');
const assert = require('node:assert/strict');
const { KINDS, DEFAULT_SHARES, parseBudget, parseShares, planTrim } = require('../lib/storage-budget');

// The storage budget with shares (M2 P2.2): parsing the two settings, and the pure trim planner.
// Budgets here are small round numbers of bytes so the arithmetic can be followed by hand.

const at = (day, hour = 0) => new Date(Date.UTC(2026, 10, day, hour)).toISOString();
// n items of `bytes` each, an hour apart from `day`, ids `<prefix>1`..; `floors` lists the 1-based
// positions that are floors
const items = (prefix, n, bytes, { day = 1, floors = [] } = {}) => Array.from({ length: n }, (_, i) => ({
	id: `${prefix}${i + 1}`, at: at(day, i), bytes, ...(floors.includes(i + 1) ? { floor: true } : {}),
}));
const sum = (list) => list.reduce((total, piece) => total + piece.bytes, 0);
const kind = (name, list, extra = {}) => ({ name, bytes: sum(list), items: list, ...extra });
const trimmed = (plan) => Object.fromEntries(Object.entries(plan.trims).filter(([, trim]) => trim.bytesFreed > 0 || trim.itemIds.length > 0 || trim.cutoffAt !== null).map(([name, trim]) => [name, trim.itemIds.length > 0 ? trim.itemIds : trim.cutoffAt]));

// ---- parsing

test('KINDS and DEFAULT_SHARES: four kinds, the agreed defaults, 100 in all', () => {
	assert.deepEqual(KINDS, ['regionPages', 'bookLogs', 'typeBooks', 'runContexts']);
	assert.deepEqual(DEFAULT_SHARES, { regionPages: 40, bookLogs: 45, typeBooks: 10, runContexts: 5 });
	assert.equal(Object.values(DEFAULT_SHARES).reduce((a, b) => a + b, 0), 100);
});

test('parseBudget: decimal sizes (1 GB is 1e9 bytes), a bare number is bytes, nothing set is no budget', () => {
	assert.equal(parseBudget('1GB'), 1e9);
	assert.equal(parseBudget('1.5 GB'), 1.5e9);
	assert.equal(parseBudget('500MB'), 5e8);
	assert.equal(parseBudget('250000000'), 250000000);
	assert.equal(parseBudget('1gb'), 1e9, 'case-insensitive');
	assert.equal(parseBudget(' 2 Gb '), 2e9);
	assert.equal(parseBudget('10kb'), 1e4);
	assert.equal(parseBudget('3TB'), 3e12);
	assert.equal(parseBudget('750B'), 750);
	assert.equal(parseBudget('.5GB'), 5e8);
	for (const none of [null, undefined, '', '   ']) assert.equal(parseBudget(none), null, String(none));
	for (const bad of ['1GiB', 'lots', '-1GB', '1 G B', '1e9', '1,5GB', 'GB', '0', '0GB', '0.0000000001KB', '1 GB extra']) {
		assert.throws(() => parseBudget(bad), RangeError, bad);
	}
});

test('parseShares: kind:percent pairs; nothing set is every default; a kind left out of a set value is 0', () => {
	assert.deepEqual(parseShares(null), DEFAULT_SHARES);
	assert.deepEqual(parseShares(undefined), DEFAULT_SHARES);
	assert.deepEqual(parseShares(''), DEFAULT_SHARES);
	assert.deepEqual(parseShares('regionPages:40,bookLogs:45,typeBooks:10,runContexts:5'), DEFAULT_SHARES);
	assert.deepEqual(parseShares(' bookLogs : 60 , REGIONPAGES:30, '), { regionPages: 30, bookLogs: 60, typeBooks: 0, runContexts: 0 }, 'spaces, any case, a trailing comma');
	assert.deepEqual(parseShares('regionPages:40,bookLogs:40'), { regionPages: 40, bookLogs: 40, typeBooks: 0, runContexts: 0 }, 'under 100 leaves headroom');
	assert.deepEqual(parseShares('regionPages:33.3,bookLogs:33.3,typeBooks:33.4'), { regionPages: 33.3, bookLogs: 33.3, typeBooks: 33.4, runContexts: 0 }, 'decimals adding up to 100');
	const shares = parseShares(null);
	shares.bookLogs = 1;
	assert.equal(DEFAULT_SHARES.bookLogs, 45, 'a copy');
});

test('parseShares rejects an unknown kind, a negative or non-numeric share, a repeat, and a sum over 100', () => {
	for (const bad of [
		'cats:5',
		'regionPages:-5',
		'regionPages:abc',
		'regionPages:1e2',
		'regionPages',
		'regionPages:40:1',
		'regionPages:40,regionPages:10',
		'regionPages:50,bookLogs:51',
		'regionPages:100,runContexts:0.5',
	]) assert.throws(() => parseShares(bad), RangeError, bad);
});

// ---- the planner

test('under the budget nothing is trimmed; with no budget nothing is either', () => {
	const kinds = [
		kind('regionPages', items('r', 3, 100)),
		kind('bookLogs', [], { bytes: 400 }),
		kind('typeBooks', items('t', 2, 50)),
		kind('runContexts', items('c', 1, 50)),
	];
	const plan = planTrim({ budgetBytes: 1000, shares: DEFAULT_SHARES, kinds });
	assert.deepEqual(plan, {
		budgetBytes: 1000,
		totalBefore: 850,
		totalAfter: 850,
		unmet: 0,
		trims: Object.fromEntries(KINDS.map(name => [name, { itemIds: [], cutoffAt: null, bytesFreed: 0 }])),
	});
	const none = planTrim({ budgetBytes: null, kinds: [kind('regionPages', items('r', 50, 100))] });
	assert.equal(none.budgetBytes, null);
	assert.equal(none.totalAfter, 5000);
	assert.deepEqual(none.trims.regionPages.itemIds, []);
	assert.deepEqual(planTrim({ budgetBytes: 1000, kinds: [] }), { budgetBytes: 1000, totalBefore: 0, totalAfter: 0, unmet: 0, trims: {} });
});

test('soft shares: a quiet kind lends its room; when the total is over, the kind furthest over its share goes first, not the biggest', () => {
	// region pages at 70 % of the budget (share 40) while the logs sit at 5 % (share 45): the total fits
	const lending = planTrim({
		budgetBytes: 1000,
		kinds: [kind('regionPages', items('r', 7, 100)), kind('bookLogs', [], { bytes: 50 }), kind('typeBooks', items('t', 2, 50)), kind('runContexts', items('c', 1, 50))],
	});
	assert.deepEqual(trimmed(lending), {});
	assert.equal(lending.totalAfter, 900);

	// over by 100: region pages are 1.75x their share, the others at or under 1x
	const over = planTrim({
		budgetBytes: 1000,
		kinds: [kind('regionPages', items('r', 7, 100)), kind('bookLogs', [], { bytes: 250 }), kind('typeBooks', items('t', 2, 50)), kind('runContexts', items('c', 1, 50))],
	});
	assert.deepEqual(trimmed(over), { regionPages: ['r1'] }, 'the oldest snapshot, and only as much as needed');
	assert.equal(over.trims.regionPages.bytesFreed, 100);
	assert.equal(over.totalAfter, 1000, 'exactly at the budget is within it');

	// the per-type books are smaller but further over (2.6x against 1.9x): they go first until they are not
	const furthest = planTrim({
		budgetBytes: 1000,
		kinds: [kind('regionPages', items('r', 8, 95)), kind('bookLogs', [], { bytes: 200 }), kind('typeBooks', items('t', 4, 65))],
	});
	// t: 260 -> 195 (1.95x, still above r's 1.9x) -> 130; then r: 760 -> 665, total 995
	assert.deepEqual(trimmed(furthest), { regionPages: ['r1'], typeBooks: ['t1', 't2'] });
	assert.equal(furthest.totalBefore, 1220);
	assert.equal(furthest.totalAfter, 995);
	assert.equal(furthest.unmet, 0);
});

test('ties go to the kind with more bytes', () => {
	// both exactly 2x their share: region pages hold more bytes, so they give way
	const plan = planTrim({
		budgetBytes: 1000,
		kinds: [kind('typeBooks', items('t', 4, 50)), kind('regionPages', items('r', 8, 100)), kind('bookLogs', [], { bytes: 100 })],
	});
	assert.deepEqual(trimmed(plan), { regionPages: ['r1'] });
});

test('floors are never trimmed, wherever they sit in the order; what is still over when only floors are left is unmet', () => {
	const plan = planTrim({
		budgetBytes: 1000,
		kinds: [
			kind('regionPages', items('r', 3, 300, { floors: [3] })), // the newest snapshot
			kind('bookLogs', [], { bytes: 900, buckets: [{ from: at(20), to: at(21), bytes: 900 }], floorAt: at(19) }), // all within the floor
			kind('typeBooks', items('t', 3, 100, { floors: [2] })), // the newest file of one slug sits between two others
		],
	});
	// typeBooks 300 bytes is 3x its share and goes first: t1 and t3, never t2; then the region pages down to their floor
	assert.deepEqual(trimmed(plan), { regionPages: ['r1', 'r2'], typeBooks: ['t1', 't3'] });
	assert.equal(plan.trims.bookLogs.cutoffAt, null, 'no bucket ends before the floor');
	assert.equal(plan.totalBefore, 2100);
	assert.equal(plan.totalAfter, 1300, 'the floors: 300 + 900 + 100');
	assert.equal(plan.unmet, 300);
	assert.equal(plan.trims.regionPages.bytesFreed, 600);
});

test('book-log buckets: the earliest cutoff that fits, and never one past the floor', () => {
	const day = (d, bytes) => ({ from: at(d), to: at(d + 1), bytes });
	const buckets = [day(1, 100), day(2, 150), day(3, 100), day(4, 200), day(5, 750)];
	const logs = (budgetBytes) => planTrim({ budgetBytes, kinds: [{ name: 'bookLogs', bytes: 1300, buckets, floorAt: at(5) }] });

	const fits = logs(1000);
	assert.equal(fits.trims.bookLogs.cutoffAt, at(4), 'three days dropped free 350: the first cutoff under 1000');
	assert.equal(fits.trims.bookLogs.bytesFreed, 350);
	assert.deepEqual(fits.trims.bookLogs.itemIds, []);
	assert.equal(fits.totalAfter, 950);
	assert.equal(fits.unmet, 0);

	const floored = logs(500);
	assert.equal(floored.trims.bookLogs.cutoffAt, at(5), 'up to the floor, not past it: the last bucket ends after it');
	assert.equal(floored.totalAfter, 750);
	assert.equal(floored.unmet, 250);

	assert.equal(logs(1300).trims.bookLogs.cutoffAt, null, 'at the budget: no cutoff');
	const unfloored = planTrim({ budgetBytes: 500, kinds: [{ name: 'bookLogs', bytes: 1300, buckets }] });
	assert.equal(unfloored.trims.bookLogs.cutoffAt, at(6), 'no floorAt: every bucket may go');
	assert.equal(unfloored.unmet, 0);
});

test('a shrunk budget trims more: the same oldest pieces first, then further', () => {
	const kinds = [kind('regionPages', items('r', 6, 100)), kind('bookLogs', [], { bytes: 300, buckets: [{ from: at(1), to: at(2), bytes: 100 }, { from: at(2), to: at(3), bytes: 100 }, { from: at(3), to: at(4), bytes: 100 }], floorAt: at(4) }), kind('typeBooks', items('t', 2, 100))];
	const plans = [1200, 1000, 800, 400].map(budgetBytes => planTrim({ budgetBytes, kinds }));
	const freed = plans.map(plan => Object.values(plan.trims).reduce((total, trim) => total + trim.bytesFreed, 0));
	assert.deepEqual(freed, [0, 100, 300, 700]);
	for (let i = 1; i < plans.length; i++) {
		for (const name of ['regionPages', 'typeBooks']) {
			const before = plans[i - 1].trims[name].itemIds;
			assert.deepEqual(plans[i].trims[name].itemIds.slice(0, before.length), before, `${name}: a smaller budget keeps the larger one's trims`);
		}
		assert.ok((plans[i].trims.bookLogs.cutoffAt || '') >= (plans[i - 1].trims.bookLogs.cutoffAt || ''), 'the cutoff only moves later');
	}
	assert.deepEqual(plans.map(plan => plan.totalAfter), [1100, 1000, 800, 400]);
	assert.deepEqual(trimmed(plans[1]), { typeBooks: ['t1'] });
	assert.deepEqual(trimmed(plans[2]), { regionPages: ['r1', 'r2'], typeBooks: ['t1'] });
	assert.deepEqual(trimmed(plans[3]), { regionPages: ['r1', 'r2', 'r3', 'r4'], bookLogs: at(2), typeBooks: ['t1', 't2'] });
});

test('share 0: a kind with no share gives way first, the larger of two such first, until it is empty', () => {
	const shares = parseShares('regionPages:50,bookLogs:50');
	const plan = planTrim({
		budgetBytes: 1000,
		shares,
		kinds: [kind('regionPages', items('r', 9, 100)), kind('bookLogs', [], { bytes: 100 }), kind('typeBooks', items('t', 3, 20)), kind('runContexts', items('c', 2, 50))],
	});
	// region pages are 1.8x their share, but the two share-0 kinds go first: runContexts (100 bytes)
	// before typeBooks (60), then whichever holds more, until the total fits
	assert.deepEqual(trimmed(plan), { typeBooks: ['t1', 't2', 't3'], runContexts: ['c1', 'c2'] });
	assert.equal(plan.totalAfter, 1000);
	assert.deepEqual(plan.trims.regionPages.itemIds, []);
	// with nothing of its own left, a share-0 kind no longer competes
	const empty = planTrim({ budgetBytes: 100, shares, kinds: [kind('regionPages', items('r', 3, 100)), { name: 'typeBooks', bytes: 0, items: [] }] });
	assert.deepEqual(trimmed(empty), { regionPages: ['r1', 'r2'] });
});

test('shares that add up to more than 100 are rejected; the planner is deterministic and leaves its input alone', () => {
	assert.throws(() => planTrim({ budgetBytes: 1000, shares: { regionPages: 60, bookLogs: 45 }, kinds: [] }), RangeError);
	assert.throws(() => planTrim({ budgetBytes: -1, kinds: [] }), RangeError);
	assert.throws(() => planTrim({ budgetBytes: 1000, kinds: [{ name: 'regionPages', bytes: 10 }, { name: 'regionPages', bytes: 10 }] }), RangeError);
	assert.throws(() => planTrim({ budgetBytes: 1000, kinds: [{ name: 'regionPages', bytes: -5 }] }), RangeError);

	const kinds = [kind('regionPages', items('r', 6, 100, { floors: [6] })), kind('typeBooks', items('t', 3, 100))];
	const copy = JSON.parse(JSON.stringify(kinds));
	const a = planTrim({ budgetBytes: 500, kinds });
	const b = planTrim({ budgetBytes: 500, kinds });
	assert.deepEqual(a, b);
	assert.deepEqual(kinds, copy);
	// items given out of order are taken oldest first all the same
	const shuffled = planTrim({ budgetBytes: 500, kinds: [kind('regionPages', [...kinds[0].items].reverse()), kinds[1]] });
	assert.deepEqual(shuffled, a);
});
