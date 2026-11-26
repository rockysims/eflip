// dataFiles.js: the filesystem layer under <dataDir>: private atomic writes, the raw store, and
// the per-character locks.
//
// Everything written here is gitignored and private: directories 0700, files 0600, every file
// replaced whole through a temp file and a rename (as tokenStore.js does), so a crash never
// leaves half a file.
//
// The raw store keeps every ESI 200 verbatim, `<dataDir>/raw/<owner>/<route-slug>/<fetchedAt>.json`
// holding {fetchedAt, url, status, headers, body}; `owner` is a character id or `public`. A raw
// file is never edited: a file name sorts in time order, so the newest is the last name. The one
// thing that deletes raw is the storage budget (lib/storage.js), and only the bulky public market
// records below (`remove` refuses anything else); everything a character owns is kept for good.
// The bulky public market records (owner `public`, slug `markets-...`: the regional order pages, the
// per-type books and the histories) are written gzipped instead, `<fetchedAt>.json.gz` holding the
// same JSON text; every reader takes either form, so files written before stay as they are.
// Alongside the route directories each owner has `_sync-log/`, one small entry per sync that
// called ESI; it names the raw files that made up that sync's snapshot, which is how derive.js can
// rebuild the retained snapshots from raw alone.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SYNC_LOG_DIR = '_sync-log';
const GZ = '.gz';

const OWNER = /^(?:public|\d{1,15})$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STAMP_FILE = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json(?:\.gz)?$/;

const ensureDir = (dir) => {
	fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
};

// `data` is text or a Buffer (a gzipped file).
const writeFileAtomic = (file, data) => {
	const dir = path.dirname(file);
	ensureDir(dir);
	const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
	try {
		fs.writeFileSync(tmp, data, { mode: FILE_MODE, flag: 'wx' });
		fs.renameSync(tmp, file);
	} catch (e) {
		fs.rmSync(tmp, { force: true });
		throw e;
	}
	fs.chmodSync(file, FILE_MODE);
};

// The text of a file, gunzipped when its name ends in `.gz`; null when it does not exist.
const readTextFile = (file) => {
	let data;
	try {
		data = fs.readFileSync(file);
	} catch (e) {
		if (e.code === 'ENOENT') return null;
		throw e;
	}
	return (file.endsWith(GZ) ? zlib.gunzipSync(data) : data).toString('utf8');
};

// The parsed JSON file (gunzipped when its name ends in `.gz`), or null when it does not exist. A
// file that is not valid JSON (or not valid gzip) throws.
const readJsonFile = (file) => {
	const text = readTextFile(file);
	return text === null ? null : JSON.parse(text);
};

// The first of `files` that exists, parsed; null when none does. For a record kept in either form.
const readFirstJsonFile = (files) => {
	for (const file of files) {
		const text = readTextFile(file);
		if (text !== null) return JSON.parse(text);
	}
	return null;
};

// The first of `files` that exists, or null; with its size in bytes.
const firstFileOf = (files) => {
	for (const file of files) {
		try {
			return { file, bytes: fs.statSync(file).size };
		} catch (e) {
			if (e.code !== 'ENOENT') throw e;
		}
	}
	return null;
};

// The gzipped form of a text, as written to a `.json.gz` file.
const gzipText = (text) => zlib.gzipSync(text);

// Names a file by its time stamp: `2026-11-20T01:22:23.592Z` -> `2026-11-20T01-22-23-592Z.json`.
// Colons are awkward in file names, and the result still sorts as time does.
const stampToFileName = (stamp) => {
	if (typeof stamp !== 'string' || !STAMP.test(stamp)) throw new Error(`bad time stamp: ${String(stamp).slice(0, 40)}`);
	return `${stamp.replace(/[:.]/g, '-')}.json`;
};

// Inverse of stampToFileName, for the plain name and the gzipped one (`....json.gz`); null for any
// other file name (temp files, stray files).
const fileNameToStamp = (name) => {
	const m = STAMP_FILE.exec(name);
	return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
};

// A hash of the parsed body, stable across re-serialisation.
const hashJson = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The stamps of the files in `dir`, oldest first, each once whether its file is plain or gzipped
// (a stamp held in both forms is still one record).
const stampsIn = (dir) => {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (e) {
		if (e.code === 'ENOENT') return [];
		throw e;
	}
	return [...new Set(names.map(fileNameToStamp).filter(stamp => stamp !== null))].sort();
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

// Whether the raw store writes a route's records gzipped: the public market routes (regional order
// pages, per-type books, histories), the bulky and replaceable ones. Everything else stays plain.
const gzipsRaw = (owner, slug) => String(owner) === 'public' && typeof slug === 'string' && slug.startsWith('markets-');

const createRawStore = ({ dataDir }) => {
	const root = path.join(path.resolve(dataDir), 'raw');
	const dirOf = (owner, slug) => path.join(root, checkOwner(owner), checkSlug(slug));
	const logDirOf = (owner) => path.join(root, checkOwner(owner), SYNC_LOG_DIR);

	// The two names a record can have on disk, gzipped first: that one is preferred when both exist.
	const filesOf = (owner, slug, stamp) => {
		const file = path.join(dirOf(owner, slug), stampToFileName(stamp));
		return [file + GZ, file];
	};

	// The record, whichever form holds it; null when neither exists.
	const read = (owner, slug, stamp) => readFirstJsonFile(filesOf(owner, slug, stamp));

	// Stored once per file name; the caller keeps fetchedAt unique per route. Gzipped for the
	// routes gzipsRaw names. Answers the path written.
	const write = (owner, slug, record) => {
		const [gz, plain] = filesOf(owner, slug, record.fetchedAt);
		const text = JSON.stringify(record) + '\n';
		if (gzipsRaw(owner, slug)) {
			writeFileAtomic(gz, gzipText(text));
			return gz;
		}
		writeFileAtomic(plain, text);
		return plain;
	};

	// The path of a record's file as it is on disk (gzipped or plain), or null when neither exists.
	const fileFor = (owner, slug, stamp) => {
		const found = firstFileOf(filesOf(owner, slug, stamp));
		return found === null ? null : found.file;
	};
	// The size on disk of a record's file in bytes (the compressed size when gzipped), or null.
	const bytes = (owner, slug, stamp) => {
		const found = firstFileOf(filesOf(owner, slug, stamp));
		return found === null ? null : found.bytes;
	};

	// Every file of a route, oldest first: [{stamp, file, bytes}], one entry per file on disk (a stamp
	// held in both forms is two entries); one directory read and a stat per file, no parsing.
	const files = (owner, slug) => {
		const dir = dirOf(owner, slug);
		let names;
		try {
			names = fs.readdirSync(dir);
		} catch (e) {
			if (e.code === 'ENOENT') return [];
			throw e;
		}
		const out = [];
		for (const name of names) {
			const stamp = fileNameToStamp(name);
			if (stamp === null) continue;
			const file = path.join(dir, name);
			try {
				out.push({ stamp, file, bytes: fs.statSync(file).size });
			} catch (e) {
				if (e.code !== 'ENOENT') throw e; // gone meanwhile
			}
		}
		return out.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : a.file < b.file ? -1 : 1));
	};

	// Deletes a record in both forms (the storage budget's trimming). Only the public market routes
	// (gzipsRaw) can be removed: character raw is irreplaceable and stays. Answers the bytes freed.
	const remove = (owner, slug, stamp) => {
		if (!gzipsRaw(owner, slug)) throw new Error('raw store: only public market records can be removed');
		let freed = 0;
		for (const file of filesOf(owner, slug, stamp)) {
			try {
				freed += fs.statSync(file).size;
			} catch (e) {
				if (e.code === 'ENOENT') continue;
				throw e;
			}
			fs.rmSync(file, { force: true });
		}
		return freed;
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

	return { root, read, write, fileFor, bytes, files, remove, list, latestStamp, latest, slugs, owners, writeSyncLog, syncLogStamps, readSyncLog };
};

// One sync or rebuild at a time per owner, across processes (the server and scripts/sync.js
// share a data directory). The lock is a file holding {pid, at, boot, token}: the holder's pid, when
// it took the lock, this machine's boot time, and a random token that names this one holder. While
// the lock is held a timer touches the file's mtime every `refreshMs` (once a minute), so a live
// holder's lock stays young however long its run; the release function stops the timer and removes
// the file only while it still holds this holder's token, so a holder whose lock was taken over
// never removes the next holder's. A lock is taken over when its process is gone; when its pid is
// alive but its boot time is not this machine's (the pid was reused after a reboot); or when its
// mtime is `staleMs` old, a frozen holder (the timer would have kept it young). A lock file that
// cannot be read (just created and not yet written, or half written) counts as held while it is
// younger than a short grace, and is taken over after it. Answers a release function, or null when
// another holder has it.
const LOCK_STALE_MS = 30 * 60 * 1000;
const LOCK_REFRESH_MS = 60 * 1000;
const LOCK_GRACE_MS = 10 * 1000;
// os.uptime() is whole seconds on a Mac, and a reboot takes longer than this anyway
const LOCK_BOOT_SLACK_MS = 10 * 1000;
const bootTime = () => Math.round(Date.now() - os.uptime() * 1000);
const readLock = (file) => {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e) {
		return null;
	}
};
const pidAlive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e.code === 'EPERM';
	}
};
const lockIsStale = (holder, age, staleMs) => {
	if (!holder || !Number.isInteger(holder.pid)) return age >= LOCK_GRACE_MS;
	if (!pidAlive(holder.pid)) return true;
	// a lock written before boot was recorded has none: judged by its pid and age alone
	if (Number.isFinite(holder.boot) && Math.abs(holder.boot - bootTime()) > LOCK_BOOT_SLACK_MS) return true;
	return age >= staleMs;
};
const acquireLock = (dataDir, name, { staleMs = LOCK_STALE_MS, refreshMs = LOCK_REFRESH_MS } = {}) => {
	const dir = path.join(path.resolve(dataDir), 'locks');
	ensureDir(dir);
	const file = path.join(dir, `${name}.lock`);
	for (let attempt = 0; attempt < 2; attempt++) {
		const token = crypto.randomBytes(16).toString('hex');
		try {
			fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), boot: bootTime(), token }), { mode: FILE_MODE, flag: 'wx' });
		} catch (e) {
			if (e.code !== 'EEXIST') throw e;
			const holder = readLock(file);
			let age = Infinity;
			try {
				age = Date.now() - fs.statSync(file).mtimeMs;
			} catch (e) {
				// gone meanwhile: the next attempt creates it
			}
			if (!lockIsStale(holder, age, staleMs)) return null;
			fs.rmSync(file, { force: true });
			continue;
		}
		const ours = () => {
			const holder = readLock(file);
			return holder !== null && holder.token === token;
		};
		const timer = setInterval(() => {
			try {
				if (!ours()) {
					clearInterval(timer); // taken over: no longer ours to keep young
					return;
				}
				const now = new Date();
				fs.utimesSync(file, now, now);
			} catch (e) {
				// a missed touch is made up by the next one
			}
		}, refreshMs);
		timer.unref();
		return () => {
			clearInterval(timer);
			if (ours()) fs.rmSync(file, { force: true });
		};
	}
	return null;
};

module.exports = {
	DIR_MODE,
	FILE_MODE,
	ensureDir,
	writeFileAtomic,
	readTextFile,
	readJsonFile,
	readFirstJsonFile,
	firstFileOf,
	gzipText,
	gzipsRaw,
	stampToFileName,
	fileNameToStamp,
	hashJson,
	createRawStore,
	acquireLock,
};
