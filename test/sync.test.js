const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createSyncService, marketTypes, marketRegions, SCOPES } = require('../lib/sync');
const { createTokenStore } = require('../lib/tokenStore');
const { TokenError } = require('../lib/tokens');
const { acquireLock } = require('../lib/dataFiles');
const {
	ALL_SCOPES, makeClock, tmpDataDir, makeLog, makeTokens, createFakeEsi,
	tx, journalRow, order, historyOrder, asset, contract, contractItem,
} = require('../test-support/esi-fake');

// Every ESI answer here comes from test-support/esi-fake.js; no test touches the network or data/.

const IVAN = 90000001;
const GRANT = 90000002;
const STRUCTURE = 1028858195912;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

const setup = (t, { characters = [IVAN], scopes = ALL_SCOPES, fake: fakeOptions = {}, service: serviceOptions = {} } = {}) => {
	const dataDir = tmpDataDir(t);
	const clock = makeClock();
	const fake = createFakeEsi({ now: clock, ...fakeOptions });
	const store = createTokenStore({ dataDir });
	for (const id of characters) {
		store.upsert({ characterId: id, name: id === IVAN ? 'Ivan Tester' : 'Grant Tester', ownerHash: `owner-${id}`, scopes, refreshToken: `refresh-${id}`, status: 'ok' });
		fake.character(id);
	}
	const tokens = makeTokens();
	const log = makeLog();
	const service = createSyncService({ dataDir, fetch: fake.fetch, now: clock, log, tokenStore: store, tokens, userAgent: 'eflip-test/1.0', ...serviceOptions });
	return { dataDir, clock, fake, store, tokens, log, service };
};

// A character with a little of everything.
const fillIvan = (fake) => fake.character(IVAN, {
	balance: 1234567.89,
	transactions: [
		tx(6001, { date: '2026-11-17T08:00:00Z' }),
		tx(6002, { is_buy: false, location_id: STRUCTURE, quantity: 3, unit_price: 9, date: '2026-11-18T08:00:00Z' }),
		tx(6003, { type_id: 35, date: '2026-11-19T08:00:00Z' }),
	],
	journal: [1, 2, 3, 4, 5].map(i => journalRow(7000 + i)),
	orders: [
		order(8001, { type_id: 35 }),
		order(8002, { is_buy_order: true, type_id: 36, region_id: 10000002, location_id: 60003760 }),
	],
	ordersHistory: [historyOrder(8101, { type_id: 34 }), historyOrder(8102, { type_id: 35, state: 'cancelled', volume_remain: 4 })],
	assets: [asset(1, { type_id: 34 }), asset(2, { type_id: 37 }), asset(3, { type_id: 38, location_id: STRUCTURE, location_type: 'other' })],
	contracts: [
		contract(9001, { type: 'item_exchange' }),
		contract(9002, { type: 'courier', status: 'in_progress', reward: 5000000, collateral: 1000000 }),
		contract(9003, { type: 'auction', status: 'outstanding' }),
	],
	contractItems: { 9001: [contractItem(1, 34, 100)], 9002: [contractItem(1, 34, 60), contractItem(2, 35, 10)] },
	skills: { skills: [{ skill_id: 16622, trained_skill_level: 4, active_skill_level: 4, skillpoints_in_skill: 181020 }], total_sp: 181020, unallocated_sp: 0 },
	standings: [{ from_id: 500001, from_type: 'faction', standing: 2.5 }],
});

const pathsOf = (calls) => calls.map(call => call.path + (Object.keys(call.query).length ? `?${new URLSearchParams(call.query)}` : ''));
const rawNames = (dataDir, owner, slug) => {
	try {
		return fs.readdirSync(path.join(dataDir, 'raw', String(owner), slug)).filter(name => /\.json(?:\.gz)?$/.test(name)).sort();
	} catch (e) {
		return [];
	}
};
// public market raw is gzipped (`.json.gz`)
const readJson = (file) => JSON.parse(file.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(file)).toString('utf8') : fs.readFileSync(file, 'utf8'));
const ledgerRows = (dataDir, id, name) => readJson(path.join(dataDir, 'ledger', String(id), `${name}.json`));

test('a first sync stores raw, builds the ledger, a snapshot and the profile, and names structures', async (t) => {
	const { dataDir, fake, service } = setup(t);
	fillIvan(fake);
	fake.structures.set(STRUCTURE, { name: 'Test Trading Tower', owner_id: 98000001, position: { x: 1, y: 2, z: 3 }, solar_system_id: 30000144, type_id: 35834 });

	const result = await service.syncCharacter(IVAN, { force: true });
	assert.equal(result.status, 'ok', JSON.stringify(result.errors));
	assert.equal(result.snapshot, 'written');
	assert.equal(result.routes.transactions.calls, 1);
	assert.equal(result.routes.journal.calls, 1);
	assert.equal(result.routes.contractItems.calls, 2, 'items for the item-exchange and the courier, not the auction');
	assert.deepEqual(result.rowsAdded, { transactions: 3, journal: 5, ordersHistory: 2, contracts: 3, contractItems: 2, structures: 1 });

	// the ledger
	assert.deepEqual(ledgerRows(dataDir, IVAN, 'transactions').map(row => row.transaction_id), [6001, 6002, 6003]);
	assert.equal(ledgerRows(dataDir, IVAN, 'journal').length, 5);
	assert.deepEqual(ledgerRows(dataDir, IVAN, 'orders-history').map(row => row.order_id), [8101, 8102]);
	assert.deepEqual(ledgerRows(dataDir, IVAN, 'contracts').map(row => row.contract_id), [9001, 9002, 9003]);
	assert.deepEqual(readJson(path.join(dataDir, 'ledger', String(IVAN), 'contract-items', '9002.json')).map(item => item.type_id), [34, 35]);
	assert.ok(!fs.existsSync(path.join(dataDir, 'ledger', String(IVAN), 'contract-items', '9003.json')));
	const profile = readJson(path.join(dataDir, 'ledger', String(IVAN), 'profile.json'));
	assert.equal(profile.skills[0].skill_id, 16622);
	assert.equal(profile.standings[0].standing, 2.5);
	const structures = readJson(path.join(dataDir, 'ledger', 'structures.json'));
	assert.equal(structures[STRUCTURE].name, 'Test Trading Tower');
	assert.equal(structures[STRUCTURE].characterId, IVAN);

	// the snapshot
	const snapshots = fs.readdirSync(path.join(dataDir, 'ledger', String(IVAN), 'snapshots'));
	assert.equal(snapshots.length, 1);
	const snapshot = readJson(path.join(dataDir, 'ledger', String(IVAN), 'snapshots', snapshots[0]));
	assert.equal(snapshot.syncedAt, result.syncedAt);
	assert.equal(snapshot.balance, 1234567.89);
	assert.equal(snapshot.orders.length, 2);
	assert.equal(snapshot.assets.length, 3);

	// raw: every 200 body is on disk, with its headers
	for (const slug of ['wallet-transactions', 'wallet-journal', 'orders', 'orders-history', 'assets', 'wallet', 'contracts', 'contracts-9001-items', 'contracts-9002-items', 'skills', 'standings', `universe-structures-${STRUCTURE}`]) {
		assert.equal(rawNames(dataDir, IVAN, slug).length, 1, slug);
	}
	const rawJournal = readJson(path.join(dataDir, 'raw', String(IVAN), 'wallet-journal', rawNames(dataDir, IVAN, 'wallet-journal')[0]));
	assert.deepEqual(Object.keys(rawJournal), ['fetchedAt', 'url', 'status', 'headers', 'body']);
	assert.equal(rawJournal.url, `https://esi.evetech.net/characters/${IVAN}/wallet/journal`);
	assert.equal(rawJournal.headers['x-pages'], '1');
	assert.equal(rawJournal.headers['x-ratelimit-group'], 'char-wallet');
	assert.equal(rawJournal.body.length, 5);
	assert.equal(rawNames(dataDir, IVAN, 'wallet-journal-page-2').length, 0);

	// the sync log names the raw files the snapshot came from, and nothing holds a token
	const logs = fs.readdirSync(path.join(dataDir, 'raw', String(IVAN), '_sync-log'));
	assert.equal(logs.length, 1);
	assert.ok(!JSON.stringify([...fs.readdirSync(path.join(dataDir, 'raw', String(IVAN), 'assets'))]).includes('token'));
	for (const file of walk(dataDir)) assert.ok(!fs.readFileSync(file, 'utf8').includes(`token-${IVAN}`), file);
});

const walk = (dir) => {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else out.push(full);
	}
	return out;
};

test('every request carries the ESI headers and the versionless URL style', async (t) => {
	const { fake, service } = setup(t);
	fillIvan(fake);
	await service.syncCharacter(IVAN, { force: true });
	assert.ok(fake.calls.length > 5);
	for (const call of fake.calls) {
		assert.ok(call.url.startsWith('https://esi.evetech.net/'), call.url);
		assert.ok(!call.url.includes('/latest/') && !call.url.includes('datasource'), call.url);
		assert.equal(call.headers.accept, 'application/json');
		assert.equal(call.headers['user-agent'], 'eflip-test/1.0');
		assert.equal(call.headers['x-compatibility-date'], '2026-08-18');
		assert.equal(call.headers.authorization, `Bearer token-${IVAN}`);
	}
});

test('a second sync before Expires makes no ESI call and changes nothing', async (t) => {
	const { dataDir, fake, service, clock } = setup(t);
	fillIvan(fake);
	await service.syncCharacter(IVAN, { force: true });
	const before = fake.calls.length;
	const filesBefore = walk(path.join(dataDir, 'raw')).length;

	clock.advance(30 * 1000);
	const second = await service.syncCharacter(IVAN, { force: true });
	assert.equal(fake.calls.length, before, 'no call went out');
	assert.equal(second.calls, 0);
	assert.equal(second.status, 'ok');
	assert.equal(second.snapshot, 'skipped');
	assert.equal(walk(path.join(dataDir, 'raw')).length, filesBefore);
	assert.equal(fs.readdirSync(path.join(dataDir, 'raw', String(IVAN), '_sync-log')).length, 1, 'a sync without calls leaves no log');
});

test('after Expires every route is asked with If-None-Match, a 304 stores nothing, and only new ids join the ledger', async (t) => {
	const { dataDir, fake, service, clock } = setup(t);
	fillIvan(fake);
	await service.syncCharacter(IVAN, { force: true });
	const afterFirst = walk(path.join(dataDir, 'raw')).length;
	const ledgerBefore = ledgerRows(dataDir, IVAN, 'transactions');

	// everything has expired, nothing changed: 304s, nothing stored
	clock.advance(2 * HOUR);
	fake.reset();
	const second = await service.syncCharacter(IVAN, { force: true });
	assert.ok(second.calls > 0);
	assert.equal(second.notModified, second.calls, 'every answer was a 304');
	assert.equal(second.stored, 0);
	assert.ok(fake.calls.every(call => call.status === 304));
	assert.ok(fake.calls.every(call => typeof call.headers['if-none-match'] === 'string' && call.headers['if-none-match'].startsWith('"')));
	assert.equal(fake.callsTo(/\/items$/).length, 0, 'contract items are never fetched again');
	assert.equal(fake.callsTo(/\/(skills|standings)$/).length, 0, 'skills and standings only once a day');
	assert.equal(fake.callsTo(/structures/).length, 0);
	// the only files added are the sync log for this sync
	assert.equal(walk(path.join(dataDir, 'raw')).length, afterFirst + 1);
	assert.deepEqual(ledgerRows(dataDir, IVAN, 'transactions'), ledgerBefore);

	// new rows appear: only they are added
	clock.advance(2 * HOUR);
	fillIvan(fake);
	fake.character(IVAN).transactions.push(tx(6004, { date: '2026-11-20T10:00:00Z' }));
	fake.character(IVAN).journal.push(journalRow(7006));
	fake.reset();
	const third = await service.syncCharacter(IVAN, { force: true });
	assert.equal(third.rowsAdded.transactions, 1);
	assert.equal(third.rowsAdded.journal, 1);
	assert.equal(third.rowsAdded.contracts, 0);
	assert.deepEqual(ledgerRows(dataDir, IVAN, 'transactions').map(row => row.transaction_id), [6001, 6002, 6003, 6004]);
	assert.equal(ledgerRows(dataDir, IVAN, 'journal').length, 6);
	assert.equal(rawNames(dataDir, IVAN, 'wallet-transactions').length, 2, 'the changed body is stored as a new file');
	assert.equal(rawNames(dataDir, IVAN, 'contracts').length, 1, 'an unchanged body is not');
});

test('a route is not called before its own Expires, only the ones that expired', async (t) => {
	const { fake, service, clock } = setup(t);
	fillIvan(fake);
	await service.syncCharacter(IVAN, { force: true });
	// wallet balance (2 min) and contracts (5 min) expire first; orders after 20 min
	clock.advance(6 * MINUTE);
	fake.reset();
	await service.syncCharacter(IVAN, { force: true });
	assert.deepEqual(pathsOf(fake.calls), [`/characters/${IVAN}/wallet`, `/characters/${IVAN}/contracts`]);
	clock.advance(15 * MINUTE);
	fake.reset();
	await service.syncCharacter(IVAN, { force: true });
	assert.deepEqual(pathsOf(fake.calls), [`/characters/${IVAN}/orders`, `/characters/${IVAN}/wallet`, `/characters/${IVAN}/contracts`]);
});

test('transactions walk back with from_id until fewer than a full page come back', async (t) => {
	const { dataDir, fake, service, clock } = setup(t, { fake: { transactionsPageSize: 4 }, service: { transactionsPageSize: 4 } });
	fake.character(IVAN, { transactions: Array.from({ length: 10 }, (_, i) => tx(6001 + i)) });
	const result = await service.syncCharacter(IVAN, { force: true });
	const calls = fake.callsTo(/wallet\/transactions/);
	assert.deepEqual(calls.map(call => call.query.from_id), [undefined, '6007', '6003']);
	assert.equal(result.routes.transactions.calls, 3);
	assert.equal(ledgerRows(dataDir, IVAN, 'transactions').length, 10);
	assert.deepEqual(rawNames(dataDir, IVAN, 'wallet-transactions-from-id-6007').length, 1);

	// a later sync stops at the first page that holds nothing new, because the earlier walk completed
	clock.advance(2 * HOUR);
	fake.character(IVAN).transactions.push(tx(6011), tx(6012));
	fake.reset();
	await service.syncCharacter(IVAN, { force: true });
	assert.deepEqual(fake.callsTo(/wallet\/transactions/).map(call => call.query.from_id), [undefined, '6009']);
	assert.equal(ledgerRows(dataDir, IVAN, 'transactions').length, 12);
});

test('a transactions walk that stopped half way is finished by the next sync, even when page 1 is unchanged', async (t) => {
	const { dataDir, fake, service, clock } = setup(t, { fake: { transactionsPageSize: 4 }, service: { transactionsPageSize: 4 } });
	fake.character(IVAN, { transactions: Array.from({ length: 10 }, (_, i) => tx(6001 + i)) });
	let broken = true;
	fake.respondWith = (call) => (broken && call.query.from_id === '6007' ? new Response('{"error":"boom"}', { status: 500 }) : null);
	const first = await service.syncCharacter(IVAN, { force: true });
	assert.equal(first.status, 'partial');
	assert.equal(ledgerRows(dataDir, IVAN, 'transactions').length, 4, 'only page 1 arrived');

	broken = false;
	clock.advance(2 * HOUR);
	fake.reset();
	const second = await service.syncCharacter(IVAN, { force: true });
	assert.equal(second.status, 'ok');
	assert.deepEqual(fake.callsTo(/wallet\/transactions/).map(call => [call.query.from_id, call.status]), [[undefined, 304], ['6007', 200], ['6003', 200]]);
	assert.equal(ledgerRows(dataDir, IVAN, 'transactions').length, 10);

	// and once complete, an unchanged page 1 ends the walk at once
	clock.advance(2 * HOUR);
	fake.reset();
	await service.syncCharacter(IVAN, { force: true });
	assert.deepEqual(fake.callsTo(/wallet\/transactions/).map(call => call.query.from_id), [undefined]);
});

test('a first transactions walk keeps going past known rows until a short page', async (t) => {
	// the ledger knows 6010 from before, but no walk ever completed: the walk must not stop on it
	const { dataDir, fake, service } = setup(t, { fake: { transactionsPageSize: 3 }, service: { transactionsPageSize: 3 } });
	fake.character(IVAN, { transactions: Array.from({ length: 7 }, (_, i) => tx(6001 + i)) });
	await service.syncCharacter(IVAN, { force: true });
	assert.equal(ledgerRows(dataDir, IVAN, 'transactions').length, 7);
	assert.equal(fake.callsTo(/wallet\/transactions/).length, 3);
});

test('the journal is read page by page up to X-Pages', async (t) => {
	const { dataDir, fake, service } = setup(t, { fake: { pageSize: 2 } });
	fake.character(IVAN, { journal: [1, 2, 3, 4, 5].map(i => journalRow(7000 + i)) });
	const result = await service.syncCharacter(IVAN, { force: true });
	assert.deepEqual(fake.callsTo(/wallet\/journal/).map(call => call.query.page), [undefined, '2', '3']);
	assert.equal(ledgerRows(dataDir, IVAN, 'journal').length, 5);
	assert.equal(rawNames(dataDir, IVAN, 'wallet-journal-page-2').length, 1);
	assert.equal(rawNames(dataDir, IVAN, 'wallet-journal-page-3').length, 1);
	assert.equal(result.routes.journal.calls, 3);
	assert.equal(result.routes.journal.rowsAdded, 5);
});

test('assets pages form one snapshot, and the snapshot is skipped while nothing in it changes', async (t) => {
	const { dataDir, fake, service, clock } = setup(t, { fake: { pageSize: 2 } });
	fillIvan(fake);
	await service.syncCharacter(IVAN, { force: true });
	const snapshotDir = path.join(dataDir, 'ledger', String(IVAN), 'snapshots');
	assert.equal(fs.readdirSync(snapshotDir).length, 1);
	assert.equal(readJson(path.join(snapshotDir, fs.readdirSync(snapshotDir)[0])).assets.length, 3, 'two asset pages merged');

	// a journal row is not in a snapshot: nothing is written
	clock.advance(2 * HOUR);
	fake.character(IVAN).journal.push(journalRow(7006));
	const second = await service.syncCharacter(IVAN, { force: true });
	assert.equal(second.snapshot, 'unchanged');
	assert.equal(fs.readdirSync(snapshotDir).length, 1);

	// a new open order is
	clock.advance(2 * HOUR);
	fake.character(IVAN).orders.push(order(8003, { type_id: 39 }));
	const third = await service.syncCharacter(IVAN, { force: true });
	assert.equal(third.snapshot, 'written');
	assert.equal(fs.readdirSync(snapshotDir).length, 2);
	const stamps = fs.readdirSync(snapshotDir).sort();
	assert.equal(readJson(path.join(snapshotDir, stamps[0])).orders.length, 2, 'the earlier snapshot is kept as it was');
	assert.equal(readJson(path.join(snapshotDir, stamps[1])).orders.length, 3);
});

test('contract items are fetched once per contract; a contract with no items still gets a file', async (t) => {
	const { dataDir, fake, service, clock } = setup(t);
	fake.character(IVAN, {
		contracts: [contract(9001), contract(9002, { type: 'courier', status: 'outstanding' })],
		contractItems: { 9001: [], 9002: [contractItem(1, 34, 5)] },
	});
	await service.syncCharacter(IVAN, { force: true });
	assert.equal(fake.callsTo(/\/items$/).length, 2);
	assert.deepEqual(readJson(path.join(dataDir, 'ledger', String(IVAN), 'contract-items', '9001.json')), []);

	clock.advance(2 * HOUR);
	fake.character(IVAN).contracts.push(contract(9004, { type: 'courier' }));
	fake.character(IVAN).contractItems[9004] = [contractItem(1, 35, 7)];
	fake.reset();
	await service.syncCharacter(IVAN, { force: true });
	assert.deepEqual(fake.callsTo(/\/items$/).map(call => call.path), [`/characters/${IVAN}/contracts/9004/items`]);
});

test('a structure the character cannot dock at is asked once, not on every sync', async (t) => {
	const { fake, service, clock } = setup(t);
	fake.character(IVAN, { transactions: [tx(6001, { location_id: STRUCTURE })] });
	fake.structures.set(STRUCTURE, 'forbidden');
	const first = await service.syncCharacter(IVAN, { force: true });
	assert.equal(fake.callsTo(/structures/).length, 1);
	assert.equal(first.structuresForbidden, 1);
	assert.equal(first.status, 'ok', 'a 403 on a structure is not a sync error');

	clock.advance(2 * HOUR);
	fake.reset();
	const second = await service.syncCharacter(IVAN, { force: true });
	assert.equal(fake.callsTo(/structures/).length, 0);
	assert.equal(second.structuresForbidden, 0);
	clock.advance(31 * 24 * HOUR);
	fake.reset();
	await service.syncCharacter(IVAN, { force: true });
	assert.equal(fake.callsTo(/structures/).length, 1, 'asked again after a month');
});

test('two characters synced at once both keep their new structure, and a name missing from structures.json is restored from raw', async (t) => {
	const { dataDir, fake, service, clock } = setup(t, { characters: [IVAN, GRANT] });
	const OTHER = STRUCTURE + 7;
	fake.structures.set(STRUCTURE, { name: 'Test Trading Tower', owner_id: 98000001, solar_system_id: 30000144, type_id: 35834 });
	fake.structures.set(OTHER, { name: 'Other Tower', owner_id: 98000001, solar_system_id: 30000144, type_id: 35834 });
	fake.character(IVAN, { transactions: [tx(6001, { location_id: STRUCTURE })] });
	fake.character(GRANT, { transactions: [tx(6501, { location_id: OTHER })] });
	const structuresFile = path.join(dataDir, 'ledger', 'structures.json');

	const [ivan, grant] = await Promise.all([service.syncCharacter(IVAN, { force: true }), service.syncCharacter(GRANT, { force: true })]);
	assert.deepEqual([ivan.status, grant.status], ['ok', 'ok']);
	assert.deepEqual([ivan.rowsAdded.structures, grant.rowsAdded.structures], [1, 1]);
	const both = readJson(structuresFile);
	assert.deepEqual(Object.keys(both).sort(), [String(STRUCTURE), String(OTHER)], 'neither write lost the other\'s name');
	assert.equal(both[STRUCTURE].characterId, IVAN);
	assert.equal(both[OTHER].characterId, GRANT);

	// the names are lost (the file rewritten); the next syncs get 304s, and put them back from raw
	fs.writeFileSync(structuresFile, '{}\n');
	clock.advance(2 * HOUR);
	fake.reset();
	const again = await service.syncAll({ force: true, market: false, regionBook: false });
	assert.deepEqual(again.characters.map(c => c.status), ['ok', 'ok']);
	assert.equal(fake.callsTo(/structures/).length, 2);
	assert.deepEqual(again.characters.map(c => c.routes.structures.notModified), [1, 1]);
	assert.deepEqual(again.characters.map(c => c.rowsAdded.structures), [1, 1], 'a restored name counts as a row added');
	assert.deepEqual(readJson(structuresFile), both, 'the entries the first answers wrote');

	// the same inside the route's Expires: ten minutes on, structures.json loses one name again
	fs.writeFileSync(structuresFile, JSON.stringify({ [OTHER]: both[OTHER] }));
	clock.advance(10 * MINUTE);
	fake.reset();
	const notDue = await service.syncCharacter(IVAN, { force: true });
	assert.equal(fake.callsTo(/structures/).length, 0);
	assert.equal(notDue.routes.structures.notDue, 1);
	assert.equal(notDue.rowsAdded.structures, 1);
	assert.deepEqual(readJson(structuresFile), both);
});

test('skills and standings are refreshed once a day', async (t) => {
	const { dataDir, fake, service, clock } = setup(t);
	fillIvan(fake);
	await service.syncCharacter(IVAN, { force: true });
	assert.equal(fake.callsTo(/\/skills$/).length, 1);
	clock.advance(23 * HOUR);
	await service.syncCharacter(IVAN, { force: true });
	assert.equal(fake.callsTo(/\/skills$/).length, 1);

	clock.advance(2 * HOUR);
	fake.character(IVAN).skills = { skills: [{ skill_id: 16622, trained_skill_level: 5, active_skill_level: 5, skillpoints_in_skill: 256000 }], total_sp: 256000, unallocated_sp: 0 };
	await service.syncCharacter(IVAN, { force: true });
	assert.equal(fake.callsTo(/\/skills$/).length, 2);
	assert.equal(readJson(path.join(dataDir, 'ledger', String(IVAN), 'profile.json')).skills[0].active_skill_level, 5);
	assert.equal(rawNames(dataDir, IVAN, 'skills').length, 2, 'the raw copies keep the history');
});

test('without a scope its routes are not called, and no snapshot is made', async (t) => {
	const scopes = ALL_SCOPES.filter(scope => scope !== SCOPES.assets && scope !== SCOPES.structures);
	const { fake, service } = setup(t, { scopes });
	fillIvan(fake);
	const result = await service.syncCharacter(IVAN, { force: true });
	assert.deepEqual(result.missingScopes.sort(), [SCOPES.assets, SCOPES.structures].sort());
	assert.equal(fake.callsTo(/assets/).length, 0);
	assert.equal(fake.callsTo(/structures/).length, 0);
	assert.equal(result.snapshot, 'skipped');
	assert.equal(result.status, 'ok');
});

test('an error-limit under 20 stops the sync; the next one waits it out', async (t) => {
	const { fake, service, clock, dataDir } = setup(t, { fake: { errorLimitRemain: 15 } });
	fillIvan(fake);
	const result = await service.syncCharacter(IVAN, { force: true });
	assert.equal(result.status, 'partial');
	assert.equal(result.stop.reason, 'error-limit');
	// transactions and journal went first; orders answered the low count; history was not asked
	assert.deepEqual(pathsOf(fake.calls), [
		`/characters/${IVAN}/wallet/transactions`,
		`/characters/${IVAN}/wallet/journal`,
		`/characters/${IVAN}/orders`,
	]);
	assert.equal(ledgerRows(dataDir, IVAN, 'journal').length, 5, 'what arrived before the stop is kept');

	fake.reset();
	const again = await service.syncCharacter(IVAN, { force: true });
	assert.equal(again.status, 'partial');
	assert.equal(fake.callsTo(/orders/).length, 0, 'still inside the error-limit window');

	clock.advance(HOUR);
	fake.errorLimitRemain = 100;
	fake.reset();
	const later = await service.syncCharacter(IVAN, { force: true });
	assert.equal(later.status, 'ok');
	assert.ok(fake.callsTo(/orders\/history/).length > 0);
});

test('a 429 stops the sync and its Retry-After is respected, also by a later process', async (t) => {
	const { dataDir, fake, service, clock, store, tokens, log } = setup(t);
	fillIvan(fake);
	fake.respondWith = (call) => (call.path.endsWith('/orders') ? new Response(JSON.stringify({ error: 'slow down' }), { status: 429, headers: { 'retry-after': '90' } }) : null);
	const result = await service.syncCharacter(IVAN, { force: true });
	assert.equal(result.status, 'partial');
	assert.deepEqual({ reason: result.stop.reason, retryAfter: result.stop.retryAfter }, { reason: 'rate-limited', retryAfter: 90 });
	assert.equal(fake.callsTo(/assets|contracts/).length, 0);

	// a new service on the same data directory (as scripts/sync.js would be) starts from the stored pause
	fake.respondWith = null;
	fake.reset();
	clock.advance(30 * 1000);
	const other = createSyncService({ dataDir, fetch: fake.fetch, now: clock, log, tokenStore: store, tokens, userAgent: 'eflip-test/1.0' });
	const waiting = await other.syncCharacter(IVAN, { force: true });
	assert.equal(waiting.status, 'partial');
	assert.equal(fake.callsTo(/\/orders/).length, 0);
	clock.advance(2 * MINUTE);
	fake.reset();
	const resumed = await other.syncCharacter(IVAN, { force: true });
	assert.equal(resumed.status, 'ok');
	assert.ok(fake.callsTo(/\/orders$/).length > 0);
});

test('a rate-limit group under 20 percent is skipped while the others carry on', async (t) => {
	const { fake, service } = setup(t);
	fillIvan(fake);
	fake.rateRemaining = { 'char-wallet': 20 }; // 20 of 150 is under 20 %
	const result = await service.syncCharacter(IVAN, { force: true });
	assert.equal(result.status, 'partial');
	assert.ok(result.pausedGroups['char-wallet'] > 0);
	assert.equal(fake.callsTo(/wallet\/transactions/).length, 1, 'the call that showed the low count');
	assert.equal(fake.callsTo(/wallet\/journal/).length, 0);
	assert.equal(fake.callsTo(/\/wallet$/).length, 0);
	assert.ok(fake.callsTo(/assets/).length > 0, 'other groups are unaffected');
	assert.ok(fake.callsTo(/contracts/).length > 0);
	assert.equal(result.snapshot, 'skipped', 'no balance, no snapshot');
});

test('a 401 is not retried and does not go on to other routes', async (t) => {
	const { fake, service, tokens } = setup(t);
	fillIvan(fake);
	fake.character(IVAN).rejectToken = true;
	const result = await service.syncCharacter(IVAN, { force: true });
	assert.equal(result.status, 'failed');
	assert.equal(result.stop.reason, 'unauthorized');
	assert.equal(fake.calls.length, 1, 'one call, no retry');
	assert.deepEqual(tokens.forgotten, [IVAN], 'the cached access token is dropped so the next sync refreshes it');
});

test('a character the token manager says needs re-linking makes no ESI call', async (t) => {
	const { fake, service, tokens, store } = setup(t);
	fillIvan(fake);
	tokens.failWith = new TokenError(`character ${IVAN} needs re-linking`, 'relink');
	const result = await service.syncCharacter(IVAN, { force: true });
	assert.equal(result.status, 'relink');
	assert.equal(fake.calls.length, 0);

	tokens.failWith = null;
	store.setStatus(IVAN, 'relink', 'invalid_grant');
	const flagged = await service.syncCharacter(IVAN, { force: true });
	assert.equal(flagged.status, 'relink');
	assert.equal(flagged.reason, 'invalid_grant');
	assert.equal(fake.calls.length, 0);
});

test('three server errors in a row end the sync with what it has', async (t) => {
	const { fake, service, dataDir } = setup(t);
	fillIvan(fake);
	fake.respondWith = (call) => (/orders|assets|contracts/.test(call.path) ? new Response('{"error":"boom"}', { status: 500 }) : null);
	const result = await service.syncCharacter(IVAN, { force: true });
	assert.equal(result.status, 'partial');
	assert.equal(result.stop.reason, 'errors');
	assert.ok(result.errors.length >= 3);
	assert.ok(ledgerRows(dataDir, IVAN, 'journal').length > 0);
	assert.equal(result.snapshot, 'skipped');
});

test('a sync inside the hour is skipped unless forced, and syncedAt only moves when a call went out', async (t) => {
	const { fake, service, clock } = setup(t);
	fillIvan(fake);
	const first = await service.syncCharacter(IVAN);
	assert.equal(first.status, 'ok');
	clock.advance(10 * MINUTE);
	const skipped = await service.syncCharacter(IVAN);
	assert.equal(skipped.status, 'skipped');
	assert.equal(skipped.syncedAt, first.syncedAt);
	const forcedAt = service.characterStatus(IVAN).syncedAt;
	clock.advance(51 * MINUTE);
	const next = await service.syncCharacter(IVAN);
	assert.equal(next.status, 'ok');
	assert.ok(next.calls > 0);
	assert.notEqual(service.characterStatus(IVAN).syncedAt, forcedAt);
	assert.equal(service.characterStatus(IVAN).status, 'ok');
});

test('concurrent requests for one character share one sync', async (t) => {
	const { fake, service } = setup(t);
	fillIvan(fake);
	const [a, b] = await Promise.all([service.syncCharacter(IVAN, { force: true }), service.syncCharacter(IVAN, { force: true })]);
	assert.equal(a, b);
	assert.equal(fake.callsTo(/wallet\/journal/).length, 1);
});

test('a character another process is syncing is reported busy, and a dead process lock is taken over', async (t) => {
	const { dataDir, fake, service } = setup(t);
	fillIvan(fake);
	// pretend the parent process holds the lock
	const lockDir = path.join(dataDir, 'locks');
	fs.mkdirSync(lockDir, { recursive: true });
	fs.writeFileSync(path.join(lockDir, `character-${IVAN}.lock`), JSON.stringify({ pid: process.ppid, at: Date.now() }));
	const busy = await service.syncCharacter(IVAN, { force: true });
	assert.equal(busy.status, 'busy');
	assert.equal(fake.calls.length, 0);

	fs.writeFileSync(path.join(lockDir, `character-${IVAN}.lock`), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
	const taken = await service.syncCharacter(IVAN, { force: true });
	assert.equal(taken.status, 'ok');
	assert.ok(!fs.existsSync(path.join(lockDir, `character-${IVAN}.lock`)), 'released afterwards');
	assert.equal(acquireLock(dataDir, 'other')(), undefined);
});

test('two characters sync independently, and a ledger deleted after a purge is rebuilt from raw first', async (t) => {
	const { dataDir, fake, service, clock } = setup(t, { characters: [IVAN, GRANT] });
	fillIvan(fake);
	fake.character(GRANT, { transactions: [tx(6501, { is_buy: false })], journal: [journalRow(7501, { first_party_id: GRANT, second_party_id: GRANT })] });
	const all = await service.syncAll({ force: true, market: false });
	assert.deepEqual(all.characters.map(c => [c.characterId, c.status]), [[IVAN, 'ok'], [GRANT, 'ok']]);
	assert.equal(all.market, null);
	assert.equal(ledgerRows(dataDir, GRANT, 'transactions').length, 1);

	fs.rmSync(path.join(dataDir, 'ledger', String(IVAN)), { recursive: true });
	clock.advance(2 * HOUR);
	const again = await service.syncCharacter(IVAN, { force: true });
	assert.equal(again.status, 'ok');
	assert.equal(ledgerRows(dataDir, IVAN, 'transactions').length, 3, 'rows the 304s would never have returned');
	assert.equal(ledgerRows(dataDir, IVAN, 'contracts').length, 3);
	assert.ok(fs.existsSync(path.join(dataDir, 'ledger', String(IVAN), 'contract-items', '9002.json')));
});

test('purging a character removes its ledger, raw and bookkeeping, and the next sync starts from nothing', async (t) => {
	const { dataDir, fake, service, clock } = setup(t);
	fillIvan(fake);
	await service.syncCharacter(IVAN, { force: true });
	service.purgeCharacter(IVAN);
	for (const dir of ['ledger', 'raw', 'esi-cache']) assert.ok(!fs.existsSync(path.join(dataDir, dir, String(IVAN))), dir);

	fake.reset();
	clock.advance(MINUTE);
	const again = await service.syncCharacter(IVAN, { force: true });
	assert.equal(again.status, 'ok');
	assert.equal(again.notModified, 0, 'every route was fetched afresh, nothing answered 304');
	assert.ok(again.stored >= 11);
	assert.equal(ledgerRows(dataDir, IVAN, 'transactions').length, 3);

	// refused with code 'busy' (the route's 409) while a sync runs here or holds the lock elsewhere
	const busy = (e) => /being synced/.test(e.message) && e.code === 'busy';
	const pending = service.syncCharacter(IVAN, { force: true });
	assert.throws(() => service.purgeCharacter(IVAN), busy);
	await pending;
	const lockDir = path.join(dataDir, 'locks');
	fs.mkdirSync(lockDir, { recursive: true });
	fs.writeFileSync(path.join(lockDir, `character-${IVAN}.lock`), JSON.stringify({ pid: process.ppid, at: Date.now() }));
	assert.throws(() => service.purgeCharacter(IVAN), busy);
});

test('an unlinked character is reported, not synced', async (t) => {
	const { fake, service } = setup(t);
	const result = await service.syncCharacter(4242, { force: true });
	assert.equal(result.status, 'failed');
	assert.equal(result.reason, 'not linked');
	assert.equal(fake.calls.length, 0);
});

// ---- the destination market

const marketSetup = (t, options = {}) => {
	const ctx = setup(t, options);
	fillIvan(ctx.fake);
	return ctx;
};

test('marketTypes ranks listed, in transit, held and recently sold types, and marketRegions picks the sell region', async (t) => {
	const { dataDir, fake, service, clock } = marketSetup(t);
	await service.syncCharacter(IVAN, { force: true });
	const now = clock();
	const types = marketTypes({ ledger: service.ledger, characterIds: [IVAN], now });
	assert.equal(types.get(35), 0, 'type 35 has an open sell order');
	assert.equal(types.get(34), 1, 'type 34 rides in the unfinished courier');
	assert.equal(types.get(37), 2, 'held');
	service.ledger.mergeInto(IVAN, 'transactions', [
		tx(6100, { is_buy: false, type_id: 40, date: '2026-11-10T00:00:00Z' }),
		tx(6101, { is_buy: false, type_id: 41, date: '2026-06-01T00:00:00Z' }),
	]);
	const withSales = marketTypes({ ledger: service.ledger, characterIds: [IVAN], now });
	assert.equal(withSales.get(40), 3, 'sold within the last 90 days');
	assert.equal(withSales.has(41), false, 'sold longer ago');
	assert.equal(types.has(36), false, 'a buy order alone is not a type in play');
	assert.deepEqual(marketRegions({ dataDir, ledger: service.ledger, characterIds: [IVAN], now }), [10000043]);

	// a persisted run's end region takes precedence
	fs.mkdirSync(path.join(dataDir, 'runs'), { recursive: true });
	fs.writeFileSync(path.join(dataDir, 'runs', 'a.json'), JSON.stringify({ copiedAt: '2026-11-18T00:00:00Z', route: { endRegionId: 10000002 } }));
	fs.writeFileSync(path.join(dataDir, 'runs', 'b.json'), JSON.stringify({ copiedAt: '2026-11-19T00:00:00Z', lastCopiedAt: '2026-11-19T01:00:00Z', route: { endRegionId: 10000030 } }));
	fs.writeFileSync(path.join(dataDir, 'runs', 'broken.json'), '{not json');
	assert.deepEqual(marketRegions({ dataDir, ledger: service.ledger, characterIds: [IVAN], now }), [10000030]);
});

test('the market snapshot stores the destination orders and history raw, for the types in play only', async (t) => {
	const { dataDir, fake, service } = marketSetup(t);
	await service.syncCharacter(IVAN, { force: true });
	fake.market.orders.set('10000043:35', [{ order_id: 1, price: 10, is_buy_order: false, volume_remain: 5, type_id: 35, issued: '2026-11-19T00:00:00Z', duration: 90, range: 'region', location_id: 60008494, system_id: 30002187, volume_total: 5, min_volume: 1 }]);
	fake.market.history.set('10000043:35', [{ date: '2026-11-19', average: 10, highest: 11, lowest: 9, order_count: 3, volume: 50 }]);
	fake.reset();

	const result = await service.syncMarket({ force: true, concurrency: 1 });
	assert.equal(result.status, 'ok', JSON.stringify(result.errors));
	assert.deepEqual(result.regionIds, [10000043]);
	assert.equal(result.types, 4, 'listed 35, courier 34, held 37 and 38; the buy-order type 36 is not in play');
	assert.equal(result.routes.marketOrders.calls, 4);
	assert.equal(result.routes.marketHistory.calls, 4);
	// no authorization on public routes
	assert.ok(fake.calls.every(call => call.headers.authorization === undefined));
	assert.ok(fake.calls.every(call => /^\/markets\/10000043\/(orders|history)$/.test(call.path)));
	assert.deepEqual(rawNames(dataDir, 'public', 'markets-10000043-orders-type-id-35').length, 1);
	assert.match(rawNames(dataDir, 'public', 'markets-10000043-orders-type-id-35')[0], /\.json\.gz$/, 'a per-type book is stored gzipped');
	const raw = readJson(path.join(dataDir, 'raw', 'public', 'markets-10000043-history-type-id-35', rawNames(dataDir, 'public', 'markets-10000043-history-type-id-35')[0]));
	assert.equal(raw.body[0].average, 10);
	assert.equal(rawNames(dataDir, 'public', 'markets-10000043-orders-type-id-36').length, 0);
	assert.equal(result.routes.marketOrders.rate.group, 'market-order');

	// readMarket serves what was stored
	const read = service.readMarket({ typeIds: [35, 34] });
	assert.deepEqual(read.regionIds, [10000043]);
	assert.equal(read.types[35][10000043].orders.rows[0].order_id, 1);
	assert.equal(read.types[35][10000043].history.rows[0].volume, 50);
	assert.deepEqual(read.types[34][10000043].orders.rows, []);
});

test('the market snapshot honours Expires too: a second run inside it calls nothing, and caps at maxTypes', async (t) => {
	const { fake, service, clock } = marketSetup(t);
	await service.syncCharacter(IVAN, { force: true });
	fake.reset();
	const first = await service.syncMarket({ force: true, concurrency: 1, maxTypes: 2 });
	assert.equal(first.types, 2);
	assert.equal(first.candidates, 4);
	assert.equal(first.capped, true);
	assert.equal(fake.calls.length, 4);
	// the two highest priorities went first: listed (35), then in transit (34)
	assert.deepEqual([...new Set(fake.calls.map(call => call.query.type_id))].sort(), ['34', '35']);

	fake.reset();
	clock.advance(MINUTE);
	const second = await service.syncMarket({ force: true, concurrency: 1, maxTypes: 2 });
	assert.equal(fake.calls.length, 0);
	assert.equal(second.calls, 0);

	// past the order cache (5 min) the least recently checked types come first within a priority
	clock.advance(10 * MINUTE);
	fake.reset();
	await service.syncMarket({ force: true, concurrency: 1, maxTypes: 2 });
	assert.deepEqual([...new Set(fake.callsTo(/orders/).map(call => call.query.type_id))].sort(), ['34', '35'], 'still the highest priorities');
	assert.equal(fake.callsTo(/history/).length, 0, 'history is cached for a day');
});

test('300 types is the default cap', async (t) => {
	const { fake, service } = setup(t);
	fake.character(IVAN, { assets: Array.from({ length: 450 }, (_, i) => asset(i + 1, { type_id: 1000 + i })), orders: [order(8001, { type_id: 35 })] });
	await service.syncCharacter(IVAN, { force: true });
	fake.reset();
	const result = await service.syncMarket({ force: true, concurrency: 3 });
	assert.equal(result.candidates, 451);
	assert.equal(result.types, 300);
	assert.equal(result.capped, true);
	assert.equal(fake.callsTo(/orders/).length, 300);
	assert.equal(fake.callsTo(/history/).length, 300);
});

test('a market book of several pages costs extra calls, but never more than twice the types', async (t) => {
	const { fake, service } = setup(t, { fake: { pageSize: 1 } });
	fake.character(IVAN, { orders: [order(8001, { type_id: 35 }), order(8002, { type_id: 36 })] });
	await service.syncCharacter(IVAN, { force: true });
	const book = (typeId) => Array.from({ length: 8 }, (_, i) => ({ order_id: typeId * 100 + i, price: 10 + i, is_buy_order: false, type_id: typeId, volume_remain: 1 }));
	fake.market.orders.set('10000043:35', book(35));
	fake.market.orders.set('10000043:36', book(36));
	fake.reset();
	const result = await service.syncMarket({ force: true, concurrency: 1 });
	// 2 types: one call each is the plan; 8 pages would be 16 calls, but pages stop at 5 and calls at 4
	assert.equal(result.routes.marketOrders.calls, 4);
	assert.equal(result.stop.reason, 'budget');
	assert.equal(result.status, 'partial');
	assert.deepEqual(fake.callsTo(/orders/).map(call => call.query.page), [undefined, '2', '3', '4']);

	const roomy = setup(t, { fake: { pageSize: 1 } });
	roomy.fake.character(IVAN, { orders: [order(8001, { type_id: 35 })], assets: [asset(1, { type_id: 34 }), asset(2, { type_id: 37 }), asset(3, { type_id: 38 })] });
	await roomy.service.syncCharacter(IVAN, { force: true });
	roomy.fake.market.orders.set('10000043:35', book(35));
	const ok = await roomy.service.syncMarket({ force: true, concurrency: 1 });
	assert.equal(ok.stop, null);
	assert.equal(ok.routes.marketOrders.calls, 5 + 1 + 1 + 1, 'five pages for the long book, one each for the three others (8 is the budget for 4 types)');
	assert.equal(ok.truncated, 1, 'and the long book was cut at five pages');
	const read = roomy.service.readMarket({ typeIds: [35] });
	assert.equal(read.types[35][10000043].orders.rows.length, 5);
});

test('the market snapshot stops when the market-order bucket runs low, and waits for a region', async (t) => {
	const { fake, service } = marketSetup(t);
	await service.syncCharacter(IVAN, { force: true });
	fake.reset();
	fake.rateRemaining = { 'market-order': 2000 }; // under 20 % of 12000
	const result = await service.syncMarket({ force: true, concurrency: 1 });
	assert.equal(result.status, 'partial');
	assert.equal(result.stop.reason, 'paused');
	assert.equal(fake.callsTo(/orders/).length, 1);

	const empty = setup(t);
	const none = await empty.service.syncMarket({ force: true });
	assert.equal(none.status, 'skipped');
	assert.match(none.reason, /no destination region/);
});

test('syncAll runs the characters then the market, unless the market is deferred', async (t) => {
	const { fake, service } = marketSetup(t);
	const deferred = await service.syncAll({ force: true, market: false });
	assert.equal(deferred.market, null);
	assert.equal(fake.callsTo(/markets/).length, 0);
	const full = await service.syncAll({ force: true });
	assert.ok(full.market && full.market.status === 'ok');
	assert.ok(fake.callsTo(/markets/).length > 0);
	assert.equal(service.status().market.status, 'ok');
	assert.equal(service.status().characters[IVAN].status, 'ok');
});

test('with a storage budget the market step ends with the storage step; syncAll answers it, and storage: true runs one more', async (t) => {
	const env = {};
	const { dataDir, fake, clock, service } = marketSetup(t, { service: { env } });
	const REGION = 10000043;
	const slug = `markets-${REGION}-orders-type-id-35`;
	const row = (price) => ({ order_id: 1, type_id: 35, price, is_buy_order: false, volume_remain: 5, volume_total: 10, issued: '2026-11-18T10:00:00Z', duration: 90, range: 'region', location_id: 60008494, system_id: 30002187, min_volume: 1 });
	fake.market.orders.set(`${REGION}:35`, [row(100)]);
	const first = await service.syncAll({ force: true });
	assert.equal(first.market.status, 'ok');
	assert.equal(first.market.storage, undefined, 'no budget: no storage step');
	assert.equal(first.storage, null);
	assert.equal(rawNames(dataDir, 'public', slug).length, 1);

	// a second book of 35 is stored; with a budget the step after the market keeps only the newest
	env.EFLIP_STORAGE_BUDGET = '1KB';
	clock.advance(2 * HOUR);
	fake.market.orders.set(`${REGION}:35`, [row(99)]);
	const second = await service.syncAll({ force: true });
	assert.equal(second.market.status, 'ok');
	assert.equal(second.market.storage.status, 'ok', JSON.stringify(second.market.storage));
	assert.equal(second.market.storage.reason, 'market');
	assert.equal(second.storage, second.market.storage, 'the answer carries the step the market ran');
	assert.ok(second.storage.trims.typeBooks.files >= 1);
	assert.equal(rawNames(dataDir, 'public', slug).length, 1, 'the older book of 35 is gone, the newest stays');
	assert.ok(second.storage.unmet > 0, 'what is left is floors: over 1 KB, nothing more to trim');
	assert.equal(service.readMarket({ typeIds: [35], regionIds: [REGION] }).types[35][REGION].orders.rows[0].price, 99, 'the market reads still find the newest book');

	// storage: true runs one more step at the end, without touching ESI
	fake.reset();
	const asked = await service.syncAll({ characterIds: [], market: false, storage: true });
	assert.equal(asked.storage.status, 'ok');
	assert.equal(asked.storage.reason, 'manual');
	assert.equal(fake.calls.length, 0);
	const entries = (() => {
		const raw = service.raw;
		return raw.syncLogStamps('public').map(stamp => raw.readSyncLog('public', stamp)).filter(entry => entry.kind === 'storage');
	})();
	assert.deepEqual(entries.map(entry => entry.reason), ['market', 'manual']);
	// the market step still reads its regions from the newest market entry, past the storage entries
	assert.deepEqual(service.readMarket({ typeIds: [35] }).regionIds, [REGION]);
});

test('a status read while a storage run yields is not answered after the run: the run measures afresh when it ends', async (t) => {
	const { createLedger } = require('../lib/ledger');
	const derive = require('../lib/derive');
	const { dataDir, clock, service } = setup(t, { service: { env: { EFLIP_STORAGE_BUDGET: '1' } } });
	const REGION = 10000043;
	const row = (id, typeId) => ({ order_id: id, type_id: typeId, price: 100 + id, is_buy_order: false, volume_remain: 5, volume_total: 10, issued: '2026-11-08T10:00:00Z', duration: 90, range: 'region', location_id: 60008494, system_id: 30002187, min_volume: 1 });
	// 120 logs (the storage run yields every 100), each with orders last seen ten days ago, which the
	// trim drops, and a sample an hour old inside the 3-day floor, which it keeps
	const ledger = createLedger({ dataDir });
	for (let typeId = 1; typeId <= 120; typeId++) {
		const log = { samples: [], orders: {} };
		derive.foldBook(log, { at: '2026-11-10T12:00:00.000Z', stored: true, rows: Array.from({ length: 30 }, (_, i) => row(typeId * 100 + i, typeId)) });
		derive.foldBook(log, { at: new Date(clock() - HOUR).toISOString(), stored: true, rows: [] });
		ledger.writeBookLog(REGION, typeId, log);
	}

	let during = null;
	setImmediate(() => {
		during = service.storageStatus(); // GET /api/config while the run is between two batches of logs
	});
	const result = await service.runStorage();
	assert.equal(result.status, 'ok', JSON.stringify(result));
	assert.ok(result.trims.bookLogs.logs > 0, 'the logs were trimmed');
	assert.ok(during, 'the read came while the run was going');
	assert.equal(during.total, result.totalBefore, 'it measured the logs before the trim');
	assert.ok(result.totalAfter < result.totalBefore);

	clock.advance(1000);
	assert.equal(service.storageStatus().total, result.totalAfter, 'not the measurement taken before the trim');
});
