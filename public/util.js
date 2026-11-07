// util.js: ESI / Fuzzwork fetching with a local file cache (/file/:path on the Express server).
//
// Remote fetches all go through a request queue (default: 30 in flight, honours ESI
// error-limit headers, pauses on HTTP 420). Local /file/ cache reads/writes bypass the queue.
//
// Cancellation: every network-touching function (getOrFetch, fetchWithRetries, getOrders,
// getDays, getTypeIds, getTypeName, getTypeM3, getTypeIdByName, getFuzzworkPricesInRegion,
// wallet getters) takes an optional trailing `options` object: `{signal, queue}`.
// Alternatively call `util.setAbortSignal(signal)` once per run (pass null to clear); it is
// used whenever no per-call `options.signal` is given. Aborted work rejects with an Error whose
// `name === 'AbortError'` and is never retried. Callers should catch it (check `e.name`).
// Progress UI: `util.queueStats()` -> {inFlight, queued, done, failed, pausedUntil}.
const util = (() => {
	const saveJson = async (path, data) => {
		await fetch(`/file/${path}`, {
			method: 'POST',
			headers: {
			  'Accept': 'application/json',
			  'Content-Type': 'application/json'
			},
			body: JSON.stringify(data)
		});
	};
	
	const loadJson = async (path, hoursStaleLimit = -1) => {
		const url = `/file/${path}?hoursStaleLimit=${hoursStaleLimit}`
		return await fetch(url, {
			method: 'GET'
		}).then(
			res => res.status === 404 ? null : res.json(),
			() => {}
		);
	};
	
	//--- abort helpers
	
	const makeAbortError = () => {
		const error = new Error('Aborted');
		error.name = 'AbortError';
		return error;
	};
	
	let defaultSignal = null;
	const setAbortSignal = (signal) => {
		defaultSignal = signal || null;
	};
	const signalOf = (options) => (options && options.signal) || defaultSignal;
	const throwIfAborted = (signal) => {
		if (signal && signal.aborted) throw makeAbortError();
	};
	
	const sleep = (ms, signal = null) => new Promise((resolve, reject) => {
		if (signal && signal.aborted) return reject(makeAbortError());
		let onAbort = null;
		const timer = setTimeout(() => {
			if (signal) signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		if (signal) {
			onAbort = () => {
				clearTimeout(timer);
				reject(makeAbortError());
			};
			signal.addEventListener('abort', onAbort, { once: true });
		}
	});
	
	//--- request queue
	
	const createQueue = ({ concurrency = 30 } = {}) => {
		const pending = [];
		let inFlight = 0;
		let done = 0;
		let failed = 0;
		let pausedUntil = 0;
		let wakeTimer = null;
		let limit = concurrency;
		
		const pump = () => {
			if (wakeTimer !== null) {
				clearTimeout(wakeTimer);
				wakeTimer = null;
			}
			const now = Date.now();
			if (pausedUntil > now) {
				if (pending.length > 0) wakeTimer = setTimeout(pump, pausedUntil - now + 5);
				return;
			}
			while (inFlight < limit && pending.length > 0) {
				const item = pending.shift();
				if (item.signal) item.signal.removeEventListener('abort', item.onAbort);
				inFlight++;
				Promise.resolve().then(() => item.task(item.signal)).then(item.resolve, item.reject).finally(() => {
					inFlight--;
					pump();
				});
			}
		};
		
		// Enqueue task (a function returning a promise). Resolves/rejects with the task's outcome.
		const add = (task, { signal = null } = {}) => new Promise((resolve, reject) => {
			if (signal && signal.aborted) return reject(makeAbortError());
			const item = { task, resolve, reject, signal, onAbort: null };
			if (signal) {
				item.onAbort = () => {
					const i = pending.indexOf(item);
					if (i !== -1) {
						pending.splice(i, 1);
						reject(makeAbortError());
					}
				};
				signal.addEventListener('abort', item.onAbort, { once: true });
			}
			pending.push(item);
			pump();
		});
		
		const pauseUntil = (timestampMs) => {
			if (timestampMs > pausedUntil) pausedUntil = timestampMs;
			pump();
		};
		
		return {
			add,
			pauseUntil,
			setConcurrency: (n) => { limit = n; pump(); },
			recordDone: () => { done++; },
			recordFailed: () => { failed++; },
			stats: () => ({
				inFlight,
				queued: pending.length,
				done,
				failed,
				pausedUntil: pausedUntil > Date.now() ? pausedUntil : null
			})
		};
	};
	
	const defaultQueue = createQueue({ concurrency: 30 });
	const queueStats = () => defaultQueue.stats();
	
	//--- fetching
	
	const ESI_ERROR_LIMIT_MIN_REMAINING = 20;
	const MAX_ATTEMPTS = 5;
	const BASE_BACKOFF_MS = 500;
	
	const isEsi = (url) => url.startsWith('https://esi.evetech.net');
	let consecutive429 = 0;
	
	// Single network attempt, run inside a queue slot. Never throws except on abort.
	// Resolves {kind: 'ok'|'notFound'|'pause'|'fail', data, headers}.
	const attemptFetch = async (url, fetchOptions, queue, signal) => {
		let res;
		try {
			res = await fetch(url, signal ? { ...fetchOptions, signal } : fetchOptions);
		} catch (error) {
			if ((signal && signal.aborted) || (error && error.name === 'AbortError')) throw makeAbortError();
			console.log(`fetch failed for ${url}: `, error && error.message);
			return { kind: 'fail' };
		}
		
		const headers = res.headers;
		const esi = isEsi(url);
		if (esi) {
			const remain = parseInt(headers.get('X-ESI-Error-Limit-Remain'), 10);
			const reset = parseInt(headers.get('X-ESI-Error-Limit-Reset'), 10);
			if (!isNaN(remain) && !isNaN(reset) && remain < ESI_ERROR_LIMIT_MIN_REMAINING) {
				queue.pauseUntil(Date.now() + reset * 1000);
			}
		}
		
		if (res.status === 420) {
			const reset = parseInt(headers.get('X-ESI-Error-Limit-Reset'), 10);
			queue.pauseUntil(Date.now() + (isNaN(reset) ? 60 : reset) * 1000);
			return { kind: 'pause' };
		}
		if (res.status === 429) {
			// Rate limited (ESI's per-endpoint limits, e.g. market history). Honour Retry-After when
			// present; otherwise back off progressively while 429s keep coming.
			const retryAfter = parseInt(headers.get('Retry-After'), 10);
			consecutive429++;
			const waitSec = !isNaN(retryAfter) && retryAfter > 0
				? retryAfter
				: Math.min(60, 5 * Math.pow(2, consecutive429 - 1));
			console.log(`429 from ${url}; pausing ${waitSec}s`);
			queue.pauseUntil(Date.now() + waitSec * 1000);
			return { kind: 'pause' };
		}
		consecutive429 = 0;
		if (res.status === 404 && esi) return { kind: 'notFound', headers };
		if (!res.ok) {
			console.log(`GET failed. status ${res.status} for ${url}`);
			return { kind: 'fail' };
		}
		
		try {
			const data = await res.json();
			if (data && data.error) {
				console.log('GET failed. data.error: ', data.error);
				return { kind: 'fail' };
			}
			return { kind: 'ok', data, headers };
		} catch (error) {
			if ((signal && signal.aborted) || (error && error.name === 'AbortError')) throw makeAbortError();
			console.log(`bad response body for ${url}: `, error && error.message);
			return { kind: 'fail' };
		}
	};
	
	// Like fetchWithRetries but resolves {data, headers} (headers is a fetch Headers or null).
	const fetchWithRetriesRaw = async (url, accessToken = null, postBody = null, options = {}) => {
		const signal = signalOf(options);
		const queue = (options && options.queue) || defaultQueue;
		const headers = {};
		if (accessToken) {
			headers['Authorization'] = `Bearer ${accessToken}`;
		}
		const fetchOptions = {
			method: postBody ? 'post' : 'get',
			headers
		};
		if (postBody) {
			headers['Content-Type'] = 'application/json';
			headers['Accept'] = 'application/json';
			fetchOptions.body = JSON.stringify(postBody);
		}
		
		let failures = 0;
		while (failures < MAX_ATTEMPTS) {
			const result = await queue.add(() => attemptFetch(url, fetchOptions, queue, signal), { signal });
			if (result.kind === 'ok' || result.kind === 'notFound') {
				queue.recordDone();
				return { data: result.kind === 'ok' ? result.data : null, headers: result.headers || null };
			}
			if (result.kind === 'pause') {
				// Queue is paused until the ESI error window resets; retry without consuming an attempt.
				continue;
			}
			
			failures++;
			if (failures < MAX_ATTEMPTS) {
				const backoff = BASE_BACKOFF_MS * Math.pow(2, failures - 1);
				console.log(`retrying ${url}`);
				await sleep(backoff * (0.75 + Math.random() * 0.5), signal);
			}
		}
		
		console.error('fetchWithRetries() exhausted retry limit');
		queue.recordFailed();
		return { data: null, headers: null };
	};
	
	const fetchWithRetries = async (url, accessToken = null, postBody = null, options = {}) => {
		return (await fetchWithRetriesRaw(url, accessToken, postBody, options)).data;
	};
	
	// Resolves {data, headers}; headers is null when data came from the local cache.
	// Concurrent calls for the same URL share one in-flight request.
	const inFlightByUrl = new Map();
	const getOrFetchRaw = (url, hoursStaleLimit = -1, accessToken = null, options = {}) => {
		const existing = inFlightByUrl.get(url);
		if (existing) return existing;
		const promise = getOrFetchRawUncached(url, hoursStaleLimit, accessToken, options)
			.finally(() => { if (inFlightByUrl.get(url) === promise) inFlightByUrl.delete(url); });
		inFlightByUrl.set(url, promise);
		if (options && options.onEach) promise.then(() => options.onEach(), () => options.onEach());
		return promise;
	};
	const getOrFetchRawUncached = async (url, hoursStaleLimit = -1, accessToken = null, options = {}) => {
		const signal = signalOf(options);
		throwIfAborted(signal);
		const path = `${url.replace(/[^a-zA-Z0-9]+/g, '')}.json`;
		try {
			const cachedData = await loadJson(path, hoursStaleLimit);
			if (cachedData && cachedData.error) throw "cached data had error";
			if (cachedData) return { data: cachedData, headers: null };	
		} catch (reason) {
			console.log('getOrFetch caught reason: ', reason);
		}
		throwIfAborted(signal);
		
		const result = await fetchWithRetriesRaw(url, accessToken, null, options);
		throwIfAborted(signal);
		await saveJson(path, result.data);
		return result;
	};
	
	const getOrFetch = async (url, hoursStaleLimit = -1, accessToken = null, options = {}) => {
		return (await getOrFetchRaw(url, hoursStaleLimit, accessToken, options)).data;
	};
	
	//---
	
	// Fetches every page of a paginated ESI resource. Page 1's X-Pages header decides the page
	// count; when page 1 comes from the local cache the count saved alongside it is used (else
	// fallbackPages). Resolves the array of page bodies (null for a failed page).
	const getAllPages = async (urlForPage, hoursStaleLimit, pagesPath, fallbackPages, options = {}) => {
		const first = await getOrFetchRaw(urlForPage(1), hoursStaleLimit, null, options);
		let pages = fallbackPages;
		const headerPages = first.headers ? parseInt(first.headers.get('X-Pages'), 10) : NaN;
		if (!isNaN(headerPages) && headerPages > 0) {
			pages = headerPages;
			await saveJson(pagesPath, { pages });
		} else if (!first.headers) {
			const saved = await loadJson(pagesPath, hoursStaleLimit).catch(() => null);
			if (saved && saved.pages > 0) pages = saved.pages;
		}
		if (options && options.onTotal) options.onTotal(pages);
		const promises = [Promise.resolve(first.data)];
		for (let p = 2; p <= pages; p++) {
			promises.push(getOrFetch(urlForPage(p), hoursStaleLimit, null, options));
		}
		return Promise.all(promises);
	};
	
	const getTypeIds = async (regionId, options = {}) => {
		const urlForPage = p => `https://esi.evetech.net/latest/markets/${regionId}/types/?datasource=tranquility&page=${p}`;
		const pages = await getAllPages(urlForPage, 8, `marketTypesPages${regionId}.json`, 16, options);
		return pages.filter(result => Array.isArray(result)).flat();
	};
	
	// Every order in a region (both sides unless orderType is 'buy'/'sell'), as one flat array.
	// A few hundred requests for a big region, versus one per type: use this when many types are
	// needed, since ESI's market-order rate limit (12000 per 15 min per IP) counts requests.
	// Pages are a snapshot taken over a few seconds; orders can shift between pages meanwhile.
	// onPage(doneCount, totalCount) reports progress (totalCount is null until page 1 has answered).
	const getRegionOrders = async (regionId, orderType = 'all', hoursStaleLimit = 0.5, options = {}, onPage = null) => {
		const urlForPage = p => `https://esi.evetech.net/latest/markets/${regionId}/orders/?datasource=tranquility&order_type=${orderType}&page=${p}`;
		let done = 0;
		let total = null;
		const wrapped = onPage
			? { ...options, onEach: () => onPage(++done, total), onTotal: (t) => { total = t; onPage(done, total); } }
			: options;
		const pages = await getAllPages(urlForPage, hoursStaleLimit, `marketOrdersPages${regionId}${orderType}.json`, 1, wrapped);
		const failed = pages.filter(page => !Array.isArray(page)).length;
		if (failed > 0) console.warn(`getRegionOrders(${regionId}): ${failed} of ${pages.length} pages failed`);
		return pages.filter(page => Array.isArray(page)).flat();
	};
	
	const getDays = async (regionId, typeId, options = {}) => {
		// const url = `https://esi.evetech.net/latest/markets/${regionId}/history/?datasource=tranquility&type_id=${typeId}`;
		const url = `https://esi.evetech.net/markets/${regionId}/history?type_id=${typeId}`;
		const days = await getOrFetch(url, 24, null, options);
		return Array.isArray(days)
			? days
			: [];
	};
	
	const getOrders = async (regionId, typeId, orderType = 'all', hoursStaleLimit = 0.5, options = {}) => {
		const url = `https://esi.evetech.net/latest/markets/${regionId}/orders/?datasource=tranquility&type_id=${typeId}&order_type=${orderType}`;
		const orders = await getOrFetch(url, hoursStaleLimit, null, options);
		return Array.isArray(orders)
			? orders
			: [];
	};
	
	const getCharacterWalletTransactions = async (characterId, accessToken, hoursStaleLimit = 0.05*100, options = {}) => {
		const url = `https://esi.evetech.net/latest/characters/${characterId}/wallet/transactions/?datasource=tranquility`;
		const transactions = await getOrFetch(url, hoursStaleLimit, accessToken, options);
		return Array.isArray(transactions)
			? transactions
			: [];
	};
	
	const getCharacterWalletJournals = async (characterId, accessToken, hoursStaleLimit = 0.05*100, options = {}) => {
		const journals = [];
		for (let p = 1; p <= 100; p++) {
			const url = `https://esi.evetech.net/latest/characters/${characterId}/wallet/journal/?datasource=tranquility&page=${p}`;
			const journalsPage = await getOrFetch(url, hoursStaleLimit, accessToken, options);
			if (journalsPage && !journalsPage.error) {
				journals.push(...journalsPage);
			} else {
				console.log('break on journal page ', p);
				break;
			}
		}
		
		return journals;
	};

	//---

	const getFuzzworkPricesInRegion = async (regionId, typeIds, hoursStaleLimit = 0.5, options = {}) => {
		const FUZZ_STEP_SIZE = 25;
		const fuzzPricesByTypeIdFragments = [];
		for (let step = 0; step * FUZZ_STEP_SIZE < typeIds.length; step++) {
			const typeIdsSlice = typeIds.slice(step * FUZZ_STEP_SIZE, (step + 1) * FUZZ_STEP_SIZE);
			const url = `https://market.fuzzwork.co.uk/aggregates/?region=${regionId}&types=${typeIdsSlice.join(',')}`;
			fuzzPricesByTypeIdFragments.push(await getOrFetch(url, hoursStaleLimit, null, options));
		}

		const fuzzPricesByTypeId = Object.assign({}, ...fuzzPricesByTypeIdFragments);
		return fuzzPricesByTypeId;
	};

	//---
	
	const roundNonZero = (num, nonZeroDigits = 2) => {
		const numStr = '' + num;
		if (numStr.indexOf('e') !== -1) return numStr;
	
		const index = numStr.search(/[^\.0]/);
		if (index === -1) return numStr;
	
		const dotIndex = numStr.indexOf('.');
		const end = Math.max(
			index + nonZeroDigits,
			dotIndex === -1
				? numStr.length
				: dotIndex + (
					num < Math.pow(10, nonZeroDigits)
						? nonZeroDigits
						: 0
				)
		);
		return numStr.substring(0, end);
	};
	
	const roundMils = (amount, nonZeroDigits = 2) => {
		return roundNonZero(amount / 1000000, nonZeroDigits);
	};
	
	const avg = (list) => {
		return list.reduce((acc, cur) => acc + cur, 0) / list.length;
	};

	const typeIdByName = {};
	const getTypeIdByName = async (typeName, options = {}) => {
		if (!typeIdByName[typeName]) {
			const url = `https://esi.evetech.net/universe/ids`;
			const res = await fetchWithRetries(url, null, [typeName], options);
			if (!res || !res.inventory_types) return null;
			const typeId = res.inventory_types[0].id;
			typeIdByName[typeName] = typeId;
		}

		return typeIdByName[typeName];
	}
	
	const typeNameById = {};
	const getTypeName = async (typeId, options = {}) => {
		if (!typeNameById[typeId]) {
			const url = `https://esi.evetech.net/latest/universe/types/${typeId}/?datasource=tranquility&language=en`;
			const type = await getOrFetch(url, 24*7, null, options);
			typeNameById[typeId] = type.name;
		}
	
		return typeNameById[typeId];
	};
	
	const typeM3ById = {};
	const getTypeM3 = async (typeId, options = {}) => {
		if (!typeM3ById[typeId]) {
			const url = `https://esi.evetech.net/latest/universe/types/${typeId}/?datasource=tranquility&language=en`;
			const type = await getOrFetch(url, 24*7, null, options);
			typeM3ById[typeId] = type.packaged_volume;
		}
	
		return typeM3ById[typeId];
	};
	
	return {
		getTypeIds,
		getRegionOrders,
		getDays,
		getOrders,
		getCharacterWalletTransactions,
		getCharacterWalletJournals,
		roundNonZero,
		roundMils,
		avg,
		getTypeIdByName,
		getTypeName,
		getTypeM3,
		getFuzzworkPricesInRegion,
		createQueue,
		queueStats,
		setAbortSignal,
		fetchWithRetries,
		getOrFetch,

		constants: {
			JITA_REGION_ID: 10000002, //The Forge
			AMARR_REGION_ID: 10000043, //Domain
			DODIXIE_REGION_ID: 10000032, //Sinq Laison
			RENS_REGION_ID: 10000030, //Heimatar
			STACMON_REGION_ID: 10000057, //Placid
			// HEK_REGION_ID: 10000042, //Metropolis
			
			JITA_STATION_ID: 60003760,
			AMARR_STATION_ID: 60008494,
			DODIXIE_STATION_ID: 60011866,
			RENS_STATION_ID: 60004588,
			STACMON_STATION_ID: 60011893,
	
			SELL_TAX: 0.08 + 0.024,
			BUY_TAX: 0.024
		}
	};
})();