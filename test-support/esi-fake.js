// esi-fake.js: a stand-in for ESI (and the pieces around it) for the sync tests. It lives outside
// test/ because a bare `node --test` runs every .js file under test/ as a test.
//
// The fake answers like ESI where the sync depends on it: a body-hash ETag with 304 on a match,
// `Expires` from a per-route cache time on the injected clock, `X-Pages` paging, the `from_id`
// walk of wallet/transactions, the rate-limit headers (2 tokens a 200, 1 a 304) and the legacy
// error-limit headers. All data is hand-made and anonymised; nothing here comes from data/.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ALL_SCOPES = [
	'esi-wallet.read_character_wallet.v1',
	'esi-markets.read_character_orders.v1',
	'esi-assets.read_assets.v1',
	'esi-contracts.read_character_contracts.v1',
	'esi-skills.read_skills.v1',
	'esi-characters.read_standings.v1',
	'esi-universe.read_structures.v1',
];

const START = Date.UTC(2026, 10, 20, 12, 0, 0);

// A clock the test moves by hand.
const makeClock = (start = START) => {
	let t = start;
	const clock = () => t;
	clock.advance = (ms) => {
		t += ms;
		return t;
	};
	clock.set = (value) => {
		t = value;
	};
	return clock;
};

const tmpDataDir = (t, prefix = 'eflip-sync-test-') => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
	return path.join(dir, 'data');
};

const makeLog = () => {
	const lines = [];
	return { lines, info: (line) => lines.push(`info: ${line}`), warn: (line) => lines.push(`warn: ${line}`) };
};

// Tokens as sync.js wants them: `accessTokenFor` answers `token-<id>`; `forget` is recorded.
const makeTokens = () => {
	const tokens = {
		forgotten: [],
		failWith: null,
		accessTokenFor: async (id) => {
			if (tokens.failWith) throw tokens.failWith;
			return `token-${id}`;
		},
		forget: (id) => tokens.forgotten.push(Number(id)),
	};
	return tokens;
};

const ROUTES = [
	{ re: /^\/characters\/(\d+)\/wallet$/, key: 'wallet', ttl: 120, group: 'char-wallet', limit: 150 },
	{ re: /^\/characters\/(\d+)\/wallet\/journal$/, key: 'journal', ttl: 3600, group: 'char-wallet', limit: 150, paged: true },
	{ re: /^\/characters\/(\d+)\/wallet\/transactions$/, key: 'transactions', ttl: 3600, group: 'char-wallet', limit: 150, walk: true },
	{ re: /^\/characters\/(\d+)\/orders$/, key: 'orders', ttl: 1200, group: null },
	{ re: /^\/characters\/(\d+)\/orders\/history$/, key: 'ordersHistory', ttl: 3600, group: null, paged: true },
	{ re: /^\/characters\/(\d+)\/assets$/, key: 'assets', ttl: 3600, group: 'char-asset', limit: 1800, paged: true },
	{ re: /^\/characters\/(\d+)\/contracts$/, key: 'contracts', ttl: 300, group: 'char-contract', limit: 600, paged: true },
	{ re: /^\/characters\/(\d+)\/contracts\/(\d+)\/items$/, key: 'contractItems', ttl: 3600, group: 'char-contract', limit: 600 },
	{ re: /^\/characters\/(\d+)\/skills$/, key: 'skills', ttl: 60, group: 'char-detail', limit: 600 },
	{ re: /^\/characters\/(\d+)\/standings$/, key: 'standings', ttl: 3600, group: 'char-social', limit: 600 },
	{ re: /^\/universe\/structures\/(\d+)$/, key: 'structure', ttl: 3600, group: null, owned: false },
	{ re: /^\/markets\/(\d+)\/orders$/, key: 'marketOrders', ttl: 300, group: 'market-order', limit: 12000, paged: true, public: true },
	{ re: /^\/markets\/(\d+)\/history$/, key: 'marketHistory', ttl: 86400, group: null, public: true },
];

const createFakeEsi = ({ now, pageSize = 1000, transactionsPageSize = 2500, errorLimitRemain = 100 }) => {
	const characters = new Map();
	const structures = new Map(); // id -> object | 'forbidden' | 'missing'
	// orders and history: `${region}:${type}` -> rows; regionOrders: `${region}` -> every order of the
	// region (what /markets/<region>/orders answers without a type_id, filtered by order_type)
	const market = { orders: new Map(), history: new Map(), regionOrders: new Map() };
	const calls = [];
	const used = new Map(); // `${owner}|${group}` -> tokens used
	const fake = { calls, structures, market, pageSize, transactionsPageSize, errorLimitRemain, respondWith: null, rateRemaining: null };

	fake.character = (id, data = {}) => {
		if (!characters.has(Number(id))) {
			characters.set(Number(id), {
				balance: 1000000,
				transactions: [],
				journal: [],
				orders: [],
				ordersHistory: [],
				assets: [],
				contracts: [],
				contractItems: {},
				skills: { skills: [], total_sp: 0, unallocated_sp: 0 },
				standings: [],
				rejectToken: false,
			});
		}
		return Object.assign(characters.get(Number(id)), data);
	};

	const json = (status, body, headers = {}) => new Response(body === undefined ? null : JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=UTF-8', ...headers },
	});

	const pageOf = (rows, page, size) => ({ rows: rows.slice((page - 1) * size, page * size), pages: Math.max(1, Math.ceil(rows.length / size)) });

	fake.fetch = async (url, init = {}) => {
		const parsed = new URL(url);
		const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
		const call = { url: String(url), path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), headers, method: init.method || 'GET', status: null };
		calls.push(call);
		const finish = (response) => {
			call.status = response.status;
			return response;
		};
		if (fake.respondWith) {
			const forced = fake.respondWith(call);
			if (forced) return finish(forced);
		}

		let route = null;
		let match = null;
		for (const candidate of ROUTES) {
			match = candidate.re.exec(parsed.pathname);
			if (match) {
				route = candidate;
				break;
			}
		}
		if (!route) return finish(json(404, { error: 'no such route' }));

		const authId = /^Bearer token-(\d+)$/.test(headers.authorization || '') ? Number(headers.authorization.slice('Bearer token-'.length)) : null;
		const owner = route.public ? 'public' : String(authId);
		const character = route.public ? null : characters.get(authId);
		if (!route.public) {
			const pathId = route.key === 'structure' ? authId : Number(match[1]);
			if (!character || authId !== pathId || character.rejectToken) {
				return finish(json(401, { error: 'token is invalid' }, { 'x-esi-error-limit-remain': String(fake.errorLimitRemain), 'x-esi-error-limit-reset': '30' }));
			}
		}

		// the body this route would answer right now
		let body;
		let pages = null;
		const page = Number(call.query.page || 1);
		switch (route.key) {
			case 'wallet': body = character.balance; break;
			case 'journal': case 'ordersHistory': case 'assets': case 'contracts': {
				const slice = pageOf(character[route.key], page, fake.pageSize);
				body = slice.rows;
				pages = slice.pages;
				break;
			}
			case 'transactions': {
				const fromId = call.query.from_id === undefined ? Infinity : Number(call.query.from_id);
				body = character.transactions
					.filter(row => row.transaction_id < fromId)
					.sort((a, b) => b.transaction_id - a.transaction_id)
					.slice(0, fake.transactionsPageSize);
				break;
			}
			case 'orders': body = character.orders; break;
			case 'contractItems': {
				const items = character.contractItems[match[2]];
				if (items === undefined) return finish(json(404, { error: 'Contract not found' }));
				body = items;
				break;
			}
			case 'skills': body = character.skills; break;
			case 'standings': body = character.standings; break;
			case 'structure': {
				const entry = structures.get(Number(match[1]));
				if (entry === 'forbidden') return finish(json(403, { error: 'Forbidden' }, { 'x-esi-error-limit-remain': String(fake.errorLimitRemain), 'x-esi-error-limit-reset': '30' }));
				if (entry === undefined || entry === 'missing') return finish(json(404, { error: 'Structure not found' }, { 'x-esi-error-limit-remain': String(fake.errorLimitRemain), 'x-esi-error-limit-reset': '30' }));
				body = entry;
				break;
			}
			case 'marketOrders': {
				let rows;
				if (call.query.type_id === undefined) {
					rows = market.regionOrders.get(match[1]) || [];
					const side = call.query.order_type || 'all';
					if (side === 'sell') rows = rows.filter(row => !row.is_buy_order);
					else if (side === 'buy') rows = rows.filter(row => row.is_buy_order);
				} else {
					rows = market.orders.get(`${match[1]}:${call.query.type_id}`) || [];
				}
				const slice = pageOf(rows, page, fake.pageSize);
				body = slice.rows;
				pages = slice.pages;
				break;
			}
			case 'marketHistory': body = market.history.get(`${match[1]}:${call.query.type_id}`) || []; break;
			default: return finish(json(500, { error: 'unhandled' }));
		}

		const text = JSON.stringify(body);
		const etag = `"${crypto.createHash('sha1').update(text).digest('hex')}"`;
		const out = {
			etag,
			expires: new Date(now() + route.ttl * 1000).toUTCString(),
			'last-modified': new Date(now()).toUTCString(),
			'x-compatibility-date': '2020-01-01',
		};
		if (pages !== null) out['x-pages'] = String(pages);
		const notModified = headers['if-none-match'] === etag;
		if (route.group) {
			const key = `${owner}|${route.group}`;
			const spent = (used.get(key) || 0) + (notModified ? 1 : 2);
			used.set(key, spent);
			out['x-ratelimit-group'] = route.group;
			out['x-ratelimit-limit'] = `${route.limit}/15m`;
			out['x-ratelimit-used'] = String(notModified ? 1 : 2);
			const override = fake.rateRemaining && fake.rateRemaining[route.group];
			out['x-ratelimit-remaining'] = String(override !== undefined && override !== null ? override : route.limit - spent);
		} else {
			out['x-esi-error-limit-remain'] = String(fake.errorLimitRemain);
			out['x-esi-error-limit-reset'] = '30';
		}
		if (notModified) return finish(new Response(null, { status: 304, headers: out }));
		return finish(new Response(text, { status: 200, headers: { 'content-type': 'application/json; charset=UTF-8', ...out } }));
	};

	fake.callsTo = (re) => calls.filter(call => re.test(call.path));
	fake.reset = () => {
		calls.length = 0;
	};
	return fake;
};

// ---- hand-made rows, shaped like the ESI answers (field types from the Phase 2 samples)

const tx = (id, o = {}) => ({
	client_id: 90000999,
	date: '2026-11-19T10:00:00Z',
	is_buy: true,
	is_personal: true,
	journal_ref_id: id + 1000,
	location_id: 60003760,
	quantity: 10,
	transaction_id: id,
	type_id: 34,
	unit_price: 5,
	...o,
});
const journalRow = (id, o = {}) => ({
	amount: -50,
	balance: 1000000,
	context_id: 5000,
	context_id_type: 'market_transaction_id',
	date: '2026-11-19T10:00:00Z',
	description: 'Market escrow release',
	first_party_id: 90000001,
	id,
	reason: '',
	ref_type: 'market_escrow',
	second_party_id: 90000001,
	...o,
});
const order = (id, o = {}) => ({
	duration: 90,
	is_corporation: false,
	issued: '2026-11-18T10:00:00Z',
	location_id: 60008494,
	order_id: id,
	price: 1000,
	range: 'region',
	region_id: 10000043,
	type_id: 34,
	volume_remain: 5,
	volume_total: 10,
	...o,
});
const historyOrder = (id, o = {}) => order(id, { state: 'expired', volume_remain: 0, ...o });
const asset = (id, o = {}) => ({
	is_singleton: false,
	item_id: id,
	location_flag: 'Hangar',
	location_id: 60003760,
	location_type: 'station',
	quantity: 100,
	type_id: 34,
	...o,
});
const contract = (id, o = {}) => ({
	acceptor_id: 90000002,
	assignee_id: 90000002,
	availability: 'personal',
	collateral: 0,
	contract_id: id,
	date_accepted: '2026-11-18T10:01:00Z',
	date_completed: '2026-11-18T10:01:00Z',
	date_expired: '2026-11-25T10:00:00Z',
	date_issued: '2026-11-18T10:00:00Z',
	days_to_complete: 0,
	end_location_id: 60003760,
	for_corporation: false,
	issuer_corporation_id: 1000115,
	issuer_id: 90000001,
	price: 1000000,
	reward: 0,
	start_location_id: 60003760,
	status: 'finished',
	title: '',
	type: 'item_exchange',
	volume: 13.07,
	...o,
});
const contractItem = (recordId, typeId, quantity) => ({ is_included: true, is_singleton: false, quantity, record_id: recordId, type_id: typeId });

module.exports = {
	ALL_SCOPES,
	START,
	makeClock,
	tmpDataDir,
	makeLog,
	makeTokens,
	createFakeEsi,
	tx,
	journalRow,
	order,
	historyOrder,
	asset,
	contract,
	contractItem,
};
