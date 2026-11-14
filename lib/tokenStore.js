// tokenStore.js: the linked characters and their refresh tokens, in <dataDir>/tokens.json.
//
// The file is gitignored (data/), mode 0600 in a 0700 directory, and always replaced whole via a
// temp file and a rename, so a crash never leaves half a file. Every call reads the file afresh,
// so a separate process (scripts/sync.js) that rotates a refresh token is never overwritten by a
// stale copy held in memory. Access tokens never reach this file: records keep known fields only.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const FILE_NAME = 'tokens.json';
const STATUSES = new Set(['ok', 'relink']);

const emptyState = () => ({ version: 1, characters: {} });

// The stored shape of a record, in a fixed field order; anything else (an access token, say) is
// dropped.
const toRecord = (record) => {
	const characterId = Number(record && record.characterId);
	if (!Number.isSafeInteger(characterId) || characterId <= 0) throw new Error('token store: bad characterId');
	if (typeof record.refreshToken !== 'string' || record.refreshToken === '') throw new Error('token store: no refreshToken');
	const status = record.status === undefined ? 'ok' : record.status;
	if (!STATUSES.has(status)) throw new Error('token store: bad status');
	return {
		characterId,
		name: typeof record.name === 'string' ? record.name : '',
		ownerHash: typeof record.ownerHash === 'string' ? record.ownerHash : null,
		scopes: Array.isArray(record.scopes) ? record.scopes.filter(scope => typeof scope === 'string') : [],
		refreshToken: record.refreshToken,
		linkedAt: record.linkedAt || null,
		refreshedAt: record.refreshedAt || null,
		status,
		lastError: typeof record.lastError === 'string' ? record.lastError : null,
	};
};

const withoutToken = ({ refreshToken, ...rest }) => rest;

const createTokenStore = ({ dataDir = process.env.EFLIP_DATA_DIR || DEFAULT_DATA_DIR } = {}) => {
	const dir = path.resolve(dataDir);
	const file = path.join(dir, FILE_NAME);

	// A missing file is an empty store. Anything unreadable throws; a JSON error is rethrown
	// without V8's message, which quotes the text around the fault (that text holds tokens).
	const load = () => {
		let text;
		try {
			text = fs.readFileSync(file, 'utf8');
		} catch (e) {
			if (e.code === 'ENOENT') return emptyState();
			throw e;
		}
		let state;
		try {
			state = JSON.parse(text);
		} catch (e) {
			throw new Error(`token store: ${file} is not valid JSON`);
		}
		if (state === null || typeof state !== 'object' || state.version !== 1
			|| state.characters === null || typeof state.characters !== 'object' || Array.isArray(state.characters)) {
			throw new Error(`token store: ${file} has an unexpected shape`);
		}
		return state;
	};

	const save = (state) => {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const tmp = path.join(dir, `.${FILE_NAME}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
		try {
			fs.writeFileSync(tmp, JSON.stringify(state, null, '\t') + '\n', { mode: 0o600, flag: 'wx' });
			fs.renameSync(tmp, file);
		} catch (e) {
			fs.rmSync(tmp, { force: true });
			throw e;
		}
		fs.chmodSync(file, 0o600);
	};

	const get = (id) => load().characters[String(id)] || null;
	const list = () => Object.values(load().characters);
	const publicList = () => list().map(withoutToken);

	const upsert = (record) => {
		const stored = toRecord(record);
		const state = load();
		state.characters[String(stored.characterId)] = stored;
		save(state);
		return stored;
	};

	// true when the character was there.
	const remove = (id) => {
		const state = load();
		const key = String(id);
		if (!Object.hasOwn(state.characters, key)) return false;
		delete state.characters[key];
		save(state);
		return true;
	};

	// The updated record, or null when the character is not linked.
	const setStatus = (id, status, lastError = null) => {
		if (!STATUSES.has(status)) throw new Error('token store: bad status');
		const state = load();
		const key = String(id);
		if (!Object.hasOwn(state.characters, key)) return null;
		const updated = toRecord({ ...state.characters[key], status, lastError });
		state.characters[key] = updated;
		save(state);
		return updated;
	};

	return { file, load, get, list, publicList, upsert, remove, setStatus };
};

module.exports = { createTokenStore, DEFAULT_DATA_DIR };
