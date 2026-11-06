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

const alwaysShowNames = [
	'10000MN Monopropellant Enduring Afterburner',
	'Arch Angel EMP XL',
	'Blood Brass Tag',
	'Blood Crystal Tag',
	// 'Blood Silver Tag',
	'Corelum B-Type Thermal Energized Membrane',
	'Gravid Ice Harvester Mutaplasmid',
	'Large Projectile Metastasis Adjuster II',
	'Lattice Locked Dekaisogen',
	'Mobile Phase Anchor',
	'Small Pulse Laser Battery',
	'Standup Ballistic Control System I',
	'Standup Radar ECM Script',
	'Trinary State Processor',
	'Void XL',

	'Domination Torpedo Launcher',
	'Variegated Asteroid Mining Crystal Type B I',
];

const isAbort = (e) => !!e && e.name === 'AbortError';

//--- pipeline

// Runs one report. Calls onRow({typeId, name, m3, report, isAlwaysShow}) for every report (filtered ones too).
// Calls onProgress at least every 500ms.
const runReport = async ({ startStationKey, endStationKey, signal, onRow = () => {}, onProgress = () => {} }) => {
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

		const alwaysShowIdSet = new Set();
		const alwaysShowIds = await Promise.all(alwaysShowNames.map(name => util.getTypeIdByName(name)));
		alwaysShowIds.forEach((typeId, i) => {
			if (typeId === null || typeId === undefined) {
				console.warn(`alwaysShow: no type id for "${alwaysShowNames[i]}", skipping`);
				return;
			}
			alwaysShowIdSet.add(typeId);
			if (!typeIds.includes(typeId)) typeIds.push(typeId);
		});

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
			const isAlwaysShow = alwaysShowIdSet.has(typeId);
			const task = (async () => {
				await acquire();
				try {
					if (aborted()) return;
					const srcOrders = (await util.getOrders(start.regionId, typeId, 'sell')).filter(o => o.location_id === start.stationId);
					const destOrders = (await util.getOrders(end.regionId, typeId, 'sell')).filter(o => o.location_id === end.stationId);
					const destDays = await util.getDays(end.regionId, typeId);
					const m3 = await util.getTypeM3(typeId);
					const name = await util.getTypeName(typeId);
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
					progress.reportsDone++;
					if (!report) {
						progress.noReport++;
						return;
					}
					if (report.filteredReason) progress.rowsFiltered++;
					else progress.rowsShown++;
					onRow({ typeId, name, m3, report, isAlwaysShow });
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
	const copyBtn = $('#copy');
	const progressElem = $('#progress');
	const headerElem = $('#reportHeader');
	const tableElem = $('#table');
	const theadElem = $('#table thead');
	const tbodyElem = $('#table tbody');
	const sumsElem = $('#sums');

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

	const orderQty = (row) => row.qtyManual ?? Math.ceil(row.report.volume * row.factor);
	const orderCost = (row) => row.report.costPerItemMil * orderQty(row);
	const orderRevenue = (row) => row.report.revenuePerItemMil * orderQty(row);
	const km3Of = (row) => Math.ceil(orderQty(row) * (row.m3 || 0)) / 1000;

	// kind: 'text' | 'num' ; cell: custom html renderer (else fmt(value))
	const COLUMNS = [
		{ key: 'select', label: '', sort: (r) => selected.has(r.typeId) ? 1 : 0 },
		{ key: 'name', label: 'name', sort: (r) => r.name.toLowerCase(), text: true },
		{ key: 'dailyProfitMil', label: 'daily profit', val: (r) => num(r.report.dailyProfitMil), fmt: fmtMil },
		{ key: 'profitPerItemMil', label: 'profit/item', val: (r) => num(r.report.profitPerItemMil), fmt: fmtMil },
		{ key: 'costPerItemMil', label: 'cost/item', val: (r) => num(r.report.costPerItemMil), fmt: fmtMil },
		{ key: 'revenuePerItemMil', label: 'revenue/item', val: (r) => num(r.report.revenuePerItemMil), fmt: fmtMil },
		{ key: 'roi', label: 'ROI', val: (r) => num(r.report.roi), fmt: fmtRoi },
		{ key: 'daysToClear', label: 'days to clear', val: (r) => num(r.report.daysToClear), fmt: fmtRoi },
		{ key: 'volume', label: 'volume', val: (r) => r.report.volume, fmt: fmtNum },
		{ key: 'factor', label: 'factor', val: (r) => r.factor },
		{ key: 'qty', label: 'order qty', val: orderQty },
		{ key: 'orderCost', label: 'order cost', val: orderCost, fmt: (v) => roundNonZero(v, 3) },
		{ key: 'orderRevenue', label: 'order revenue', val: orderRevenue, fmt: (v) => roundNonZero(v) },
		{ key: 'km3', label: 'km3', val: km3Of, fmt: fmtNum },
		{ key: 'competingVolume', label: 'competing volume', val: (r) => num(r.report.competingVolume), fmt: fmtNum },
		{ key: 'activeSellers', label: 'active sellers', val: (r) => num(r.report.activeSellers), fmt: fmtNum },
		{ key: 'daysSinceSellerUpdate', label: 'days since update', val: (r) => num(r.report.daysSinceSellerUpdate), fmt: fmtRoi },
		{ key: 'activeDaysFraction', label: 'active days', val: (r) => num(r.report.activeDaysFraction), fmt: fmtRoi },
		{ key: 'dailyProfitOldMil', label: 'daily profit (old)', val: (r) => num(r.report.dailyProfitOldMil), fmt: fmtMil },
		{ key: 'reason', label: 'reason', sort: (r) => r.report.filteredReason || '', text: true, filteredOnly: true }
	];
	const visibleColumns = () => COLUMNS.filter(c => !c.filteredOnly || showFiltered);
	const sortValue = (col, row) => col.sort ? col.sort(row) : col.val(row);

	const esc = (s) => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

	const renderHead = () => {
		theadElem.innerHTML = '<tr>' + visibleColumns().map(col => {
			const active = sort.key === col.key;
			const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
			const cls = (col.text ? 'text ' : 'numeric ') + (active ? 'sorted' : '');
			return `<th class="${cls}" data-key="${col.key}">${esc(col.label)}${arrow}</th>`;
		}).join('') + '</tr>';
	};

	const rowHtml = (row) => {
		const cls = [];
		if (row.report.filteredReason) cls.push('filtered', 'dim');
		if (row.isAlwaysShow) cls.push('alwaysShowItem');
		const cells = visibleColumns().map(col => {
			switch (col.key) {
				case 'select':
					return `<td class="sel"><input type="checkbox" class="selbox" ${selected.has(row.typeId) ? 'checked' : ''}></td>`;
				case 'name':
					return `<td class="text"><span class="name">${esc(row.name)}</span> <span class="dim">${row.typeId}</span></td>`;
				case 'factor':
					return `<td class="numeric"><input type="number" class="factor" step="0.1" min="0" value="${row.factor}"></td>`;
				case 'qty':
					return `<td class="numeric"><input type="number" class="qty" step="1" min="0" value="${orderQty(row)}"></td>`;
				case 'reason':
					return `<td class="text">${esc(row.report.filteredReason || '')}</td>`;
				default:
					return `<td class="numeric" data-col="${col.key}">${col.fmt(col.val(row))}</td>`;
			}
		});
		return `<tr class="${cls.join(' ')}" data-type-id="${row.typeId}">${cells.join('')}</tr>`;
	};

	const sortedVisibleRows = () => {
		const col = COLUMNS.find(c => c.key === sort.key) || COLUMNS[2];
		const dir = sort.dir === 'asc' ? 1 : -1;
		const list = rows.filter(r => showFiltered || !r.report.filteredReason);
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
		let cost = 0, revenue = 0, km3 = 0, count = 0;
		for (const row of rows) {
			if (!selected.has(row.typeId)) continue;
			if (!showFiltered && row.report.filteredReason) continue;
			cost += orderCost(row);
			revenue += orderRevenue(row);
			km3 += km3Of(row);
			count++;
		}
		sumsElem.innerHTML =
			`${roundNonZero(revenue - cost)}` +
			`<span class="dim"> (-${roundNonZero(cost)} + ${roundNonZero(revenue)}) </span>` +
			`${roundNonZero(km3)}km3 <span class="dim">&middot; ${count} selected</span>`;
	};

	const render = () => {
		pendingRender = false;
		lastRenderAt = Date.now();
		renderHead();
		const scrollY = window.scrollY;
		tbodyElem.innerHTML = sortedVisibleRows().map(rowHtml).join('');
		if (window.scrollY !== scrollY) window.scrollTo(window.scrollX, scrollY);
		updateSums();
	};

	// Throttled: at most one render per 500ms; suspended while a row input is focused.
	const scheduleRender = () => {
		if (pendingRender) return;
		pendingRender = true;
		const wait = Math.max(0, 500 - (Date.now() - lastRenderAt));
		renderTimer = setTimeout(() => {
			if (isEditing()) { pendingRender = false; return; } // resumes on blur
			render(); // (not requestAnimationFrame: it never fires in a hidden tab)
		}, wait);
	};

	//--- row events
	const rowFromEvent = (e) => {
		const tr = e.target.closest('tr[data-type-id]');
		return tr ? { tr, row: rowByTypeId.get(+tr.dataset.typeId) } : null;
	};

	const refreshRowCells = (tr, row, skip) => {
		for (const cell of tr.querySelectorAll('td[data-col]')) {
			const col = COLUMNS.find(c => c.key === cell.dataset.col);
			cell.textContent = col.fmt(col.val(row));
		}
		const factorInput = tr.querySelector('input.factor');
		const qtyInput = tr.querySelector('input.qty');
		if (factorInput && skip !== 'factor') factorInput.value = row.factor;
		if (qtyInput && skip !== 'qty') qtyInput.value = orderQty(row);
	};

	tbodyElem.addEventListener('input', (e) => {
		const hit = rowFromEvent(e);
		if (!hit || !hit.row) return;
		const { tr, row } = hit;
		if (e.target.classList.contains('factor')) {
			const f = parseFloat(e.target.value);
			if (!(f >= 0)) return;
			row.factor = f;
			row.qtyManual = null;
			row.hasOverride = true;
			factorOverrides[row.typeId] = f;
			saveFactors();
			refreshRowCells(tr, row, 'factor');
		} else if (e.target.classList.contains('qty')) {
			const q = parseInt(e.target.value, 10);
			if (!(q >= 0)) return;
			row.qtyManual = q;
			if (row.report.volume > 0) {
				row.factor = Math.round(q / row.report.volume * 100) / 100;
				row.hasOverride = true;
				factorOverrides[row.typeId] = row.factor;
				saveFactors();
			}
			refreshRowCells(tr, row, 'qty');
		} else return;
		updateSums();
	});

	tbodyElem.addEventListener('change', (e) => {
		if (!e.target.classList.contains('selbox')) return;
		const hit = rowFromEvent(e);
		if (!hit || !hit.row) return;
		if (e.target.checked) selected.add(hit.row.typeId);
		else selected.delete(hit.row.typeId);
		saveSelected();
		updateSums();
	});

	tbodyElem.addEventListener('focusout', () => {
		// let focus settle (tabbing between inputs of a row), then resume if not editing
		setTimeout(() => { if (!isEditing()) scheduleRender(); }, 0);
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
				hasOverride: override !== undefined,
				qtyManual: null
			};
			const existing = rowByTypeId.get(r.typeId);
			if (existing) rows[rows.indexOf(existing)] = row;
			else rows.push(row);
			rowByTypeId.set(r.typeId, row);
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
		rows = [];
		rowByTypeId = new Map();
		rowBuffer = [];
		reportGeneratedAt = moment().format('MMM. Do, h:mm a');
		headerElem.innerHTML = `${esc(startSel.value)} &rarr; ${esc(endSel.value)} <span class="dim">${reportGeneratedAt}</span>`;
		render();

		const controller = new AbortController();
		currentRun = { controller };
		setRunning(true);
		try {
			await runReport({
				startStationKey: startSel.value,
				endStationKey: endSel.value,
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
		rows = [];
		rowByTypeId = new Map();
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
			row.qtyManual = null;
		}
		render();
	});

	showFilteredChk.checked = showFiltered;
	showFilteredChk.addEventListener('change', () => {
		showFiltered = showFilteredChk.checked;
		lsSet('showFiltered', showFiltered);
		render();
	});

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

	//--- init
	loadRouteState();
	setRunning(false);
	render();
	if (autoRunChk.checked) run();
})();
