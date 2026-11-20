// dataFiles.js: the filesystem layer under <dataDir>: private atomic writes, the raw store, and
// the per-character locks.
//
// Everything written here is gitignored and private: directories 0700, files 0600, every file
// replaced whole through a temp file and a rename (as tokenStore.js does), so a crash never
// leaves half a file.
//
// The raw store keeps every ESI 200 verbatim, `<dataDir>/raw/<owner>/<route-slug>/<fetchedAt>.json`
// holding {fetchedAt, url, status, headers, body}; `owner` is a character id or `public`. A raw
// file is never edited or deleted: a file name sorts in time order, so the newest is the last name.
// Alongside the route directories each owner has `_sync-log/`, one small entry per sync that
// called ESI; it names the raw files that made up that sync's snapshot, which is how derive.js can
// rebuild the retained snapshots from raw alone.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SYNC_LOG_DIR = '_sync-log';

const OWNER = /^(?:public|\d{1,15})$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STAMP_FILE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/;

const ensureDir = (dir) => {
	fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
};

const writeFileAtomic = (file, text) => {
	const dir = path.dirname(file);
	ensureDir(dir);
	const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
	try {
		fs.writeFileSync(tmp, text, { mode: FILE_MODE, flag: 'wx' });
		fs.renameSync(tmp, file);
	} catch (e) {
		fs.rmSync(tmp, { force: true });
		throw e;
	}
	fs.chmodSync(file, FILE_MODE);
};

// The parsed JSON file, or null when it does not exist. A file that is not valid JSON throws.
const readJsonFile = (file) => {
	let text;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch (e) {
		if (e.code === 'ENOENT') return null;
		throw e;
	}
	return JSON.parse(text);
};

// Names a file by its time stamp: `2026-11-20T01:22:23.592Z` -> `2026-11-20T01-22-23-592Z.json`.
// Colons are awkward in file names, and the result still sorts as time does.
const stampToFileName = (stamp) => {
	if (typeof stamp !== 'string' || !STAMP.test(stamp)) throw new Error(`bad time stamp: ${String(stamp).slice(0, 40)}`);
	return `${stamp.replace(/[:.]/g, '-')}.json`;
};

// Inverse of stampToFileName; null for any other file name (temp files, stray files).
const fileNameToStamp = (name) => {
	const m = STAMP_FILE.exec(name);
	return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
};

// A hash of the parsed body, stable across re-serialisation.
const hashJson = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

const stampsIn = (dir) => {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (e) {
		if (e.code === 'ENOENT') return [];
		throw e;
	}
	return names.map(fileNameToStamp).filter(stamp => stamp !== null).sort();
};

const checkOwner = (owner) => {
	const text = String(owner);
	if (!OWNER.test(text)) throw new Error('raw store: bad owner');
	return text;
};
const checkSlug = (slug) => {
	if (typeof slug !== 'string' || !SLUG.test(slug)) throw new Error('raw store: bad route slug');
	return slug;
};

const createRawStore = ({ dataDir }) => {
	const root = path.join(path.resolve(dataDir), 'raw');
	const dirOf = (owner, slug) => path.join(root, checkOwner(owner), checkSlug(slug));
	const logDirOf = (owner) => path.join(root, checkOwner(owner), SYNC_LOG_DIR);

	const read = (owner, slug, stamp) => readJsonFile(path.join(dirOf(owner, slug), stampToFileName(stamp)));

	// Stored once per file name; the caller keeps fetchedAt unique per route.
	const write = (owner, slug, record) => {
		const file = path.join(dirOf(owner, slug), stampToFileName(record.fetchedAt));
		writeFileAtomic(file, JSON.stringify(record) + '\n');
		return file;
	};

	const list = (owner, slug) => stampsIn(dirOf(owner, slug));
	const latestStamp = (owner, slug) => {
		const stamps = list(owner, slug);
		return stamps.length === 0 ? null : stamps[stamps.length - 1];
	};
	const latest = (owner, slug) => {
		const stamp = latestStamp(owner, slug);
		return stamp === null ? null : read(owner, slug, stamp);
	};

	// Route directories of an owner (sync logs and any other `_` directory excluded).
	const slugs = (owner) => {
		let names;
		try {
			names = fs.readdirSync(path.join(root, checkOwner(owner)), { withFileTypes: true });
		} catch (e) {
			if (e.code === 'ENOENT') return [];
			throw e;
		}
		return names.filter(entry => entry.isDirectory() && SLUG.test(entry.name)).map(entry => entry.name).sort();
	};
	const owners = () => {
		let names;
		try {
			names = fs.readdirSync(root, { withFileTypes: true });
		} catch (e) {
			if (e.code === 'ENOENT') return [];
			throw e;
		}
		return names.filter(entry => entry.isDirectory() && OWNER.test(entry.name)).map(entry => entry.name).sort();
	};

	const writeSyncLog = (owner, entry) => {
		writeFileAtomic(path.join(logDirOf(owner), stampToFileName(entry.syncedAt)), JSON.stringify(entry, null, '\t') + '\n');
	};
	const syncLogStamps = (owner) => stampsIn(logDirOf(owner));
	const readSyncLog = (owner, stamp) => readJsonFile(path.join(logDirOf(owner), stampToFileName(stamp)));

	return { root, read, write, list, latestStamp, latest, slugs, owners, writeSyncLog, syncLogStamps, readSyncLog };
};

// One sync or rebuild at a time per owner, across processes (the server and scripts/sync.js
// share a data directory). The lock is a file holding the owner's pid; a lock whose process is
// gone, or that is older than `staleMs`, is taken over. Answers a release function, or null when
// another live process holds it.
const LOCK_STALE_MS = 30 * 60 * 1000;
const acquireLock = (dataDir, name, { staleMs = LOCK_STALE_MS } = {}) => {
	const dir = path.join(path.resolve(dataDir), 'locks');
	ensureDir(dir);
	const file = path.join(dir, `${name}.lock`);
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: FILE_MODE, flag: 'wx' });
			return () => fs.rmSync(file, { force: true });
		} catch (e) {
			if (e.code !== 'EEXIST') throw e;
		}
		let holder = null;
		try {
			holder = JSON.parse(fs.readFileSync(file, 'utf8'));
		} catch (e) {
			// unreadable or half-written: judged by its age below
		}
		let alive = false;
		if (holder && Number.isInteger(holder.pid)) {
			try {
				process.kill(holder.pid, 0);
				alive = true;
			} catch (e) {
				alive = e.code === 'EPERM';
			}
		}
		let age = Infinity;
		try {
			age = Date.now() - fs.statSync(file).mtimeMs;
		} catch (e) {
			// gone meanwhile: the next attempt creates it
		}
		if (alive && age < staleMs) return null;
		fs.rmSync(file, { force: true });
	}
	return null;
};

module.exports = {
	DIR_MODE,
	FILE_MODE,
	ensureDir,
	writeFileAtomic,
	readJsonFile,
	stampToFileName,
	fileNameToStamp,
	hashJson,
	createRawStore,
	acquireLock,
};
