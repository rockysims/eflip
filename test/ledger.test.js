const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { mergeRows, rowsText, classifySlug, createLedger, snapshotHash, bookLogText, KINDS } = require('../lib/ledger');
const { tmpDataDir, tx, journalRow, historyOrder, contract } = require('../test-support/esi-fake');

const CHAR = 90000001;
const mode = (file) => fs.statSync(file).mode & 0o777;
const ids = (rows, key) => rows.map(row => row[key]);

test('merging adds only new ids and keeps rows that ESI no longer returns', () => {
	const first = mergeRows([], [tx(3), tx(1), tx(2)], 'transaction_id');
	assert.deepEqual(ids(first.rows, 'transaction_id'), [1, 2, 3], 'sorted by id whatever the arrival order');
	assert.deepEqual({ added: first.added, changed: first.changed }, { added: 3, changed: 0 });

	// ESI's window moved on: 1 is gone from the answer, 4 is new
	const second = mergeRows(first.rows, [tx(2), tx(3), tx(4)], 'transaction_id');
	assert.deepEqual(ids(second.rows, 'transaction_id'), [1, 2, 3, 4]);
	assert.deepEqual({ added: second.added, changed: second.changed }, { added: 1, changed: 0 });
});

test('an order or contract seen again takes its latest status', () => {
	const open = [contract(9001, { status: 'outstanding', date_completed: undefined })];
	const merged = mergeRows(open, [contract(9001, { status: 'finished' }), contract(9002)], 'contract_id');
	assert.deepEqual(merged.rows.map(row => [row.contract_id, row.status]), [[9001, 'finished'], [9002, 'finished']]);
	assert.deepEqual({ added: merged.added, changed: merged.changed }, { added: 1, changed: 1 });

	const orders = mergeRows([historyOrder(1, { state: 'cancelled', volume_remain: 3 })], [historyOrder(1)], 'order_id');
	assert.equal(orders.rows[0].state, 'expired');
	assert.equal(orders.rows[0].volume_remain, 0);
});

test('merging is order-independent, so a rebuild from raw lands on the same file', () => {
	const a = [journalRow(5), journalRow(2)];
	const b = [journalRow(9), journalRow(7)];
	const forward = mergeRows(mergeRows([], a, 'id').rows, b, 'id').rows;
	const backward = mergeRows(mergeRows([], b, 'id').rows, a, 'id').rows;
	assert.equal(rowsText(forward), rowsText(backward));
	assert.deepEqual(ids(forward, 'id'), [2, 5, 7, 9]);

	// the same id twice: the later write wins
	const later = mergeRows(forward, [journalRow(2, { amount: -1 })], 'id').rows;
	assert.equal(later[0].amount, -1);
});

test('rows without a key are ignored, and unknown fields survive untouched', () => {
	const odd = { ...tx(7), brand_new_field: { nested: [1, 2] } };
	const merged = mergeRows([], [null, 'x', { amount: 1 }, odd], 'transaction_id');
	assert.equal(merged.rows.length, 1);
	assert.deepEqual(merged.rows[0], odd);
});

test('rows are written one per line, empty as []', () => {
	assert.equal(rowsText([]), '[]\n');
	assert.equal(rowsText([{ a: 1 }, { a: 2 }]), '[\n{"a":1},\n{"a":2}\n]\n');
	assert.deepEqual(JSON.parse(rowsText([{ a: 1 }, { a: 2 }])), [{ a: 1 }, { a: 2 }]);
});

test('raw route slugs are classified for the ledger', () => {
	const cases = {
		'wallet-transactions': 'transactions',
		'wallet-transactions-from-id-6919559472': 'transactions',
		'wallet-journal': 'journal',
		'wallet-journal-page-2': 'journal',
		'orders-history': 'orders-history',
		'orders-history-page-2': 'orders-history',
		contracts: 'contracts',
		'contracts-page-2': 'contracts',
		'contracts-237910844-items': 'contract-items',
		orders: 'orders',
		assets: 'assets',
		'assets-page-2': 'assets',
		wallet: 'wallet',
		skills: 'skills',
		standings: 'standings',
		'universe-structures-1028858195912': 'structure',
	};
	for (const [slug, kind] of Object.entries(cases)) assert.equal(classifySlug(slug).kind, kind, slug);
	assert.equal(classifySlug('contracts-237910844-items').id, '237910844');
	assert.equal(classifySlug('universe-structures-5').id, '5');
	for (const other of ['markets-10000043-orders-type-id-34', 'wallet-whatever', 'orders-page-2', '']) assert.equal(classifySlug(other), null, other);
	assert.deepEqual(Object.keys(KINDS), ['transactions', 'journal', 'orders-history', 'contracts']);
});

test('the ledger merges into private files and reports what was new', (t) => {
	const dataDir = tmpDataDir(t);
	const ledger = createLedger({ dataDir });
	assert.deepEqual(ledger.readRows(CHAR, 'transactions'), []);
	assert.equal(ledger.exists(CHAR), false);

	assert.deepEqual(ledger.mergeInto(CHAR, 'transactions', [tx(2), tx(1)]), { added: 2, changed: 0, total: 2 });
	assert.deepEqual(ledger.mergeInto(CHAR, 'transactions', [tx(1), tx(2), tx(3)]), { added: 1, changed: 0, total: 3 });
	assert.deepEqual(ids(ledger.readRows(CHAR, 'transactions'), 'transaction_id'), [1, 2, 3]);
	const file = path.join(dataDir, 'ledger', String(CHAR), 'transactions.json');
	assert.equal(mode(file), 0o600);
	assert.equal(mode(path.dirname(file)), 0o700);
	assert.equal(ledger.exists(CHAR), true);
	assert.throws(() => ledger.mergeInto(CHAR, 'nonsense', []), /unknown file/);
	assert.throws(() => ledger.readRows(CHAR, '../tokens'), /unknown file/);
});

test('contract items are kept per contract and read back by id', (t) => {
	const ledger = createLedger({ dataDir: tmpDataDir(t) });
	assert.equal(ledger.hasContractItems(CHAR, 9001), false);
	ledger.writeContractItems(CHAR, 9001, [{ type_id: 34, quantity: 5, is_included: true, record_id: 1, is_singleton: false }]);
	ledger.writeContractItems(CHAR, 9002, []);
	assert.equal(ledger.hasContractItems(CHAR, 9001), true);
	assert.deepEqual(Object.keys(ledger.readContractItems(CHAR)), ['9001', '9002']);
	assert.deepEqual(ledger.readContractItems(CHAR)['9002'], []);
});

test('a snapshot equal to the previous one is not written; a changed one is, and earlier ones stay', (t) => {
	const dataDir = tmpDataDir(t);
	const ledger = createLedger({ dataDir });
	const snap = (syncedAt, extra = {}) => ({ syncedAt, orders: [{ order_id: 1 }], assets: [{ item_id: 1 }], balance: 10, ...extra });

	assert.equal(ledger.writeSnapshot(CHAR, snap('2026-11-20T12:00:00.000Z')), true);
	assert.equal(ledger.writeSnapshot(CHAR, snap('2026-11-20T13:00:00.000Z')), false, 'same content, later time');
	assert.equal(ledger.writeSnapshot(CHAR, snap('2026-11-20T14:00:00.000Z', { balance: 11 })), true);
	assert.equal(ledger.writeSnapshot(CHAR, snap('2026-11-20T15:00:00.000Z')), true, 'back to the first content: the last one written differs, so it counts');
	const stamps = ledger.snapshotStamps(CHAR);
	assert.deepEqual(stamps, ['2026-11-20T12:00:00.000Z', '2026-11-20T14:00:00.000Z', '2026-11-20T15:00:00.000Z']);
	assert.equal(ledger.latestSnapshot(CHAR).syncedAt, '2026-11-20T15:00:00.000Z');
	assert.equal(snapshotHash(snap('a')), snapshotHash(snap('b')), 'the time is not part of the content');
	assert.notEqual(snapshotHash(snap('a')), snapshotHash(snap('a', { assets: [] })));
	assert.deepEqual(ledger.readSnapshots(CHAR, { since: Date.parse('2026-11-20T13:30:00Z') }).map(s => s.syncedAt), ['2026-11-20T14:00:00.000Z', '2026-11-20T15:00:00.000Z']);
	assert.equal(mode(path.join(dataDir, 'ledger', String(CHAR), 'snapshots', '2026-11-20T12-00-00-000Z.json')), 0o600);
});

test('readAll gives the page everything for a character, filtered by date on request', (t) => {
	const ledger = createLedger({ dataDir: tmpDataDir(t) });
	ledger.mergeInto(CHAR, 'transactions', [tx(1, { date: '2026-11-01T00:00:00Z' }), tx(2, { date: '2026-11-15T00:00:00Z' })]);
	ledger.mergeInto(CHAR, 'journal', [journalRow(1, { date: '2026-11-01T00:00:00Z' }), journalRow(2, { date: '2026-11-16T00:00:00Z' })]);
	ledger.mergeInto(CHAR, 'orders-history', [historyOrder(1, { issued: '2026-10-01T00:00:00Z' }), historyOrder(2, { issued: '2026-11-17T00:00:00Z' })]);
	ledger.mergeInto(CHAR, 'contracts', [contract(9001, { date_issued: '2026-11-01T00:00:00Z' }), contract(9002, { date_issued: '2026-11-18T00:00:00Z' })]);
	ledger.writeContractItems(CHAR, 9001, [{ type_id: 1 }]);
	ledger.writeContractItems(CHAR, 9002, [{ type_id: 2 }]);
	ledger.writeProfile(CHAR, { fetchedAt: '2026-11-20T00:00:00.000Z', skills: [], standings: [] });

	const everything = ledger.readAll(CHAR);
	assert.deepEqual(Object.keys(everything), ['transactions', 'journal', 'ordersHistory', 'contracts', 'contractItems', 'profile']);
	assert.equal(everything.transactions.length, 2);
	assert.deepEqual(Object.keys(everything.contractItems), ['9001', '9002']);

	const recent = ledger.readAll(CHAR, { since: Date.parse('2026-11-10T00:00:00Z') });
	assert.deepEqual(ids(recent.transactions, 'transaction_id'), [2]);
	assert.deepEqual(ids(recent.journal, 'id'), [2]);
	assert.deepEqual(ids(recent.ordersHistory, 'order_id'), [2]);
	assert.deepEqual(ids(recent.contracts, 'contract_id'), [9002]);
	assert.deepEqual(Object.keys(recent.contractItems), ['9002'], 'items follow their contracts');
	assert.deepEqual(ledger.readAll(4242), { transactions: [], journal: [], ordersHistory: [], contracts: [], contractItems: {}, profile: null });
});

test('structure names are kept in one file, sorted by id', (t) => {
	const dataDir = tmpDataDir(t);
	const ledger = createLedger({ dataDir });
	assert.deepEqual(ledger.readStructures(), {});
	ledger.writeStructures({ 1028858195912: { name: 'B' }, 1000000000001: { name: 'A' } });
	assert.deepEqual(Object.keys(ledger.readStructures()), ['1000000000001', '1028858195912']);
	assert.equal(mode(path.join(dataDir, 'ledger', 'structures.json')), 0o600);
});

test('book logs: written bytes, file size and the ids a region has', (t) => {
	const ledger = createLedger({ dataDir: tmpDataDir(t) });
	assert.deepEqual(ledger.listBookLogs(10000043), []);
	assert.equal(ledger.bookLogBytes(10000043, 35), 0);
	const written = ledger.writeBookLog(10000043, 35, { samples: [{ at: '2026-11-20T12:00:00.000Z', stored: true }], orders: {} });
	assert.equal(written, fs.statSync(path.join(ledger.root, 'market', '10000043', '35.json.gz')).size, 'the compressed bytes');
	assert.equal(ledger.bookLogBytes(10000043, 35), written);
	ledger.writeBookLog(10000043, 9, { samples: [], orders: {} });
	ledger.writeBookLog(10000043, 1000, { samples: [], orders: {} });
	ledger.writeBookLog(10000002, 34, { samples: [], orders: {} });
	fs.writeFileSync(path.join(ledger.root, 'market', '10000043', 'notes.txt'), 'stray');
	assert.deepEqual(ledger.listBookLogs(10000043), [9, 35, 1000], 'numeric order, stray files ignored');
	assert.deepEqual(ledger.listBookLogs(10000002), [34]);
});

test('book logs are written gzipped with the stable text inside; a plain log from before is read, listed once, and replaced on the next write', (t) => {
	const ledger = createLedger({ dataDir: tmpDataDir(t) });
	const dir = path.join(ledger.root, 'market', '10000043');
	const log = { samples: [{ at: '2026-11-20T12:00:00.000Z', stored: true }], orders: { 7: { firstSeen: '2026-11-20T12:00:00.000Z', path: [{ at: '2026-11-20T12:00:00.000Z', price: 5 }] } } };
	ledger.writeBookLog(10000043, 35, log);
	assert.deepEqual(fs.readdirSync(dir), ['35.json.gz']);
	assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(dir, '35.json.gz'))).toString('utf8'), bookLogText(log), 'the stable text, compressed');
	assert.equal(mode(path.join(dir, '35.json.gz')), 0o600);
	assert.equal(ledger.bookLogFile(10000043, 35), path.join(dir, '35.json.gz'));

	// a plain log as written before gzip: read as it is, counted once, its own size
	const old = { samples: [{ at: '2026-11-19T12:00:00.000Z', stored: true }], orders: {} };
	fs.writeFileSync(path.join(dir, '36.json'), bookLogText(old));
	assert.ok(ledger.hasBookLog(10000043, 36));
	assert.deepEqual(ledger.readBookLog(10000043, 36), old);
	assert.equal(ledger.bookLogBytes(10000043, 36), Buffer.byteLength(bookLogText(old)));
	assert.equal(ledger.bookLogFile(10000043, 36), path.join(dir, '36.json'));
	assert.deepEqual(ledger.listBookLogs(10000043), [35, 36]);

	// the next write migrates it: the gzipped file replaces the plain one
	const grown = { samples: [...old.samples, { at: '2026-11-20T12:00:00.000Z', stored: true }], orders: {} };
	const bytes = ledger.writeBookLog(10000043, 36, grown);
	assert.deepEqual(fs.readdirSync(dir).sort(), ['35.json.gz', '36.json.gz']);
	assert.equal(bytes, ledger.bookLogBytes(10000043, 36));
	assert.deepEqual(ledger.readBookLog(10000043, 36), grown);

	// both forms at once (a plain file put back by hand): the gzipped one is read, the type listed once
	fs.writeFileSync(path.join(dir, '35.json'), bookLogText(old));
	assert.deepEqual(ledger.readBookLog(10000043, 35), log);
	assert.deepEqual(ledger.listBookLogs(10000043), [35, 36]);
	assert.equal(ledger.bookLogBytes(10000043, 35), fs.statSync(path.join(dir, '35.json.gz')).size);
	assert.equal(ledger.hasBookLog(10000043, 37), false);
	assert.equal(ledger.bookLogFile(10000043, 37), null);
	assert.deepEqual(ledger.readBookLog(10000043, 37), { samples: [], orders: {} });
});
