// sso.js: EVE SSO as a confidential client (authorization code flow with the client secret).
//
// Covers the metadata and JWKS caches, the authorize URL, the code exchange, refresh, revoke and
// verification of the access-token JWT, using nothing beyond Node's fetch and crypto.
// No token ever appears in an error message: errors carry the HTTP status and the OAuth `error`
// code, and `errorDescription` has every value sent in the request blanked out.
const crypto = require('crypto');

const METADATA_URL = 'https://login.eveonline.com/.well-known/oauth-authorization-server';
// Used when the metadata cannot be fetched (values checked 2026-11-13).
const FALLBACK_METADATA = Object.freeze({
	issuer: 'https://login.eveonline.com',
	authorization_endpoint: 'https://login.eveonline.com/v2/oauth/authorize',
	token_endpoint: 'https://login.eveonline.com/v2/oauth/token',
	revocation_endpoint: 'https://login.eveonline.com/v2/oauth/revoke',
	jwks_uri: 'https://login.eveonline.com/oauth/jwks',
});
const ENDPOINT_KEYS = ['authorization_endpoint', 'token_endpoint', 'revocation_endpoint', 'jwks_uri'];
const JWKS_TTL_MS = 5 * 60 * 1000;
const EXP_SKEW_S = 30;
const REQUEST_TIMEOUT_MS = 15000;
// CCP added the scheme to `iss` on 1 Nov 2023 and still says to accept both forms.
const ISSUERS = new Set(['https://login.eveonline.com', 'login.eveonline.com']);
const EVE_AUDIENCE = 'EVE Online';
const SUB_PATTERN = /^CHARACTER:EVE:(\d+)$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const OAUTH_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
// The only accepted algorithms, each bound to the key type it must be verified with, so a token
// cannot pick `none`, an HMAC, or a key of another type.
const ALGS = {
	RS256: { kty: 'RSA' },
	ES256: { kty: 'EC', crv: 'P-256', dsaEncoding: 'ieee-p1363' },
};

class SsoError extends Error {
	constructor(message, details = {}) {
		super(message);
		this.name = 'SsoError';
		Object.assign(this, details);
	}
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const decodeJsonPart = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

// `text` with every non-empty value of `secrets` replaced, cut to `max` characters.
const redact = (text, secrets, max = 200) => {
	let out = String(text);
	for (const secret of secrets) {
		if (typeof secret === 'string' && secret !== '') out = out.split(secret).join('[redacted]');
	}
	return out.slice(0, max);
};

const createSso = ({
	clientId,
	clientSecret,
	callbackUrl,
	userAgent,
	fetch = globalThis.fetch,
	now = () => Date.now(),
	metadataUrl = METADATA_URL,
}) => {
	const basicAuth = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
	const baseHeaders = { Accept: 'application/json', 'User-Agent': userAgent };

	// Metadata: fetched once and kept for the life of the process; on any failure the checked
	// fallback values are used instead (and kept, since they are what CCP publishes).
	let metadataPromise = null;
	const loadMetadata = async () => {
		try {
			const res = await fetch(metadataUrl, { headers: baseHeaders, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
			if (!res.ok) throw new Error(`metadata answered ${res.status}`);
			const json = await res.json();
			const merged = { ...FALLBACK_METADATA };
			for (const key of ENDPOINT_KEYS) {
				if (isPlainObject(json) && typeof json[key] === 'string' && json[key].startsWith('https://')) merged[key] = json[key];
			}
			return merged;
		} catch (e) {
			return { ...FALLBACK_METADATA };
		}
	};
	const getMetadata = () => {
		if (!metadataPromise) metadataPromise = loadMetadata();
		return metadataPromise;
	};

	// JWKS: cached for 5 min; concurrent callers share one fetch.
	let jwksCache = null; // { jwks, fetchedAt }
	let jwksInflight = null;
	const fetchJwks = async () => {
		const { jwks_uri } = await getMetadata();
		const res = await fetch(jwks_uri, { headers: baseHeaders, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		if (!res.ok) throw new SsoError(`jwks answered ${res.status}`, { status: res.status });
		let jwks = null;
		try {
			jwks = await res.json();
		} catch (e) {
			// falls through to the shape check
		}
		if (!isPlainObject(jwks) || !Array.isArray(jwks.keys)) throw new SsoError('jwks: unexpected response');
		jwksCache = { jwks, fetchedAt: now() };
		return jwks;
	};
	const getJwks = async ({ force = false } = {}) => {
		if (!force && jwksCache && now() - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.jwks;
		if (!jwksInflight) jwksInflight = fetchJwks().finally(() => { jwksInflight = null; });
		return jwksInflight;
	};
	// The JWK for `kid`; an unknown kid refetches the JWKS once (CCP may have rotated keys).
	const findKey = async (kid) => {
		if (typeof kid !== 'string' || kid === '') throw new SsoError('jwt: no kid in header');
		const pick = (jwks) => jwks.keys.find(key => isPlainObject(key) && key.kid === kid);
		let jwk = pick(await getJwks());
		if (!jwk) jwk = pick(await getJwks({ force: true }));
		if (!jwk) throw new SsoError('jwt: unknown kid');
		return jwk;
	};

	const authorizeUrl = async ({ state, scopes }) => {
		const { authorization_endpoint } = await getMetadata();
		const params = new URLSearchParams({
			response_type: 'code',
			redirect_uri: callbackUrl,
			client_id: clientId,
			scope: scopes.join(' '),
			state,
		});
		return `${authorization_endpoint}?${params}`;
	};

	// POSTs a form to a token or revocation endpoint, authenticated as `client_secret_basic`
	// (`auth: 'basic'`) or `client_secret_post` (`auth: 'post'`).
	const postForm = (url, params, auth) => {
		const headers = { ...baseHeaders, 'Content-Type': 'application/x-www-form-urlencoded' };
		const body = new URLSearchParams(params);
		if (auth === 'basic') {
			headers.Authorization = basicAuth;
		} else {
			body.set('client_id', clientId);
			body.set('client_secret', clientSecret);
		}
		return fetch(url, { method: 'POST', headers, body: body.toString(), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	};

	const readJson = async (res) => {
		const text = await res.text();
		try {
			return JSON.parse(text);
		} catch (e) {
			return null;
		}
	};

	// Basic auth first; when the endpoint rejects it as `invalid_client`, the same request once
	// more with the credentials in the body (the metadata lists both methods). Answers
	// `{res, json}` on 2xx and throws an SsoError otherwise; `secrets` are the request values
	// to keep out of the error.
	const callEndpoint = async (what, url, params, secrets) => {
		let res = await postForm(url, params, 'basic');
		let json = await readJson(res);
		if (res.status === 401 && isPlainObject(json) && json.error === 'invalid_client') {
			res = await postForm(url, params, 'post');
			json = await readJson(res);
		}
		if (!res.ok) {
			const error = isPlainObject(json) && typeof json.error === 'string' && OAUTH_ERROR_CODE.test(json.error) ? json.error : undefined;
			const errorDescription = isPlainObject(json) && typeof json.error_description === 'string'
				? redact(json.error_description, [...secrets, clientSecret])
				: undefined;
			throw new SsoError(`${what} answered ${res.status}${error ? ` ${error}` : ''}`, { status: res.status, error, errorDescription });
		}
		return { res, json };
	};

	const tokenRequest = async (params, secret) => {
		const { token_endpoint } = await getMetadata();
		const { res, json } = await callEndpoint('token endpoint', token_endpoint, params, [secret]);
		if (!isPlainObject(json) || typeof json.access_token !== 'string' || json.access_token === '') {
			throw new SsoError('token endpoint answered without an access token', { status: res.status });
		}
		return json;
	};

	const exchangeCode = async (code) => {
		if (typeof code !== 'string' || code === '') throw new SsoError('no authorization code');
		return tokenRequest({ grant_type: 'authorization_code', code }, code);
	};

	const refresh = async (refreshToken) => {
		if (typeof refreshToken !== 'string' || refreshToken === '') throw new SsoError('no refresh token');
		return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }, refreshToken);
	};

	// CCP answers 200 even for a token it does not know, so any 2xx is success.
	const revoke = async (refreshToken) => {
		if (typeof refreshToken !== 'string' || refreshToken === '') throw new SsoError('no refresh token');
		const { revocation_endpoint } = await getMetadata();
		await callEndpoint('revocation endpoint', revocation_endpoint, { token: refreshToken, token_type_hint: 'refresh_token' }, [refreshToken]);
	};

	// Verifies an access-token JWT (signature against CCP's JWKS, then iss, aud, exp and sub) and
	// answers the character it is for. Throws an SsoError naming the first check that failed.
	const verifyJwt = async (token) => {
		const parts = typeof token === 'string' ? token.split('.') : [];
		if (parts.length !== 3 || !B64URL.test(parts[0])) throw new SsoError('jwt: malformed');
		let header;
		try {
			header = decodeJsonPart(parts[0]);
		} catch (e) {
			throw new SsoError('jwt: malformed header');
		}
		if (!isPlainObject(header)) throw new SsoError('jwt: malformed header');
		const spec = typeof header.alg === 'string' && Object.hasOwn(ALGS, header.alg) ? ALGS[header.alg] : null;
		if (!spec) throw new SsoError(`jwt: alg ${JSON.stringify(String(header.alg)).slice(0, 20)} is not accepted`);
		if (!B64URL.test(parts[1]) || !B64URL.test(parts[2])) throw new SsoError('jwt: malformed');

		const jwk = await findKey(header.kid);
		const keyMatches = jwk.kty === spec.kty
			&& (spec.crv === undefined || jwk.crv === spec.crv)
			&& (jwk.alg === undefined || jwk.alg === header.alg)
			&& (jwk.use === undefined || jwk.use === 'sig');
		if (!keyMatches) throw new SsoError(`jwt: alg ${header.alg} does not match the key for its kid`);

		let signatureOk = false;
		try {
			const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
			const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
			const signature = Buffer.from(parts[2], 'base64url');
			signatureOk = crypto.verify('sha256', signingInput, spec.dsaEncoding ? { key, dsaEncoding: spec.dsaEncoding } : key, signature);
		} catch (e) {
			signatureOk = false;
		}
		if (!signatureOk) throw new SsoError('jwt: bad signature');

		let claims;
		try {
			claims = decodeJsonPart(parts[1]);
		} catch (e) {
			throw new SsoError('jwt: malformed payload');
		}
		if (!isPlainObject(claims)) throw new SsoError('jwt: malformed payload');

		if (!ISSUERS.has(claims.iss)) throw new SsoError('jwt: bad iss');
		// CCP sends an array holding the client id and "EVE Online"; a lone string audience can
		// only be the client id.
		const audienceOk = Array.isArray(claims.aud)
			? claims.aud.includes(clientId) && claims.aud.includes(EVE_AUDIENCE)
			: claims.aud === clientId;
		if (!audienceOk) throw new SsoError('jwt: bad aud');
		if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) throw new SsoError('jwt: bad exp');
		if (!(claims.exp > now() / 1000 - EXP_SKEW_S)) throw new SsoError('jwt: expired');
		const sub = typeof claims.sub === 'string' ? SUB_PATTERN.exec(claims.sub) : null;
		const characterId = sub ? Number(sub[1]) : NaN;
		if (!Number.isSafeInteger(characterId) || characterId <= 0) throw new SsoError('jwt: bad sub');
		if (typeof claims.name !== 'string' || claims.name === '') throw new SsoError('jwt: no name');
		if (typeof claims.owner !== 'string' || claims.owner === '') throw new SsoError('jwt: no owner');
		// One granted scope can arrive as a plain string.
		const scopes = claims.scp === undefined ? [] : Array.isArray(claims.scp) ? claims.scp : [claims.scp];
		if (!scopes.every(scope => typeof scope === 'string')) throw new SsoError('jwt: bad scp');

		return { characterId, name: claims.name, owner: claims.owner, scopes, exp: claims.exp };
	};

	return { getMetadata, authorizeUrl, exchangeCode, refresh, revoke, verifyJwt };
};

module.exports = { createSso, SsoError, METADATA_URL };
