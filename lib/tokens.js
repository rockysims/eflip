// tokens.js: access tokens for the server's own ESI calls (Phase 3 onward). No HTTP route.
//
// Access tokens live in this process's memory only: never on disk, never sent to the browser.
// A token is reused while more than 60 s remain; after that one refresh runs per character and
// every caller waiting on that character shares it. CCP may rotate the refresh token on each
// refresh, so the one it returns is stored at once.
//
// Failure handling:
//   - The token endpoint refusing the grant (a 4xx whose OAuth error is invalid_grant) marks the
//     character `relink` and stops there: retrying a dead grant only burns error budget. No other
//     4xx says the grant is dead (429, invalid_client, invalid_request, a 403 block page, a 404
//     during a deploy), so those are thrown like a 5xx: a mark only a re-link clears would
//     otherwise land on every character whose token expires meanwhile.
//   - A network error (no answer at all) is retried once after 500 ms, then thrown.
//   - Anything else (a 5xx, any other 4xx, an unverifiable JWT) is thrown with the status left alone.
//   - A refreshed JWT for another owner means the character was transferred: `relink`.
const REFRESH_MARGIN_MS = 60 * 1000;
const RETRY_DELAY_MS = 500;

class TokenError extends Error {
	constructor(message, code, details = {}) {
		super(message);
		this.name = 'TokenError';
		this.code = code; // 'not-linked' | 'relink'
		Object.assign(this, details);
	}
}

const answered = (e) => e !== null && typeof e === 'object' && typeof e.status === 'number';
const refusesGrant = (e) => answered(e) && e.status >= 400 && e.status < 500 && e.error === 'invalid_grant';

const defaultSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const createTokenManager = ({ sso, store, now = () => Date.now(), sleep = defaultSleep }) => {
	const cache = new Map(); // characterId -> { accessToken, expiresAt (ms) }
	const inflight = new Map(); // characterId -> Promise<accessToken>

	const linkedRecord = (id) => {
		const record = store.get(id);
		if (!record) throw new TokenError(`character ${id} is not linked`, 'not-linked');
		if (record.status === 'relink') throw new TokenError(`character ${id} needs re-linking`, 'relink');
		return record;
	};

	const markRelink = (id, reason) => {
		cache.delete(id);
		store.setStatus(id, 'relink', reason);
	};

	const callRefresh = async (id, refreshToken) => {
		for (let attempt = 1; ; attempt++) {
			try {
				return await sso.refresh(refreshToken);
			} catch (e) {
				if (refusesGrant(e)) {
					markRelink(id, e.message);
					throw new TokenError(`character ${id} needs re-linking (${e.message})`, 'relink', { status: e.status, error: e.error });
				}
				if (attempt === 1 && !answered(e)) {
					await sleep(RETRY_DELAY_MS);
					continue;
				}
				throw e;
			}
		}
	};

	const refreshFor = async (id) => {
		const record = linkedRecord(id);
		const response = await callRefresh(id, record.refreshToken);

		// Store the rotated refresh token before anything else can fail, unless the character
		// was removed or re-linked meanwhile (that newer state wins).
		const current = store.get(id);
		if (!current) throw new TokenError(`character ${id} is not linked`, 'not-linked');
		if (current.refreshToken === record.refreshToken) {
			const rotated = typeof response.refresh_token === 'string' && response.refresh_token !== '' ? response.refresh_token : current.refreshToken;
			store.upsert({ ...current, refreshToken: rotated, refreshedAt: new Date(now()).toISOString(), lastError: null });
		}

		const claims = await sso.verifyJwt(response.access_token);
		if (claims.characterId !== id || (current.ownerHash && claims.owner !== current.ownerHash)) {
			markRelink(id, 'character owner changed');
			throw new TokenError(`character ${id} needs re-linking (owner changed)`, 'relink');
		}
		cache.set(id, { accessToken: response.access_token, expiresAt: claims.exp * 1000 });
		return response.access_token;
	};

	const accessTokenFor = async (characterId) => {
		const id = Number(characterId);
		linkedRecord(id);
		const cached = cache.get(id);
		if (cached && cached.expiresAt - now() > REFRESH_MARGIN_MS) return cached.accessToken;
		if (!inflight.has(id)) inflight.set(id, refreshFor(id).finally(() => inflight.delete(id)));
		return inflight.get(id);
	};

	// The access token from a fresh code exchange, so the first ESI call after linking needs no
	// refresh. `exp` is the JWT's, in seconds.
	const prime = (characterId, accessToken, exp) => {
		cache.set(Number(characterId), { accessToken, expiresAt: exp * 1000 });
	};

	const forget = (characterId) => {
		cache.delete(Number(characterId));
	};

	return { accessTokenFor, prime, forget };
};

module.exports = { createTokenManager, TokenError };
