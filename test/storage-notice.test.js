const test = require('node:test');
const assert = require('node:assert/strict');
const { sizeText, storageNoticeLines } = require('../public/storage-notice.js');

// The storage line of the pages' env notice (results-shared.js, export.js), from GET /api/config.

const config = (storage, regionBook = true) => ({ regionBook: { enabled: regionBook }, storage });

test('the hourly book on with no budget: a note that raw grows, and the setting that stops it', () => {
	assert.deepEqual(storageNoticeLines(config({ budget: null, total: 5e9, unmet: 0 })), [
		{ kind: 'warn', text: 'The hourly destination book is on with no storage budget: it adds about 8 MB an hour on disk (46 MB of order pages, gzipped). Set EFLIP_STORAGE_BUDGET (e.g. 1GB).' },
	]);
	assert.deepEqual(storageNoticeLines(config({ budget: null, total: 5e9, unmet: 0 }, false)), [], 'the book off: nothing grows unbounded, nothing to say');
});

test('a budget or shares setting that does not parse: a warning that no budget is applied, whether or not the book is on', () => {
	const error = 'storage budget: "1GiB" is not a size such as 1GB, 500MB or a number of bytes';
	const expected = [{ kind: 'warn', text: `EFLIP_STORAGE_BUDGET or EFLIP_STORAGE_SHARES did not parse (${error}): no storage budget is applied.` }];
	assert.deepEqual(storageNoticeLines({ regionBook: { enabled: false }, storage: { budget: null, error, total: 5e9, unmet: 0 } }), expected);
	assert.deepEqual(storageNoticeLines(config({ budget: null, error, total: 5e9, unmet: 0 })), expected, 'the book on: not "Set EFLIP_STORAGE_BUDGET", which is set');
	assert.deepEqual(storageNoticeLines(config({ budget: null, error: null, total: 5e9, unmet: 0 }, false)), [], 'no error: as before');
});

test('a budget: the share of it used, and how far over when only the floors are left', () => {
	assert.deepEqual(storageNoticeLines(config({ budget: 1e9, total: 620e6, unmet: 0 })), [{ kind: 'info', text: 'Storage 62 % of 1 GB.' }]);
	assert.deepEqual(storageNoticeLines(config({ budget: 1e9, total: 620e6, unmet: 0 }, false)), [{ kind: 'info', text: 'Storage 62 % of 1 GB.' }], 'whether or not the book is on');
	assert.deepEqual(storageNoticeLines(config({ budget: 1e9, total: 1.04e9, unmet: 40e6 })), [
		{ kind: 'warn', text: 'Storage 104 % of 1 GB, over budget by 40 MB: nothing left to trim above the floors.' },
	]);
	assert.deepEqual(storageNoticeLines(config({ budget: 5e8, total: 0, unmet: 0 })), [{ kind: 'info', text: 'Storage 0 % of 500 MB.' }]);
});

test('nothing to read: no line', () => {
	assert.deepEqual(storageNoticeLines(null), []);
	assert.deepEqual(storageNoticeLines({}), []);
	assert.deepEqual(storageNoticeLines({ regionBook: { enabled: true }, storage: null }), [], 'the server could not measure');
});

test('sizeText: decimal units, three significant digits at most', () => {
	assert.equal(sizeText(1e9), '1 GB');
	assert.equal(sizeText(1.5e9), '1.5 GB');
	assert.equal(sizeText(46.34e6), '46.3 MB');
	assert.equal(sizeText(620e6), '620 MB');
	assert.equal(sizeText(2048), '2.05 KB');
	assert.equal(sizeText(512), '512 bytes');
	assert.equal(sizeText(0), '0 bytes');
	assert.equal(sizeText(3.2e12), '3.2 TB');
});
