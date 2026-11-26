// storage.js: the storage budget applied to the data directory (planning/2026-11-25-export-history-
// columns, M2 P2.2). lib/storage-budget.js is the pure planner; this file measures the four kinds on
// disk, hands them to it, and applies the plan it answers. sync.js (runStorage) calls these under
// the `market` lock, which the region book, the market snapshot and the watch refresh hold while
// they write the same files.
//
// The kinds, and what one piece of each is:
//   regionPages  one regional snapshot: the raw page files its `kind: 'regionBook'` sync log entry
//                names (`pageStamps`). A page that did not change between two snapshots is one file
//                both entries name; it belongs to the newest one (or to a floor), so trimming an
//                older snapshot never deletes a page a newer one still needs. Regional page files
//                no entry names (a run that crashed) are a piece each, dated by their stamp.
//                Floors: the newest complete snapshot, and the newest file of each page route
//                (esi.js answers a 304 for that page from it).
//   typeBooks    the raw files of the per-type book pages and histories (`markets-<r>-orders[-page-
//                <n>]-type-id-<t>`, `markets-<r>-history-type-id-<t>`), cut at one time across all of
//                them (measureTypeBooks). Floor: the newest file of each route, and the newest before
//                the cutoff.
//   bookLogs     the book logs (ledger/market), cut at one time across all of them (trimBookLog).
//                Floor: the last 3 days.
//   runContexts  one saved run's market context (the rows stay). Floor: the newest run.
// Outside the budget and never touched: character raw and ledgers, the retained snapshots, the sync
// logs (but for the `trimmedAt` mark on a trimmed snapshot's entry) and esi-cache bookkeeping.
//
// Sizes are bytes on disk (compressed for the gzipped raw and logs), as the budget is.
const fs = require('fs');
const path = require('path');
const { KINDS } = require('./storage-budget');
const { regionBookEntries, snapshotPages, snapshotFolded, REGION_PAGE_SLUG } = require('./derive');
const { readJsonFile, writeFileAtomic } = require('./dataFiles');

const DAY_MS = 24 * 60 * 60 * 1000;
// The last days of every book log no trim reaches: M1's shortest observed window.
const BOOK_LOG_FLOOR_MS = 3 * DAY_MS;
const YIELD_EVERY = 100;
const STATE_FILE = '_storage.json';

const TYPE_BOOK_SLUG = /^markets-\d+-orders(?:-page-\d+)?-type-id-\d+$/;
const TYPE_HISTORY_SLUG = /^markets-\d+-history-type-id-\d+$/;

// The kind a public raw route belongs to, or null for a route outside the budget.
const kindOfSlug = (slug) => {
	if (REGION_PAGE_SLUG.test(slug)) return 'regionPages';
	if (TYPE_BOOK_SLUG.test(slug) || TYPE_HISTORY_SLUG.test(slug)) return 'typeBooks';
	return null;
};

const iso = (ms) => new Date(ms).toISOString();
const msOf = (now) => (typeof now === 'function' ? now() : typeof now === 'number' ? now : Date.now());
const yieldToLoop = () => new Promise(resolve => setImmediate(resolve));
const emptyUsage = () => Object.fromEntries(KINDS.map(kind => [kind, 0]));
const totalOf = (usage) => KINDS.reduce((total, kind) => total + (usage[kind] || 0), 0);

// ---- measuring

// The bytes each kind takes on disk, {regionPages, bookLogs, typeBooks, runContexts}: a directory
// read and a stat per file (run contexts: a read per run whose file changed since the last ask), so
// cheap enough for every GET /api/config.
const measureUsage = ({ raw, ledger, runs = null }) => {
	const usage = emptyUsage();
	for (const slug of raw.slugs('public')) {
		const kind = kindOfSlug(slug);
		if (kind === null) continue;
		for (const file of raw.files('public', slug)) usage[kind] += file.bytes;
	}
	for (const regionId of ledger.listBookLogRegions()) {
		for (const bytes of ledger.bookLogSizes(regionId).values()) usage.bookLogs += bytes;
	}
	if (runs) for (const run of runs.contexts()) usage.runContexts += run.bytes;
	return usage;
};

// The regional snapshots as pieces. Each page file on disk goes to the snapshot that owns it: the
// floor snapshot when it names the file, else the newest entry naming it, so trimming the snapshots
// oldest first never deletes a file a kept one names. A file no entry names (a run that crashed) is
// a piece of its own. The newest file of each page route stays whoever owns it (esi.js reads it
// when ESI answers 304 for that page): it counts in the kind's bytes but in no piece, so a snapshot
// whose other files are gone is trimmed all the same.
const measureRegionPages = ({ raw }) => {
	const entries = regionBookEntries(raw);
	const onDisk = new Map(); // `${slug}|${stamp}` -> {slug, stamp, bytes}
	const newestOfSlug = new Set();
	for (const slug of raw.slugs('public')) {
		if (!REGION_PAGE_SLUG.test(slug)) continue;
		const files = raw.files('public', slug);
		for (const file of files) {
			const key = `${slug}|${file.stamp}`;
			const held = onDisk.get(key);
			if (held) held.bytes += file.bytes; // both forms of one stamp
			else onDisk.set(key, { slug, stamp: file.stamp, bytes: file.bytes });
		}
		if (files.length > 0) newestOfSlug.add(`${slug}|${files[files.length - 1].stamp}`);
	}
	// the floor: the newest snapshot that folded and still has every page on disk
	let floorIndex = -1;
	entries.forEach((entry, i) => {
		if (snapshotFolded(entry) && snapshotPages(entry).every(({ slug, stamp }) => onDisk.has(`${slug}|${stamp}`))) floorIndex = i;
	});
	const owner = new Map(); // file key -> entry index
	entries.forEach((entry, i) => {
		for (const { slug, stamp } of snapshotPages(entry)) owner.set(`${slug}|${stamp}`, i);
	});
	if (floorIndex !== -1) for (const { slug, stamp } of snapshotPages(entries[floorIndex])) owner.set(`${slug}|${stamp}`, floorIndex);

	const pieces = entries.map((entry, i) => ({
		id: entry.syncedAt,
		at: typeof entry.fetchedAt === 'string' ? entry.fetchedAt : entry.syncedAt,
		bytes: 0,
		floor: i === floorIndex,
		entry: entry.syncedAt,
		files: [],
	}));
	const items = [];
	let bytes = 0;
	for (const [key, file] of onDisk) {
		bytes += file.bytes;
		const index = owner.get(key);
		if (index !== floorIndex && newestOfSlug.has(key)) continue; // kept: not part of any piece
		if (index === undefined) {
			items.push({ id: `file:${file.slug}/${file.stamp}`, at: file.stamp, bytes: file.bytes, entry: null, files: [{ slug: file.slug, stamp: file.stamp }] });
			continue;
		}
		pieces[index].bytes += file.bytes;
		pieces[index].files.push({ slug: file.slug, stamp: file.stamp });
	}
	// a snapshot left with no file of its own frees nothing: not a piece
	return { name: 'regionPages', bytes, items: pieces.filter(piece => piece.files.length > 0).concat(items) };
};

// The per-type raw books and histories as day buckets, cut at one time across all their routes
// rather than file by file. A file is freed once the next file of its route is older than the
// cutoff too: until then it is the route's page as of the cutoff, which a check after the cutoff
// that found that page unchanged (a 304, or a page it did not ask for) reads from it. So it is
// bucketed by the UTC day of the next file's stamp, and the newest file of a route never is (it
// counts in the kind's bytes; esi.js answers a 304 from it). The pages one check stores carry
// stamps milliseconds apart, so they go together; the one exception is the last check before the
// cutoff, which keeps the pages it stored but can lose an older page it read unchanged when a later
// check before the cutoff replaced that page (only books of more than one page).
const measureTypeBooks = ({ raw }) => {
	const byDay = new Map();
	let bytes = 0;
	for (const slug of raw.slugs('public')) {
		if (kindOfSlug(slug) !== 'typeBooks') continue;
		const byStamp = new Map(); // both forms of a stamp together
		for (const file of raw.files('public', slug)) byStamp.set(file.stamp, (byStamp.get(file.stamp) || 0) + file.bytes);
		const stamps = [...byStamp.keys()].sort();
		stamps.forEach((stamp, i) => {
			bytes += byStamp.get(stamp);
			if (i + 1 === stamps.length) return; // the newest: never freed
			const day = stamps[i + 1].slice(0, 10);
			byDay.set(day, (byDay.get(day) || 0) + byStamp.get(stamp));
		});
	}
	const buckets = [...byDay.keys()].sort().map(day => {
		const from = `${day}T00:00:00.000Z`;
		return { from, to: iso(Date.parse(from) + DAY_MS), bytes: byDay.get(day) };
	});
	return { name: 'typeBooks', bytes, buckets };
};

// Every piece of a book log with the time a cutoff frees it (trimBookLog's rule): a sample at its
// own time; a path entry once the entry after it is older than the cutoff too (until then it is the
// order's state at the cutoff), the last one with its order; an order (its fixed fields) at its
// lastSeen. `add(at, bytes)` is called once per piece, `bytes` the length of its JSON.
const bookLogPieces = (log, add) => {
	for (const sample of log.samples) add(sample && sample.at, JSON.stringify(sample).length);
	for (const [id, order] of Object.entries(log.orders)) {
		if (!order || typeof order !== 'object') continue;
		const entries = Array.isArray(order.path) ? order.path : [];
		const { path: omitted, ...fixed } = order;
		add(order.lastSeen, id.length + JSON.stringify(fixed).length);
		entries.forEach((entry, i) => add(i + 1 < entries.length ? entries[i + 1].at : order.lastSeen, JSON.stringify(entry).length));
	}
};

// The book logs as day buckets for the planner. Each piece's bytes are the length of its JSON: an
// estimate of the plain text (bookLogText). The files are gzipped, so the budget counts them
// compressed: the buckets are scaled so they add up to the logs' bytes on disk, the share of each
// day taken to be its share of the plain text. Dropping everything before a bucket's `to` frees
// the pieces in it (and in the buckets before it). A log that cannot be read is counted in the
// kind's bytes but has no bucket: nothing in it can be trimmed.
const measureBookLogs = async ({ ledger, log = console, nowMs }) => {
	const plainByDay = new Map();
	const add = (at, bytes) => {
		if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(at)) return;
		const day = at.slice(0, 10);
		plainByDay.set(day, (plainByDay.get(day) || 0) + bytes);
	};
	let bytes = 0;
	let readable = 0;
	let read = 0;
	for (const regionId of ledger.listBookLogRegions()) {
		for (const [typeId, size] of ledger.bookLogSizes(regionId)) {
			bytes += size;
			try {
				bookLogPieces(ledger.readBookLog(regionId, typeId), add);
				readable += size;
			} catch (e) {
				log.warn(`storage: book log ${regionId}/${typeId} is unreadable (${e.message}); not trimmed`);
			}
			if (++read % YIELD_EVERY === 0) await yieldToLoop();
		}
	}
	const days = [...plainByDay.keys()].sort();
	const plain = days.reduce((total, day) => total + plainByDay.get(day), 0);
	const buckets = [];
	let cumulative = 0;
	let given = 0;
	for (const day of days) {
		cumulative += plainByDay.get(day);
		// rounded on the running total, so the buckets add up to the bytes on disk exactly
		const upTo = plain > 0 ? Math.round((cumulative / plain) * readable) : 0;
		const from = `${day}T00:00:00.000Z`;
		buckets.push({ from, to: iso(Date.parse(from) + DAY_MS), bytes: upTo - given });
		given = upTo;
	}
	return { name: 'bookLogs', bytes, buckets, floorAt: iso(nowMs - BOOK_LOG_FLOOR_MS) };
};

const measureRunContexts = ({ runs }) => {
	const contexts = runs ? runs.contexts() : [];
	const newest = contexts.length === 0 ? null : contexts[contexts.length - 1].id; // contexts() is oldest first
	const items = contexts.map(run => ({ id: run.id, at: run.copiedAt || '', bytes: run.bytes, floor: run.id === newest }));
	return { name: 'runContexts', bytes: items.reduce((total, item) => total + item.bytes, 0), items };
};

// The `kinds` array for storage-budget.js planTrim, in KINDS order: each kind's bytes on disk and the
// pieces it could give up (items for the discrete kinds, day buckets for the book logs). Reads every
// book log, so it is only asked for when the total is over the budget.
const measureKinds = async ({ raw, ledger, runs = null, now, log = console }) => {
	const nowMs = msOf(now);
	const measured = {
		regionPages: measureRegionPages({ raw }),
		bookLogs: await measureBookLogs({ ledger, log, nowMs }),
		typeBooks: measureTypeBooks({ raw }),
		runContexts: measureRunContexts({ runs }),
	};
	return KINDS.map(kind => measured[kind]);
};

// ---- trimming

// Drops from a book log what is older than `cutoffAt` (ISO): the samples taken before it, every
// order last seen before it (its whole path is older), and, of an order still listed at or after
// the cutoff, its path entries before it except the newest of them. That entry is the order's
// price and volume at the cutoff: kept, the state at the first kept sample is known, and a re-price
// just after the cutoff still reads as a re-price, not as a new order (public/market-stats.js).
// So every order kept keeps its newest entry, and none is left with no entry. Pure: answers
// {log, samplesDropped, entriesDropped, ordersDropped}.
const trimBookLog = (log, cutoffAt) => {
	const samples = log.samples.filter(sample => !(sample && sample.at < cutoffAt));
	const orders = {};
	let entriesDropped = 0;
	let ordersDropped = 0;
	for (const [id, order] of Object.entries(log.orders)) {
		const entries = order && Array.isArray(order.path) ? order.path : [];
		if (order && typeof order.lastSeen === 'string' && order.lastSeen < cutoffAt) {
			ordersDropped++;
			entriesDropped += entries.length;
			continue;
		}
		let firstKept = entries.findIndex(entry => !(entry && entry.at < cutoffAt));
		if (firstKept === -1) firstKept = entries.length;
		const from = Math.max(0, firstKept - 1); // the entry just before the cutoff stays
		entriesDropped += from;
		orders[id] = from === 0 ? order : { ...order, path: entries.slice(from) };
	}
	return { log: { samples, orders }, samplesDropped: log.samples.length - samples.length, entriesDropped, ordersDropped };
};

const emptyRemoved = () => ({
	regionPages: { pieces: 0, snapshots: 0, strayFiles: 0, files: 0, bytesFreed: 0 },
	bookLogs: { pieces: 0, cutoffAt: null, logs: 0, samplesDropped: 0, entriesDropped: 0, ordersDropped: 0, bytesFreed: 0 },
	typeBooks: { pieces: 0, cutoffAt: null, files: 0, bytesFreed: 0 },
	runContexts: { pieces: 0, runs: 0, bytesFreed: 0 },
});

// Applies a plan (planTrim's answer) to the kinds measureKinds measured. regionPages: deletes each
// trimmed snapshot's page files (both forms) and marks its sync log entry `trimmedAt`; typeBooks:
// deletes every per-type file older than the cutoff but the newest of each route before it; bookLogs: trims every log at the cutoff (trimBookLog) and rewrites the ones
// that changed; runContexts: rewrites each run with `context: {}` (runs.trimContext). A piece that
// fails is logged and skipped. Answers what was removed per kind (bytes are what left the disk: the
// book logs' are their compressed sizes before less after).
const applyTrims = async ({ raw, ledger, runs = null, plan, kinds, log = console, now }) => {
	const at = iso(msOf(now));
	const removed = emptyRemoved();
	const itemsOf = (name) => new Map(((kinds.find(kind => kind.name === name) || {}).items || []).map(item => [item.id, item]));
	const trimOf = (name) => (plan && plan.trims && plan.trims[name]) || { itemIds: [], cutoffAt: null };
	const guarded = (what, fn) => {
		try {
			fn();
		} catch (e) {
			log.warn(`storage: ${what}: ${e.message}`);
		}
	};

	const pages = itemsOf('regionPages');
	for (const id of trimOf('regionPages').itemIds) {
		const item = pages.get(id);
		if (!item) continue;
		guarded(`regional pages ${id}`, () => {
			for (const { slug, stamp } of item.files) {
				removed.regionPages.bytesFreed += raw.remove('public', slug, stamp);
				removed.regionPages.files++;
			}
			if (item.entry !== null) {
				const entry = raw.readSyncLog('public', item.entry);
				if (entry) raw.writeSyncLog('public', { ...entry, trimmedAt: at });
				removed.regionPages.snapshots++;
			} else {
				removed.regionPages.strayFiles++;
			}
			removed.regionPages.pieces++;
		});
	}

	const typeCutoff = trimOf('typeBooks').cutoffAt;
	if (typeCutoff) {
		removed.typeBooks.cutoffAt = typeCutoff;
		for (const slug of raw.slugs('public')) {
			if (kindOfSlug(slug) !== 'typeBooks') continue;
			const stamps = raw.list('public', slug);
			// every file older than the cutoff but the newest of them (measureTypeBooks has the why)
			stamps.forEach((stamp, i) => {
				if (i + 1 === stamps.length || !(stamps[i + 1] < typeCutoff)) return;
				guarded(`raw ${slug}/${stamp}`, () => {
					removed.typeBooks.bytesFreed += raw.remove('public', slug, stamp);
					removed.typeBooks.files++;
					removed.typeBooks.pieces++;
				});
			});
		}
	}

	const cutoffAt = trimOf('bookLogs').cutoffAt;
	if (cutoffAt) {
		removed.bookLogs.cutoffAt = cutoffAt;
		let seen = 0;
		for (const regionId of ledger.listBookLogRegions()) {
			for (const typeId of ledger.listBookLogs(regionId)) {
				guarded(`book log ${regionId}/${typeId}`, () => {
					const before = ledger.bookLogBytes(regionId, typeId);
					const trimmed = trimBookLog(ledger.readBookLog(regionId, typeId), cutoffAt);
					if (trimmed.samplesDropped + trimmed.entriesDropped + trimmed.ordersDropped === 0) return;
					const after = ledger.writeBookLog(regionId, typeId, trimmed.log);
					removed.bookLogs.logs++;
					removed.bookLogs.pieces++;
					removed.bookLogs.samplesDropped += trimmed.samplesDropped;
					removed.bookLogs.entriesDropped += trimmed.entriesDropped;
					removed.bookLogs.ordersDropped += trimmed.ordersDropped;
					removed.bookLogs.bytesFreed += before - after;
				});
				if (++seen % YIELD_EVERY === 0) await yieldToLoop();
			}
		}
	}

	if (runs) {
		for (const id of trimOf('runContexts').itemIds) {
			guarded(`run ${id}`, () => {
				const freed = runs.trimContext(id, { at });
				if (freed > 0) {
					removed.runContexts.runs++;
					removed.runContexts.pieces++;
					removed.runContexts.bytesFreed += freed;
				}
			});
		}
	}
	return removed;
};

const trimmedAnything = (removed) => Object.values(removed || {}).some(kind => kind && kind.pieces > 0);

// ---- the last run, kept beside the other public bookkeeping

// data/esi-cache/public/_storage.json: the last storage entry, plus `lastTrim` ({at, trims}: the
// newest run that trimmed something), so a status read is one small file.
const stateFile = (dataDir) => path.join(path.resolve(dataDir), 'esi-cache', 'public', STATE_FILE);
const readState = (dataDir) => {
	try {
		return readJsonFile(stateFile(dataDir));
	} catch (e) {
		return null;
	}
};
const writeState = (dataDir, state) => writeFileAtomic(stateFile(dataDir), JSON.stringify(state, null, '\t') + '\n');

module.exports = {
	BOOK_LOG_FLOOR_MS,
	kindOfSlug,
	totalOf,
	measureUsage,
	measureKinds,
	bookLogPieces,
	trimBookLog,
	applyTrims,
	emptyRemoved,
	trimmedAnything,
	readState,
	writeState,
};
