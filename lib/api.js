// api.js: the /api and /sso routes the browser pages use for server-side features.
//
// The server listens on 127.0.0.1 only, but that alone is not enough: a web page the user has
// open can still reach it by DNS rebinding (a hostname that later resolves to 127.0.0.1) or by a
// cross-site request, and so can any other local process. Two guards answer 403 to those:
//   - Host must be a loopback name, which defeats DNS rebinding (the rebound request carries the
//     attacker's hostname in Host).
//   - Origin, when the browser sends one, must be this very server (same host and port), which
//     defeats cross-site requests. No Access-Control-* header is ever set, so browsers also refuse
//     to hand responses to other origins.
//
// EVE SSO (Phase 2): /sso/login and /sso/callback link a character; /api/characters lists and
// removes them. Refresh tokens stay in <dataDir>/tokens.json and access tokens in server memory
// (app.locals.tokens, for the server's own ESI calls); neither is ever sent to the browser.
//
// Synced data (Phase 3): POST|GET /api/sync run and report syncs (lib/sync.js), and
// /api/ledger, /api/snapshots and /api/market read what they stored. There is still no generic ESI
// proxy: the browser asks for these task-specific answers and nothing it sends reaches ESI.
//
// Order monitor (docs/order-monitor-plan.md): POST|GET /api/watch run and report one watch refresh
// (our open orders, then the books of the types listed), /api/order-log reads the order log and
// /api/market?log=1 the book logs. /api/config also says where the data lives and whether
// EFLIP_DATA_DIR and ESI_USER_AGENT are set (booleans and a local path, never a secret) so the
// pages can remind the user; it stays outside requireConfigured.
//
// Export runs (Phase 5): POST|GET /api/runs save and list what the export page copied (lib/runs.js).
// They are local files, so they work without EVE SSO and sit outside requireConfigured.
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { createSso } = require('./sso');
const { createTokenStore, DEFAULT_DATA_DIR } = require('./tokenStore');
const { createTokenManager } = require('./tokens');
const { createSyncService, MARKET_MAX_TYPE_IDS } = require('./sync');
const { createRunStore, RunError, RUNS_MAX_BYTES } = require('./runs');

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

// Requested at link time. A scope added later means re-linking every character, so the last
// three (trade skills, standings, structure names) are asked for now although Phase 3 uses them.
const SCOPES = Object.freeze([
	'esi-wallet.read_character_wallet.v1',
	'esi-markets.read_character_orders.v1',
	'esi-assets.read_assets.v1',
	'esi-contracts.read_character_contracts.v1',
	'esi-skills.read_skills.v1',
	'esi-characters.read_standings.v1',
	'esi-universe.read_structures.v1',
]);
const DEFAULT_CALLBACK_URL = 'http://localhost:5001/sso/callback';
const DEFAULT_USER_AGENT = 'eflip (local)';
const DEFAULT_RETURN = '/results.html';
const STATE_COOKIE = 'eflip_sso';
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_LOGINS = 100;

// Hostname part of a Host header value without its port; handles `[::1]:5001`. null when empty.
const hostnameOf = (hostHeader) => {
	if (typeof hostHeader !== 'string' || hostHeader === '') return null;
	if (hostHeader.startsWith('[')) {
		const end = hostHeader.indexOf(']');
		return end === -1 ? null : hostHeader.slice(1, end);
	}
	return hostHeader.split(':')[0];
};

const hostGuard = (req, res, next) => {
	const hostname = hostnameOf(req.headers.host);
	if (hostname === null || !LOCAL_HOSTNAMES.has(hostname.toLowerCase())) {
		return res.status(403).json({error: 'forbidden host'});
	}
	next();
};

const originGuard = (req, res, next) => {
	const origin = req.headers.origin;
	if (origin === undefined) return next();
	let originHost = null;
	try {
		originHost = new URL(origin).host;
	} catch (e) {
		// unparsable: falls through to the 403 below
	}
	if (originHost === null || originHost !== req.headers.host) {
		return res.status(403).json({error: 'forbidden origin'});
	}
	next();
};

// The page to come back to after login: a path on this server, else /results.html. Rejects
// `//host` and `/\host` (browsers read both as another host), whitespace and control characters
// (browsers drop tabs and newlines, so `/\t/host` would become `//host`), and anything long.
const safeReturnPath = (value) => {
	if (typeof value !== 'string' || value.length > 512) return DEFAULT_RETURN;
	if (!/^\/(?![/\\])[^\\\s\x00-\x1f\x7f]*$/.test(value)) return DEFAULT_RETURN;
	return value;
};

// `target` (a path, maybe with a query and a fragment) with `key=value` added to its query.
const withParam = (target, key, value) => {
	const hashAt = target.indexOf('#');
	const base = hashAt === -1 ? target : target.slice(0, hashAt);
	const hash = hashAt === -1 ? '' : target.slice(hashAt);
	return `${base}${base.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}${hash}`;
};

const parseCookies = (header) => {
	const cookies = Object.create(null);
	if (typeof header !== 'string') return cookies;
	for (const pair of header.split(';')) {
		const eq = pair.indexOf('=');
		if (eq === -1) continue;
		const name = pair.slice(0, eq).trim();
		let value = pair.slice(eq + 1).trim();
		try {
			value = decodeURIComponent(value);
		} catch (e) {
			// keep the raw value
		}
		if (name !== '' && !(name in cookies)) cookies[name] = value;
	}
	return cookies;
};

// CCP's `?error=` echoed back to the page: a short code, nothing else.
const errorCode = (value) => String(value).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'error';

const stateCookie = (state) => `${STATE_COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/sso; Max-Age=600`;
const CLEAR_STATE_COOKIE = `${STATE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/sso; Max-Age=0`;

const ID_PATTERN = /^\d{1,15}$/;
const MAX_ID_LIST = 100;

// A list of ids from a query value (`1,2` or a repeated key): null when absent, undefined when any
// of it is not a plain positive id or there are too many.
const parseIdList = (value, max = MAX_ID_LIST) => {
	if (value === undefined) return null;
	const parts = [];
	for (const piece of Array.isArray(value) ? value : [value]) {
		if (typeof piece !== 'string') return undefined;
		parts.push(...piece.split(','));
	}
	if (parts.length > max || parts.some(part => !ID_PATTERN.test(part) || Number(part) <= 0)) return undefined;
	return [...new Set(parts.map(Number))];
};

// characterIds / regionIds of a POST body: null when absent, undefined when not a list of ids.
const idsOfBody = (value) => (value === undefined ? null : Array.isArray(value) ? parseIdList(value.map(String)) : undefined);

// A `since` query value as ms since the epoch: null when absent, undefined when not a date.
const parseSince = (value) => {
	if (value === undefined) return null;
	if (typeof value !== 'string' || value === '') return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
};

// options: {env, dataDir, fetch, now, log}, all for tests; the server passes none.
const mountApi = (app, options = {}) => {
	const {
		env = process.env,
		fetch = globalThis.fetch,
		now = () => Date.now(),
		log = console,
	} = options;
	const clientId = env.EVE_CLIENT_ID || '';
	const clientSecret = env.EVE_CLIENT_SECRET || '';
	const callbackUrl = env.EVE_CALLBACK_URL || DEFAULT_CALLBACK_URL;
	const userAgent = env.ESI_USER_AGENT || DEFAULT_USER_AGENT;
	const dataDir = path.resolve(options.dataDir || env.EFLIP_DATA_DIR || DEFAULT_DATA_DIR);
	const configured = Boolean(clientId && clientSecret);

	let callbackOrigin = null;
	try {
		callbackOrigin = new URL(callbackUrl);
	} catch (e) {
		// left null: no canonical-host redirect
	}

	const store = createTokenStore({ dataDir });
	const sso = configured ? createSso({ clientId, clientSecret, callbackUrl, userAgent, fetch, now }) : null;
	const tokens = configured ? createTokenManager({ sso, store, now }) : null;
	// For the server's own ESI calls (Phase 3); never exposed over HTTP. null when not configured.
	app.locals.tokens = tokens;
	app.locals.tokenStore = store;
	// The sync service reaches the token manager through app.locals, so a test can swap it. It
	// touches no file until a sync or a read.
	const sync = createSyncService({
		dataDir,
		fetch,
		now,
		log,
		userAgent,
		compatDate: env.ESI_COMPAT_DATE || undefined,
		tokenStore: store,
		tokens: {
			accessTokenFor: (id) => app.locals.tokens.accessTokenFor(id),
			forget: (id) => app.locals.tokens && app.locals.tokens.forget(id),
		},
	});
	app.locals.sync = sync;
	const runs = createRunStore({ dataDir, log });

	// Logins waiting for their callback: state -> {returnTo, expiresAt}.
	const pendingLogins = new Map();
	const purgeExpiredLogins = () => {
		const t = now();
		for (const [state, entry] of pendingLogins) {
			if (entry.expiresAt <= t) pendingLogins.delete(state);
		}
		// Map order is insertion order: drop the oldest past the cap.
		while (pendingLogins.size >= MAX_PENDING_LOGINS) pendingLogins.delete(pendingLogins.keys().next().value);
	};
	const takeLogin = (state) => {
		const entry = pendingLogins.get(state);
		if (!entry) return null;
		pendingLogins.delete(state);
		return entry.expiresAt > now() ? entry : null;
	};

	const requireConfigured = (req, res, next) => {
		if (!configured) return res.status(503).json({error: 'not configured'});
		next();
	};

	const router = express.Router();
	// Guards cover both prefixes, so routes added below must live under /api or /sso.
	router.use(['/api', '/sso'], hostGuard, originGuard);

	router.get('/api/health', (req, res) => res.json({ok: true}));

	router.get('/api/config', (req, res) => res.json({
		configured,
		callbackUrl,
		scopes: SCOPES,
		env: {dataDir, dataDirFromEnv: Boolean(env.EFLIP_DATA_DIR), userAgentFromEnv: Boolean(env.ESI_USER_AGENT)},
	}));

	router.get('/sso/login', requireConfigured, async (req, res) => {
		const returnTo = safeReturnPath(req.query.return);
		// The state cookie belongs to one host name. Starting on 127.0.0.1 when the callback is
		// registered on localhost would bring the callback back without it, so start over there.
		if (callbackOrigin && String(req.headers.host).toLowerCase() !== callbackOrigin.host) {
			return res.redirect(302, `${callbackOrigin.origin}/sso/login?return=${encodeURIComponent(returnTo)}`);
		}
		purgeExpiredLogins();
		const state = crypto.randomBytes(16).toString('hex');
		pendingLogins.set(state, {returnTo, expiresAt: now() + STATE_TTL_MS});
		try {
			const url = await sso.authorizeUrl({state, scopes: SCOPES});
			res.setHeader('Set-Cookie', stateCookie(state));
			res.redirect(302, url);
		} catch (e) {
			pendingLogins.delete(state);
			log.warn(`sso login: ${e.message}`);
			res.status(500).json({error: 'sso unavailable'});
		}
	});

	router.get('/sso/callback', requireConfigured, async (req, res) => {
		res.setHeader('Set-Cookie', CLEAR_STATE_COOKIE);
		const queryState = typeof req.query.state === 'string' ? req.query.state : '';
		const cookieState = parseCookies(req.headers.cookie)[STATE_COOKIE] || '';
		const login = queryState !== '' && queryState === cookieState ? takeLogin(queryState) : null;

		if (req.query.error !== undefined) {
			return res.redirect(302, withParam(DEFAULT_RETURN, 'ssoError', errorCode(req.query.error)));
		}
		if (!login) {
			log.warn('sso callback: state missing, mismatched or expired');
			return res.redirect(302, withParam(DEFAULT_RETURN, 'ssoError', 'state'));
		}
		// `reason` is an SsoError/TokenError/fs message: by construction it holds no token.
		const fail = (code, reason) => {
			log.warn(`sso callback: ${code} failed: ${reason}`);
			res.redirect(302, withParam(login.returnTo, 'ssoError', code));
		};

		let tokenResponse;
		try {
			tokenResponse = await sso.exchangeCode(typeof req.query.code === 'string' ? req.query.code : '');
		} catch (e) {
			return fail('exchange', e.message);
		}
		if (typeof tokenResponse.refresh_token !== 'string' || tokenResponse.refresh_token === '') {
			return fail('exchange', 'no refresh token in the answer');
		}
		let claims;
		try {
			claims = await sso.verifyJwt(tokenResponse.access_token);
		} catch (e) {
			return fail('jwt', e.message);
		}
		const stamp = new Date(now()).toISOString();
		try {
			store.upsert({
				characterId: claims.characterId,
				name: claims.name,
				ownerHash: claims.owner,
				scopes: claims.scopes,
				refreshToken: tokenResponse.refresh_token,
				linkedAt: stamp,
				refreshedAt: stamp,
				status: 'ok',
				lastError: null,
			});
		} catch (e) {
			return fail('store', e.message);
		}
		tokens.prime(claims.characterId, tokenResponse.access_token, claims.exp);
		log.info(`sso: linked ${claims.name} (${claims.characterId})`);
		res.redirect(302, withParam(login.returnTo, 'linked', String(claims.characterId)));
	});

	router.get('/api/characters', requireConfigured, (req, res) => {
		try {
			const characters = store.publicList().sort((a, b) => String(a.name).localeCompare(String(b.name)));
			res.json(characters);
		} catch (e) {
			log.warn(`characters: ${e.message}`);
			res.status(500).json({error: 'token store unreadable'});
		}
	});

	router.delete('/api/characters/:id', requireConfigured, async (req, res) => {
		const id = /^\d{1,15}$/.test(req.params.id) ? Number(req.params.id) : null;
		let record = null;
		try {
			record = id === null ? null : store.get(id);
		} catch (e) {
			log.warn(`characters: ${e.message}`);
			return res.status(500).json({error: 'token store unreadable'});
		}
		if (!record) return res.status(404).json({error: 'unknown character'});

		const purge = req.query.purge === '1';
		if (purge) {
			// Ledger, raw and ESI bookkeeping go together: a ledger deleted alone would be rebuilt from
			// raw by the next sync. Refused, before anything else changes, while this character syncs.
			try {
				sync.purgeCharacter(id);
			} catch (e) {
				log.warn(`characters: purge of ${id} refused: ${e.message}`);
				return res.status(409).json({error: 'a sync of this character is running; try again shortly'});
			}
		}
		try {
			await sso.revoke(record.refreshToken);
		} catch (e) {
			log.warn(`sso: revoke for ${id} failed (${e.message}); removing the character anyway`);
		}
		try {
			store.remove(id);
			tokens.forget(id);
		} catch (e) {
			log.warn(`characters: removing ${id} failed: ${e.message}`);
			return res.status(500).json({error: 'remove failed'});
		}
		log.info(`sso: removed ${record.name} (${id})${purge ? ' and its synced data' : ''}`);
		res.json({ok: true, purged: purge});
	});

	// Characters named in a request: the linked ones when it names none.
	const requestedCharacters = (ids) => (ids === null ? store.list().map(record => record.characterId) : ids);

	router.post('/api/sync', requireConfigured, express.json({limit: '16kb'}), async (req, res) => {
		const body = req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
		const characterIds = idsOfBody(body.characterIds);
		const regionIds = idsOfBody(body.regionIds);
		const flag = (value) => value === undefined || typeof value === 'boolean';
		if (characterIds === undefined || regionIds === undefined || !flag(body.force) || !flag(body.market)) {
			return res.status(400).json({error: 'bad request'});
		}
		try {
			if (characterIds !== null && characterIds.some(id => !store.get(id))) {
				return res.status(404).json({error: 'unknown character'});
			}
			const result = await sync.syncAll({characterIds, force: body.force === true, market: body.market !== false, regionIds});
			res.json(result);
		} catch (e) {
			log.warn(`sync: ${e.message}`);
			res.status(500).json({error: 'sync failed'});
		}
	}, (err, req, res, next) => res.status(err.status === 413 ? 413 : 400).json({error: 'bad request'}));

	router.get('/api/sync', requireConfigured, (req, res) => {
		try {
			res.json(sync.status());
		} catch (e) {
			log.warn(`sync status: ${e.message}`);
			res.status(500).json({error: 'sync state unreadable'});
		}
	});

	// One watch refresh: our open orders, then the books of the types we have listed. Answers what it
	// did (the same object as GET /api/watch after it); a tick already running answers both callers.
	router.post('/api/watch', requireConfigured, express.json({limit: '16kb'}), async (req, res) => {
		const body = req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
		const characterIds = idsOfBody(body.characterIds);
		if (characterIds === undefined) return res.status(400).json({error: 'bad request'});
		try {
			if (characterIds !== null && characterIds.some(id => !store.get(id))) {
				return res.status(404).json({error: 'unknown character'});
			}
			res.json(await sync.syncWatch({characterIds}));
		} catch (e) {
			log.warn(`watch: ${e.message}`);
			res.status(500).json({error: 'watch failed'});
		}
	}, (err, req, res, next) => res.status(err.status === 413 ? 413 : 400).json({error: 'bad request'}));

	router.get('/api/watch', requireConfigured, (req, res) => {
		try {
			res.json(sync.watchStatus());
		} catch (e) {
			log.warn(`watch status: ${e.message}`);
			res.status(500).json({error: 'watch state unreadable'});
		}
	});

	router.get('/api/order-log', requireConfigured, (req, res) => {
		const ids = parseIdList(req.query.characterIds);
		if (ids === undefined) return res.status(400).json({error: 'bad request'});
		try {
			const characters = {};
			for (const id of requestedCharacters(ids)) characters[id] = sync.ledger.readOrderLog(id);
			res.json({characters});
		} catch (e) {
			log.warn(`order log: ${e.message}`);
			res.status(500).json({error: 'order log unreadable'});
		}
	});

	router.get('/api/ledger', requireConfigured, (req, res) => {
		const ids = parseIdList(req.query.characterIds);
		const since = parseSince(req.query.since);
		if (ids === undefined || since === undefined) return res.status(400).json({error: 'bad request'});
		try {
			const characters = {};
			for (const id of requestedCharacters(ids)) {
				characters[id] = {characterId: id, sync: sync.characterStatus(id), ...sync.ledger.readAll(id, {since})};
			}
			res.json({characters, structures: sync.ledger.readStructures()});
		} catch (e) {
			log.warn(`ledger: ${e.message}`);
			res.status(500).json({error: 'ledger unreadable'});
		}
	});

	router.get('/api/snapshots', requireConfigured, (req, res) => {
		const ids = parseIdList(req.query.characterIds);
		const since = parseSince(req.query.since);
		if (ids === undefined || since === undefined) return res.status(400).json({error: 'bad request'});
		try {
			const characters = {};
			for (const id of requestedCharacters(ids)) characters[id] = sync.ledger.readSnapshots(id, {since});
			res.json({characters});
		} catch (e) {
			log.warn(`snapshots: ${e.message}`);
			res.status(500).json({error: 'snapshots unreadable'});
		}
	});

	router.get('/api/market', requireConfigured, (req, res) => {
		const typeIds = parseIdList(req.query.typeIds, MARKET_MAX_TYPE_IDS);
		const regionIds = parseIdList(req.query.regionIds, 10);
		if (typeIds === null || typeIds === undefined || regionIds === undefined) return res.status(400).json({error: 'bad request'});
		try {
			res.json(sync.readMarket({typeIds, regionIds, log: req.query.log === '1'}));
		} catch (e) {
			log.warn(`market: ${e.message}`);
			res.status(500).json({error: 'market data unreadable'});
		}
	});

	// Saves the run the export page posts when "Copy orders" is pressed. The same orders posted
	// again only bump the saved run's copyCount and lastCopiedAt: 201 for a new file, 200 for that.
	// Not behind requireConfigured: runs are local files.
	router.post('/api/runs', express.json({limit: RUNS_MAX_BYTES}), async (req, res) => {
		try {
			const result = await runs.save(req.body);
			res.status(result.created ? 201 : 200).json(result);
		} catch (e) {
			if (e instanceof RunError) return res.status(e.status).json({error: e.status === 413 ? 'too large' : 'bad request', detail: e.message});
			log.warn(`runs: ${e.message}`);
			res.status(500).json({error: 'run not saved'});
		}
	}, (err, req, res, next) => res.status(err.status === 413 ? 413 : 400).json({error: err.status === 413 ? 'too large' : 'bad request'}));

	// The saved runs, most recently copied first, without their market context unless `?context=1`.
	router.get('/api/runs', (req, res) => {
		try {
			res.json(runs.list({context: req.query.context === '1'}));
		} catch (e) {
			log.warn(`runs: ${e.message}`);
			res.status(500).json({error: 'runs unreadable'});
		}
	});

	app.use(router);
};

module.exports = { mountApi, SCOPES, safeReturnPath };
