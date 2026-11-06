// export.js: pipeline (runReport) + page UI for export.html.
// Every displayed number comes from ESI (station orders + region history) via estimate.js.
// Fuzzwork aggregates are used ONLY for triage (deciding which types get a full report).
const {
	roundNonZero,
	constants: {
		JITA_REGION_ID,
		AMARR_REGION_ID,
		DODIXIE_REGION_ID,
		RENS_REGION_ID,
		STACMON_REGION_ID,

		JITA_STATION_ID,
		AMARR_STATION_ID,
		DODIXIE_STATION_ID,
		RENS_STATION_ID,
		STACMON_STATION_ID,

		SELL_TAX
	}
} = util;

const STATIONS = {
	Jita: { regionId: JITA_REGION_ID, stationId: JITA_STATION_ID },
	Amarr: { regionId: AMARR_REGION_ID, stationId: AMARR_STATION_ID },
	Dodixie: { regionId: DODIXIE_REGION_ID, stationId: DODIXIE_STATION_ID },
	Rens: { regionId: RENS_REGION_ID, stationId: RENS_STATION_ID },
	Stacmon: { regionId: STACMON_REGION_ID, stationId: STACMON_STATION_ID }
};

const DAYS_CONSIDERED = 30;
const DAYS_TO_COMPLETE = 5;
const HAULING_REWARD_FRACTION = 0.10;
const COST_LIMIT = 10 * Math.pow(10, 9);
const MIN_ROI = 1.5;

const ignoreOneActiveSellerForTypeIds = [
	//Max
	// 31484, //Small Energy Locus Coordinator II (31484)
	// 56066, //Glorification-5 'Devana' Filament (56066) 
	// 18797, //Coreli A-Type Thermal Coating (18797)
	// 61203, //Common Moon Mining Crystal Type B II (61203)
	// 28282, //'Integrated' Infiltrator (28282)
	// 19229, //Pithum A-Type Kinetic Shield Amplifier (19229)

	//Taymor
	// 49099, //Zero-Point Mass Entangler (49099)
	// 34306, //Large Higgs Anchor I (34306)
	// 12221, //Medium Remote Capacitor Transmitter II (12221)
	// 34290, //Polarized Rocket Launcher (34290)
	// 34278, // Polarized Light Neutron Blaster (34278)
];

// Seeds the always-show textarea the first time the page is opened; after that the list lives in the UI.
const DEFAULT_ALWAYS_SHOW_NAMES = [
	// 'Blood Silver Tag',
	// 'Corelum B-Type Thermal Energized Membrane',
	// 'Gravid Ice Harvester Mutaplasmid',
	// 'Large Projectile Metastasis Adjuster II',
	// 'Lattice Locked Dekaisogen',
	// 'Mobile Phase Anchor',
	// 'Small Pulse Laser Battery',
	// 'Standup Ballistic Control System I',
	// 'Standup Radar ECM Script',
	// 'Trinary State Processor',
	// 'Void XL',

	// 'Domination Torpedo Launcher',
	// 'Variegated Asteroid Mining Crystal Type B I',
];

const isAbort = (e) => !!e && e.name === 'AbortError';

//--- pipeline

// Runs one report. Calls onRow({typeId, name, m3, report, isAlwaysShow}) for every report (filtered ones too).
// Calls onProgress at least every 500ms.
// Fetches the ESI data for one type and computes its report.
// Resolves {typeId, name, m3, report, isAlwaysShow}; report is null when there is nothing to buy.
// options ({signal, queue}) is passed through to util so callers can use their own request queue.
const buildRow = async ({ start, end, typeId, isAlwaysShow, options = {} }) => {
	const srcOrders = (await util.getOrders(start.regionId, typeId, 'sell', 0.5, options)).filter(o => o.location_id === start.stationId);
	const destOrders = (await util.getOrders(end.regionId, typeId, 'sell', 0.5, options)).filter(o => o.location_id === end.stationId);
	const destDays = await util.getDays(end.regionId, typeId, options);
	const m3 = await util.getTypeM3(typeId, options);
	const name = await util.getTypeName(typeId, options);
	const report = estimate.computeItemReport({
		srcOrders,
		destOrders,
		destDays,
		typeId,
		config: {
			DAYS_CONSIDERED,
			DAYS_TO_COMPLETE,
			HAULING_REWARD_FRACTION,
			COST_LIMIT,
			MIN_ROI,
			SELL_TAX,
			isAlwaysShow,
			ignoreOneActiveSeller: ignoreOneActiveSellerForTypeIds.includes(typeId)
		}
	});
	return { typeId, name, m3, report, isAlwaysShow };
};

// Resolves item names to type ids. Resolves {ids: Set, unresolved: [names]}.
const resolveTypeNames = async (names, options = {}) => {
	const ids = new Set();
	const unresolved = [];
	const results = await Promise.all(names.map(name => util.getTypeIdByName(name, options).catch(e => { if (isAbort(e)) throw e; return null; })));
	results.forEach((typeId, i) => {
		if (typeId === null || typeId === undefined) unresolved.push(names[i]);
		else ids.add(typeId);
	});
	return { ids, unresolved };
};

// alwaysShowIds: already-resolved type ids to report regardless of triage/filters. isAlwaysShow(typeId) is
// consulted when each report is built, so the caller may change the set while the run is going.
const runReport = async ({ startStationKey, endStationKey, alwaysShowIds = new Set(), isAlwaysShow = (id) => alwaysShowIds.has(id), signal, onRow = () => {}, onProgress = () => {} }) => {
	const start = STATIONS[startStationKey];
	const end = STATIONS[endStationKey];
	if (!start || !end) throw new Error(`unknown station (${startStationKey} -> ${endStationKey})`);

	const startedAt = Date.now();
	const progress = {
		typesTotal: 0,
		triaged: 0,
		triagePassed: 0,
		reportsDone: 0,
		reportsFailed: 0,
		rowsShown: 0,
		rowsFiltered: 0,
		noReport: 0,
		phase: 'typeIds'
	};
	const emit = () => onProgress({
		...progress,
		queue: util.queueStats(),
		elapsedMs: Date.now() - startedAt
	});
	const timer = setInterval(emit, 250);
	const aborted = () => !!(signal && signal.aborted);

	util.setAbortSignal(signal);
	try {
		emit();
		const typeIds = (await util.getTypeIds(end.regionId)).slice();

		const alwaysShowIdSet = new Set(alwaysShowIds);
		for (const typeId of alwaysShowIdSet) {
			if (!typeIds.includes(typeId)) typeIds.push(typeId);
		}

		progress.typesTotal = typeIds.length;
		progress.phase = 'running';
		emit();

		// The util queue is FIFO, so starting thousands of report tasks at once would run every task's
		// first request before any task's second one and rows would only appear at the very end.
		// Cap the number of report tasks in progress so rows stream in steadily.
		const MAX_ACTIVE_REPORTS = 40;
		let activeReports = 0;
		const waiting = [];
		const reportPromises = [];
		const acquire = () => {
			if (activeReports < MAX_ACTIVE_REPORTS) { activeReports++; return Promise.resolve(); }
			return new Promise(resolve => waiting.push(resolve));
		};
		const release = () => {
			const next = waiting.shift();
			if (next) next(); else activeReports--;
		};
		const startReport = (typeId) => {
			if (aborted()) return;
			const task = (async () => {
				await acquire();
				try {
					if (aborted()) return;
					const row = await buildRow({ start, end, typeId, isAlwaysShow: isAlwaysShow(typeId) });
					progress.reportsDone++;
					if (!row.report) {
						progress.noReport++;
						return;
					}
					if (row.report.filteredReason) progress.rowsFiltered++;
					else progress.rowsShown++;
					onRow(row);
				} catch (e) {
					if (isAbort(e)) return;
					console.error(`report failed (typeId: ${typeId})`, e);
					progress.reportsFailed++;
				} finally {
					release();
				}
			})();
			reportPromises.push(task);
		};

		// Always-show types skip triage.
		for (const typeId of alwaysShowIdSet) {
			progress.triaged++;
			progress.triagePassed++;
			startReport(typeId);
		}

		// Triage chunks of 25, all kicked off at once (the util queue caps concurrency).
		const chunks = [];
		const triageIds = typeIds.filter(id => !alwaysShowIdSet.has(id));
		for (let i = 0; i < triageIds.length; i += 25) chunks.push(triageIds.slice(i, i + 25));

		await Promise.all(chunks.map(async (chunk) => {
			try {
				const [srcFuzzByTypeId, destFuzzByTypeId] = await Promise.all([
					util.getFuzzworkPricesInRegion(start.regionId, chunk),
					util.getFuzzworkPricesInRegion(end.regionId, chunk)
				]);
				for (const typeId of chunk) {
					if (aborted()) break;
					progress.triaged++;
					const srcFuzzPrice = +(srcFuzzByTypeId?.[typeId]?.sell?.min ?? 0);
					const destFuzzPrice = +(destFuzzByTypeId?.[typeId]?.sell?.min ?? 0);
					if (!srcFuzzPrice || !destFuzzPrice) {
						console.warn(`${typeId} fuzz no price (src: ${srcFuzzPrice}, dest: ${destFuzzPrice})`);
						continue;
					}
					if (destFuzzPrice < srcFuzzPrice) {
						console.log(`${typeId} fuzz negative spread (src: ${util.roundMils(srcFuzzPrice)}, dest: ${util.roundMils(destFuzzPrice)})`);
						continue;
					}
					if (destFuzzPrice < srcFuzzPrice * MIN_ROI) {
						// Fuzz margin too slim
						console.log(`${typeId} fuzz margin too slim (${Math.round(100 * destFuzzPrice / srcFuzzPrice) / 100}x)`);
						continue;
					}
					console.log(`${typeId} fuzz margin ok (${Math.round(100 * destFuzzPrice / srcFuzzPrice) / 100}x)`);
					progress.triagePassed++;
					startReport(typeId);
				}
			} catch (e) {
				if (isAbort(e)) return;
				console.error('triage chunk failed', e);
				progress.triaged += chunk.length;
			}
		}));

		await Promise.all(reportPromises);
		progress.phase = aborted() ? 'stopped' : 'done';
	} catch (e) {
		if (isAbort(e) || aborted()) progress.phase = 'stopped';
		else {
			console.error('runReport failed', e);
			progress.phase = 'error';
		}
	} finally {
		clearInterval(timer);
		util.setAbortSignal(null);
		emit();
	}
};

//--- UI

(() => {
	if (typeof document === 'undefined') return;

	const $ = (sel) => document.querySelector(sel);
	const nf = new Intl.NumberFormat('en-US');
	const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

	//--- localStorage (guarded)
	const PREFIX = 'eflip.export.';
	const lsGet = (key, fallback) => {
		try {
			const raw = localStorage.getItem(PREFIX + key);
			return raw === null ? fallback : JSON.parse(raw);
		} catch (e) { return fallback; }
	};
	const lsSet = (key, val) => {
		try { localStorage.setItem(PREFIX + key, JSON.stringify(val)); } catch (e) { /* ignore */ }
	};

	//--- elements
	const startSel = $('#startStation');
	const endSel = $('#endStation');
	const runBtn = $('#run');
	const stopBtn = $('#stop');
	const autoRunChk = $('#autoRun');
	const globalFactorInput = $('#globalFactor');
	const showFilteredChk = $('#showFiltered');
	const searchInput = $('#search');
	const copyBtn = $('#copy');
	const progressElem = $('#progress');
	const headerElem = $('#reportHeader');
	const tableElem = $('#table');
	const theadElem = $('#table thead');
	const tbodyElem = $('#table tbody');
	const sumsElem = $('#sums');
	const totalsElem = $('#totals');
	const alwaysShowText = $('#alwaysShowText');
	const alwaysShowNote = $('#alwaysShowNote');

	// The totals strip is sticky at the top; the table header sticks just below it.
	const updateStickyOffset = () => {
		document.documentElement.style.setProperty('--sticky-offset', totalsElem.offsetHeight + 'px');
		document.documentElement.style.setProperty('--head-h', $('#sortRow').offsetHeight + 'px');
	};
	if (typeof ResizeObserver !== 'undefined') {
		const ro = new ResizeObserver(updateStickyOffset);
		ro.observe(totalsElem);
		ro.observe($('#sortRow'));
	}
	updateStickyOffset();

	const stationNames = Object.keys(STATIONS);
	for (const sel of [startSel, endSel]) {
		for (const name of stationNames) sel.add(new Option(name, name));
	}
	const savedRoute = lsGet('route', { start: 'Jita', end: 'Amarr' });
	startSel.value = STATIONS[savedRoute.start] ? savedRoute.start : 'Jita';
	endSel.value = STATIONS[savedRoute.end] ? savedRoute.end : 'Amarr';
	if (startSel.value === endSel.value) endSel.value = startSel.value === 'Amarr' ? 'Jita' : 'Amarr';

	//--- state
	let routeKey = '';
	let rows = [];            // all rows of the current run
	let rowByTypeId = new Map();
	let selected = new Set(); // type ids (current route)
	let factorOverrides = {}; // typeId -> factor (current route)
	let globalFactor = +lsGet('globalFactor', 1);
	if (!(globalFactor >= 0)) globalFactor = 1;
	let sort = lsGet('sort', { key: 'dailyProfitMil', dir: 'desc' });
	let showFiltered = !!lsGet('showFiltered', false);
	let pendingRender = false;
	let renderTimer = null;
	let lastRenderAt = 0;
	let currentRun = null; // {controller}
	let reportGeneratedAt = null;

	const route = () => `${startSel.value}-${endSel.value}`;
	const loadRouteState = () => {
		routeKey = route();
		selected = new Set(lsGet(`selected.${routeKey}`, []));
		factorOverrides = lsGet(`factors.${routeKey}`, {});
	};
	const saveSelected = () => lsSet(`selected.${routeKey}`, [...selected]);
	const saveFactors = () => lsSet(`factors.${routeKey}`, factorOverrides);

	//--- columns
	const fmtNum = (v) => v === null || v === undefined ? '' : nf.format(v);
	const fmtMil = (v) => v === null || v === undefined ? '' : String(v);
	const fmtRoi = (v) => v === null || v === undefined ? '' : nf2.format(v);
	const num = (v) => v === null || v === undefined ? null : +v;

	// quantity = what the Copy button writes (equals the recommended volume when factor is 1)
	const orderQty = (row) => Math.ceil(row.report.volume * row.factor);
	const orderCost = (row) => row.report.costPerItemMil * orderQty(row);
	const orderRevenue = (row) => row.report.revenuePerItemMil * orderQty(row);
	const km3Of = (row) => Math.ceil(orderQty(row) * (row.m3 || 0)) / 1000;

	// text: left aligned, sorts ascending first ; sort: custom sort value ; val/fmt: displayed number
	const COLUMNS = [
		{ key: 'select', label: '', sort: (r) => selected.has(r.typeId) ? 1 : 0 },
		{ key: 'name', label: 'name', sort: (r) => r.name.toLowerCase(), text: true },
		{ key: 'dailyProfitMil', label: 'daily profit', val: (r) => num(r.report.dailyProfitMil), fmt: fmtMil },
		{ key: 'roi', label: 'ROI', val: (r) => num(r.report.roi), fmt: fmtRoi },
		{ key: 'factor', label: 'factor', val: (r) => r.factor },
		{ key: 'qty', label: 'quantity', val: orderQty, fmt: fmtNum },
		{ key: 'daysOfSupply', label: 'days of supply', val: (r) => num(r.report.daysOfSupply), fmt: fmtRoi },
		{ key: 'activeSellers', label: 'active sellers', val: (r) => num(r.report.activeSellers), fmt: fmtNum },
		{ key: 'daysSinceSellerUpdate', label: 'days idle', val: (r) => num(r.report.daysSinceSellerUpdate), fmt: fmtRoi },
		{ key: 'km3', label: 'km3', val: km3Of, fmt: fmtNum },
		{ key: 'activeDaysFraction', label: 'active days', val: (r) => num(r.report.activeDaysFraction), fmt: fmtRoi },
		{ key: 'costPerItemMil', label: 'cost/item', val: (r) => num(r.report.costPerItemMil), fmt: fmtMil },
		{ key: 'revenuePerItemMil', label: 'revenue/item', val: (r) => num(r.report.revenuePerItemMil), fmt: fmtMil },
		{ key: 'daysToClear', label: 'days to clear', val: (r) => num(r.report.daysToClear), fmt: fmtRoi }
	];
	const sortValue = (col, row) => col.sort ? col.sort(row) : col.val(row);
	if (!COLUMNS.some(c => c.key === sort.key) || (sort.dir !== 'asc' && sort.dir !== 'desc')) {
		sort = { key: 'dailyProfitMil', dir: 'desc' };
	}

	const esc = (s) => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

	const sortRowElem = $('#sortRow');
	const filterRowElem = $('#filterRow');
	const renderHead = () => {
		sortRowElem.innerHTML = COLUMNS.map(col => {
			const active = sort.key === col.key;
			const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
			const cls = (col.text ? 'text ' : 'numeric ') + (active ? 'sorted' : '');
			return `<th class="${cls}" data-key="${col.key}">${esc(col.label)}${arrow}</th>`;
		}).join('');
	};

	//--- column filters: min/max per numeric column (blank = no limit); persisted globally.
	// Empty values pass. Selected rows and search matches ignore column filters.
	const FILTERABLE = (col) => !['select', 'name', 'factor'].includes(col.key);
	let colFilters = lsGet('colFilters', {});
	const passesColFilters = (row) => {
		for (const col of COLUMNS) {
			const f = colFilters[col.key];
			if (!f) continue;
			const v = col.val(row);
			if (v === null || v === undefined || Number.isNaN(v)) continue;
			if (f.min !== null && f.min !== undefined && v < f.min) return false;
			if (f.max !== null && f.max !== undefined && v > f.max) return false;
		}
		return true;
	};
	const buildFilterRow = () => {
		filterRowElem.innerHTML = COLUMNS.map(col => {
			if (col.key === 'name') return '<th class="text"><a href="#" id="clearFilters" title="clear all column filters">clear</a></th>';
			if (!FILTERABLE(col)) return '<th></th>';
			const f = colFilters[col.key] || {};
			const v = (x) => x === null || x === undefined ? '' : x;
			return `<th class="numeric">` +
				`<input type="number" step="any" placeholder="min" data-key="${col.key}" data-bound="min" value="${v(f.min)}" title="${esc(col.label)} min">` +
				`<input type="number" step="any" placeholder="max" data-key="${col.key}" data-bound="max" value="${v(f.max)}" title="${esc(col.label)} max">` +
				`</th>`;
		}).join('');
	};
	let colFilterTimer = null;
	filterRowElem.addEventListener('input', (e) => {
		const input = e.target;
		if (!input.dataset || !input.dataset.key) return;
		const n = parseFloat(input.value);
		const f = colFilters[input.dataset.key] || (colFilters[input.dataset.key] = { min: null, max: null });
		f[input.dataset.bound] = Number.isFinite(n) ? n : null;
		if (f.min === null && f.max === null) delete colFilters[input.dataset.key];
		lsSet('colFilters', colFilters);
		clearTimeout(colFilterTimer);
		colFilterTimer = setTimeout(render, 150);
	});
	filterRowElem.addEventListener('click', (e) => {
		if (e.target.id !== 'clearFilters') return;
		e.preventDefault();
		colFilters = {};
		lsSet('colFilters', colFilters);
		buildFilterRow();
		render();
	});

	//--- rows: one persistent <tr> per type id; created once, updated in place, moved/detached but never rebuilt
	const trByTypeId = new Map();

	const clearRows = () => {
		rows = [];
		rowByTypeId = new Map();
		trByTypeId.clear();
		tbodyElem.innerHTML = '';
	};

	const updateRowEl = (tr, row) => {
		const filtered = !!row.report.filteredReason;
		tr.classList.toggle('filtered', filtered);
		tr.classList.toggle('dim', filtered);
		tr.classList.toggle('alwaysShowItem', !!row.isAlwaysShow);
		const nameCell = tr.querySelector('td.nameCell');
		nameCell.title = row.report.filteredReason || '';
		for (const cell of tr.querySelectorAll('td[data-col]')) {
			const col = COLUMNS.find(c => c.key === cell.dataset.col);
			cell.textContent = col.fmt(col.val(row));
		}
		const factorInput = tr.querySelector('input.factor');
		if (document.activeElement !== factorInput && factorInput.value !== String(row.factor)) factorInput.value = row.factor;
	};

	const createRowEl = (row) => {
		const tr = document.createElement('tr');
		tr.dataset.typeId = row.typeId;
		for (const col of COLUMNS) {
			const td = document.createElement('td');
			switch (col.key) {
				case 'select': {
					td.className = 'sel';
					const box = document.createElement('input');
					box.type = 'checkbox';
					box.className = 'selbox';
					box.checked = selected.has(row.typeId);
					td.appendChild(box);
					break;
				}
				case 'name': {
					td.className = 'text nameCell';
					const nameSpan = document.createElement('span');
					nameSpan.className = 'name';
					nameSpan.textContent = row.name;
					const idSpan = document.createElement('span');
					idSpan.className = 'dim';
					idSpan.textContent = row.typeId;
					td.append(nameSpan, ' ', idSpan);
					break;
				}
				case 'factor': {
					td.className = 'numeric';
					const input = document.createElement('input');
					input.type = 'number';
					input.className = 'factor';
					input.step = '0.1';
					input.min = '0';
					td.appendChild(input);
					break;
				}
				default:
					td.className = 'numeric';
					td.dataset.col = col.key;
			}
			tr.appendChild(td);
		}
		trByTypeId.set(row.typeId, tr);
		updateRowEl(tr, row);
		return tr;
	};

	// selected rows are always visible; else a search matches every row (filtered ones too); else the estimate filter applies
	const isRowVisible = (row, query) => {
		if (selected.has(row.typeId)) return true;
		if (query) return row.name.toLowerCase().includes(query);
		return (showFiltered || !row.report.filteredReason) && passesColFilters(row);
	};

	const sortedVisibleRows = () => {
		const col = COLUMNS.find(c => c.key === sort.key);
		const dir = sort.dir === 'asc' ? 1 : -1;
		const query = searchInput.value.trim().toLowerCase();
		const list = rows.filter(r => isRowVisible(r, query));
		const keyed = list.map(r => ({ r, v: sortValue(col, r) }));
		keyed.sort((a, b) => {
			const an = a.v === null || a.v === undefined || Number.isNaN(a.v);
			const bn = b.v === null || b.v === undefined || Number.isNaN(b.v);
			if (an || bn) return an === bn ? 0 : (an ? 1 : -1); // nulls last regardless of direction
			if (a.v < b.v) return -dir;
			if (a.v > b.v) return dir;
			return 0;
		});
		return keyed.map(k => k.r);
	};

	const isEditing = () => {
		const el = document.activeElement;
		return !!el && tbodyElem.contains(el) && el.tagName === 'INPUT' && el.type === 'number';
	};

	const updateSums = () => {
		let cost = 0, revenue = 0, km3 = 0, count = 0, hiddenByColFilters = 0;
		for (const row of rows) {
			if (!selected.has(row.typeId) && !row.report.filteredReason && !passesColFilters(row)) hiddenByColFilters++;
			if (!selected.has(row.typeId)) continue;
			cost += orderCost(row);
			revenue += orderRevenue(row);
			km3 += km3Of(row);
			count++;
		}
		sumsElem.innerHTML =
			`${roundNonZero(revenue - cost)}` +
			`<span class="dim"> (-${roundNonZero(cost)} + ${roundNonZero(revenue)}) </span>` +
			`${roundNonZero(km3)}km3 <span class="dim">&middot; ${count} selected</span>` +
			(hiddenByColFilters ? `<span class="dim"> &middot; ${hiddenByColFilters} hidden by column filters</span>` : '');
	};

	const render = () => {
		pendingRender = false;
		lastRenderAt = Date.now();
		renderHead();
		const scrollY = window.scrollY;
		const ordered = sortedVisibleRows();
		const orderedIds = new Set(ordered.map(r => r.typeId));
		// detach hidden rows (kept in trByTypeId so they can come back)
		for (const [typeId, tr] of trByTypeId) {
			if (tr.parentNode && !orderedIds.has(typeId)) tr.remove();
		}
		// put visible rows in order, moving only the nodes that are out of place
		let cursor = tbodyElem.firstChild;
		for (const row of ordered) {
			const tr = trByTypeId.get(row.typeId) || createRowEl(row);
			if (tr === cursor) cursor = cursor.nextSibling;
			else tbodyElem.insertBefore(tr, cursor);
		}
		if (window.scrollY !== scrollY) window.scrollTo(window.scrollX, scrollY);
		updateSums();
	};

	// Throttled: at most one render per 500ms. Suspended while a row input is focused or while the
	// pointer is over the table (so rows never re-sort under a click); resumes on blur / mouseleave.
	let pointerInTable = false;
	let renderHeld = false;
	const scheduleRender = () => {
		if (pendingRender) return;
		pendingRender = true;
		const wait = Math.max(0, 500 - (Date.now() - lastRenderAt));
		renderTimer = setTimeout(() => {
			if (isEditing() || pointerInTable) { pendingRender = false; renderHeld = true; return; }
			render(); // (not requestAnimationFrame: it never fires in a hidden tab)
		}, wait);
	};
	const resumeRender = () => {
		if (renderHeld && !isEditing() && !pointerInTable) {
			renderHeld = false;
			scheduleRender();
		}
	};
	tableElem.addEventListener('mouseenter', () => { pointerInTable = true; });
	tableElem.addEventListener('mouseleave', () => { pointerInTable = false; resumeRender(); });

	//--- row events
	const rowFromEvent = (e) => {
		const tr = e.target.closest('tr[data-type-id]');
		return tr ? { tr, row: rowByTypeId.get(+tr.dataset.typeId) } : null;
	};

	tbodyElem.addEventListener('input', (e) => {
		if (!e.target.classList.contains('factor')) return;
		const hit = rowFromEvent(e);
		if (!hit || !hit.row) return;
		const { tr, row } = hit;
		const f = parseFloat(e.target.value);
		if (!(f >= 0)) return;
		row.factor = f;
		row.hasOverride = true;
		factorOverrides[row.typeId] = f;
		saveFactors();
		updateRowEl(tr, row);
		updateSums();
	});

	tbodyElem.addEventListener('change', (e) => {
		if (!e.target.classList.contains('selbox')) return;
		const hit = rowFromEvent(e);
		if (!hit || !hit.row) return;
		if (e.target.checked) selected.add(hit.row.typeId);
		else selected.delete(hit.row.typeId);
		saveSelected();
		updateSums(); // no re-render here: the row node stays put, hiding (if now unselected) happens on the next render
	});

	tbodyElem.addEventListener('focusout', () => {
		// let focus settle (tabbing between inputs of a row), then resume if not editing
		setTimeout(resumeRender, 0);
	});

	theadElem.addEventListener('click', (e) => {
		const th = e.target.closest('th[data-key]');
		if (!th) return;
		const key = th.dataset.key;
		if (sort.key === key) sort = { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' };
		else sort = { key, dir: COLUMNS.find(c => c.key === key).text ? 'asc' : 'desc' };
		lsSet('sort', sort);
		render();
	});

	//--- row intake (buffered)
	let rowBuffer = [];
	const addRow = ({ typeId, name, m3, report, isAlwaysShow }) => {
		rowBuffer.push({ typeId, name, m3, report, isAlwaysShow });
		scheduleFlush();
	};
	let flushTimer = null;
	const scheduleFlush = () => {
		if (flushTimer) return;
		flushTimer = setTimeout(() => {
			flushTimer = null;
			flushRows();
		}, 250);
	};
	const flushRows = () => {
		for (const r of rowBuffer) {
			const override = factorOverrides[r.typeId];
			const row = {
				...r,
				factor: override !== undefined ? override : globalFactor,
				hasOverride: override !== undefined
			};
			const existing = rowByTypeId.get(r.typeId);
			if (existing) rows[rows.indexOf(existing)] = row;
			else rows.push(row);
			rowByTypeId.set(r.typeId, row);
			const tr = trByTypeId.get(r.typeId);
			if (tr) updateRowEl(tr, row);
		}
		rowBuffer = [];
		scheduleRender();
	};

	//--- progress
	const fmtElapsed = (ms) => {
		const s = Math.floor(ms / 1000);
		const m = Math.floor(s / 60);
		return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
	};
	let lastProgress = null;
	const showProgress = (p) => {
		lastProgress = p;
		const q = p.queue || {};
		const parts = [];
		if (p.phase === 'typeIds') parts.push('loading type ids');
		else {
			parts.push(`triage ${p.triaged}/${p.typesTotal}`);
			parts.push(`reports ${p.reportsDone}/${p.triagePassed} done`);
			if (p.reportsFailed) parts.push(`${p.reportsFailed} failed`);
		}
		parts.push(`in flight ${q.inFlight ?? 0}`);
		parts.push(`queued ${q.queued ?? 0}`);
		if (q.pausedUntil && q.pausedUntil > Date.now()) parts.push(`paused ${Math.ceil((q.pausedUntil - Date.now()) / 1000)}s`);
		parts.push(fmtElapsed(p.elapsedMs));
		parts.push(`rows ${p.rowsShown}` + (p.rowsFiltered ? ` (+${p.rowsFiltered} filtered)` : ''));
		if (p.phase === 'done' || p.phase === 'stopped' || p.phase === 'error') parts.push(p.phase);
		progressElem.textContent = parts.join(' · ');
	};

	//--- run / stop
	const setRunning = (running) => {
		runBtn.disabled = running;
		stopBtn.disabled = !running;
		startSel.disabled = running;
		endSel.disabled = running;
	};

	const run = async () => {
		if (currentRun) return;
		if (startSel.value === endSel.value) return;
		loadRouteState();
		clearRows();
		rowBuffer = [];
		reportGeneratedAt = moment().format('MMM. Do, h:mm a');
		headerElem.innerHTML = `${esc(startSel.value)} &rarr; ${esc(endSel.value)} <span class="dim">${reportGeneratedAt}</span>`;
		render();

		const controller = new AbortController();
		currentRun = { controller };
		setRunning(true);
		try {
			await syncAlwaysShow({ refreshRows: false });
			await runReport({
				startStationKey: startSel.value,
				endStationKey: endSel.value,
				alwaysShowIds,
				isAlwaysShow: (id) => alwaysShowIds.has(id),
				signal: controller.signal,
				onRow: addRow,
				onProgress: showProgress
			});
		} finally {
			flushRows();
			currentRun = null;
			setRunning(false);
			// in-flight may still be draining after a stop; keep refreshing the stats briefly
			if (lastProgress) {
				const drain = setInterval(() => {
					const q = util.queueStats();
					showProgress({ ...lastProgress, queue: q });
					if (q.inFlight === 0 && q.queued === 0) clearInterval(drain);
				}, 500);
				setTimeout(() => clearInterval(drain), 30000);
			}
		}
	};

	runBtn.addEventListener('click', run);
	stopBtn.addEventListener('click', () => {
		if (currentRun) currentRun.controller.abort();
	});

	//--- controls
	const onRouteChange = (changed) => {
		const other = changed === startSel ? endSel : startSel;
		if (startSel.value === endSel.value) {
			// pick the first station that differs
			other.value = stationNames.find(n => n !== changed.value);
		}
		lsSet('route', { start: startSel.value, end: endSel.value });
		loadRouteState();
		clearRows();
		headerElem.textContent = '';
		render();
	};
	startSel.addEventListener('change', () => onRouteChange(startSel));
	endSel.addEventListener('change', () => onRouteChange(endSel));

	autoRunChk.checked = !!lsGet('autoRun', false);
	autoRunChk.addEventListener('change', () => lsSet('autoRun', autoRunChk.checked));

	globalFactorInput.value = globalFactor;
	globalFactorInput.addEventListener('input', () => {
		const f = parseFloat(globalFactorInput.value);
		if (!(f >= 0)) return;
		globalFactor = f;
		lsSet('globalFactor', f);
		for (const row of rows) {
			if (row.hasOverride) continue;
			row.factor = f;
			const tr = trByTypeId.get(row.typeId);
			if (tr) updateRowEl(tr, row);
		}
		render();
	});

	showFilteredChk.checked = showFiltered;
	showFilteredChk.addEventListener('change', () => {
		showFiltered = showFilteredChk.checked;
		lsSet('showFiltered', showFiltered);
		render();
	});

	searchInput.addEventListener('input', () => render());

	//--- copy orders
	const buildOrdersText = () => sortedVisibleRows()
		.filter(r => selected.has(r.typeId))
		.map(r => `${r.name}\t${orderQty(r)}`)
		.join('\n');
	window.getOrdersText = buildOrdersText; // for debugging / tests

	let copyTimer = null;
	copyBtn.addEventListener('click', async () => {
		copyBtn.classList.add('pending');
		try {
			await navigator.clipboard.writeText(buildOrdersText());
			copyBtn.textContent = 'Copied';
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => { copyBtn.textContent = 'Copy orders'; }, 1000);
		} catch (e) {
			console.error('clipboard write failed', e);
			copyBtn.textContent = 'Copy failed';
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => { copyBtn.textContent = 'Copy orders'; }, 1500);
		} finally {
			copyBtn.classList.remove('pending');
		}
	});

	//--- always-show list (textarea, persisted; seeded from DEFAULT_ALWAYS_SHOW_NAMES once)
	const alwaysShowNamesFromUi = () => [...new Set(
		alwaysShowText.value.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//'))
	)];
	const storedAlwaysShow = lsGet('alwaysShowNames', null);
	alwaysShowText.value = Array.isArray(storedAlwaysShow) ? storedAlwaysShow.join('\n') : DEFAULT_ALWAYS_SHOW_NAMES.join('\n');
	if (!Array.isArray(storedAlwaysShow)) lsSet('alwaysShowNames', alwaysShowNamesFromUi());

	// Edits apply live: names are resolved, the set is swapped, and every item that entered or left it
	// gets its report rebuilt (always-show bypasses the ROI stop and the filters, so the numbers change),
	// fetching a report for items the run never produced. Syncs are chained so edits never interleave.
	let alwaysShowIds = new Set();
	let alwaysShowSyncChain = Promise.resolve();
	// Own small queue, so live edits are not stuck behind a running report's backlog.
	const liveQueue = util.createQueue({ concurrency: 4 });
	const liveOptions = { queue: liveQueue };
	const syncAlwaysShow = ({ refreshRows = true } = {}) => {
		alwaysShowSyncChain = alwaysShowSyncChain.then(async () => {
			const names = alwaysShowNamesFromUi();
			lsSet('alwaysShowNames', names);
			alwaysShowNote.textContent = names.length ? 'resolving…' : '';
			let resolved;
			try {
				resolved = await resolveTypeNames(names, liveOptions);
			} catch (e) {
				if (isAbort(e)) return;
				throw e;
			}
			const added = [...resolved.ids].filter(id => !alwaysShowIds.has(id));
			const removed = [...alwaysShowIds].filter(id => !resolved.ids.has(id));
			alwaysShowIds = resolved.ids;
			alwaysShowNote.textContent = resolved.unresolved.length
				? `${resolved.ids.size} resolved; not found: ${resolved.unresolved.join(', ')}`
				: (names.length ? `${resolved.ids.size} resolved` : '');

			if (!refreshRows || !reportGeneratedAt) return;
			const start = STATIONS[startSel.value];
			const end = STATIONS[endSel.value];
			await Promise.all([...added, ...removed].map(async (typeId) => {
				try {
					const row = await buildRow({ start, end, typeId, isAlwaysShow: alwaysShowIds.has(typeId), options: liveOptions });
					if (row.report) addRow(row);
				} catch (e) {
					if (!isAbort(e)) console.error(`always-show refresh failed (typeId: ${typeId})`, e);
				}
			}));
		}).catch(e => console.error('always-show sync failed', e));
		return alwaysShowSyncChain;
	};
	let alwaysShowInputTimer = null;
	alwaysShowText.addEventListener('input', () => {
		clearTimeout(alwaysShowInputTimer);
		alwaysShowInputTimer = setTimeout(() => syncAlwaysShow(), 400);
	});
	$('#alwaysShowDetails').open = !!lsGet('alwaysShowOpen', false);
	$('#alwaysShowDetails').addEventListener('toggle', e => lsSet('alwaysShowOpen', e.target.open));

	//--- init
	loadRouteState();
	setRunning(false);
	buildFilterRow();
	render();
	if (autoRunChk.checked) run();
})();
