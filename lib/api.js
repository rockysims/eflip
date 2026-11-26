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
// /api/ledger, /api/snapshots and /api/market read what they stored. POST /api/sync also takes
// `regionBook` (true: take the destination region's whole order book now; false: not even when
// EFLIP_REGION_BOOK=1 asks for it each hour). With EFLIP_REGION_BOOK=1, mountApi also starts the hourly
// scheduler (createRegionBookScheduler in sync.js, on app.locals.regionBookScheduler: the first
// snapshot a minute after the server starts, then every hour). /api/config's `regionBook` says
// {enabled (the variable), scheduled (the timers are running), nextRunAt (ISO or null), lastRun
// ({at, status} of the last scheduled run since this server started, or null)}.
// POST /api/sync `storage: true` runs the storage budget's step once more at the end (lib/storage.js),
// and /api/config's `storage` says the budget (EFLIP_STORAGE_BUDGET, null when unset), the shares,
// each kind's bytes on disk and their total (measured at most once a minute: `measuredAt`), when the
// budget last trimmed something and what the last run could not bring under the budget (`unmet`, bytes). There is still no generic ESI proxy:
// the browser asks for these task-specific answers and nothing it sends reaches ESI.
//
// Order monitor (docs/order-monitor-plan.md): POST|GET /api/watch run and report one watch refresh
// (our open orders, then the books of the types listed), /api/order-log reads the order log and
// /api/market?log=1 the book logs. /api/config also says where the data lives and whether
// EFLIP_DATA_DIR and ESI_USER_AGENT are set (booleans and a local path, never a secret) so the
// pages can remind the user; it stays outside requireConfigured. `env.dataDirError` is null while
// the data directory takes a file and {code, message} while it does not (probeDataDir): a link or a
// sync would fail there, so the pages say so before the user tries. A failed link comes back to the
// page as ?ssoError=<stage>&ssoReason=<code>, the code being the error's own (EACCES, EROFS ...)
// when it is a short upper-case token, else `error`; the message stays in the server's log.
//
// Observed figures (planning/2026-11-25-export-history-columns, M1): POST /api/market-stats answers, for
// the types in the body, what each type's book log (data/ledger/market/<regionId>/<typeId>.json.gz) saw at
// one station over the last windowDays (public/market-stats.js computeMarketStats), computed on request.
// A POST because each type carries its own ordersPerDay, which sets how close two samples must be to
// count as watching the book. A type with no log, or one the stats could not be computed for, answers null.
//
// Sold before (planning/2026-11-25-export-history-columns, M3): POST /api/sold-before answers, for the
// types in the body, what the linked characters sold at one station over the last `days` days, from the
// ledger and no ESI call (lib/sold-before.js): {stationId, days, types: {<typeId>: {units, sales, lastSoldAt,
// netMarginMilPerUnit, medianDaysOnMarket}}}, a type with no sale left out.
//
// Export runs (Phase 5): POST|GET /api/runs save and list what the export page copied (lib/runs.js).
// They are local files, so they work without EVE SSO and sit outside requireConfigured.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { createSso } = require('./sso');
const { createTokenStore, DEFAULT_DATA_DIR } = require('./tokenStore');
const { createTokenManager } = require('./tokens');
const { createSyncService, createRegionBookScheduler, regionBookEnabled, MARKET_MAX_TYPE_IDS } = require('./sync');
const { createRunStore, RunError, RUNS_MAX_BYTES } = require('./runs');
const { computeMarketStats } = require('../public/market-stats.js');
const soldBefore = require('./sold-before');

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

// Why a sign-in step failed, as the page may see it: the error's own `code` (an fs code such as
// EACCES, or a network one) when it is a short upper-case token, else `error`. Never a message.
const REASON_PATTERN = /^[A-Z][A-Z0-9_]{2,15}$/;
// A failed fetch is a TypeError whose code sits on `cause` (undici), so that is looked at too.
const reasonCode = (e) => {
	for (const err of [e, e && e.cause]) {
		if (err && typeof err.code === 'string' && REASON_PATTERN.test(err.code)) return err.code;
	}
	return 'error';
};

// Whether <dataDir> takes a file, tried the way tokenStore.js and dataFiles.js write: create the
// directory (0700), write a tiny temp file (0600, 'wx'), delete it. null when all of that worked,
// else {code, message} from the first step that failed. An fs message names the path and the
// syscall, never file contents, so it is safe to show; nothing is ever read from the directory.
const PROBE_MESSAGE_MAX = 300;

// What decided a denial, as far as stat can tell: the directory the probe could not write to (the
// target when it exists, else its nearest existing parent), that directory's owner and mode, and
// the account this server runs as. A folder owned by another account, or one without its owner's
// write bit, is the usual answer, and the user cannot see it from the fs message alone.
const ownershipNote = (target) => {
	let me = null;
	try {
		me = os.userInfo();
	} catch (e) {
		// no passwd entry for this uid: name the uid only
	}
	const uid = typeof process.getuid === 'function' ? process.getuid() : null;
	const self = me ? `${me.username} (uid ${me.uid})` : uid === null ? 'an unknown account' : `uid ${uid}`;
	const describe = (dir) => {
		const st = fs.statSync(dir);
		const mode = (st.mode & 0o7777).toString(8).padStart(4, '0');
		const owner = me && st.uid === me.uid ? `${me.username} (uid ${st.uid})` : `uid ${st.uid}`;
		return `owned by ${owner} with mode ${mode}`;
	};
	const resolved = path.resolve(target);
	let dir = resolved;
	for (let i = 0; i < 64; i++) {
		let exists = false;
		try {
			fs.statSync(dir);
			exists = true;
		} catch (e) {
			exists = false;
		}
		if (exists) {
			try {
				if (dir === resolved) {
					const parent = path.dirname(dir);
					return ` It exists, ${describe(dir)}; its parent ${parent} is ${describe(parent)}; this server runs as ${self}.`;
				}
				return ` Its nearest existing parent, ${dir}, is ${describe(dir)}; this server runs as ${self}.`;
			} catch (e) {
				return ` This server runs as ${self}.`;
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) return '';
		dir = parent;
	}
	return '';
};
const probeDataDir = (dataDir) => {
	let tmp = null;
	try {
		fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		tmp = path.join(dataDir, `.probe.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
		fs.writeFileSync(tmp, 'eflip\n', { mode: 0o600, flag: 'wx' });
		fs.rmSync(tmp);
		return null;
	} catch (e) {
		if (tmp !== null) {
			try { fs.rmSync(tmp, { force: true }); } catch (e2) { /* the first error is the one to report */ }
		}
		return {
			code: e && typeof e.code === 'string' && e.code !== '' ? e.code : 'error',
			message: `${String(e && e.message !== undefined ? e.message : e).slice(0, PROBE_MESSAGE_MAX)}${ownershipNote(dataDir)}`,
		};
	}
};

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

// options: {env, dataDir, fetch, now, log, timers}, all for tests; the server passes none. `timers` is
// {setInterval, clearInterval, setTimeout, clearTimeout} for the region book scheduler's clock.
const mountApi = (app, options = {}) => {
	const {
		env = process.env,
		fetch = globalThis.fetch,
		now = () => Date.now(),
		log = console,
		timers = {},
	} = options;
	const clientId = env.EVE_CLIENT_ID || '';
	const clientSecret = env.EVE_CLIENT_SECRET || '';
	const callbackUrl = env.EVE_CALLBACK_URL || DEFAULT_CALLBACK_URL;
	const userAgent = env.ESI_USER_AGENT || DEFAULT_USER_AGENT;
	const dataDir = path.resolve(options.dataDir || env.EFLIP_DATA_DIR || DEFAULT_DATA_DIR);
	const configured = Boolean(clientId && clientSecret);

	// Said once here, and answered afresh by every /api/config, so a fixed folder shows without a restart.
	const startupProbe = probeDataDir(dataDir);
	if (startupProbe) log.warn(`data directory ${dataDir} is not writable (${startupProbe.code}): ${startupProbe.message}`);

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
		env,
		tokenStore: store,
		tokens: {
			accessTokenFor: (id) => app.locals.tokens.accessTokenFor(id),
			forget: (id) => app.locals.tokens && app.locals.tokens.forget(id),
		},
	});
	app.locals.sync = sync;
	// The hourly snapshot of the destination book, when EFLIP_REGION_BOOK=1: it runs while the server
	// is up (`npm run start`); without the flag start() only logs that it is off.
	const regionBookScheduler = createRegionBookScheduler({ sync, env, log, now, ...timers });
	app.locals.regionBookScheduler = regionBookScheduler;
	regionBookScheduler.start();
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

	// The storage budget as the pages' notice reads it; null when it cannot be measured (logged).
	const storageConfig = () => {
		try {
			const status = sync.storageStatus();
			return {budget: status.budget, shares: status.shares, usage: status.usage, total: status.total, measuredAt: status.measuredAt, lastTrimAt: status.lastTrimAt, unmet: status.unmet};
		} catch (e) {
			log.warn(`storage status: ${e.message}`);
			return null;
		}
	};

	// The hourly destination book: the variable (EFLIP_REGION_BOOK=1), whether this server's timer is
	// running, when it next fires and how the last scheduled run since the server started ended.
	const regionBookConfig = () => {
		const schedule = regionBookScheduler.status();
		return {enabled: regionBookEnabled(env), scheduled: schedule.scheduled, nextRunAt: schedule.nextRunAt, lastRun: schedule.lastRun};
	};

	router.get('/api/config', (req, res) => res.json({
		configured,
		callbackUrl,
		scopes: SCOPES,
		env: {dataDir, dataDirFromEnv: Boolean(env.EFLIP_DATA_DIR), userAgentFromEnv: Boolean(env.ESI_USER_AGENT), dataDirError: probeDataDir(dataDir)},
		// whether the hourly sync also takes the destination region's whole order book (EFLIP_REGION_BOOK=1)
		regionBook: regionBookConfig(),
		// the storage budget (EFLIP_STORAGE_BUDGET, EFLIP_STORAGE_SHARES) and the bytes it covers now
		storage: storageConfig(),
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
		const queryState = typeof req.query.state === 'string' ? req.query.state : '';
		const cookieState = parseCookies(req.headers.cookie)[STATE_COOKIE] || '';
		const matched = queryState !== '' && queryState === cookieState;
		// Cleared only by the callback it belongs to: with two sign-ins open in two tabs, the older
		// tab's callback must not clear the cookie the newer one still needs.
		if (matched) res.setHeader('Set-Cookie', CLEAR_STATE_COOKIE);
		const login = matched ? takeLogin(queryState) : null;

		if (req.query.error !== undefined) {
			return res.redirect(302, withParam(login ? login.returnTo : DEFAULT_RETURN, 'ssoError', errorCode(req.query.error)));
		}
		if (!login) {
			log.warn('sso callback: state missing, mismatched or expired');
			return res.redirect(302, withParam(DEFAULT_RETURN, 'ssoError', 'state'));
		}
		// `cause` is an Error or a message: an SsoError/TokenError/fs message holds no token by
		// construction. The page gets the stage and a short reason token, the log gets the message.
		const fail = (code, cause) => {
			const reason = reasonCode(cause);
			const message = typeof cause === 'string' ? cause : String(cause && cause.message !== undefined ? cause.message : cause);
			log.warn(`sso callback: ${code} failed${reason === 'error' ? '' : ` (${reason})`}: ${message}`);
			res.redirect(302, withParam(withParam(login.returnTo, 'ssoError', code), 'ssoReason', reason));
		};

		let tokenResponse;
		try {
			tokenResponse = await sso.exchangeCode(typeof req.query.code === 'string' ? req.query.code : '');
		} catch (e) {
			return fail('exchange', e);
		}
		if (typeof tokenResponse.refresh_token !== 'string' || tokenResponse.refresh_token === '') {
			return fail('exchange', 'no refresh token in the answer');
		}
		let claims;
		try {
			claims = await sso.verifyJwt(tokenResponse.access_token);
		} catch (e) {
			return fail('jwt', e);
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
			return fail('store', e);
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
		let unlinked = false;
		const unlink = () => {
			store.remove(id);
			tokens.forget(id);
			unlinked = true;
		};
		let purgeFailed = false;
		if (purge) {
			// Ledger, raw and ESI bookkeeping go together: a ledger deleted alone would be rebuilt from
			// raw by the next sync. The character is unlinked under its lock before anything is deleted,
			// so a watch tick or a sync during the revoke below finds it gone rather than writing for it
			// again. Refused, before anything else changes, while this character syncs.
			try {
				sync.purgeCharacter(id, { unlink });
			} catch (e) {
				if (e.code === 'busy') {
					log.warn(`characters: purge of ${id} refused: ${e.message}`);
					return res.status(409).json({error: 'a sync of this character is running; try again shortly'});
				}
				log.warn(`characters: purge of ${id} failed: ${e.message}`);
				// Unlinked before the failure: its grant is still revoked below.
				if (!unlinked) return res.status(500).json({error: 'purge failed'});
				purgeFailed = true;
			}
		}
		try {
			await sso.revoke(record.refreshToken);
		} catch (e) {
			log.warn(`sso: revoke for ${id} failed (${e.message}); the character is removed anyway`);
		}
		if (purgeFailed) return res.status(500).json({error: 'purge failed'});
		if (!purge) {
			try {
				unlink();
			} catch (e) {
				log.warn(`characters: removing ${id} failed: ${e.message}`);
				return res.status(500).json({error: 'remove failed'});
			}
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
		if (characterIds === undefined || regionIds === undefined || !flag(body.force) || !flag(body.market) || !flag(body.regionBook) || !flag(body.storage)) {
			return res.status(400).json({error: 'bad request'});
		}
		try {
			if (characterIds !== null && characterIds.some(id => !store.get(id))) {
				return res.status(404).json({error: 'unknown character'});
			}
			// regionBook: true runs the destination region's book now, false skips it even when the
			// environment enables it, absent follows EFLIP_REGION_BOOK; storage: true runs the storage
			// budget's step at the end (it measures only, without a budget)
			const result = await sync.syncAll({characterIds, force: body.force === true, market: body.market !== false, regionIds, regionBook: body.regionBook, storage: body.storage === true});
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

	// Observed figures of up to MARKET_MAX_TYPE_IDS types at one station: body {regionId, stationId,
	// windowDays (1-60), now? (ISO; the server's clock when absent), types: [{typeId, ordersPerDay}]}.
	// Answers {regionId, stationId, windowDays, now, types: {<typeId>: computeMarketStats's answer or null}}.
	// A type answers null when it has no book log, when its entry is not {typeId: a positive integer,
	// ordersPerDay: a number >= 0} (an entry whose typeId is not an integer has no key to answer under, so
	// it is left out), or when reading or computing it fails (one warning a request). A type named twice
	// is answered once, from its first entry. The batch never fails for one type.
	const isPositiveInt = (value) => Number.isSafeInteger(value) && value > 0;
	router.post('/api/market-stats', requireConfigured, express.json({limit: '1mb'}), (req, res) => {
		const body = req.body;
		if (body === null || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({error: 'bad request'});
		const {regionId, stationId, windowDays, types} = body;
		const nowIso = body.now === undefined ? new Date(now()).toISOString() : body.now;
		const nowMs = typeof nowIso === 'string' ? Date.parse(nowIso) : NaN;
		if (!isPositiveInt(regionId) || !isPositiveInt(stationId)
			|| typeof windowDays !== 'number' || !(windowDays >= 1 && windowDays <= 60)
			|| !Number.isFinite(nowMs)
			|| !Array.isArray(types) || types.length < 1 || types.length > MARKET_MAX_TYPE_IDS
			|| types.some(entry => entry === null || typeof entry !== 'object' || Array.isArray(entry))) {
			return res.status(400).json({error: 'bad request'});
		}
		const answers = {};
		let warned = false;
		for (const {typeId, ordersPerDay} of types) {
			if (!isPositiveInt(typeId) || Object.hasOwn(answers, typeId)) continue;
			answers[typeId] = null;
			if (typeof ordersPerDay !== 'number' || !Number.isFinite(ordersPerDay) || ordersPerDay < 0) continue;
			try {
				if (!sync.ledger.hasBookLog(regionId, typeId)) continue;
				answers[typeId] = computeMarketStats({
					log: sync.ledger.readBookLog(regionId, typeId),
					stationId,
					now: new Date(nowMs).toISOString(),
					windowDays,
					ordersPerDay,
				});
			} catch (e) {
				if (!warned) log.warn(`market stats: type ${typeId} in region ${regionId} failed: ${e.message}`);
				warned = true;
			}
		}
		res.json({regionId, stationId, windowDays, now: new Date(nowMs).toISOString(), types: answers});
	}, (err, req, res, next) => res.status(err.status === 413 ? 413 : 400).json({error: 'bad request'}));

	// What the linked characters (every one in the token store, as the results page pools them) sold of up to
	// MARKET_MAX_TYPE_IDS types at one station: body {stationId, typeIds, days (1-365, default 90),
	// sourceStationId? (the route's start: with it the courier haul is in the margin)}. Answers
	// {stationId, days, types: {<typeId>: {units, sales, lastSoldAt, netMarginMilPerUnit, medianDaysOnMarket}}} for
	// the types with a sale in the last `days` days up to the server's clock (the two figures after lastSoldAt are
	// null when the results accounting has no matched sale or could not run). Working a ledger out takes a moment,
	// so the answer for every type of one (station, source, days) is kept for SOLD_BEFORE_TTL_MS and the batches of
	// a run share it.
	const SOLD_BEFORE_TTL_MS = 60 * 1000;
	const SOLD_BEFORE_MAX_CACHED = 8;
	const soldBeforeCache = new Map(); // 'stationId:sourceStationId:days' -> {at, byType}
	router.post('/api/sold-before', requireConfigured, express.json({limit: '256kb'}), (req, res) => {
		const body = req.body;
		if (body === null || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({error: 'bad request'});
		const {stationId, typeIds} = body;
		const days = body.days === undefined ? 90 : body.days;
		const sourceStationId = body.sourceStationId === undefined || body.sourceStationId === null ? null : body.sourceStationId;
		if (!isPositiveInt(stationId)
			|| !Array.isArray(typeIds) || typeIds.length < 1 || typeIds.length > MARKET_MAX_TYPE_IDS || !typeIds.every(isPositiveInt)
			|| !Number.isInteger(days) || days < 1 || days > 365
			|| (sourceStationId !== null && !isPositiveInt(sourceStationId))) {
			return res.status(400).json({error: 'bad request'});
		}
		try {
			const nowMs = now();
			const key = `${stationId}:${sourceStationId}:${days}`;
			let cached = soldBeforeCache.get(key);
			if (!cached || nowMs - cached.at >= SOLD_BEFORE_TTL_MS || nowMs < cached.at) {
				const inputs = soldBefore.readInputs({ledger: sync.ledger, runs, characterIds: requestedCharacters(null), sinceMs: nowMs - days * 24 * 60 * 60 * 1000});
				cached = {at: nowMs, byType: soldBefore.soldBeforeByType({...inputs, stationId, sourceStationId, days, nowMs, log})};
				soldBeforeCache.delete(key);
				soldBeforeCache.set(key, cached);
				while (soldBeforeCache.size > SOLD_BEFORE_MAX_CACHED) soldBeforeCache.delete(soldBeforeCache.keys().next().value);
			}
			const types = {};
			for (const typeId of typeIds) {
				if (Object.hasOwn(cached.byType, typeId)) types[typeId] = cached.byType[typeId];
			}
			res.json({stationId, days, types});
		} catch (e) {
			log.warn(`sold before: ${e.message}`);
			res.status(500).json({error: 'sold before unreadable'});
		}
	}, (err, req, res, next) => res.status(err.status === 413 ? 413 : 400).json({error: 'bad request'}));

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

module.exports = { mountApi, SCOPES, safeReturnPath, probeDataDir };
