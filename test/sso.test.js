const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createSso, SsoError } = require('../lib/sso');
const { createTokenStore } = require('../lib/tokenStore');
const { createTokenManager, TokenError } = require('../lib/tokens');
const { mountApi, SCOPES, safeReturnPath, probeDataDir } = require('../lib/api');

// Nothing here touches the network: every fetch goes to a stub that serves CCP's URLs.

const CLIENT_ID = '0123456789abcdef0123456789abcdef';
const CLIENT_SECRET = 'test-client-secret-xyz';
const CALLBACK_URL = 'http://localhost:5001/sso/callback';
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const NOW_S = NOW / 1000;
const CHARACTER_ID = 90000001;
const OWNER = 'b3duZXItaGFzaC0x';

const METADATA_URL = 'https://login.eveonline.com/.well-known/oauth-authorization-server';
const AUTHORIZE_URL = 'https://login.eveonline.com/v2/oauth/authorize';
const TOKEN_URL = 'https://login.eveonline.com/v2/oauth/token';
const REVOKE_URL = 'https://login.eveonline.com/v2/oauth/revoke';
const JWKS_URL = 'https://login.eveonline.com/oauth/jwks';
const METADATA = {
	issuer: 'https://login.eveonline.com',
	authorization_endpoint: AUTHORIZE_URL,
	token_endpoint: TOKEN_URL,
	revocation_endpoint: REVOKE_URL,
	jwks_uri: JWKS_URL,
	token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'client_secret_jwt'],
	revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'client_secret_jwt'],
};

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const otherRsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const RSA_KID = 'JWT-Signature-Key';
const EC_KID = 'JWT-Signature-Key-EC';
const jwkOf = (publicKey, kid, alg) => ({ ...publicKey.export({ format: 'jwk' }), kid, alg, use: 'sig' });
const JWKS = { keys: [jwkOf(rsa.publicKey, RSA_KID, 'RS256'), jwkOf(ec.publicKey, EC_KID, 'ES256')] };

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

const claimsFor = (overrides = {}) => ({
	scp: ['esi-wallet.read_character_wallet.v1', 'esi-assets.read_assets.v1'],
	jti: 'c0ffee00-0000-4000-8000-000000000000',
	kid: RSA_KID,
	sub: `CHARACTER:EVE:${CHARACTER_ID}`,
	azp: CLIENT_ID,
	tenant: 'tranquility',
	tier: 'live',
	region: 'world',
	aud: [CLIENT_ID, 'EVE Online'],
	name: 'Ivan Tester',
	owner: OWNER,
	exp: NOW_S + 1200,
	iat: NOW_S,
	iss: 'https://login.eveonline.com',
	...overrides,
});

// A compact JWS. `key` overrides the signing key (a private key, or the HMAC secret for HS256).
const signJwt = (claims, { alg = 'RS256', kid = alg === 'ES256' ? EC_KID : RSA_KID, key } = {}) => {
	const header = b64url({ alg, kid, typ: 'JWT' });
	const payload = b64url(claims);
	const input = Buffer.from(`${header}.${payload}`);
	let signature = Buffer.alloc(0);
	if (alg === 'RS256') signature = crypto.sign('sha256', input, key || rsa.privateKey);
	if (alg === 'ES256') signature = crypto.sign('sha256', input, { key: key || ec.privateKey, dsaEncoding: 'ieee-p1363' });
	if (alg === 'HS256') signature = crypto.createHmac('sha256', key).update(input).digest();
	return `${header}.${payload}.${signature.toString('base64url')}`;
};

const jsonResponse = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), {
	status,
	headers: { 'Content-Type': 'application/json' },
});

// A fetch stand-in: `handlers` maps a URL to (call) => Response; every call is recorded.
const fakeFetch = (handlers) => {
	const calls = [];
	const fn = async (url, init = {}) => {
		const call = {
			url: String(url),
			method: init.method || 'GET',
			headers: { ...init.headers },
			body: init.body === undefined ? undefined : String(init.body),
		};
		calls.push(call);
		const handler = handlers[call.url];
		if (!handler) throw new TypeError('fetch failed');
		return handler(call, calls.filter(c => c.url === call.url).length);
	};
	fn.calls = calls;
	fn.callsTo = (url) => calls.filter(c => c.url === url);
	return fn;
};

const ssoHandlers = (extra = {}) => ({
	[METADATA_URL]: () => jsonResponse(200, METADATA),
	[JWKS_URL]: () => jsonResponse(200, JWKS),
	...extra,
});

const makeSso = (extraHandlers = {}, overrides = {}) => {
	const fetch = fakeFetch(ssoHandlers(extraHandlers));
	const sso = createSso({
		clientId: CLIENT_ID,
		clientSecret: CLIENT_SECRET,
		callbackUrl: CALLBACK_URL,
		userAgent: 'eflip-test/1.0',
		fetch,
		now: () => NOW,
		...overrides,
	});
	return { sso, fetch };
};

const tmpDir = (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eflip-sso-test-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
};

const modeOf = (file) => fs.statSync(file).mode & 0o777;

const BASIC = 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

// ---- verifyJwt

test('verifyJwt accepts RS256 and ES256 tokens signed by a JWKS key', async () => {
	const { sso } = makeSso();
	const fromRsa = await sso.verifyJwt(signJwt(claimsFor()));
	assert.deepEqual(fromRsa, {
		characterId: CHARACTER_ID,
		name: 'Ivan Tester',
		owner: OWNER,
		scopes: ['esi-wallet.read_character_wallet.v1', 'esi-assets.read_assets.v1'],
		exp: NOW_S + 1200,
	});
	const fromEc = await sso.verifyJwt(signJwt(claimsFor(), { alg: 'ES256' }));
	assert.equal(fromEc.characterId, CHARACTER_ID);
});

test('verifyJwt accepts both iss forms, aud as array or as the client id alone, and a string scp', async () => {
	const { sso } = makeSso();
	assert.equal((await sso.verifyJwt(signJwt(claimsFor({ iss: 'login.eveonline.com' })))).characterId, CHARACTER_ID);
	assert.equal((await sso.verifyJwt(signJwt(claimsFor({ aud: CLIENT_ID })))).characterId, CHARACTER_ID);
	const single = await sso.verifyJwt(signJwt(claimsFor({ scp: 'esi-wallet.read_character_wallet.v1' })));
	assert.deepEqual(single.scopes, ['esi-wallet.read_character_wallet.v1']);
	const none = await sso.verifyJwt(signJwt(claimsFor({ scp: undefined })));
	assert.deepEqual(none.scopes, []);
});

test('verifyJwt rejects bad signatures, claims and algorithms', async () => {
	const { sso } = makeSso();
	const rejects = (token, pattern) => assert.rejects(sso.verifyJwt(token), (e) => e instanceof SsoError && pattern.test(e.message));

	await rejects(signJwt(claimsFor(), { key: otherRsa.privateKey }), /bad signature/);
	const good = signJwt(claimsFor());
	const [h, , s] = good.split('.');
	await rejects(`${h}.${b64url(claimsFor({ sub: 'CHARACTER:EVE:1' }))}.${s}`, /bad signature/);
	await rejects(signJwt(claimsFor(), { alg: 'ES256', key: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey }), /bad signature/);

	await rejects(signJwt(claimsFor({ iss: 'https://evil.example' })), /bad iss/);
	await rejects(signJwt(claimsFor({ iss: undefined })), /bad iss/);
	await rejects(signJwt(claimsFor({ aud: ['someone-else', 'EVE Online'] })), /bad aud/);
	await rejects(signJwt(claimsFor({ aud: [CLIENT_ID] })), /bad aud/);
	await rejects(signJwt(claimsFor({ aud: 'EVE Online' })), /bad aud/);
	await rejects(signJwt(claimsFor({ aud: `x${CLIENT_ID}x EVE Online` })), /bad aud/);
	await rejects(signJwt(claimsFor({ sub: 'CHARACTER:EVE:abc' })), /bad sub/);
	await rejects(signJwt(claimsFor({ sub: 'CORPORATION:EVE:98000001' })), /bad sub/);
	await rejects(signJwt(claimsFor({ exp: undefined })), /bad exp/);

	await rejects(signJwt(claimsFor(), { alg: 'none' }), /alg "none" is not accepted/);
	await rejects(`${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claimsFor())}.`, /alg "none" is not accepted/);
	const pem = rsa.publicKey.export({ format: 'pem', type: 'spki' });
	await rejects(signJwt(claimsFor(), { alg: 'HS256', key: pem }), /alg "HS256" is not accepted/);
	// An ES256 header naming the RSA key: the alg must match the key type.
	await rejects(signJwt(claimsFor(), { alg: 'ES256', kid: RSA_KID }), /does not match the key/);
	await rejects('not-a-jwt', /malformed/);
	await rejects(undefined, /malformed/);
});

test('verifyJwt allows 30 s of clock skew on exp, no more', async () => {
	const { sso } = makeSso();
	assert.equal((await sso.verifyJwt(signJwt(claimsFor({ exp: NOW_S - 29 })))).characterId, CHARACTER_ID);
	await assert.rejects(sso.verifyJwt(signJwt(claimsFor({ exp: NOW_S - 31 }))), /expired/);
	await assert.rejects(sso.verifyJwt(signJwt(claimsFor({ exp: NOW_S - 30 }))), /expired/);
});

test('an unknown kid refetches the JWKS once, then fails', async () => {
	const { sso, fetch } = makeSso();
	await assert.rejects(sso.verifyJwt(signJwt(claimsFor(), { kid: 'rotated-away' })), (e) => e instanceof SsoError && /unknown kid/.test(e.message));
	assert.equal(fetch.callsTo(JWKS_URL).length, 2);
});

test('an unknown kid that appears after a key rotation is found by the refetch', async () => {
	const rotated = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
	const { sso, fetch } = makeSso({
		[JWKS_URL]: (call, n) => jsonResponse(200, n === 1 ? JWKS : { keys: [...JWKS.keys, jwkOf(rotated.publicKey, 'new-key', 'RS256')] }),
	});
	await sso.verifyJwt(signJwt(claimsFor()));
	const claims = await sso.verifyJwt(signJwt(claimsFor(), { kid: 'new-key', key: rotated.privateKey }));
	assert.equal(claims.characterId, CHARACTER_ID);
	assert.equal(fetch.callsTo(JWKS_URL).length, 2);
});

test('the JWKS is cached for 5 minutes and the metadata for good', async () => {
	let t = NOW;
	const { sso, fetch } = makeSso({}, { now: () => t });
	await sso.verifyJwt(signJwt(claimsFor()));
	await sso.verifyJwt(signJwt(claimsFor(), { alg: 'ES256' }));
	assert.equal(fetch.callsTo(JWKS_URL).length, 1);
	t = NOW + 5 * 60 * 1000;
	await sso.verifyJwt(signJwt(claimsFor({ exp: t / 1000 + 600 })));
	assert.equal(fetch.callsTo(JWKS_URL).length, 2);
	assert.equal(fetch.callsTo(METADATA_URL).length, 1);
	const jwksCall = fetch.callsTo(JWKS_URL)[0];
	assert.equal(jwksCall.headers['User-Agent'], 'eflip-test/1.0');
});

// ---- metadata and authorize URL

test('authorizeUrl builds the authorize request from the metadata', async () => {
	const { sso } = makeSso();
	const url = new URL(await sso.authorizeUrl({ state: 'abc123', scopes: SCOPES }));
	assert.equal(`${url.origin}${url.pathname}`, AUTHORIZE_URL);
	assert.equal(url.searchParams.get('response_type'), 'code');
	assert.equal(url.searchParams.get('redirect_uri'), CALLBACK_URL);
	assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
	assert.equal(url.searchParams.get('scope'), SCOPES.join(' '));
	assert.equal(url.searchParams.get('state'), 'abc123');
});

test('a failed metadata fetch falls back to the checked endpoints, once', async () => {
	const fetch = fakeFetch({}); // every URL fails like a network error
	const sso = createSso({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, callbackUrl: CALLBACK_URL, userAgent: 'x', fetch, now: () => NOW });
	const url = await sso.authorizeUrl({ state: 's', scopes: SCOPES });
	assert.ok(url.startsWith(`${AUTHORIZE_URL}?`));
	const metadata = await sso.getMetadata();
	assert.equal(metadata.token_endpoint, TOKEN_URL);
	assert.equal(metadata.revocation_endpoint, REVOKE_URL);
	assert.equal(metadata.jwks_uri, JWKS_URL);
	assert.equal(fetch.callsTo(METADATA_URL).length, 1);
});

test('SCOPES lists the seven scopes in order', () => {
	assert.deepEqual([...SCOPES], [
		'esi-wallet.read_character_wallet.v1',
		'esi-markets.read_character_orders.v1',
		'esi-assets.read_assets.v1',
		'esi-contracts.read_character_contracts.v1',
		'esi-skills.read_skills.v1',
		'esi-characters.read_standings.v1',
		'esi-universe.read_structures.v1',
	]);
});

// ---- token endpoint and revoke

const tokenBody = (accessToken = signJwt(claimsFor()), refreshToken = 'refresh-token-1') => ({
	access_token: accessToken,
	expires_in: 1200,
	token_type: 'Bearer',
	refresh_token: refreshToken,
});

test('exchangeCode posts the code with Basic client auth', async () => {
	const { sso, fetch } = makeSso({ [TOKEN_URL]: () => jsonResponse(200, tokenBody()) });
	const result = await sso.exchangeCode('the-code');
	assert.equal(result.refresh_token, 'refresh-token-1');
	const [call] = fetch.callsTo(TOKEN_URL);
	assert.equal(call.method, 'POST');
	assert.equal(call.headers.Authorization, BASIC);
	assert.equal(call.headers['Content-Type'], 'application/x-www-form-urlencoded');
	assert.equal(call.headers['User-Agent'], 'eflip-test/1.0');
	const body = new URLSearchParams(call.body);
	assert.equal(body.get('grant_type'), 'authorization_code');
	assert.equal(body.get('code'), 'the-code');
	assert.equal(body.has('client_secret'), false);
	assert.equal(body.has('client_id'), false);
});

test('a 401 invalid_client falls back to credentials in the body, exactly once', async () => {
	const { sso, fetch } = makeSso({
		[TOKEN_URL]: (call) => (call.headers.Authorization ? jsonResponse(401, { error: 'invalid_client' }) : jsonResponse(200, tokenBody())),
	});
	await sso.exchangeCode('the-code');
	const calls = fetch.callsTo(TOKEN_URL);
	assert.equal(calls.length, 2);
	assert.equal(calls[1].headers.Authorization, undefined);
	const body = new URLSearchParams(calls[1].body);
	assert.equal(body.get('client_id'), CLIENT_ID);
	assert.equal(body.get('client_secret'), CLIENT_SECRET);
	assert.equal(body.get('code'), 'the-code');

	const stubborn = makeSso({ [TOKEN_URL]: () => jsonResponse(401, { error: 'invalid_client' }) });
	await assert.rejects(stubborn.sso.exchangeCode('the-code'), (e) => e instanceof SsoError && e.status === 401 && e.error === 'invalid_client');
	assert.equal(stubborn.fetch.callsTo(TOKEN_URL).length, 2);
});

test('a 400 throws an SsoError with the OAuth error and no token text', async () => {
	const code = 'SECRET-CODE-1234';
	const { sso } = makeSso({
		[TOKEN_URL]: () => jsonResponse(400, { error: 'invalid_grant', error_description: `Authorization code ${code} is invalid` }),
	});
	await assert.rejects(sso.exchangeCode(code), (e) => {
		assert.ok(e instanceof SsoError);
		assert.equal(e.status, 400);
		assert.equal(e.error, 'invalid_grant');
		assert.ok(!e.message.includes(code));
		assert.ok(!e.errorDescription.includes(code));
		assert.ok(!e.errorDescription.includes(CLIENT_SECRET));
		return true;
	});
});

test('refresh posts the refresh token grant', async () => {
	const { sso, fetch } = makeSso({ [TOKEN_URL]: () => jsonResponse(200, tokenBody()) });
	await sso.refresh('old-refresh');
	const body = new URLSearchParams(fetch.callsTo(TOKEN_URL)[0].body);
	assert.equal(body.get('grant_type'), 'refresh_token');
	assert.equal(body.get('refresh_token'), 'old-refresh');
});

test('a 2xx without an access token is an error', async () => {
	const { sso } = makeSso({ [TOKEN_URL]: () => new Response('<html>oops</html>', { status: 200 }) });
	await assert.rejects(sso.refresh('r'), /without an access token/);
});

test('revoke posts the refresh token with its type hint and resolves on 200', async () => {
	const { sso, fetch } = makeSso({ [REVOKE_URL]: () => new Response('', { status: 200 }) });
	await sso.revoke('refresh-to-drop');
	const [call] = fetch.callsTo(REVOKE_URL);
	assert.equal(call.method, 'POST');
	assert.equal(call.headers.Authorization, BASIC);
	assert.equal(call.headers['Content-Type'], 'application/x-www-form-urlencoded');
	const body = new URLSearchParams(call.body);
	assert.equal(body.get('token'), 'refresh-to-drop');
	assert.equal(body.get('token_type_hint'), 'refresh_token');

	const failing = makeSso({ [REVOKE_URL]: () => jsonResponse(500, { error: 'server_error' }) });
	await assert.rejects(failing.sso.revoke('refresh-to-drop'), (e) => e instanceof SsoError && e.status === 500 && !e.message.includes('refresh-to-drop'));
});

// ---- token store

const sampleRecord = (overrides = {}) => ({
	characterId: CHARACTER_ID,
	name: 'Ivan Tester',
	ownerHash: OWNER,
	scopes: [...SCOPES],
	refreshToken: 'refresh-old',
	linkedAt: '2026-11-13T11:00:00.000Z',
	refreshedAt: '2026-11-13T11:00:00.000Z',
	status: 'ok',
	lastError: null,
	...overrides,
});

test('token store round-trips records in a 0600 file inside a 0700 directory', (t) => {
	const dataDir = path.join(tmpDir(t), 'data');
	const store = createTokenStore({ dataDir });
	assert.deepEqual(store.list(), []);
	assert.equal(store.get(CHARACTER_ID), null);
	assert.equal(fs.existsSync(dataDir), false);

	store.upsert(sampleRecord({ accessToken: 'must-not-be-stored' }));
	store.upsert(sampleRecord({ characterId: 90000002, name: 'Grant Tester', refreshToken: 'refresh-grant' }));
	const file = path.join(dataDir, 'tokens.json');
	assert.equal(modeOf(dataDir), 0o700);
	assert.equal(modeOf(file), 0o600);
	assert.deepEqual(fs.readdirSync(dataDir), ['tokens.json']);
	assert.ok(!fs.readFileSync(file, 'utf8').includes('must-not-be-stored'));

	const reopened = createTokenStore({ dataDir });
	const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
	assert.equal(onDisk.version, 1);
	assert.deepEqual(Object.keys(onDisk.characters).sort(), [String(CHARACTER_ID), '90000002']);
	const { accessToken, ...expected } = sampleRecord();
	assert.deepEqual(reopened.get(CHARACTER_ID), expected);
	assert.equal(reopened.list().length, 2);

	const pub = reopened.publicList();
	assert.equal(pub.length, 2);
	for (const record of pub) assert.equal('refreshToken' in record, false);

	assert.equal(reopened.setStatus(CHARACTER_ID, 'relink', 'token endpoint answered 400 invalid_grant').status, 'relink');
	assert.equal(store.get(CHARACTER_ID).lastError, 'token endpoint answered 400 invalid_grant');
	assert.equal(store.setStatus(1, 'relink', 'x'), null);
	assert.equal(store.remove(90000002), true);
	assert.equal(store.remove(90000002), false);
	assert.deepEqual(store.list().map(r => r.characterId), [CHARACTER_ID]);
	assert.equal(modeOf(file), 0o600);
});

test('token store throws on a corrupt file without quoting it', (t) => {
	const dataDir = tmpDir(t);
	fs.writeFileSync(path.join(dataDir, 'tokens.json'), '{"characters": {"1": {"refreshToken": "leaky-token" oops');
	const store = createTokenStore({ dataDir });
	assert.throws(() => store.list(), (e) => /not valid JSON/.test(e.message) && !e.message.includes('leaky-token'));
	fs.writeFileSync(path.join(dataDir, 'tokens.json'), '[]');
	assert.throws(() => store.list(), /unexpected shape/);
});

// ---- token manager

const managerFixture = (t, tokenHandler, { clock = () => NOW, record = {} } = {}) => {
	const dataDir = tmpDir(t);
	const store = createTokenStore({ dataDir });
	store.upsert(sampleRecord(record));
	const fetch = fakeFetch(ssoHandlers({ [TOKEN_URL]: tokenHandler }));
	const sso = createSso({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, callbackUrl: CALLBACK_URL, userAgent: 'x', fetch, now: clock });
	const sleeps = [];
	const tokens = createTokenManager({ sso, store, now: clock, sleep: async (ms) => { sleeps.push(ms); } });
	return { dataDir, store, fetch, tokens, sleeps };
};

// A token endpoint that issues a fresh JWT (exp relative to `clock`) and a new refresh token each time.
const issuingEndpoint = (clock = () => NOW) => {
	let n = 0;
	return async () => {
		n += 1;
		await new Promise(resolve => setTimeout(resolve, 5));
		return jsonResponse(200, tokenBody(signJwt(claimsFor({ exp: Math.floor(clock() / 1000) + 1200, jti: `jti-${n}` })), `refresh-new-${n}`));
	};
};

test('concurrent accessTokenFor calls share one refresh, and the rotated refresh token is stored', async (t) => {
	const { store, fetch, tokens, dataDir } = managerFixture(t, issuingEndpoint());
	const [a, b] = await Promise.all([tokens.accessTokenFor(CHARACTER_ID), tokens.accessTokenFor(String(CHARACTER_ID))]);
	assert.equal(a, b);
	assert.equal(fetch.callsTo(TOKEN_URL).length, 1);
	assert.equal(new URLSearchParams(fetch.callsTo(TOKEN_URL)[0].body).get('refresh_token'), 'refresh-old');
	const record = store.get(CHARACTER_ID);
	assert.equal(record.refreshToken, 'refresh-new-1');
	assert.equal(record.refreshedAt, new Date(NOW).toISOString());
	assert.equal(record.status, 'ok');
	// The access token lives in memory only.
	assert.ok(!fs.readFileSync(path.join(dataDir, 'tokens.json'), 'utf8').includes(a));
});

test('a token with more than 60 s left is reused; one with less is refreshed', async (t) => {
	let now = NOW;
	const clock = () => now;
	const { fetch, tokens } = managerFixture(t, issuingEndpoint(clock), { clock });
	const first = await tokens.accessTokenFor(CHARACTER_ID);
	now = NOW + 1100 * 1000; // 100 s left
	assert.equal(await tokens.accessTokenFor(CHARACTER_ID), first);
	assert.equal(fetch.callsTo(TOKEN_URL).length, 1);
	now = NOW + 1150 * 1000; // 50 s left
	const second = await tokens.accessTokenFor(CHARACTER_ID);
	assert.notEqual(second, first);
	assert.equal(fetch.callsTo(TOKEN_URL).length, 2);
	assert.equal(new URLSearchParams(fetch.callsTo(TOKEN_URL)[1].body).get('refresh_token'), 'refresh-new-1');
});

test('invalid_grant marks the character relink and later calls skip the endpoint', async (t) => {
	const { store, fetch, tokens } = managerFixture(t, () => jsonResponse(400, { error: 'invalid_grant', error_description: 'Invalid refresh token. Token missing/expired.' }));
	await assert.rejects(tokens.accessTokenFor(CHARACTER_ID), (e) => e instanceof TokenError && e.code === 'relink' && e.status === 400);
	const record = store.get(CHARACTER_ID);
	assert.equal(record.status, 'relink');
	assert.match(record.lastError, /400 invalid_grant/);
	assert.ok(!record.lastError.includes('refresh-old'));
	assert.equal(record.refreshToken, 'refresh-old');
	await assert.rejects(tokens.accessTokenFor(CHARACTER_ID), (e) => e instanceof TokenError && e.code === 'relink');
	assert.equal(fetch.callsTo(TOKEN_URL).length, 1);
});

test('a network error is retried once after 500 ms, then thrown with the status unchanged', async (t) => {
	const { store, fetch, tokens, sleeps } = managerFixture(t, () => { throw new TypeError('fetch failed'); });
	await assert.rejects(tokens.accessTokenFor(CHARACTER_ID), /fetch failed/);
	assert.equal(fetch.callsTo(TOKEN_URL).length, 2);
	assert.deepEqual(sleeps, [500]);
	assert.equal(store.get(CHARACTER_ID).status, 'ok');
	assert.equal(store.get(CHARACTER_ID).refreshToken, 'refresh-old');
});

test('a network error followed by an answer succeeds on the retry', async (t) => {
	const issue = issuingEndpoint();
	const { fetch, tokens } = managerFixture(t, (call, n) => {
		if (n === 1) throw new TypeError('fetch failed');
		return issue();
	});
	assert.equal(typeof await tokens.accessTokenFor(CHARACTER_ID), 'string');
	assert.equal(fetch.callsTo(TOKEN_URL).length, 2);
});

test('invalid_client and 5xx answers leave the character linked', async (t) => {
	const badClient = managerFixture(t, () => jsonResponse(401, { error: 'invalid_client' }));
	await assert.rejects(badClient.tokens.accessTokenFor(CHARACTER_ID), (e) => e instanceof SsoError && e.status === 401);
	assert.equal(badClient.store.get(CHARACTER_ID).status, 'ok');
	assert.equal(badClient.fetch.callsTo(TOKEN_URL).length, 2); // basic, then post

	const down = managerFixture(t, () => jsonResponse(503, {}));
	await assert.rejects(down.tokens.accessTokenFor(CHARACTER_ID), (e) => e instanceof SsoError && e.status === 503);
	assert.equal(down.store.get(CHARACTER_ID).status, 'ok');
	assert.equal(down.fetch.callsTo(TOKEN_URL).length, 1);
});

test('a refreshed token for another owner marks the character relink', async (t) => {
	const { store, tokens } = managerFixture(t, issuingEndpoint(), { record: { ownerHash: 'previous-owner' } });
	await assert.rejects(tokens.accessTokenFor(CHARACTER_ID), (e) => e instanceof TokenError && e.code === 'relink');
	assert.equal(store.get(CHARACTER_ID).status, 'relink');
});

test('an unlinked character throws without calling the endpoint', async (t) => {
	const { fetch, tokens } = managerFixture(t, issuingEndpoint());
	await assert.rejects(tokens.accessTokenFor(12345), (e) => e instanceof TokenError && e.code === 'not-linked');
	assert.equal(fetch.callsTo(TOKEN_URL).length, 0);
});

// ---- routes

// node:http rather than fetch: undici's fetch silently drops a custom Host header.
const request = (port, method, urlPath, headers = {}) => new Promise((resolve, reject) => {
	const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: { Host: `localhost:${port}`, ...headers } }, res => {
		const chunks = [];
		res.on('data', chunk => chunks.push(chunk));
		res.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8');
			let json = null;
			try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
			resolve({ status: res.statusCode, headers: res.headers, text, json });
		});
	});
	req.on('error', reject);
	req.end();
});

const startApp = async (t, { configured = true, handlers = {}, clock = () => NOW, dataDir = tmpDir(t) } = {}) => {
	const app = express();
	const server = await new Promise(resolve => {
		const s = app.listen(0, '127.0.0.1', () => resolve(s));
	});
	t.after(() => new Promise(resolve => server.close(resolve)));
	const port = server.address().port;
	const fetch = fakeFetch(ssoHandlers(handlers));
	const env = configured
		? { EVE_CLIENT_ID: CLIENT_ID, EVE_CLIENT_SECRET: CLIENT_SECRET, EVE_CALLBACK_URL: `http://localhost:${port}/sso/callback`, ESI_USER_AGENT: 'eflip-test/1.0' }
		: {};
	const logs = [];
	const log = { info: (line) => logs.push(line), warn: (line) => logs.push(line) };
	mountApi(app, { env, dataDir, fetch, now: clock, log });
	return { app, port, dataDir, fetch, logs, get: (p, h) => request(port, 'GET', p, h), del: (p, h) => request(port, 'DELETE', p, h) };
};

const cookieFrom = (res) => {
	const header = (res.headers['set-cookie'] || []).find(c => c.startsWith('eflip_sso='));
	return header === undefined ? undefined : header.split(';')[0].slice('eflip_sso='.length);
};

// Runs /sso/login and answers the state its cookie holds.
const login = async (ctx, returnTo = '/results.html') => {
	const res = await ctx.get(`/sso/login?return=${encodeURIComponent(returnTo)}`);
	assert.equal(res.status, 302);
	return cookieFrom(res);
};

const callback = (ctx, state, { code = 'the-code', cookie = state } = {}) => ctx.get(
	`/sso/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
	cookie === null ? {} : { Cookie: `other=1; eflip_sso=${cookie}` },
);

// a data directory with nothing in it and no EFLIP_STORAGE_BUDGET: the storage block of /api/config
const NO_BUDGET = { budget: null, shares: { regionPages: 40, bookLogs: 45, typeBooks: 10, runContexts: 5 }, usage: { regionPages: 0, bookLogs: 0, typeBooks: 0, runContexts: 0 }, total: 0, measuredAt: new Date(NOW).toISOString(), lastTrimAt: null, unmet: 0 };

test('GET /api/config tells whether SSO is configured and leaks nothing else', async (t) => {
	const on = await startApp(t);
	const res = await on.get('/api/config');
	assert.equal(res.status, 200);
	assert.deepEqual(res.json, { configured: true, callbackUrl: `http://localhost:${on.port}/sso/callback`, scopes: [...SCOPES], env: { dataDir: on.dataDir, dataDirFromEnv: false, userAgentFromEnv: true, dataDirError: null }, regionBook: { enabled: false, scheduled: false, nextRunAt: null, lastRun: null }, storage: NO_BUDGET });
	assert.ok(!res.text.includes(CLIENT_SECRET));
	assert.equal(res.text.split(on.dataDir).length, 2, 'the data directory appears once, as env.dataDir (a local path, shown so the pages can remind the user)');

	const off = await startApp(t, { configured: false });
	const offRes = await off.get('/api/config');
	assert.equal(offRes.status, 200);
	assert.deepEqual(offRes.json, { configured: false, callbackUrl: 'http://localhost:5001/sso/callback', scopes: [...SCOPES], env: { dataDir: off.dataDir, dataDirFromEnv: false, userAgentFromEnv: false, dataDirError: null }, regionBook: { enabled: false, scheduled: false, nextRunAt: null, lastRun: null }, storage: NO_BUDGET });

	const foreign = await on.get('/api/config', { Host: 'evil.example' });
	assert.equal(foreign.status, 403);
});

test('without credentials the SSO and character routes answer 503', async (t) => {
	const off = await startApp(t, { configured: false });
	for (const [method, p] of [['GET', '/sso/login'], ['GET', '/sso/callback?code=a&state=b'], ['GET', '/api/characters'], ['DELETE', `/api/characters/${CHARACTER_ID}`]]) {
		const res = await request(off.port, method, p);
		assert.equal(res.status, 503, `${method} ${p}`);
		assert.deepEqual(res.json, { error: 'not configured' });
	}
	assert.equal(off.app.locals.tokens, null);
	assert.equal(off.fetch.calls.length, 0);
});

test('/sso/login sets a state cookie and redirects to the authorize endpoint', async (t) => {
	const ctx = await startApp(t);
	const res = await ctx.get('/sso/login?return=/results.html');
	assert.equal(res.status, 302);
	const state = cookieFrom(res);
	assert.match(state, /^[0-9a-f]{32}$/);
	const cookie = res.headers['set-cookie'].find(c => c.startsWith('eflip_sso='));
	for (const attribute of ['HttpOnly', 'SameSite=Lax', 'Path=/sso', 'Max-Age=600']) assert.ok(cookie.includes(attribute), attribute);
	const location = new URL(res.headers.location);
	assert.equal(`${location.origin}${location.pathname}`, AUTHORIZE_URL);
	assert.equal(location.searchParams.get('response_type'), 'code');
	assert.equal(location.searchParams.get('client_id'), CLIENT_ID);
	assert.equal(location.searchParams.get('redirect_uri'), `http://localhost:${ctx.port}/sso/callback`);
	assert.equal(location.searchParams.get('scope'), SCOPES.join(' '));
	assert.equal(location.searchParams.get('state'), state);
	assert.ok(!res.headers.location.includes(CLIENT_SECRET));

	const again = await ctx.get('/sso/login');
	assert.notEqual(cookieFrom(again), state);
});

test('/sso/login on another loopback name restarts on the callback host', async (t) => {
	const ctx = await startApp(t);
	const res = await ctx.get('/sso/login?return=/export.html', { Host: `127.0.0.1:${ctx.port}` });
	assert.equal(res.status, 302);
	assert.equal(res.headers.location, `http://localhost:${ctx.port}/sso/login?return=%2Fexport.html`);
	assert.equal(cookieFrom(res), undefined);
});

test('safeReturnPath keeps same-server paths only', () => {
	for (const ok of ['/results.html', '/export.html?tab=1#top', '/']) assert.equal(safeReturnPath(ok), ok);
	for (const bad of ['//evil.example', '//evil.example/results.html', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)',
		'/\t/evil.example', '/a\nb', 'results.html', '', undefined, ['/results.html'], `/${'a'.repeat(600)}`]) {
		assert.equal(safeReturnPath(bad), '/results.html', JSON.stringify(bad));
	}
});

test('/sso/callback rejects a missing, mismatched, unknown, reused or expired state', async (t) => {
	let now = NOW;
	const ctx = await startApp(t, { handlers: { [TOKEN_URL]: () => jsonResponse(200, tokenBody()) }, clock: () => now });
	const stateError = '/results.html?ssoError=state';

	const state = await login(ctx);
	assert.equal((await callback(ctx, state, { cookie: null })).headers.location, stateError);
	assert.equal((await callback(ctx, state, { cookie: 'f'.repeat(32) })).headers.location, stateError);
	assert.equal((await callback(ctx, 'f'.repeat(32))).headers.location, stateError);
	assert.equal(ctx.fetch.callsTo(TOKEN_URL).length, 0);

	const used = await login(ctx);
	assert.equal((await callback(ctx, used)).headers.location, `/results.html?linked=${CHARACTER_ID}`);
	assert.equal((await callback(ctx, used)).headers.location, stateError);

	const stale = await login(ctx);
	now = NOW + 10 * 60 * 1000 + 1;
	assert.equal((await callback(ctx, stale)).headers.location, stateError);
	assert.equal(ctx.fetch.callsTo(TOKEN_URL).length, 1);
});

test('/sso/callback passes CCP errors on as a short code', async (t) => {
	const ctx = await startApp(t);
	const res = await ctx.get('/sso/callback?error=access_denied&error_description=nope');
	assert.equal(res.status, 302);
	assert.equal(res.headers.location, '/results.html?ssoError=access_denied');
	const odd = await ctx.get(`/sso/callback?error=${encodeURIComponent('<script>x</script>')}`);
	assert.equal(odd.headers.location, '/results.html?ssoError=scriptxscript');
});

test('/sso/callback stores the character, primes its access token and clears the cookie', async (t) => {
	const accessToken = signJwt(claimsFor());
	const ctx = await startApp(t, { handlers: { [TOKEN_URL]: () => jsonResponse(200, tokenBody(accessToken, 'refresh-token-1')) } });
	const state = await login(ctx);
	const res = await callback(ctx, state);
	assert.equal(res.status, 302);
	assert.equal(res.headers.location, `/results.html?linked=${CHARACTER_ID}`);
	const cleared = res.headers['set-cookie'].find(c => c.startsWith('eflip_sso='));
	assert.ok(cleared.startsWith('eflip_sso=;'));
	assert.ok(cleared.includes('Max-Age=0'));
	assert.ok(cleared.includes('Path=/sso'));
	const [exchange] = ctx.fetch.callsTo(TOKEN_URL);
	assert.equal(new URLSearchParams(exchange.body).get('code'), 'the-code');
	assert.equal(exchange.headers.Authorization, BASIC);

	const exposed = [res.text, JSON.stringify(res.headers), ...ctx.logs].join('\n');
	assert.ok(!exposed.includes('refresh-token-1'));
	assert.ok(!exposed.includes(accessToken));

	const file = path.join(ctx.dataDir, 'tokens.json');
	assert.equal(modeOf(file), 0o600);
	const onDisk = fs.readFileSync(file, 'utf8');
	assert.ok(!onDisk.includes(accessToken));
	const stored = JSON.parse(onDisk).characters[String(CHARACTER_ID)];
	assert.deepEqual(stored, {
		characterId: CHARACTER_ID,
		name: 'Ivan Tester',
		ownerHash: OWNER,
		scopes: ['esi-wallet.read_character_wallet.v1', 'esi-assets.read_assets.v1'],
		refreshToken: 'refresh-token-1',
		linkedAt: new Date(NOW).toISOString(),
		refreshedAt: new Date(NOW).toISOString(),
		status: 'ok',
		lastError: null,
	});

	// The exchange's access token is reused: no refresh request.
	assert.equal(await ctx.app.locals.tokens.accessTokenFor(CHARACTER_ID), accessToken);
	assert.equal(ctx.fetch.callsTo(TOKEN_URL).length, 1);
});

test('re-linking replaces the record and its token', async (t) => {
	let n = 0;
	const ctx = await startApp(t, {
		handlers: { [TOKEN_URL]: () => { n += 1; return jsonResponse(200, tokenBody(signJwt(claimsFor({ jti: `j${n}` })), `refresh-token-${n}`)); } },
	});
	await ctx.app.locals.tokenStore.upsert(sampleRecord({ status: 'relink', lastError: 'old failure', refreshToken: 'refresh-dead' }));
	await callback(ctx, await login(ctx));
	const stored = ctx.app.locals.tokenStore.get(CHARACTER_ID);
	assert.equal(stored.refreshToken, 'refresh-token-1');
	assert.equal(stored.status, 'ok');
	assert.equal(stored.lastError, null);
	assert.equal(ctx.app.locals.tokenStore.list().length, 1);
});

test('/sso/callback failures return to the page with a short code and store nothing', async (t) => {
	const ctx = await startApp(t, { handlers: { [TOKEN_URL]: () => jsonResponse(400, { error: 'invalid_grant' }) } });
	// An unsafe return falls back to /results.html; a safe one keeps its query.
	assert.equal((await callback(ctx, await login(ctx, '//evil.example'))).headers.location, '/results.html?ssoError=exchange&ssoReason=error');
	assert.equal((await callback(ctx, await login(ctx, '/export.html?tab=1'))).headers.location, '/export.html?tab=1&ssoError=exchange&ssoReason=error');
	assert.equal(fs.existsSync(path.join(ctx.dataDir, 'tokens.json')), false);

	const badJwt = await startApp(t, { handlers: { [TOKEN_URL]: () => jsonResponse(200, tokenBody(signJwt(claimsFor(), { key: otherRsa.privateKey }))) } });
	assert.equal((await callback(badJwt, await login(badJwt))).headers.location, '/results.html?ssoError=jwt&ssoReason=error');
	assert.equal(fs.existsSync(path.join(badJwt.dataDir, 'tokens.json')), false);

	const badStore = await startApp(t, { handlers: { [TOKEN_URL]: () => jsonResponse(200, tokenBody()) } });
	fs.mkdirSync(path.join(badStore.dataDir, 'tokens.json')); // unreadable as a file
	assert.equal((await callback(badStore, await login(badStore))).headers.location, '/results.html?ssoError=store&ssoReason=EISDIR');
	assert.ok(!badStore.logs.join('\n').includes('refresh-token-1'));
});

// The reason on the redirect is what lets the page say why a link failed (EACCES, EROFS ...). It is the
// error's own code when that is a short upper-case token, never its message.
test('/sso/callback: a store error with a code puts the code on the redirect and in the log', async (t) => {
	const ctx = await startApp(t, { handlers: { [TOKEN_URL]: () => jsonResponse(200, tokenBody()) } });
	const message = `EACCES: permission denied, open '${path.join(ctx.dataDir, 'tokens.json')}'`;
	ctx.app.locals.tokenStore.upsert = () => { throw Object.assign(new Error(message), { code: 'EACCES' }); };

	const res = await callback(ctx, await login(ctx));
	assert.equal(res.status, 302);
	assert.equal(res.headers.location, '/results.html?ssoError=store&ssoReason=EACCES');
	assert.ok(ctx.logs.includes(`sso callback: store failed (EACCES): ${message}`), ctx.logs.join('\n'));
	assert.ok(!res.headers.location.includes('refresh-token-1') && !ctx.logs.join('\n').includes('refresh-token-1'));

	// the page that asked comes back with both parameters added to its own query
	const orders = await callback(ctx, await login(ctx, '/orders.html'));
	assert.equal(orders.headers.location, '/orders.html?ssoError=store&ssoReason=EACCES');
	const withQuery = await callback(ctx, await login(ctx, '/export.html?tab=1'));
	assert.equal(withQuery.headers.location, '/export.html?tab=1&ssoError=store&ssoReason=EACCES');
	assert.equal(fs.existsSync(path.join(ctx.dataDir, 'tokens.json')), false);
});

test('/sso/callback: an error without a usable code gives the reason `error`, and no message reaches the redirect', async (t) => {
	const ctx = await startApp(t, { handlers: { [TOKEN_URL]: () => jsonResponse(200, tokenBody()) } });
	const throwing = (error) => { ctx.app.locals.tokenStore.upsert = () => { throw error; }; };
	const reasonOf = async () => new URL((await callback(ctx, await login(ctx))).headers.location, 'http://x').searchParams;

	throwing(new Error('token store: /somewhere/tokens.json has an unexpected shape'));
	let params = await reasonOf();
	assert.equal(params.get('ssoError'), 'store');
	assert.equal(params.get('ssoReason'), 'error');
	assert.ok(ctx.logs.includes('sso callback: store failed: token store: /somewhere/tokens.json has an unexpected shape'), ctx.logs.join('\n'));

	// a code that is not a short upper-case token is not passed on
	for (const code of ['eacces', 'E', 'ERR_THIS_CODE_IS_FAR_TOO_LONG', 'EACCES; x=1', 42]) {
		throwing(Object.assign(new Error('boom'), { code }));
		params = await reasonOf();
		assert.equal(params.get('ssoReason'), 'error', `code ${String(code)}`);
	}
	throwing(Object.assign(new Error('boom'), { code: 'ERR_FS_EISDIR' }));
	assert.equal((await reasonOf()).get('ssoReason'), 'ERR_FS_EISDIR');
});

test('/sso/callback: the exchange and jwt failures carry their error code too', async (t) => {
	const reset = await startApp(t, { handlers: { [TOKEN_URL]: () => { throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' }); } } });
	assert.equal((await callback(reset, await login(reset))).headers.location, '/results.html?ssoError=exchange&ssoReason=ECONNRESET');
	assert.ok(reset.logs.includes('sso callback: exchange failed (ECONNRESET): fetch failed'), reset.logs.join('\n'));

	const noRefresh = await startApp(t, { handlers: { [TOKEN_URL]: () => jsonResponse(200, { access_token: signJwt(claimsFor()) }) } });
	assert.equal((await callback(noRefresh, await login(noRefresh))).headers.location, '/results.html?ssoError=exchange&ssoReason=error');

	const badJwt = await startApp(t, { handlers: { [TOKEN_URL]: () => jsonResponse(200, tokenBody(signJwt(claimsFor(), { key: otherRsa.privateKey }))) } });
	assert.equal((await callback(badJwt, await login(badJwt))).headers.location, '/results.html?ssoError=jwt&ssoReason=error');
});

// The data directory probe: /api/config says, on every call, whether <dataDir> takes a file, so the pages
// can say so before a link fails.
test('GET /api/config: dataDirError is null for a writable directory and the probe leaves nothing behind', async (t) => {
	const ctx = await startApp(t);
	for (let i = 0; i < 3; i++) {
		const res = await ctx.get('/api/config');
		assert.equal(res.json.env.dataDirError, null);
	}
	assert.deepEqual(fs.readdirSync(ctx.dataDir).filter(name => name.includes('probe')), []);
	assert.deepEqual(ctx.logs.filter(line => line.includes('not writable')), [], 'nothing said while the directory works');

	// the probe on its own: a directory that does not exist yet is created (0700) and left empty
	const fresh = path.join(tmpDir(t), 'a', 'b');
	assert.equal(probeDataDir(fresh), null);
	assert.deepEqual(fs.readdirSync(fresh), []);
	assert.equal(modeOf(fresh), 0o700);
});

test('GET /api/config: a data directory that is a file is reported with its code, and a fix shows without a restart', async (t) => {
	const parent = tmpDir(t);
	const file = path.join(parent, 'data');
	fs.writeFileSync(file, 'not a directory');
	const ctx = await startApp(t, { dataDir: file });

	const res = await ctx.get('/api/config');
	assert.equal(res.status, 200);
	const { dataDirError } = res.json.env;
	assert.deepEqual(Object.keys(dataDirError), ['code', 'message']);
	assert.ok(['EEXIST', 'ENOTDIR'].includes(dataDirError.code), `code ${dataDirError.code}`);
	assert.ok(dataDirError.message.includes(file), 'the fs message names the path');
	assert.equal(res.json.env.dataDir, file);

	// said once at mount, not on every /api/config
	await ctx.get('/api/config');
	const said = ctx.logs.filter(line => line.includes('not writable'));
	assert.equal(said.length, 1, ctx.logs.join('\n'));
	assert.equal(said[0], `data directory ${file} is not writable (${dataDirError.code}): ${dataDirError.message}`);

	// below a file is the same trouble
	const below = await startApp(t, { dataDir: path.join(file, 'deeper') });
	const belowError = (await below.get('/api/config')).json.env.dataDirError;
	assert.ok(['EEXIST', 'ENOTDIR'].includes(belowError.code), `code ${belowError.code}`);

	// the folder is fixed while the server runs: the next /api/config reflects it
	fs.rmSync(file);
	fs.mkdirSync(file);
	assert.equal((await ctx.get('/api/config')).json.env.dataDirError, null);
	assert.deepEqual(fs.readdirSync(file), []);
});

test('GET /api/config: a read-only data directory is EACCES, and no token or secret is in the answer', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) }, async (t) => {
	const dir = tmpDir(t);
	fs.chmodSync(dir, 0o500);
	try {
		const ctx = await startApp(t, { dataDir: dir });
		const res = await ctx.get('/api/config');
		assert.equal(res.json.env.dataDirError.code, 'EACCES');
		assert.ok(res.json.env.dataDirError.message.includes(dir));
		assert.ok(!res.text.includes(CLIENT_SECRET));
		assert.deepEqual(fs.readdirSync(dir), []);
	} finally {
		fs.chmodSync(dir, 0o700);
	}
});

test('GET /api/characters lists characters by name without refresh tokens', async (t) => {
	const ctx = await startApp(t);
	ctx.app.locals.tokenStore.upsert(sampleRecord({ characterId: 90000002, name: 'Zed Tester', refreshToken: 'refresh-zed' }));
	ctx.app.locals.tokenStore.upsert(sampleRecord({ characterId: 90000003, name: 'Grant Tester', refreshToken: 'refresh-grant' }));
	const res = await ctx.get('/api/characters');
	assert.equal(res.status, 200);
	assert.deepEqual(res.json.map(c => c.name), ['Grant Tester', 'Zed Tester']);
	for (const character of res.json) assert.equal('refreshToken' in character, false);
	assert.ok(!res.text.includes('refresh-'));
	assert.equal(res.json[0].characterId, 90000003);
	assert.equal(res.json[0].status, 'ok');
});

test('DELETE /api/characters/:id revokes, removes, and purges synced data on request', async (t) => {
	const ctx = await startApp(t, { handlers: { [REVOKE_URL]: () => new Response('', { status: 200 }) } });
	const store = ctx.app.locals.tokenStore;
	store.upsert(sampleRecord({ refreshToken: 'refresh-ivan' }));
	store.upsert(sampleRecord({ characterId: 90000002, name: 'Grant Tester', refreshToken: 'refresh-grant' }));
	const ivanLedger = path.join(ctx.dataDir, 'ledger', String(CHARACTER_ID));
	const grantLedger = path.join(ctx.dataDir, 'ledger', '90000002');
	for (const dir of [ivanLedger, grantLedger]) {
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'transactions.json'), '[]');
	}

	const kept = await ctx.del('/api/characters/90000002');
	assert.equal(kept.status, 200);
	assert.deepEqual(kept.json, { ok: true, purged: false });
	assert.equal(fs.existsSync(grantLedger), true);

	const purged = await ctx.del(`/api/characters/${CHARACTER_ID}?purge=1`);
	assert.equal(purged.status, 200);
	assert.deepEqual(purged.json, { ok: true, purged: true });
	assert.equal(fs.existsSync(ivanLedger), false);
	assert.equal(fs.existsSync(path.join(ctx.dataDir, 'ledger')), true);

	const revoked = ctx.fetch.callsTo(REVOKE_URL).map(call => new URLSearchParams(call.body));
	assert.deepEqual(revoked.map(body => body.get('token')), ['refresh-grant', 'refresh-ivan']);
	assert.ok(revoked.every(body => body.get('token_type_hint') === 'refresh_token'));
	assert.deepEqual(store.list(), []);

	assert.equal((await ctx.del(`/api/characters/${CHARACTER_ID}`)).status, 404);
	assert.equal((await ctx.del('/api/characters/..%2F..%2Fetc')).status, 404);
	assert.equal(ctx.fetch.callsTo(REVOKE_URL).length, 2);
});

test('a failed revoke still removes the character', async (t) => {
	const ctx = await startApp(t, { handlers: { [REVOKE_URL]: () => jsonResponse(500, { error: 'server_error' }) } });
	ctx.app.locals.tokenStore.upsert(sampleRecord({ refreshToken: 'refresh-ivan' }));
	const res = await ctx.del(`/api/characters/${CHARACTER_ID}`);
	assert.equal(res.status, 200);
	assert.deepEqual(res.json, { ok: true, purged: false });
	assert.equal(ctx.app.locals.tokenStore.get(CHARACTER_ID), null);
	assert.ok(ctx.logs.some(line => /revoke .* failed/.test(line)));
	assert.ok(!ctx.logs.join('\n').includes('refresh-ivan'));
});

test('DELETE from another origin is refused by the guards', async (t) => {
	const ctx = await startApp(t, { handlers: { [REVOKE_URL]: () => new Response('', { status: 200 }) } });
	ctx.app.locals.tokenStore.upsert(sampleRecord());
	const res = await ctx.del(`/api/characters/${CHARACTER_ID}`, { Origin: 'http://evil.example' });
	assert.equal(res.status, 403);
	assert.notEqual(ctx.app.locals.tokenStore.get(CHARACTER_ID), null);
	assert.equal(ctx.fetch.callsTo(REVOKE_URL).length, 0);
});
