// esi.js: the server's ESI client. Every ESI call the server makes goes through `get`.
//
// What it guarantees:
//   - Raw first: every 200 is stored verbatim under data/raw/<owner>/<route-slug>/ (see
//     dataFiles.js), unless its body hashes the same as the newest stored body of that route.
//     A 304 stores nothing.
//   - Expires is honoured: a route is not called again before its `Expires`. After it, the call
//     sends `If-None-Match` with the stored ETag, so an unchanged answer costs 1 token, not 2.
//     That bookkeeping (etag, expires, X-Pages, last check) lives in data/esi-cache/<owner>/<slug>.json;
//     it is keyed by path and query, never by token.
//   - Rate limits are respected, not probed: per-character groups (X-Ratelimit-*) pause once
//     under 20 % of their bucket remains, the legacy error limit (X-Esi-Error-Limit-*) stops all
//     calls under 20, and a 420 or 429 pauses until Retry-After. That state persists in
//     data/esi-cache/_limits.json (flushLimits) so a later process starts from it.
//   - A 401 never retries: the cached access token is dropped, so the next call refreshes it, and
//     a refresh the SSO server refuses marks the character `relink` (tokens.js).
//   - A 403 on a route flagged `rememberForbidden`, or a 404 (or a 400, which ESI also answers for a
//     type with no market) on one flagged `rememberNotFound`, is recorded in its state, so it is
//     asked once and not on every sync.
//
// `get` never throws for an HTTP or network failure; it answers an object whose `outcome` says
// what happened: ok, not-modified, not-due, paused, rate-limited, auth, forbidden, not-found or
// error. An access token is only ever sent as a request header; it appears in no stored file, log
// line or message here.
const path = require('path');
const { createRawStore, writeFileAtomic, readJsonFile, hashJson } = require('./dataFiles');
const { TokenError } = require('./tokens');

const BASE_URL = 'https://esi.evetech.net';
const DEFAULT_USER_AGENT = 'eflip (local)';
const DEFAULT_COMPAT_DATE = '2026-08-18';
const REQUEST_TIMEOUT_MS = 20000;
const ERROR_LIMIT_FLOOR = 20;
const GROUP_PAUSE_FRACTION = 0.2;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_RETRY_MS = 60 * 1000;
const FORBIDDEN_RETRY_MS = 30 * 24 * 60 * 60 * 1000;
const MESSAGE_MAX = 200;
const UNITS = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000 };

// The rate-limit group each route draws from; a route not listed has only the legacy error limit
// (orders, orders/history, markets history, universe/structures). Names as observed 2026-11-19.
const GROUPS = [
	[/^\/characters\/\d+\/wallet(?:\/|$)/, 'char-wallet'],
	[/^\/characters\/\d+\/contracts(?:\/|$)/, 'char-contract'],
	[/^\/characters\/\d+\/assets$/, 'char-asset'],
	[/^\/characters\/\d+\/skills$/, 'char-detail'],
	[/^\/characters\/\d+\/standings$/, 'char-social'],
	[/^\/markets\/\d+\/orders$/, 'market-order'],
];
const groupFor = (apiPath) => {
	for (const [pattern, group] of GROUPS) {
		if (pattern.test(apiPath)) return group;
	}
	return null;
};

const clean = (text) => String(text).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// The route slug that names a raw directory: the path without its `/characters/<id>` prefix,
// joined with dashes, then the query as key-value pairs in key order (page 1 is the default and
// is left out). `/characters/1/wallet/journal?page=2` -> `wallet-journal-page-2`.
const slugFor = (apiPath, query = {}) => {
	const segments = String(apiPath).split('/').filter(Boolean);
	if (segments[0] === 'characters') segments.splice(0, 2);
	const parts = segments.map(clean);
	for (const key of Object.keys(query).sort()) {
		const value = query[key];
		if (value === undefined || value === null) continue;
		if (key === 'page' && Number(value) === 1) continue;
		parts.push(clean(key), clean(value));
	}
	const slug = parts.filter(part => part !== '').join('-');
	if (slug === '') throw new Error('esi: empty route slug');
	return slug;
};

const urlFor = (apiPath, query = {}) => {
	const params = [];
	for (const key of Object.keys(query).sort()) {
		const value = query[key];
		if (value === undefined || value === null) continue;
		if (key === 'page' && Number(value) === 1) continue;
		params.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
	}
	return `${BASE_URL}${apiPath}${params.length === 0 ? '' : `?${params.join('&')}`}`;
};

const ownerKey = (owner) => (owner === 'public' ? 'public' : String(Number(owner)));

const shorten = (text) => String(text).replace(/\s+/g, ' ').slice(0, MESSAGE_MAX);

// `150/15m` -> {limit: 150, windowMs: 900000}; null parts when the header is missing or odd.
const parseRateLimit = (text) => {
	const m = /^(\d+)\/(\d+)([smh])$/.exec(typeof text === 'string' ? text.trim() : '');
	return m ? { limit: Number(m[1]), windowMs: Number(m[2]) * UNITS[m[3]] } : { limit: null, windowMs: DEFAULT_WINDOW_MS };
};

const numberOf = (value) => {
	if (value === undefined || value === null || value === '') return NaN;
	return Number(value);
};

// When the response says it may be reused until, in ms; `fallback` (now) when it says nothing.
const expiresOf = (headers, fallback) => {
	const stamp = Date.parse(headers.expires);
	if (Number.isFinite(stamp)) return stamp;
	const maxAge = /max-age=(\d+)/.exec(headers['cache-control'] || '');
	return maxAge ? fallback + Number(maxAge[1]) * 1000 : fallback;
};

const emptyLimits = () => ({ errorLimit: { remain: null, resetAt: 0, pausedUntil: 0 }, groups: {} });

const createEsiClient = ({
	dataDir,
	fetch = globalThis.fetch,
	now = () => Date.now(),
	tokens = null,
	userAgent = DEFAULT_USER_AGENT,
	compatDate = DEFAULT_COMPAT_DATE,
	timeoutMs = REQUEST_TIMEOUT_MS,
}) => {
	const dir = path.resolve(dataDir);
	const raw = createRawStore({ dataDir: dir });
	const cacheRoot = path.join(dir, 'esi-cache');
	const limitsFile = path.join(cacheRoot, '_limits.json');

	// ---- per-route bookkeeping

	const stateFile = (owner, slug) => path.join(cacheRoot, ownerKey(owner), `${slug}.json`);
	const loadState = (owner, slug) => {
		try {
			return readJsonFile(stateFile(owner, slug));
		} catch (e) {
			return null; // unreadable bookkeeping only costs one unconditional call
		}
	};
	const saveState = (owner, slug, state) => {
		writeFileAtomic(stateFile(owner, slug), JSON.stringify(state, null, '\t') + '\n');
	};

	// ---- rate-limit state

	let limits = emptyLimits();
	// Folds the stored limits (another process may have written them) into what this process
	// already knows, keeping the newer observation of each group and the longer pause.
	const loadLimits = () => {
		let stored = null;
		try {
			stored = readJsonFile(limitsFile);
		} catch (e) {
			stored = null;
		}
		if (!stored || typeof stored !== 'object') return;
		const error = stored.errorLimit;
		if (error && typeof error === 'object' && Number(error.resetAt) > limits.errorLimit.resetAt) limits.errorLimit = { ...limits.errorLimit, ...error };
		if (stored.groups && typeof stored.groups === 'object') {
			for (const [key, entry] of Object.entries(stored.groups)) {
				const mine = limits.groups[key];
				if (!mine || Number(entry.observedAt) > mine.observedAt) limits.groups[key] = { ...entry, pausedUntil: Math.max(Number(entry.pausedUntil) || 0, mine ? mine.pausedUntil : 0) };
			}
		}
	};
	const flushLimits = () => {
		const t = now();
		const groups = {};
		for (const [key, entry] of Object.entries(limits.groups)) {
			// A group not seen for an hour holds nothing worth keeping.
			if (entry.pausedUntil > t || t - entry.observedAt < 60 * 60 * 1000) groups[key] = entry;
		}
		limits.groups = groups;
		writeFileAtomic(limitsFile, JSON.stringify(limits, null, '\t') + '\n');
	};

	// Folds the rate-limit headers of an answer into `limits`; answers the figures worth showing.
	const noteLimits = (key, group, headers, t) => {
		const rate = {};
		const remain = numberOf(headers['x-esi-error-limit-remain']);
		if (Number.isFinite(remain)) {
			const reset = numberOf(headers['x-esi-error-limit-reset']);
			const resetAt = t + (Number.isFinite(reset) ? reset * 1000 : DEFAULT_RETRY_MS);
			limits.errorLimit = { remain, resetAt, pausedUntil: remain < ERROR_LIMIT_FLOOR ? resetAt : 0 };
			rate.errorLimitRemain = remain;
		}
		const groupName = headers['x-ratelimit-group'] || null;
		const remaining = numberOf(headers['x-ratelimit-remaining']);
		if (groupName !== null && Number.isFinite(remaining)) {
			const { limit, windowMs } = parseRateLimit(headers['x-ratelimit-limit']);
			const low = limit !== null && remaining < limit * GROUP_PAUSE_FRACTION;
			limits.groups[`${key}|${groupName}`] = { group: groupName, limit, windowMs, remaining, observedAt: t, pausedUntil: low ? t + windowMs : 0 };
			Object.assign(rate, { group: groupName, limit, remaining });
		} else if (group !== null) {
			rate.group = group;
		}
		return rate;
	};

	// Why a call to `group` must wait, or null.
	const pausedFor = (key, group) => {
		const t = now();
		if (limits.errorLimit.pausedUntil > t) return { reason: 'error-limit', until: limits.errorLimit.pausedUntil };
		if (group !== null) {
			const entry = limits.groups[`${key}|${group}`];
			if (entry && entry.pausedUntil > t) return { reason: 'group', group, until: entry.pausedUntil };
		}
		return null;
	};

	// ---- one call

	// File names must be unique and rise within a route even when the clock does not move (a
	// test clock, or two answers in one millisecond); derive.js replays raw in this order.
	let lastStamp = 0;
	const stampNow = () => {
		let t = now();
		if (t <= lastStamp) t = lastStamp + 1;
		lastStamp = t;
		return new Date(t).toISOString();
	};

	// request: {owner (character id or 'public'), path, query?, rememberForbidden?, rememberNotFound?}
	const get = async (request) => {
		const { owner, path: apiPath, query = {}, rememberForbidden = false, rememberNotFound = false } = request;
		const key = ownerKey(owner);
		const slug = slugFor(apiPath, query);
		const url = urlFor(apiPath, query);
		const group = groupFor(apiPath);
		const base = { slug, url };
		const state = loadState(key, slug);
		let t = now();

		if (state) {
			if (state.forbiddenUntil && Date.parse(state.forbiddenUntil) > t) return { ...base, outcome: 'forbidden', status: 403, cached: true };
			if (state.notFound) return { ...base, outcome: 'not-found', status: 404, cached: true };
			if (state.expires && Date.parse(state.expires) > t) {
				return { ...base, outcome: 'not-due', pages: state.pages || 1, expires: state.expires };
			}
		}
		const pause = pausedFor(key, group);
		if (pause) return { ...base, outcome: 'paused', ...pause };

		const headers = {
			Accept: 'application/json',
			'User-Agent': userAgent,
			'X-Compatibility-Date': compatDate,
		};
		if (key !== 'public') {
			try {
				headers.Authorization = `Bearer ${await tokens.accessTokenFor(Number(key))}`;
			} catch (e) {
				if (e instanceof TokenError) return { ...base, outcome: 'auth', code: e.code, message: shorten(e.message) };
				return { ...base, outcome: 'error', kind: 'token', message: shorten(e.message) };
			}
		}
		if (state && state.etag) headers['If-None-Match'] = state.etag;

		let res;
		let text;
		try {
			res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
			text = await res.text();
		} catch (e) {
			const reason = e && e.cause && e.cause.code ? e.cause.code : (e && e.name) || 'error';
			return { ...base, outcome: 'error', kind: 'network', message: shorten(`request failed (${reason})`) };
		}
		t = now();
		const responseHeaders = Object.fromEntries(res.headers.entries());
		const rate = noteLimits(key, group, responseHeaders, t);
		const status = res.status;
		const pagesHeader = numberOf(responseHeaders['x-pages']);
		const pages = Number.isFinite(pagesHeader) && pagesHeader >= 1 ? Math.floor(pagesHeader) : (state && state.pages) || 1;

		if (status === 200) {
			let body;
			try {
				body = JSON.parse(text);
			} catch (e) {
				return { ...base, outcome: 'error', kind: 'parse', status, message: 'the answer was not JSON', rate };
			}
			const fetchedAt = stampNow();
			const last = raw.latest(key, slug);
			const stored = !(last && hashJson(last.body) === hashJson(body));
			if (stored) raw.write(key, slug, { fetchedAt, url, status, headers: responseHeaders, body });
			saveState(key, slug, {
				url,
				etag: responseHeaders.etag || null,
				expires: new Date(expiresOf(responseHeaders, t)).toISOString(),
				pages,
				checkedAt: fetchedAt,
				status,
			});
			return { ...base, outcome: 'ok', status, body, headers: responseHeaders, pages, fetchedAt, stored, rate };
		}

		if (status === 304) {
			saveState(key, slug, {
				...(state || { url }),
				etag: responseHeaders.etag || (state && state.etag) || null,
				expires: new Date(expiresOf(responseHeaders, t)).toISOString(),
				pages,
				checkedAt: new Date(t).toISOString(),
				status,
			});
			return { ...base, outcome: 'not-modified', status, pages, rate };
		}

		let message = '';
		try {
			const json = JSON.parse(text);
			if (json && typeof json.error === 'string') message = json.error;
		} catch (e) {
			// not JSON: no message
		}
		message = shorten(message);

		if (status === 420 || status === 429) {
			const retry = numberOf(responseHeaders['retry-after']);
			const reset = numberOf(responseHeaders['x-esi-error-limit-reset']);
			const waitMs = Number.isFinite(retry) ? retry * 1000 : Number.isFinite(reset) ? reset * 1000 : (group !== null ? DEFAULT_WINDOW_MS : DEFAULT_RETRY_MS);
			const until = t + waitMs;
			if (group !== null && status === 429) {
				const groupKey = `${key}|${responseHeaders['x-ratelimit-group'] || group}`;
				limits.groups[groupKey] = { ...(limits.groups[groupKey] || { group, limit: null, windowMs: DEFAULT_WINDOW_MS, remaining: 0, observedAt: t }), pausedUntil: until };
			} else {
				limits.errorLimit = { ...limits.errorLimit, resetAt: until, pausedUntil: until };
			}
			return { ...base, outcome: 'rate-limited', status, retryAfter: Math.ceil(waitMs / 1000), until, message, rate };
		}
		if (status === 401) {
			// The cached access token is bad (revoked, or expired early): drop it so the next call
			// refreshes, and let the token manager's relink path decide. Never retried here.
			if (key !== 'public' && tokens && typeof tokens.forget === 'function') tokens.forget(Number(key));
			return { ...base, outcome: 'auth', status, code: 'unauthorized', message: message || 'unauthorized', rate };
		}
		if (status === 403) {
			if (rememberForbidden) saveState(key, slug, { ...(state || { url }), forbiddenUntil: new Date(t + FORBIDDEN_RETRY_MS).toISOString(), checkedAt: new Date(t).toISOString(), status });
			return { ...base, outcome: 'forbidden', status, message, rate };
		}
		if (status === 404 || (status === 400 && rememberNotFound)) {
			// Market history answers 404 "Type not found" or 400 "Type not tradable on market" for a type
			// with no market; on a flagged route both mean the same lasting thing.
			if (rememberNotFound) saveState(key, slug, { ...(state || { url }), notFound: true, checkedAt: new Date(t).toISOString(), status });
			return { ...base, outcome: 'not-found', status, message, rate };
		}
		return { ...base, outcome: 'error', kind: status >= 500 ? 'server' : 'client', status, message, rate };
	};

	// What `get` would answer without any network call (not-due, a remembered 403/404, or a
	// pause), or null when a call would go out. Lets a caller plan work without spending any.
	const peek = ({ owner, path: apiPath, query = {} }) => {
		const key = ownerKey(owner);
		const slug = slugFor(apiPath, query);
		const state = loadState(key, slug);
		const t = now();
		if (state) {
			if (state.forbiddenUntil && Date.parse(state.forbiddenUntil) > t) return { slug, outcome: 'forbidden', cached: true };
			if (state.notFound) return { slug, outcome: 'not-found', cached: true };
			if (state.expires && Date.parse(state.expires) > t) return { slug, outcome: 'not-due', pages: state.pages || 1, expires: state.expires };
		}
		const pause = pausedFor(key, groupFor(apiPath));
		return pause ? { slug, outcome: 'paused', ...pause } : null;
	};

	// The bookkeeping of a route, as stored (checkedAt, expires, pages), or null.
	const stateOf = (owner, apiPath, query = {}) => loadState(ownerKey(owner), slugFor(apiPath, query));

	return { raw, get, peek, stateOf, loadLimits, flushLimits, limitsSnapshot: () => JSON.parse(JSON.stringify(limits)) };
};

module.exports = {
	createEsiClient,
	slugFor,
	urlFor,
	groupFor,
	parseRateLimit,
	BASE_URL,
	DEFAULT_USER_AGENT,
	DEFAULT_COMPAT_DATE,
	ERROR_LIMIT_FLOOR,
};
