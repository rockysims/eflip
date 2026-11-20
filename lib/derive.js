// derive.js: raw -> ledger. Rebuilds everything under data/ledger/ from data/raw/ alone, so a
// wrong rule is fixed by re-deriving, never by re-fetching (the Data principle).
//
// The invariant that matters: a rebuild gives byte-for-byte the ledger the incremental sync built.
// Both fold the same raw records through the same functions (ledger.js merging, the builders
// below) in the same order (fetchedAt, which esi.js keeps strictly increasing), and both write
// with the same text writers. test/derive.test.js checks exactly that.
//
// Snapshots come from the sync logs in data/raw/<id>/_sync-log/: each names the raw files that
// made up that sync's {orders, assets, balance}; a snapshot equal to the previous one is skipped.
// Structure names come from every character's universe-structures-<id> raw, newest answer wins.
//
// A rebuild is built beside the live ledger and swapped in, and a character with no raw at all is
// left alone (its ledger may predate the raw store).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createRawStore, acquireLock, ensureDir } = require('./dataFiles');
const { KINDS, classifySlug, rowMap, overlay, sortedRows, createLedger } = require('./ledger');

// Slug of the n-th page (1-based) of the asset list; matches esi.js `slugFor`.
const assetSlug = (page) => (page === 1 ? 'assets' : `assets-page-${page}`);

// The snapshot a sync log entry describes, from the raw files it names; null when one is missing.
// refs: {orders: stamp, wallet: stamp, assets: [stamp per page, page 1 first]}.
const snapshotFromRefs = (raw, characterId, syncedAt, refs) => {
	if (!refs || !Array.isArray(refs.assets)) return null;
	const orders = raw.read(characterId, 'orders', refs.orders);
	const wallet = raw.read(characterId, 'wallet', refs.wallet);
	if (!orders || !wallet) return null;
	let assets = [];
	for (let i = 0; i < refs.assets.length; i++) {
		const page = raw.read(characterId, assetSlug(i + 1), refs.assets[i]);
		if (!page) return null;
		assets = assets.concat(page.body);
	}
	return { syncedAt, orders: orders.body, assets, balance: wallet.body };
};

// {fetchedAt, skills, standings} from the newest raw skills and standings; null with neither.
// fetchedAt is the newer of the two raw files, which is a fact about the data held (a refresh that
// found nothing changed stores no file).
const profileFromRaw = (raw, characterId) => {
	const skills = raw.latest(characterId, 'skills');
	const standings = raw.latest(characterId, 'standings');
	if (!skills && !standings) return null;
	const stamps = [skills, standings].filter(Boolean).map(record => record.fetchedAt).sort();
	return {
		fetchedAt: stamps[stamps.length - 1],
		skills: skills ? (Array.isArray(skills.body && skills.body.skills) ? skills.body.skills : []) : null,
		standings: standings ? standings.body : null,
	};
};

// A structure's ledger entry: what ESI said, plus when and through which character.
const structureEntry = (record, characterId) => ({ ...record.body, fetchedAt: record.fetchedAt, characterId: Number(characterId) });

const compareStamped = (a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

const randomName = () => crypto.randomBytes(6).toString('hex');

// Builds data/ledger/<id>/ from raw into `ledger` (a createLedger instance, possibly one rooted at
// a scratch directory). Answers counts, or {skipped} when there is no raw to build from.
const buildCharacter = ({ raw, ledger, characterId }) => {
	const id = Number(characterId);
	const entries = [];
	const slugs = raw.slugs(id);
	for (const slug of slugs) {
		const cls = classifySlug(slug);
		if (!cls || !(Object.hasOwn(KINDS, cls.kind) || cls.kind === 'contract-items')) continue;
		for (const stamp of raw.list(id, slug)) entries.push({ stamp, slug, cls });
	}
	const syncLogs = raw.syncLogStamps(id);
	if (slugs.length === 0 && syncLogs.length === 0) return { skipped: 'no raw data' };
	entries.sort(compareStamped);

	const maps = {};
	const items = new Map();
	for (const { stamp, slug, cls } of entries) {
		const record = raw.read(id, slug, stamp);
		if (!record || !Array.isArray(record.body)) continue;
		if (cls.kind === 'contract-items') {
			items.set(cls.id, record.body);
		} else {
			if (!maps[cls.kind]) maps[cls.kind] = new Map();
			overlay(maps[cls.kind], record.body, KINDS[cls.kind].key);
		}
	}

	const counts = { transactions: 0, journal: 0, ordersHistory: 0, contracts: 0, contractItems: items.size, snapshots: 0, profile: false };
	const countKey = { transactions: 'transactions', journal: 'journal', 'orders-history': 'ordersHistory', contracts: 'contracts' };
	for (const kind of Object.keys(maps)) {
		const rows = sortedRows(maps[kind]);
		ledger.writeRows(id, kind, rows);
		counts[countKey[kind]] = rows.length;
	}
	for (const [contractId, body] of items) ledger.writeContractItems(id, contractId, body);

	for (const syncedAt of syncLogs) {
		const entry = raw.readSyncLog(id, syncedAt);
		if (!entry || !entry.snapshot) continue;
		const snapshot = snapshotFromRefs(raw, id, entry.syncedAt, entry.snapshot);
		if (snapshot && ledger.writeSnapshot(id, snapshot)) counts.snapshots++;
	}

	const profile = profileFromRaw(raw, id);
	if (profile) {
		ledger.writeProfile(id, profile);
		counts.profile = true;
	}
	return counts;
};

// The ledger's structures.json from every character's raw universe-structures-<id> files.
// Returns the number of structures, or null when there is no such raw (an existing file stays).
const buildStructures = ({ raw, ledger }) => {
	const entries = [];
	for (const owner of raw.owners()) {
		if (owner === 'public') continue;
		for (const slug of raw.slugs(owner)) {
			const cls = classifySlug(slug);
			if (!cls || cls.kind !== 'structure') continue;
			for (const stamp of raw.list(owner, slug)) entries.push({ stamp, slug, owner, id: cls.id });
		}
	}
	if (entries.length === 0) return null;
	entries.sort(compareStamped);
	const structures = {};
	for (const { stamp, slug, owner, id } of entries) {
		const record = raw.read(owner, slug, stamp);
		if (record && record.body && typeof record.body === 'object') structures[id] = structureEntry(record, owner);
	}
	ledger.writeStructures(structures);
	return Object.keys(structures).length;
};

// Rebuilds one character's ledger from raw: written to a scratch directory, then swapped in.
// The caller holds the character's lock (sync.js does; rebuildCharacter below takes it).
const rebuildCharacterLocked = ({ dataDir, characterId }) => {
	const raw = createRawStore({ dataDir });
	const live = createLedger({ dataDir });
	const scratchRoot = path.join(live.root, `.rebuild-${randomName()}`);
	const scratch = createLedger({ dataDir, root: scratchRoot });
	try {
		ensureDir(scratch.dirOf(characterId)); // raw that yields no rows still replaces the old ledger with an empty one
		const counts = buildCharacter({ raw, ledger: scratch, characterId });
		if (counts.skipped) return counts;
		const target = live.dirOf(characterId);
		const old = `${target}.old-${randomName()}`;
		if (fs.existsSync(target)) fs.renameSync(target, old);
		fs.renameSync(scratch.dirOf(characterId), target);
		fs.rmSync(old, { recursive: true, force: true });
		return counts;
	} finally {
		fs.rmSync(scratchRoot, { recursive: true, force: true });
	}
};

const rebuildCharacter = ({ dataDir, characterId }) => {
	const release = acquireLock(dataDir, `character-${Number(characterId)}`);
	if (!release) throw new Error(`derive: character ${characterId} is being synced; try again in a moment`);
	try {
		return rebuildCharacterLocked({ dataDir, characterId });
	} finally {
		release();
	}
};

// Every character with raw data, then the structure names.
const rebuildAll = ({ dataDir, log = console }) => {
	const raw = createRawStore({ dataDir });
	const characters = {};
	for (const owner of raw.owners()) {
		if (owner === 'public') continue;
		characters[owner] = rebuildCharacter({ dataDir, characterId: owner });
		log.info(`derive: ${owner} rebuilt`);
	}
	const structures = buildStructures({ raw, ledger: createLedger({ dataDir }) });
	return { characters, structures };
};

module.exports = {
	assetSlug,
	snapshotFromRefs,
	profileFromRaw,
	structureEntry,
	buildCharacter,
	buildStructures,
	rebuildCharacterLocked,
	rebuildCharacter,
	rebuildAll,
};
