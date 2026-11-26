const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createRawStore, stampToFileName, fileNameToStamp, gzipsRaw, acquireLock } = require('../lib/dataFiles');
const { tmpDataDir } = require('../test-support/esi-fake');

// The raw store's two forms: the public market records (`public/markets-...`) are written gzipped,
// `<stamp>.json.gz`; everything else plain, `<stamp>.json`. Every reader takes both.

const CHAR = 90000001;
const BOOK = 'markets-10000043-orders-type-id-34';
const mode = (file) => fs.statSync(file).mode & 0o777;
const record = (fetchedAt, body) => ({ fetchedAt, url: 'https://esi.evetech.net/x', status: 200, headers: { etag: '"a"' }, body });

test('file names: a stamp names a plain file, and either form names the stamp back', () => {
	assert.equal(stampToFileName('2026-11-20T01:22:23.592Z'), '2026-11-20T01-22-23-592Z.json');
	assert.equal(fileNameToStamp('2026-11-20T01-22-23-592Z.json'), '2026-11-20T01:22:23.592Z');
	assert.equal(fileNameToStamp('2026-11-20T01-22-23-592Z.json.gz'), '2026-11-20T01:22:23.592Z');
	for (const name of ['2026-11-20T01-22-23-592Z.gz', '2026-11-20T01-22-23-592Z.json.gz.tmp', '.2026-11-20T01-22-23-592Z.json.gz.123.abc.tmp', 'notes.txt']) assert.equal(fileNameToStamp(name), null, name);
	assert.equal(gzipsRaw('public', BOOK), true);
	assert.equal(gzipsRaw('public', 'markets-10000043-history-type-id-34'), true);
	assert.equal(gzipsRaw('public', 'markets-10000043-orders-order-type-all-page-2'), true);
	assert.equal(gzipsRaw('public', 'universe-structures-1'), false);
	assert.equal(gzipsRaw(CHAR, 'markets-10000043-orders-type-id-34'), false, 'only the public owner');
	assert.equal(gzipsRaw(String(CHAR), 'wallet-journal'), false);
});

test('a public market record is written gzipped and reads back equal; its size and path are the gzipped file\'s', (t) => {
	const raw = createRawStore({ dataDir: tmpDataDir(t) });
	const rec = record('2026-11-20T12:00:00.000Z', [{ order_id: 1, price: 10.5, type_id: 34 }, { order_id: 2, price: 11, type_id: 34 }]);
	const file = raw.write('public', BOOK, rec);
	assert.equal(path.basename(file), '2026-11-20T12-00-00-000Z.json.gz');
	assert.deepEqual(fs.readdirSync(path.dirname(file)), ['2026-11-20T12-00-00-000Z.json.gz'], 'no plain twin, no temp file');
	assert.equal(mode(file), 0o600);
	assert.equal(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'), JSON.stringify(rec) + '\n', 'the same JSON text, compressed');
	assert.deepEqual(raw.read('public', BOOK, rec.fetchedAt), rec);
	assert.deepEqual(raw.latest('public', BOOK), rec);
	assert.deepEqual(raw.list('public', BOOK), [rec.fetchedAt]);
	assert.equal(raw.fileFor('public', BOOK, rec.fetchedAt), file);
	assert.equal(raw.bytes('public', BOOK, rec.fetchedAt), fs.statSync(file).size);
	assert.equal(raw.read('public', BOOK, '2026-11-20T13:00:00.000Z'), null);
	assert.equal(raw.bytes('public', BOOK, '2026-11-20T13:00:00.000Z'), null);
	assert.equal(raw.fileFor('public', BOOK, '2026-11-20T13:00:00.000Z'), null);
});

test('a character record, a public route outside the market and a sync log stay plain', (t) => {
	const raw = createRawStore({ dataDir: tmpDataDir(t) });
	const rec = record('2026-11-20T12:00:00.000Z', [{ id: 7001 }]);
	const file = raw.write(CHAR, 'wallet-journal', rec);
	assert.equal(path.basename(file), '2026-11-20T12-00-00-000Z.json');
	assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(rec) + '\n');
	assert.deepEqual(raw.read(CHAR, 'wallet-journal', rec.fetchedAt), rec);
	assert.equal(raw.bytes(CHAR, 'wallet-journal', rec.fetchedAt), fs.statSync(file).size);
	assert.equal(raw.fileFor(CHAR, 'wallet-journal', rec.fetchedAt), file);

	const status = raw.write('public', 'status', record('2026-11-20T12:00:00.000Z', { players: 1 }));
	assert.equal(path.basename(status), '2026-11-20T12-00-00-000Z.json');

	raw.writeSyncLog('public', { syncedAt: '2026-11-20T12:00:01.000Z', source: 'market' });
	assert.deepEqual(fs.readdirSync(path.join(raw.root, 'public', '_sync-log')), ['2026-11-20T12-00-01-000Z.json']);
	assert.deepEqual(raw.syncLogStamps('public'), ['2026-11-20T12:00:01.000Z']);
});

test('a slug with plain files from before and gzipped ones after lists every stamp once, in time order; latest is the newest whichever form', (t) => {
	const raw = createRawStore({ dataDir: tmpDataDir(t) });
	const dir = path.join(raw.root, 'public', BOOK);
	fs.mkdirSync(dir, { recursive: true });
	// two plain files as written before gzip, then two new records through the store
	const old1 = record('2026-11-19T10:00:00.000Z', [{ order_id: 1, price: 9 }]);
	const old2 = record('2026-11-19T11:00:00.000Z', [{ order_id: 1, price: 8 }]);
	for (const rec of [old1, old2]) fs.writeFileSync(path.join(dir, stampToFileName(rec.fetchedAt)), JSON.stringify(rec) + '\n');
	const new1 = record('2026-11-20T10:00:00.000Z', [{ order_id: 1, price: 7 }]);
	raw.write('public', BOOK, new1);
	assert.deepEqual(raw.list('public', BOOK), [old1.fetchedAt, old2.fetchedAt, new1.fetchedAt]);
	assert.equal(raw.latestStamp('public', BOOK), new1.fetchedAt);
	assert.deepEqual(raw.latest('public', BOOK), new1);
	assert.deepEqual(raw.read('public', BOOK, old1.fetchedAt), old1, 'the plain file still reads');
	assert.equal(raw.bytes('public', BOOK, old2.fetchedAt), fs.statSync(path.join(dir, stampToFileName(old2.fetchedAt))).size);
	assert.equal(raw.fileFor('public', BOOK, old2.fetchedAt), path.join(dir, stampToFileName(old2.fetchedAt)));

	// a plain file newer than the gzipped ones (written by hand): the newest is still the last stamp
	const later = record('2026-11-21T10:00:00.000Z', [{ order_id: 1, price: 6 }]);
	fs.writeFileSync(path.join(dir, stampToFileName(later.fetchedAt)), JSON.stringify(later) + '\n');
	assert.deepEqual(raw.list('public', BOOK), [old1.fetchedAt, old2.fetchedAt, new1.fetchedAt, later.fetchedAt]);
	assert.deepEqual(raw.latest('public', BOOK), later);

	// one stamp in both forms is one record, read from the gzipped file
	const twin = { ...old1, body: [{ order_id: 1, price: 99 }] };
	fs.writeFileSync(path.join(dir, `${stampToFileName(old1.fetchedAt)}.gz`), zlib.gzipSync(JSON.stringify(twin) + '\n'));
	assert.deepEqual(raw.list('public', BOOK), [old1.fetchedAt, old2.fetchedAt, new1.fetchedAt, later.fetchedAt]);
	assert.deepEqual(raw.read('public', BOOK, old1.fetchedAt), twin);
	assert.equal(raw.bytes('public', BOOK, old1.fetchedAt), fs.statSync(path.join(dir, `${stampToFileName(old1.fetchedAt)}.gz`)).size);

	// strays and temp files are not stamps
	fs.writeFileSync(path.join(dir, 'notes.txt'), 'stray');
	fs.writeFileSync(path.join(dir, `.${stampToFileName(later.fetchedAt)}.gz.1.abc.tmp`), 'half');
	assert.equal(raw.list('public', BOOK).length, 4);
});

test('a damaged gzipped record throws on read, as a damaged plain one does', (t) => {
	const raw = createRawStore({ dataDir: tmpDataDir(t) });
	const dir = path.join(raw.root, 'public', BOOK);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, '2026-11-20T12-00-00-000Z.json.gz'), '{not gzip');
	assert.throws(() => raw.read('public', BOOK, '2026-11-20T12:00:00.000Z'));
	fs.writeFileSync(path.join(dir, '2026-11-20T13-00-00-000Z.json.gz'), zlib.gzipSync('{not json'));
	assert.throws(() => raw.read('public', BOOK, '2026-11-20T13:00:00.000Z'), SyntaxError);
});

test('files lists a route\'s files with their sizes, both forms of a stamp apart; remove deletes a public market record in both forms and nothing else', (t) => {
	const dataDir = tmpDataDir(t);
	const raw = createRawStore({ dataDir });
	raw.write('public', BOOK, record('2026-11-20T01:00:00.000Z', [1]));
	raw.write('public', BOOK, record('2026-11-20T02:00:00.000Z', [2]));
	// the same stamp held plain too (written before the gzip rule)
	const plain = path.join(raw.root, 'public', BOOK, '2026-11-20T01-00-00-000Z.json');
	fs.writeFileSync(plain, JSON.stringify(record('2026-11-20T01:00:00.000Z', [1])) + '\n');
	const files = raw.files('public', BOOK);
	assert.deepEqual(files.map(file => [file.stamp, path.basename(file.file)]), [
		['2026-11-20T01:00:00.000Z', '2026-11-20T01-00-00-000Z.json'],
		['2026-11-20T01:00:00.000Z', '2026-11-20T01-00-00-000Z.json.gz'],
		['2026-11-20T02:00:00.000Z', '2026-11-20T02-00-00-000Z.json.gz'],
	]);
	for (const file of files) assert.equal(file.bytes, fs.statSync(file.file).size);
	assert.deepEqual(raw.files('public', 'markets-1-history-type-id-2'), [], 'no such route');

	const freed = raw.remove('public', BOOK, '2026-11-20T01:00:00.000Z');
	assert.equal(freed, files[0].bytes + files[1].bytes);
	assert.deepEqual(raw.list('public', BOOK), ['2026-11-20T02:00:00.000Z']);
	assert.equal(raw.remove('public', BOOK, '2026-11-20T01:00:00.000Z'), 0, 'gone already');

	raw.write(CHAR, 'wallet', record('2026-11-20T01:00:00.000Z', 5));
	assert.throws(() => raw.remove(CHAR, 'wallet', '2026-11-20T01:00:00.000Z'), /only public market records/);
	assert.throws(() => raw.remove('public', 'universe-structures-1', '2026-11-20T01:00:00.000Z'), /only public market records/);
	assert.ok(raw.fileFor(CHAR, 'wallet', '2026-11-20T01:00:00.000Z'));
});

// The cross-process lock: data/locks/<name>.lock holding {pid, at, boot, token}.

const lockFile = (dataDir, name) => path.join(dataDir, 'locks', `${name}.lock`);
const backdate = (file, ms) => {
	const then = (Date.now() - ms) / 1000;
	fs.utimesSync(file, then, then);
};
const thisBoot = () => Math.round(Date.now() - os.uptime() * 1000);

test('a holder whose lock was taken over does not remove the new holder\'s lock when it releases', (t) => {
	const dataDir = tmpDataDir(t);
	const file = lockFile(dataDir, 'market');
	const first = acquireLock(dataDir, 'market');
	assert.equal(typeof first, 'function');
	assert.equal(acquireLock(dataDir, 'market'), null, 'held');
	// 31 minutes with no refresh: the first holder looks frozen
	backdate(file, 31 * 60 * 1000);
	const second = acquireLock(dataDir, 'market');
	assert.equal(typeof second, 'function', 'taken over');
	const { token } = JSON.parse(fs.readFileSync(file, 'utf8'));

	first();
	assert.ok(fs.existsSync(file), 'the second holder still holds it');
	assert.match(token, /^[0-9a-f]{16,}$/);
	assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, token);
	assert.equal(acquireLock(dataDir, 'market'), null, 'a third caller is kept out');
	second();
	assert.ok(!fs.existsSync(file), 'released');
});

test('an empty lock file counts as held for a short grace, then is taken over', (t) => {
	const dataDir = tmpDataDir(t);
	const file = lockFile(dataDir, 'market');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	for (const content of ['', '{"pid":12']) {
		fs.writeFileSync(file, content); // just created, not yet (fully) written
		assert.equal(acquireLock(dataDir, 'market'), null, JSON.stringify(content));
		backdate(file, 60 * 1000);
		const release = acquireLock(dataDir, 'market');
		assert.equal(typeof release, 'function', JSON.stringify(content));
		release();
	}
});

test('a held lock is kept young while held, so a long run is not taken over', async (t) => {
	const dataDir = tmpDataDir(t);
	const release = acquireLock(dataDir, 'market', { staleMs: 60, refreshMs: 10 });
	assert.equal(typeof release, 'function');
	await new Promise(resolve => setTimeout(resolve, 120));
	assert.equal(acquireLock(dataDir, 'market', { staleMs: 60, refreshMs: 10 }), null);
	release();
	assert.ok(!fs.existsSync(lockFile(dataDir, 'market')));
});

test('a live pid recorded under another boot is a reused pid: its lock is taken over', (t) => {
	const dataDir = tmpDataDir(t);
	const file = lockFile(dataDir, 'market');
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), boot: thisBoot(), token: 'a1' }));
	assert.equal(acquireLock(dataDir, 'market'), null, 'this boot: held');
	fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), boot: thisBoot() - 60 * 60 * 1000, token: 'a1' }));
	const release = acquireLock(dataDir, 'market');
	assert.equal(typeof release, 'function', 'another boot: taken over');
	assert.notEqual(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'a1');
	release();
});
