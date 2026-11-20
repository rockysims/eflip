const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSyncService } = require('../lib/sync');
const { createTokenStore } = require('../lib/tokenStore');
const derive = require('../lib/derive');
const { createRawStore } = require('../lib/dataFiles');
const {
	ALL_SCOPES, makeClock, tmpDataDir, makeLog, makeTokens, createFakeEsi,
	tx, journalRow, order, historyOrder, asset, contract, contractItem,
} = require('../test-support/esi-fake');

// The invariant under test (Phase 3 gate): re-deriving from data/raw/ alone gives byte-for-byte the
// ledger the incremental sync built.

const IVAN = 90000001;
const GRANT = 90000002;
const STRUCTURE = 1028858195912;
const HOUR = 60 * 60 * 1000;

// path (relative, slash-separated) -> text of every file under `dir`.
const treeOf = (dir) => {
	const out = {};
	const visit = (current) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) visit(full);
			else if (!entry.name.startsWith('.')) out[path.relative(dir, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
		}
	};
	if (fs.existsSync(dir)) visit(dir);
	return out;
};

const copyDir = (from, to) => fs.cpSync(from, to, { recursive: true });

const setup = (t) => {
	const dataDir = tmpDataDir(t);
	const clock = makeClock();
	const fake = createFakeEsi({ now: clock, pageSize: 2 });
	const store = createTokenStore({ dataDir });
	for (const id of [IVAN, GRANT]) {
		store.upsert({ characterId: id, name: id === IVAN ? 'Ivan Tester' : 'Grant Tester', ownerHash: `owner-${id}`, scopes: ALL_SCOPES, refreshToken: `refresh-${id}`, status: 'ok' });
		fake.character(id);
	}
	const log = makeLog();
	const service = createSyncService({ dataDir, fetch: fake.fetch, now: clock, log, tokenStore: store, tokens: makeTokens(), userAgent: 'eflip-test/1.0' });
	return { dataDir, clock, fake, service, log };
};

// Several syncs of two characters with data that grows, changes status, shrinks and goes quiet.
const history = async (ctx) => {
	const { fake, clock, service } = ctx;
	fake.structures.set(STRUCTURE, { name: 'Test Trading Tower', owner_id: 98000001, position: { x: 1, y: 2, z: 3 }, solar_system_id: 30000144, type_id: 35834 });
	fake.character(IVAN, {
		balance: 1000,
		transactions: [tx(6001), tx(6002, { is_buy: false, location_id: STRUCTURE }), tx(6003)],
		journal: [1, 2, 3, 4, 5].map(i => journalRow(7000 + i)),
		orders: [order(8001, { type_id: 35 })],
		ordersHistory: [historyOrder(8101, { state: 'cancelled', volume_remain: 4 })],
		assets: [1, 2, 3, 4, 5].map(i => asset(i, { type_id: 30 + i })),
		contracts: [contract(9001, { type: 'courier', status: 'outstanding', date_completed: undefined }), contract(9002)],
		contractItems: { 9001: [contractItem(1, 34, 60)], 9002: [contractItem(1, 35, 5)] },
		skills: { skills: [{ skill_id: 16622, trained_skill_level: 3, active_skill_level: 3, skillpoints_in_skill: 1 }], total_sp: 1, unallocated_sp: 0 },
		standings: [{ from_id: 500001, from_type: 'faction', standing: 1.5 }],
	});
	fake.character(GRANT, { balance: 77, transactions: [tx(6501, { is_buy: false })], assets: [asset(50)] });
	await service.syncAll({ force: true, market: false });

	// +2 h: new rows, the courier is delivered, an order is added, a new contract with items
	clock.advance(2 * HOUR);
	const ivan = fake.character(IVAN);
	ivan.transactions.push(tx(6004, { is_buy: false }));
	ivan.journal.push(journalRow(7006));
	ivan.orders.push(order(8002, { type_id: 36 }));
	ivan.ordersHistory.push(historyOrder(8102));
	ivan.contracts[0] = contract(9001, { type: 'courier', status: 'finished' });
	ivan.contracts.push(contract(9003, { type: 'courier', status: 'outstanding', date_completed: undefined }));
	ivan.contractItems[9003] = [contractItem(1, 36, 9)];
	ivan.balance = 2000;
	await service.syncAll({ force: true, market: false });

	// +26 h: skills move on, the asset list shrinks from three pages to two, a structure turns up forbidden
	clock.advance(24 * HOUR);
	ivan.skills = { skills: [{ skill_id: 16622, trained_skill_level: 4, active_skill_level: 4, skillpoints_in_skill: 2 }], total_sp: 2, unallocated_sp: 0 };
	ivan.assets = ivan.assets.slice(0, 3);
	ivan.transactions.push(tx(6005, { location_id: STRUCTURE + 1 }));
	fake.structures.set(STRUCTURE + 1, 'forbidden');
	await service.syncAll({ force: true, market: false });

	// +2 h: an error stop in the middle leaves no snapshot behind
	clock.advance(2 * HOUR);
	fake.errorLimitRemain = 10;
	await service.syncCharacter(IVAN, { force: true });
	fake.errorLimitRemain = 100;

	// +4 h: nothing changed at all
	clock.advance(4 * HOUR);
	await service.syncAll({ force: true, market: false });
};

test('re-deriving from raw gives byte-for-byte the ledger the incremental sync built', async (t) => {
	const ctx = await (async () => {
		const c = setup(t);
		await history(c);
		return c;
	})();
	const { dataDir } = ctx;
	const incremental = treeOf(path.join(dataDir, 'ledger'));

	// sanity: the history really exercised the pieces
	const names = Object.keys(incremental);
	assert.ok(names.includes(`${IVAN}/transactions.json`));
	assert.ok(names.includes(`${IVAN}/contract-items/9003.json`));
	assert.ok(names.includes('structures.json'));
	assert.ok(names.includes(`${IVAN}/profile.json`));
	const ivanSnapshots = names.filter(name => name.startsWith(`${IVAN}/snapshots/`));
	assert.ok(ivanSnapshots.length >= 2 && ivanSnapshots.length <= 4, `snapshots: ${ivanSnapshots.length}`);
	assert.equal(JSON.parse(incremental[`${IVAN}/profile.json`]).skills[0].active_skill_level, 4);
	assert.equal(JSON.parse(incremental[ivanSnapshots[ivanSnapshots.length - 1]]).assets.length, 3, 'the shrunken asset list, not a stale third page');
	const contracts = JSON.parse(incremental[`${IVAN}/contracts.json`]);
	assert.equal(contracts.find(c => c.contract_id === 9001).status, 'finished');

	// (a) rebuilt in place
	const result = derive.rebuildAll({ dataDir, log: makeLog() });
	assert.equal(result.characters[IVAN].transactions, 5);
	assert.equal(result.structures, 1);
	assert.deepEqual(treeOf(path.join(dataDir, 'ledger')), incremental);

	// (b) from raw alone: a data directory that holds nothing else
	const fresh = tmpDataDir(t);
	copyDir(path.join(dataDir, 'raw'), path.join(fresh, 'raw'));
	derive.rebuildAll({ dataDir: fresh, log: makeLog() });
	assert.deepEqual(treeOf(path.join(fresh, 'ledger')), incremental);
	assert.deepEqual(Object.keys(treeOf(path.join(fresh))).filter(name => !name.startsWith('raw/') && !name.startsWith('ledger/')), [], 'derive writes only under ledger/');
});

test('an error-stopped sync leaves no snapshot, and an unchanged one writes none', async (t) => {
	const ctx = setup(t);
	await history(ctx);
	const raw = createRawStore({ dataDir: ctx.dataDir });
	const logs = raw.syncLogStamps(IVAN).map(stamp => raw.readSyncLog(IVAN, stamp));
	assert.equal(logs.length, 5, 'one log per sync that called ESI');
	const stopped = logs.find(entry => entry.stop && entry.stop.reason === 'error-limit');
	assert.ok(stopped, 'the error-limit sync is logged');
	assert.equal(stopped.snapshot, null);
	const snapshots = fs.readdirSync(path.join(ctx.dataDir, 'ledger', String(IVAN), 'snapshots'));
	assert.equal(snapshots.length, logs.filter(entry => entry.snapshot).length - 1, 'the last, quiet sync repeated the previous snapshot');
});

test('a rebuild drops anything the raw store cannot account for, and re-derives the same snapshot contents', async (t) => {
	const ctx = setup(t);
	await history(ctx);
	const ledgerDir = path.join(ctx.dataDir, 'ledger', String(IVAN));
	const before = treeOf(path.join(ctx.dataDir, 'ledger'));
	fs.writeFileSync(path.join(ledgerDir, 'transactions.json'), '[{"transaction_id":999999,"bogus":true}]\n');
	fs.writeFileSync(path.join(ledgerDir, 'stray.json'), '{}');
	derive.rebuildCharacter({ dataDir: ctx.dataDir, characterId: IVAN });
	assert.deepEqual(treeOf(path.join(ctx.dataDir, 'ledger')), before);
	assert.ok(!fs.existsSync(path.join(ledgerDir, 'stray.json')));
	assert.deepEqual(fs.readdirSync(path.join(ctx.dataDir, 'ledger')).filter(name => name.startsWith('.')), [], 'no scratch directory is left behind');
});

test('a character with no raw data keeps the ledger it has', (t) => {
	const dataDir = tmpDataDir(t);
	const ledgerFile = path.join(dataDir, 'ledger', '5', 'transactions.json');
	fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
	fs.writeFileSync(ledgerFile, '[{"transaction_id":1}]\n');
	const result = derive.rebuildCharacter({ dataDir, characterId: 5 });
	assert.deepEqual(result, { skipped: 'no raw data' });
	assert.equal(fs.readFileSync(ledgerFile, 'utf8'), '[{"transaction_id":1}]\n');
	assert.deepEqual(derive.rebuildAll({ dataDir, log: makeLog() }), { characters: {}, structures: null });
});

test('a rebuild waits for a sync in progress instead of racing it', async (t) => {
	const ctx = setup(t);
	await history(ctx);
	const lockDir = path.join(ctx.dataDir, 'locks');
	fs.mkdirSync(lockDir, { recursive: true });
	fs.writeFileSync(path.join(lockDir, `character-${IVAN}.lock`), JSON.stringify({ pid: process.ppid, at: Date.now() }));
	assert.throws(() => derive.rebuildCharacter({ dataDir: ctx.dataDir, characterId: IVAN }), /being synced/);
});

test('structure names come from every character, the newest answer winning', async (t) => {
	const ctx = setup(t);
	const { fake, clock, service } = ctx;
	fake.structures.set(STRUCTURE, { name: 'Old Name', owner_id: 1, position: { x: 1, y: 2, z: 3 }, solar_system_id: 30000144, type_id: 35834 });
	fake.character(IVAN, { transactions: [tx(1, { location_id: STRUCTURE })] });
	await service.syncCharacter(IVAN, { force: true });
	clock.advance(HOUR);
	fake.structures.set(STRUCTURE, { name: 'New Name', owner_id: 1, position: { x: 1, y: 2, z: 3 }, solar_system_id: 30000144, type_id: 35834 });
	// the ledger already knows the structure, so the second character's sync would not ask; derive
	// must still pick the newest raw answer when several exist
	const raw = createRawStore({ dataDir: ctx.dataDir });
	raw.write(GRANT, `universe-structures-${STRUCTURE}`, { fetchedAt: '2026-11-20T20:00:00.000Z', url: 'x', status: 200, headers: {}, body: { name: 'New Name', owner_id: 1, solar_system_id: 30000144, type_id: 35834, position: { x: 1, y: 2, z: 3 } } });
	derive.rebuildAll({ dataDir: ctx.dataDir, log: makeLog() });
	const structures = JSON.parse(fs.readFileSync(path.join(ctx.dataDir, 'ledger', 'structures.json'), 'utf8'));
	assert.equal(structures[STRUCTURE].name, 'New Name');
	assert.equal(structures[STRUCTURE].characterId, GRANT);
	assert.equal(structures[STRUCTURE].fetchedAt, '2026-11-20T20:00:00.000Z');
});

test('derived snapshots hold the orders, assets and balance of their sync', async (t) => {
	const ctx = setup(t);
	await history(ctx);
	const snapshots = derive.rebuildCharacter({ dataDir: ctx.dataDir, characterId: IVAN });
	assert.ok(snapshots.snapshots >= 2);
	const dir = path.join(ctx.dataDir, 'ledger', String(IVAN), 'snapshots');
	const all = fs.readdirSync(dir).sort().map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
	assert.deepEqual(all.map(s => [s.orders.length, s.assets.length, s.balance]).slice(0, 2), [[1, 5, 1000], [2, 5, 2000]]);
	assert.deepEqual(all.map(s => s.syncedAt), [...all.map(s => s.syncedAt)].sort());
	assert.equal(all[all.length - 1].assets.length, 3);
});
