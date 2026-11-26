// insights.js: the insights page (insights.html). Phase 8 of docs/trade-results-plan.md.
//
// Charts over the same data as the results page: the window bar, the loader and the figures come from
// results-shared.js and results-calc.js; what each chart groups out of the fact table (facts.sells,
// facts.lots, the batches, couriers and runs, the retained snapshots) is insights-calc.js, pure and
// tested. This file draws: Observable Plot for the marks, a hit layer of our own over them (hover and
// keyboard tooltips, nearest-point for scatter, a snapping crosshair for lines), a table twin of every
// chart, and the empty, loading and error states.
//
// Colour is assigned by job (dataviz skill): the documented categorical palette in its fixed order, one
// hue per entity and never cycled (a tail past the slots folds into grey); one blue ramp for the
// heatmap's magnitude; blue and red as the profit/loss pair; no colour carries meaning alone (every
// mark has a legend entry, a tooltip and a row in the table view). Light theme only, like the other pages.
(() => {
	if (typeof document === 'undefined') return;

	const $ = (sel) => document.querySelector(sel);

	//--- shared with the results page

	const { DASH, ARROW } = resultsShared.constants;
	const { isNum, esc, fmtIsk, fmtExact, fmtQty, fmtPct, fmtPct0, fmtDays, ago, stamp } = resultsShared.fmt;
	const { setHtml, setText, widenNext } = resultsShared;
	const ic = insightsCalc;
	const store = resultsShared.storage('eflip.insights.');

	//--- palette (dataviz skill, references/palette.md; checked with the dataviz skill's validate_palette.js, see the report)

	const INK = '#0b0b0b';
	const INK2 = '#52514e';
	const SURFACE = '#fcfcfb';
	const GRID = '#e1e0d9';
	const AXIS = '#c3c2b7';
	const NONE = '#f0efec'; // a heatmap cell with no sales
	const OTHER = '#b9b8b0'; // the folded tail of a series list
	// Categorical slots, fixed order. Entities keep their slot: money in and profit are blue, a loss is red,
	// and the five cost components take slots 2-6 in the order a sale pays them.
	const CAT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
	const COLOR = {
		total: CAT[0], loss: CAT[7],
		buy: CAT[1], haul: CAT[2], tax: CAT[3], listing: CAT[4], relist: CAT[5]
	};
	// One blue ramp, steps 250 to 700 of the documented sequential hue (the validator's ordinal check passes on it).
	const RAMP = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#0d366b'];
	const CAPITAL_COLORS = { wallet: CAT[0], escrow: CAT[1], source: CAT[2], transit: CAT[3], dest: CAT[4], listed: CAT[5] };
	const CAPITAL_LABELS = { wallet: 'Wallet', escrow: 'Escrow', source: 'Source stock', transit: 'In transit', dest: 'Destination hangar', listed: 'Listed' };
	const PLOT_STYLE = { background: 'transparent', color: INK2, fontSize: '12px', overflow: 'visible' };

	//--- the loader (shared) and this page's own state

	const shared = resultsShared.create({
		render: () => render(),
		renderStatus: () => renderStatus(),
		typesChanged: () => { renderStatus(); renderCharts(); } // each chart redraws only if its own figures or names changed
	});
	const { state, charName, nameOf } = shared;
	const page = { stateBox: $('#stateBox'), charts: $('#charts'), banners: $('#banners'), status: $('#statusNote'), dataNote: $('#dataNote'), tip: $('#tip') };

	const nameOfType = (typeId) => nameOf(typeId);

	//--- small DOM helpers (every label and name goes in with textContent)

	const el = (tag, attrs = {}, ...kids) => {
		const node = document.createElement(tag);
		for (const [k, v] of Object.entries(attrs)) {
			if (v === null || v === undefined || v === false) continue;
			if (k === 'class') node.className = v;
			else if (k === 'text') node.textContent = v;
			else node.setAttribute(k, v === true ? '' : String(v));
		}
		for (const kid of kids.flat()) {
			if (kid === null || kid === undefined || kid === false) continue;
			node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
		}
		return node;
	};
	const svgNode = (tag, attrs = {}) => {
		const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
		for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
		return node;
	};

	//--- the tooltip: one element, text only, the value first (interaction.md)

	const tipEl = page.tip;
	let tipOwner = null;
	const hideTip = () => {
		tipEl.hidden = true;
		tipOwner = null;
	};
	// spec: {title?, rows: [{color?, value, name}], note?}
	const fillTip = (spec) => {
		tipEl.replaceChildren();
		if (spec.title) tipEl.append(el('div', { class: 'tt', text: spec.title }));
		for (const r of spec.rows || []) {
			tipEl.append(el('div', { class: 'tr' },
				r.color ? el('span', { class: 'tk', style: `background:${r.color}` }) : null,
				el('span', { class: 'tv', text: r.value }),
				r.name ? el('span', { class: 'tn', text: r.name }) : null));
		}
		if (spec.note) tipEl.append(el('div', { class: 'tx', text: spec.note }));
	};
	// Puts the tooltip near a point (client coordinates), kept inside the viewport.
	const showTip = (spec, cx, cy, owner) => {
		fillTip(spec);
		tipEl.hidden = false;
		tipOwner = owner || null;
		const r = tipEl.getBoundingClientRect();
		let x = cx + 14;
		let y = cy + 14;
		if (x + r.width > window.innerWidth - 8) x = Math.max(8, cx - r.width - 14);
		if (y + r.height > window.innerHeight - 8) y = Math.max(8, cy - r.height - 14);
		tipEl.style.left = `${x}px`;
		tipEl.style.top = `${y}px`;
	};
	const tipText = (spec) => [spec.title, ...(spec.rows || []).map(r => `${r.value} ${r.name || ''}`.trim()), spec.note].filter(Boolean).join('. ');
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !tipEl.hidden) hideTip();
	});

	//--- the hit layer. Plot draws the marks; this layer sits over them: transparent, larger than the
	// mark, one tab stop for the whole layer (arrow keys move between targets), the same tooltip on
	// hover and focus. aria-labels carry what the tooltip says; the table view is the full twin.

	const finishSvg = (svg, label) => {
		svg.setAttribute('role', 'group');
		svg.setAttribute('aria-label', label);
		for (const g of svg.querySelectorAll(':scope > g')) g.setAttribute('aria-hidden', 'true');
		return svg;
	};

	// targets: [{shape: 'rect'|'circle', x, y, w, h | r, tip: spec}]. opts: {cols (grid width for up/down),
	// nearest (pointer picks the closest circle within `reach` px instead of the element under it), label}.
	const attachTargets = (svg, targets, opts = {}) => {
		if (targets.length === 0) return;
		const g = svgNode('g', { class: 'hits', role: 'group', 'aria-label': opts.label || 'Chart values, arrow keys move between them' });
		const els = [];
		let active = 0;
		const centre = (t) => (t.shape === 'circle' ? { x: t.x, y: t.y } : { x: t.x + t.w / 2, y: t.y + t.h / 2 });
		const clientOf = (t) => {
			const p = svg.createSVGPoint();
			const c = centre(t);
			p.x = c.x;
			p.y = c.y;
			const m = svg.getScreenCTM();
			const q = m ? p.matrixTransform(m) : { x: 0, y: 0 };
			return q;
		};
		const mark = (i, on) => { els[i].classList.toggle('on', on); };
		const show = (i, cx, cy) => {
			showTip(targets[i].tip, cx, cy, svg);
			els.forEach((_, j) => mark(j, j === i));
		};
		const off = () => {
			els.forEach((_, j) => mark(j, false));
			if (tipOwner === svg) hideTip();
		};
		const focusAt = (i) => {
			els[active].setAttribute('tabindex', '-1');
			active = i;
			els[i].setAttribute('tabindex', '0');
			els[i].focus();
		};
		targets.forEach((t, i) => {
			const node = t.shape === 'circle'
				? svgNode('circle', { cx: t.x, cy: t.y, r: t.r })
				: svgNode('rect', { x: t.x, y: t.y, width: t.w, height: t.h, rx: t.rx || 0 });
			node.setAttribute('class', 'hit');
			node.setAttribute('tabindex', i === 0 ? '0' : '-1');
			node.setAttribute('role', 'img');
			node.setAttribute('aria-label', tipText(t.tip));
			if (opts.nearest) node.style.pointerEvents = 'none';
			else {
				node.addEventListener('pointerenter', (e) => show(i, e.clientX, e.clientY));
				node.addEventListener('pointermove', (e) => show(i, e.clientX, e.clientY));
				node.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') off(); }); // a tapped value stays until the next tap
			}
			node.addEventListener('focus', () => {
				active = i;
				const q = clientOf(t);
				show(i, q.x, q.y);
			});
			node.addEventListener('blur', off);
			node.addEventListener('keydown', (e) => {
				const cols = opts.cols || 1;
				let next = null;
				if (e.key === 'ArrowRight') next = i + 1;
				else if (e.key === 'ArrowLeft') next = i - 1;
				else if (e.key === 'ArrowDown') next = opts.cols ? i + cols : i + 1;
				else if (e.key === 'ArrowUp') next = opts.cols ? i - cols : i - 1;
				else if (e.key === 'Home') next = 0;
				else if (e.key === 'End') next = targets.length - 1;
				if (next === null) return;
				e.preventDefault();
				if (next >= 0 && next < targets.length) focusAt(next);
			});
			els.push(node);
			g.append(node);
		});
		svg.append(g);
		if (opts.nearest) {
			const reach = opts.reach || 28;
			const delaunay = d3.Delaunay.from(targets.map(t => [centre(t).x, centre(t).y]));
			const toLocal = (e) => {
				const p = svg.createSVGPoint();
				p.x = e.clientX;
				p.y = e.clientY;
				const m = svg.getScreenCTM();
				return m ? p.matrixTransform(m.inverse()) : p;
			};
			const pick = (e) => {
				const p = toLocal(e);
				const i = delaunay.find(p.x, p.y);
				const c = centre(targets[i]);
				if (Math.hypot(c.x - p.x, c.y - p.y) > reach) { off(); return; }
				show(i, e.clientX, e.clientY);
			};
			svg.addEventListener('pointermove', pick);
			svg.addEventListener('pointerdown', pick); // touch: a tap reads the nearest point
			svg.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') off(); });
		}
	};

	// A crosshair that snaps to the nearest x (line and area charts): `xs` are the data x values it can
	// rest on, `xPix` maps one to a pixel, `spec(x)` gives the one tooltip with every series at that x.
	const attachCrosshair = (svg, box, xs, xPix, spec, label, live) => {
		if (xs.length === 0) return;
		const line = svgNode('line', { class: 'crossline', x1: 0, x2: 0, y1: box.y0, y2: box.y1, visibility: 'hidden' });
		const hit = svgNode('rect', { class: 'cross-hit', x: box.x0, y: box.y0, width: box.x1 - box.x0, height: box.y1 - box.y0, tabindex: 0, role: 'group', 'aria-label': label });
		let index = -1;
		const toLocalX = (e) => {
			const p = svg.createSVGPoint();
			p.x = e.clientX;
			p.y = e.clientY;
			const m = svg.getScreenCTM();
			return (m ? p.matrixTransform(m.inverse()) : p).x;
		};
		const put = (i, cx, cy) => {
			index = i;
			const px = xPix(xs[i]);
			line.setAttribute('x1', px);
			line.setAttribute('x2', px);
			line.setAttribute('visibility', 'visible');
			const s = spec(xs[i]);
			showTip(s, cx, cy, svg);
			if (live) live.textContent = tipText(s);
		};
		const nearest = (px) => {
			let lo = 0;
			let hi = xs.length - 1;
			while (hi - lo > 1) {
				const mid = (lo + hi) >> 1;
				if (xPix(xs[mid]) <= px) lo = mid; else hi = mid;
			}
			return Math.abs(xPix(xs[lo]) - px) <= Math.abs(xPix(xs[hi]) - px) ? lo : hi;
		};
		const off = () => {
			line.setAttribute('visibility', 'hidden');
			if (tipOwner === svg) hideTip();
		};
		hit.addEventListener('pointermove', (e) => put(nearest(toLocalX(e)), e.clientX, e.clientY));
		hit.addEventListener('pointerdown', (e) => put(nearest(toLocalX(e)), e.clientX, e.clientY)); // touch: tap or drag along the chart
		hit.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') off(); });
		hit.addEventListener('blur', off);
		hit.addEventListener('keydown', (e) => {
			let next = null;
			if (e.key === 'ArrowRight') next = Math.min(xs.length - 1, (index < 0 ? -1 : index) + 1);
			else if (e.key === 'ArrowLeft') next = Math.max(0, (index < 0 ? xs.length : index) - 1);
			else if (e.key === 'Home') next = 0;
			else if (e.key === 'End') next = xs.length - 1;
			if (next === null) return;
			e.preventDefault();
			const r = hit.getBoundingClientRect();
			const m = svg.getScreenCTM();
			const cx = m ? m.e + m.a * xPix(xs[next]) : r.left;
			put(next, cx, r.top + 12);
		});
		svg.append(line, hit);
	};

	//--- chart states and the card scaffold

	const chartPrefs = {};
	const pref = (chartId, key, fallback) => {
		const k = `${chartId}.${key}`;
		if (!(k in chartPrefs)) chartPrefs[k] = store.get(k, fallback);
		return chartPrefs[k];
	};
	const setPref = (chartId, key, value) => {
		const k = `${chartId}.${key}`;
		chartPrefs[k] = value;
		store.set(k, value);
	};

	const legendEl = (items) => {
		if (!items || items.length < 2) return null;
		return el('div', { class: 'legend', role: 'list', 'aria-label': 'Legend' }, items.map(it => el('span', { class: 'key', role: 'listitem' },
			it.ramp ? el('span', { class: 'ramp', style: `background:linear-gradient(90deg, ${RAMP.join(', ')})` }) : el('span', { class: `sw ${it.kind || ''}`, style: it.kind === 'ring' || it.kind === 'diamond' ? `border-color:${it.color}` : `background:${it.color}` }),
			it.label)));
	};

	const tableEl = (t) => el('div', { class: 'tableWrap', tabindex: 0, role: 'region', 'aria-label': `${t.caption} (table view)` },
		el('table', { class: 'data' },
			el('caption', { text: t.caption }),
			el('thead', {}, el('tr', {}, t.columns.map(c => el('th', { class: c.numeric ? 'numeric' : '', scope: 'col', text: c.label })))),
			el('tbody', {}, t.rows.map(r => el('tr', { class: r.total ? 'total' : '' }, r.cells.map((c, i) => {
				const cell = typeof c === 'object' && c !== null ? c : { t: c };
				return el('td', { class: `${t.columns[i].numeric ? 'numeric' : ''}${cell.neg ? ' neg' : ''}`, title: cell.title || null, text: cell.t });
			}))))));

	const stateCard = (kind, title, text, ...buttons) => el('div', { class: `chartState ${kind}`, role: kind === 'err' ? 'alert' : 'status' },
		el('h3', { text: title }), text ? el('p', { text }) : null, buttons.length > 0 ? el('div', {}, buttons) : null);

	//--- the models: what each chart reads from the fact table (insights-calc.js does the grouping)

	const scoped = (v) => {
		const f = v.result.facts;
		if (!v.isUnplanned) return { sells: f.sells, lots: f.lots, batches: v.batches };
		const ids = new Set(v.batches.map(b => b.batchId));
		return {
			sells: f.sells.filter(s => s.batchId !== null && ids.has(s.batchId)),
			lots: f.lots.filter(l => l.batchId !== null && ids.has(l.batchId)),
			batches: v.batches
		};
	};
	const windowWord = (v) => (v.isRun ? 'this run' : v.isUnplanned ? 'the unplanned batches' : 'this window');
	const emptyWindow = (title, text, widen = true) => ({ empty: { title, text, widen } });

	//--- 1. cost waterfall

	const STEP_HELP = {
		gross: 'Everything the units sold fetched at the destination, before any fee.',
		tax: 'Sales tax, from the wallet journal’s tax row of each sale.',
		listing: 'Broker fees paid when the orders were first listed (matched to their orders).',
		relist: 'Broker fees of later modifications and relists, plus the share of unmatched fees spread over the sales (estimated).',
		haul: 'Hand-off, courier and (if counted) hauler-bonus cost carried by the units sold.',
		buy: 'What the units sold cost to buy, with buy-order fees.',
		net: 'Gross sales minus everything above: the realized profit of the units sold.'
	};

	const modelWaterfall = (v) => {
		const sc = scoped(v);
		const w = ic.waterfall({ rows: v.rows, sells: sc.sells, unplanned: v.isUnplanned });
		if (!(w.gross > 0) && !(w.buy > 0) && w.soldQty === 0) {
			return emptyWindow('Nothing sold in this window', `No sales at ${v.view.route.end} in ${windowWord(v)} yet, so there are no costs to set against sales.`);
		}
		const t = v.totals;
		const strip = {
			gross: t.gross, tax: t.tax, listing: null, relist: null, broker: t.broker,
			haul: isNum(t.haulPaid) ? t.haulPaid : t.haul, net: t.realizedProfit, spent: t.spent
		};
		return { w, strip, totals: t, bonuses: shared.countBonuses(), isRun: v.isRun, end: v.view.route.end };
	};

	const stepName = (m, s) => (s.key === 'haul' && m.bonuses ? 'Haul + hauler bonuses' : s.label);
	const stepColor = (m, s) => (s.key === 'gross' ? COLOR.total : s.key === 'net' ? (s.amount < 0 ? COLOR.loss : COLOR.total) : COLOR[s.key]);

	const drawWaterfall = (m, width) => {
		const steps = m.w.steps;
		const rowH = 38;
		const height = steps.length * rowH + 34;
		const compact = width < 520; // a phone: shorter margins, no percentages beside the bars
		const marginLeft = compact ? 112 : 150;
		const marginRight = compact ? 70 : Math.min(170, Math.max(110, width * 0.2));
		const rows = steps.map(s => ({
			...s, name: stepName(m, s), lo: Math.min(s.start, s.end), hi: Math.max(s.start, s.end), color: stepColor(m, s),
			text: s.key === 'gross' ? fmtIsk(s.amount) : s.key === 'net' ? `${fmtIsk(s.amount, true)}${m.w.gross > 0 && !compact ? ` (${fmtPct(s.amount / m.w.gross)})` : ''}` : `${fmtIsk(-s.amount)}${m.w.gross > 0 && !compact ? ` (${fmtPct(s.amount / m.w.gross)})` : ''}`
		}));
		const names = rows.map(r => r.name);
		// a bar thinner than 3 px (a fee that is a sliver of the sales) is drawn 3 px wide so it can still be seen; its figure is exact in the label, tooltip and table
		const minSpan = (m.w.max - m.w.min) / Math.max(1, width - marginLeft - marginRight) * 3;
		for (const r of rows) if (r.hi - r.lo < minSpan) r.hi = r.lo + minSpan;
		const plot = Plot.plot({
			width, height, marginLeft, marginRight, marginTop: 4, marginBottom: 28,
			style: PLOT_STYLE,
			x: { domain: [m.w.min, m.w.max], nice: true, label: null, tickFormat: (d) => fmtIsk(d), ticks: Math.max(2, Math.floor((width - marginLeft - marginRight) / 110)), tickSize: 0 },
			y: { domain: names, label: null, tickSize: 0, padding: 0.35 },
			marks: [
				Plot.gridX({ stroke: GRID, strokeOpacity: 1, strokeWidth: 1 }),
				Plot.ruleX([0], { stroke: AXIS, strokeWidth: 1 }),
				Plot.barX(rows, { x1: 'lo', x2: 'hi', y: 'name', fill: 'color', rx: 4, insetTop: 0, className: 'wf-bars' }),
				// the value sits at the tip of the bar, to its right; a total below zero (a loss) puts it right of the zero line, clear of the axis labels
				Plot.text(rows, { x: (r) => (r.kind === 'total' && r.end < 0 ? 0 : r.hi), y: 'name', text: 'text', textAnchor: 'start', dx: 6, fill: INK, fontWeight: 600 })
			]
		});
		finishSvg(plot, 'Cost waterfall from gross sales to net profit');
		// geometry from the scales, not from the drawn elements: Plot may reorder what it draws
		const sy = plot.scale('y');
		const targets = rows.map((s) => {
			const top = sy.apply(s.name);
			const bandH = sy.bandwidth;
			const rowsTip = [{ color: s.color, value: s.key === 'net' ? fmtIsk(s.amount, true) : s.key === 'gross' ? fmtIsk(s.amount) : fmtIsk(-s.amount), name: s.name }];
			if (s.key !== 'gross' && m.w.gross > 0) rowsTip.push({ value: fmtPct(s.amount / m.w.gross), name: 'of gross sales' });
			return {
				shape: 'rect', x: marginLeft, y: top - 6, w: width - marginLeft, h: bandH + 12,
				tip: { title: fmtExact(s.amount), rows: rowsTip, note: STEP_HELP[s.key] }
			};
		});
		attachTargets(plot, targets, { label: 'Waterfall steps, arrow keys move between them' });
		return plot;
	};

	const legendWaterfall = (m) => {
		const items = [
			{ label: 'Gross sales and net profit', color: COLOR.total },
			{ label: 'Buy cost', color: COLOR.buy }, { label: 'Haul', color: COLOR.haul }, { label: 'Sales tax', color: COLOR.tax },
			{ label: 'Listing fees', color: COLOR.listing }, { label: 'Relist fees', color: COLOR.relist }
		];
		if (m.w.net < 0) items.push({ label: 'Loss', color: COLOR.loss });
		return items;
	};

	const tableWaterfall = (m) => {
		const stripText = (s) => {
			if (s.key === 'gross') return fmtExact(m.strip.gross);
			if (s.key === 'tax') return fmtExact(m.strip.tax);
			if (s.key === 'listing' || s.key === 'relist') return `${fmtExact(m.strip.broker)} together`;
			if (s.key === 'haul') return `${fmtExact(m.strip.haul)} paid${Math.abs(m.strip.haul - m.w.haul) > 0.5 ? `, ${fmtExact(m.w.haul)} in units sold` : ''}`;
			if (s.key === 'buy') return `${fmtExact(m.strip.spent)} spent on everything bought`;
			return fmtExact(m.strip.net);
		};
		return {
			caption: 'Cost waterfall: the figures behind the bars, next to the results page’s totals strip',
			columns: [{ label: 'step' }, { label: 'amount', numeric: true }, { label: 'exact', numeric: true }, { label: 'share of gross', numeric: true }, { label: 'totals strip reads' }],
			rows: m.w.steps.map(s => ({
				total: s.kind === 'total',
				cells: [stepName(m, s), { t: s.kind === 'cost' ? fmtIsk(-s.amount) : fmtIsk(s.amount, s.key === 'net'), neg: s.amount < 0 && s.kind === 'total' }, fmtExact(s.kind === 'cost' ? -s.amount : s.amount), m.w.gross > 0 ? fmtPct(s.amount / m.w.gross) : DASH, stripText(s)]
			}))
		};
	};

	const footWaterfall = (m) => {
		const lines = [];
		lines.push(`The bars are the figures of the results page’s totals strip for the same window, cost of the ${fmtQty(m.w.soldQty)} units sold.`);
		if (Math.abs(m.strip.haul - m.w.haul) > 0.5) lines.push(`Haul: the strip shows ${fmtIsk(m.strip.haul)} paid in the window; ${fmtIsk(m.w.haul)} of it sits in the units sold and the rest waits in unsold stock. Buy cost is that of the units sold too; the strip’s “spent” (${fmtIsk(m.strip.spent)}) counts everything bought.`);
		if (m.w.buyFee > 0.5) lines.push(`Buy cost includes ${fmtIsk(m.w.buyFee)} of buy-order fees.`);
		if (isNum(m.totals.brokerEst) && m.totals.brokerEst > 0.5) lines.push(`Relist fees include ${fmtIsk(m.totals.brokerEst)} of fees that matched no order, spread over the sales by value (estimated).`);
		if (Math.abs(m.w.residual) > 0.5) lines.push(`The steps differ from the net profit by ${fmtExact(m.w.residual)}.`);
		return lines;
	};

	//--- 2. sales heatmap

	const modelHeat = (v, utc) => {
		const sc = scoped(v);
		if (sc.sells.length === 0) return emptyWindow('No sales to place on the clock', `No sales at ${v.view.route.end} in ${windowWord(v)}.`);
		const h = ic.heat(sc.sells, { utc });
		return { h, utc, end: v.view.route.end };
	};

	const heatLabel = (c, utc) => `${ic.WEEKDAYS[c.weekday]} ${String(c.hour).padStart(2, '0')}:00–${String(c.hour).padStart(2, '0')}:59 ${utc ? 'EVE time (UTC)' : 'local time'}`;

	const drawHeat = (m, width, metric) => {
		const key = metric === 'units' ? 'units' : 'isk';
		const marginLeft = 40;
		const cellW = (width - marginLeft - 6) / 24;
		const cellH = 28;
		const stride = cellW < 26 ? 2 : 1;
		const data = m.h.cells.map(c => ({ ...c, value: c[key] > 0 ? c[key] : null, day: ic.WEEKDAYS[c.weekday] }));
		const plot = Plot.plot({
			width, height: 7 * cellH + 34, marginLeft, marginRight: 6, marginTop: 4, marginBottom: 30,
			style: PLOT_STYLE,
			x: { domain: d3.range(24), label: null, tickSize: 0, tickFormat: (hr) => (hr % stride === 0 ? String(hr).padStart(2, '0') : ''), padding: 0 },
			y: { domain: ic.WEEKDAYS, label: null, tickSize: 0, padding: 0 },
			color: { type: 'linear', domain: [0, m.h.max[key]], range: RAMP, unknown: NONE, clamp: true },
			marks: [Plot.cell(data, { x: 'hour', y: 'day', fill: 'value', inset: 1, rx: 2, className: 'heat-cells' })]
		});
		finishSvg(plot, `Sales by weekday and hour, ${m.utc ? 'EVE time' : 'local time'}, in ${key === 'isk' ? 'ISK' : 'units'}`);
		const sx = plot.scale('x');
		const sy = plot.scale('y');
		const targets = m.h.cells.map((c) => {
			const b = { x: sx.apply(c.hour), y: sy.apply(ic.WEEKDAYS[c.weekday]), width: sx.bandwidth, height: sy.bandwidth };
			const rowsTip = c.sales === 0
				? [{ value: 'no sales', name: '' }]
				: [{ value: key === 'isk' ? fmtIsk(c.isk) : `${fmtQty(c.units)} units`, name: key === 'isk' ? `${fmtQty(c.units)} units` : fmtIsk(c.isk) }, { value: String(c.sales), name: c.sales === 1 ? 'sale' : 'sales' }];
			return { shape: 'rect', x: b.x, y: b.y, w: b.width, h: b.height, rx: 2, tip: { title: heatLabel(c, m.utc), rows: rowsTip } };
		});
		attachTargets(plot, targets, { cols: 24, label: 'Heatmap cells, arrow keys move between hours and days' });
		return plot;
	};

	const legendHeat = (m, metric) => [{ ramp: true, label: `fewer ${metric === 'units' ? 'units' : 'ISK'} to more (most: ${metric === 'units' ? fmtQty(m.h.max.units) : fmtIsk(m.h.max.isk)})` }, { label: 'no sales', color: NONE }];

	const tableHeat = (m, metric) => {
		const key = metric === 'units' ? 'units' : 'isk';
		const fmt = (c) => (c[key] > 0 ? (key === 'isk' ? { t: fmtIsk(c.isk), title: fmtExact(c.isk) } : { t: fmtQty(c.units) }) : { t: DASH });
		const columns = [{ label: m.utc ? 'UTC' : 'local' }, ...d3.range(24).map(hr => ({ label: String(hr).padStart(2, '0'), numeric: true })), { label: 'day total', numeric: true }];
		const rows = ic.WEEKDAYS.map((d, wd) => {
			const cs = m.h.cells.slice(wd * 24, wd * 24 + 24);
			const tot = cs.reduce((a, c) => a + c[key], 0);
			return { cells: [d, ...cs.map(fmt), key === 'isk' ? { t: fmtIsk(tot), title: fmtExact(tot) } : fmtQty(tot)] };
		});
		const hourTotals = d3.range(24).map(hr => m.h.cells.filter(c => c.hour === hr).reduce((a, c) => a + c[key], 0));
		rows.push({ total: true, cells: ['hour total', ...hourTotals.map(t => (t > 0 ? (key === 'isk' ? { t: fmtIsk(t), title: fmtExact(t) } : fmtQty(t)) : DASH)), key === 'isk' ? { t: fmtIsk(m.h.totals.isk), title: fmtExact(m.h.totals.isk) } : fmtQty(m.h.totals.units)] });
		return { caption: `Sales by weekday and hour (${m.utc ? 'EVE time, UTC' : 'local time'}), in ${key === 'isk' ? 'ISK' : 'units'}`, columns, rows };
	};

	const footHeat = (m, metric) => {
		const top = m.h.top[metric === 'units' ? 'units' : 'isk'];
		const lines = [`${fmtQty(m.h.totals.sales)} sales, ${fmtIsk(m.h.totals.isk)}, ${fmtQty(m.h.totals.units)} units at ${m.end}. EVE time is UTC, the same on every clock.`];
		if (top) lines.push(`Busiest: ${heatLabel(top, m.utc)} with ${metric === 'units' ? `${fmtQty(top.units)} units` : fmtIsk(top.isk)}.`);
		return lines;
	};

	//--- 3. sell-through curves

	const batchName = (s) => `${stamp(s.issuedAt)} · ${s.types} type${s.types === 1 ? '' : 's'}${s.runId ? '' : ' · unplanned'}`;

	const modelSellThrough = (v) => {
		const sc = scoped(v);
		if (sc.batches.length === 0) return emptyWindow('No batches in this window', `No hand-off to the seller was issued in ${windowWord(v)}, so there is nothing to follow from arrival to sold out.`);
		const out = ic.sellThrough({ batches: sc.batches, lots: sc.lots, sells: sc.sells, runs: state.runs, now: v.view.now });
		if (out.series.length === 0) {
			return emptyWindow('No batch has arrived yet', `${out.pending.length === 1 ? 'The batch in this window has' : `The ${out.pending.length} batches in this window have`} no courier delivery on record, so the clock (days since arrival) has not started.`);
		}
		// colour: the newest batches take the slots in order; older ones fold into grey
		const newest = out.series.slice().reverse();
		const slotOf = new Map(newest.map((s, i) => [s.batchId, i < 8 ? i : -1]));
		const series = out.series.map(s => ({ ...s, slot: slotOf.get(s.batchId), color: slotOf.get(s.batchId) >= 0 ? CAT[slotOf.get(s.batchId)] : OTHER }));
		return { series, pending: out.pending, now: v.view.now };
	};

	const drawSellThrough = (m, width, live) => {
		const colored = m.series.filter(s => s.slot >= 0).sort((a, b) => a.slot - b.slot);
		const grey = m.series.filter(s => s.slot < 0);
		const xmax = Math.max(1, ...m.series.map(s => Math.max(s.endDay, s.predictedDays || 0))) * 1.04;
		const height = 340;
		const marginLeft = 54;
		const marginRight = 30;
		const marks = [Plot.gridY({ stroke: GRID, strokeOpacity: 1 }), Plot.ruleY([0], { stroke: AXIS })];
		const line = (s, strokeWidth) => Plot.line(s.points.concat(s.soldOut ? [] : [{ day: s.endDay, share: s.soldShare }]), { x: 'day', y: 'share', stroke: s.color, strokeWidth, curve: 'step-after', strokeLinejoin: 'round', strokeLinecap: 'round' });
		for (const s of grey) marks.push(line(s, 1.5));
		for (const s of colored) marks.push(line(s, 2));
		const ends = m.series.map(s => ({ day: s.endDay, share: s.soldShare, color: s.color }));
		marks.push(Plot.dot(ends, { x: 'day', y: 'share', r: 4, fill: 'color', stroke: SURFACE, strokeWidth: 2 }));
		const preds = m.series.filter(s => isNum(s.predictedDays)).map(s => ({ day: s.predictedDays, share: 1, color: s.color }));
		if (preds.length > 0) marks.push(Plot.dot(preds, { x: 'day', y: 'share', symbol: 'diamond', r: 6, fill: SURFACE, stroke: 'color', strokeWidth: 2 }));
		const plot = Plot.plot({
			width, height, marginLeft, marginRight, marginTop: 28, marginBottom: 40,
			style: PLOT_STYLE,
			x: { domain: [0, xmax], label: 'days since the batch arrived →', labelAnchor: 'center', tickSize: 0, tickFormat: (d) => String(Math.round(d * 10) / 10) },
			y: { domain: [0, 1.04], label: '↑ share of the batch sold', tickFormat: (d) => `${Math.round(d * 100)}%`, ticks: [0, 0.25, 0.5, 0.75, 1], tickSize: 0 },
			marks
		});
		finishSvg(plot, 'Cumulative share of each batch sold, against days since it arrived');
		const sx = plot.scale('x');
		const sy = plot.scale('y');
		// direct labels at the line ends, for up to four coloured series that do not collide
		if (colored.length <= 4) {
			const placed = [];
			for (const s of colored.slice().sort((a, b) => sy.apply(a.soldShare) - sy.apply(b.soldShare))) {
				const py = sy.apply(s.soldShare);
				if (placed.some(p => Math.abs(p - py) < 14)) continue;
				placed.push(py);
				const t = svgNode('text', { x: Math.min(width - 4, sx.apply(s.endDay) + 8), y: py + 4, fill: INK2, 'font-size': 11, 'text-anchor': sx.apply(s.endDay) + 8 > width - 120 ? 'end' : 'start' });
				if (t.getAttribute('text-anchor') === 'end') t.setAttribute('x', sx.apply(s.endDay) - 8);
				t.textContent = `${stamp(s.issuedAt)}`;
				t.setAttribute('aria-hidden', 'true');
				plot.append(t);
			}
		}
		const xs = [...new Set([0, ...m.series.flatMap(s => s.points.map(p => Math.round(p.day * 1000) / 1000)), ...m.series.map(s => Math.round(s.endDay * 1000) / 1000)])].sort((a, b) => a - b);
		const spec = (x) => {
			const rows = colored.map(s => ({ color: s.color, value: fmtPct0(ic.shareAt(s, x)), name: `${batchName(s)}${s.soldOut && x >= s.endDay ? ' (sold out)' : ''}` }));
			const plan = colored.filter(s => isNum(s.predictedDays)).map(s => `${stamp(s.issuedAt)} batch: predicted to clear in ${fmtDays(s.predictedDays)} days.`);
			const note = [...plan, grey.length > 0 ? `${grey.length} older batch${grey.length === 1 ? '' : 'es'} in grey are in the table.` : null].filter(Boolean).join(' ');
			return { title: `${fmtDays(x)} days after arrival`, rows, note: note || null };
		};
		attachCrosshair(plot, { x0: marginLeft, x1: width - marginRight, y0: 28, y1: height - 40 }, xs, (x) => sx.apply(x), spec, 'Sell-through curves. Left and right arrow keys read the share sold of each batch at each sale day.', live);
		return plot;
	};

	const legendSellThrough = (m) => {
		const colored = m.series.filter(s => s.slot >= 0).sort((a, b) => a.slot - b.slot);
		const items = colored.map(s => ({ label: batchName(s), color: s.color, kind: 'line' }));
		if (m.series.some(s => s.slot < 0)) items.push({ label: `${m.series.filter(s => s.slot < 0).length} older batches`, color: OTHER, kind: 'line' });
		items.push({ label: 'last sale, or today while stock is left', color: INK2, kind: 'dot' });
		if (m.series.some(s => isNum(s.predictedDays))) items.push({ label: 'predicted days to clear', color: INK2, kind: 'diamond' });
		return items;
	};

	const tableSellThrough = (m) => ({
		caption: 'Sell-through per batch: units sold and the days it took, from the courier’s delivery',
		columns: [{ label: 'batch (hand-off issued)' }, { label: 'contract', numeric: true }, { label: 'run' }, { label: 'units', numeric: true }, { label: 'sold', numeric: true }, { label: 'share sold', numeric: true }, { label: 'days to 50%', numeric: true }, { label: 'days to sold out', numeric: true }, { label: 'predicted days', numeric: true }, { label: 'sold before delivery', numeric: true }],
		rows: [...m.series.slice().reverse().map(s => ({
			cells: [batchName(s), String(s.batchId), s.runId ? 'yes' : 'none', fmtQty(s.units), fmtQty(s.sold), fmtPct0(s.soldShare), isNum(s.days50) ? fmtDays(s.days50) : DASH, isNum(s.days100) ? fmtDays(s.days100) : DASH, isNum(s.predictedDays) ? fmtDays(s.predictedDays) : DASH, s.early > 0 ? fmtQty(s.early) : DASH]
		})), ...m.pending.map(s => ({ cells: [batchName(s), String(s.batchId), s.runId ? 'yes' : 'none', fmtQty(s.units), DASH, DASH, DASH, DASH, DASH, 'not delivered yet'] }))]
	});

	const footSellThrough = (m) => {
		const lines = ['A curve rises with each sale of the batch’s units (the books’ first-in, first-out match) and stops at its last sale; a batch with stock left runs on to today.'];
		const early = m.series.reduce((a, s) => a + s.early, 0);
		if (early > 0) lines.push(`${fmtQty(early)} units were sold before their courier delivered them (the books say they were not there yet); they are drawn at day 0.`);
		if (m.pending.length > 0) lines.push(`${m.pending.length} batch${m.pending.length === 1 ? '' : 'es'} with no delivery yet ${m.pending.length === 1 ? 'is' : 'are'} not drawn (in the table).`);
		if (m.series.some(s => isNum(s.predictedDays))) lines.push('The diamond marks the longest days-to-clear the batch’s run predicted for the types in it; a curve that reaches 100% to the left of it cleared faster than planned.');
		return lines;
	};

	//--- 4. prediction calibration

	const CAL_MAX_RUNS = 25;
	// A run is told apart by shape as well as hue (circle, square, triangle); older runs are grey circles.
	const SCATTER_SYMBOLS = ['circle', 'square', 'triangle'];
	let calCache = null; // {key, promise, result}

	// Every run's per-item rows with their prediction: the selected run's own when a run is selected, else
	// one compute() per run copied in the window (each over its own route, no market needed).
	const calibrationRuns = async (v) => {
		// the selected run is already worked out (v.rows), and is redone whenever new volumes change the haul split
		if (v.isRun) return { runs: [{ run: v.view.run, rows: v.rows }], skipped: 0, waiting: 0, capped: false };
		// the others are worked out once per window, bonus choice, data load and set of known volumes
		const key = `${v.view.sel.kind}:${v.view.sel.runId || v.view.sel.days || v.view.sel.date || ''}:${shared.countBonuses()}:${v.view.route.end}:${Object.keys(state.m3).length}`;
		if (calCache && calCache.key === key && calCache.ledgers === state.ledgers && calCache.snapshots === state.snapshots) return calCache.promise;
		const promise = (async () => {
			const startMs = v.result.window.start === null ? -Infinity : Date.parse(v.result.window.start);
			let runs = state.runs.filter(r => Date.parse(r.copiedAt) >= startMs);
			const waiting = runs.filter(r => (v.result.runs.find(x => x.runId === r.id) || {}).waiting).length;
			runs = runs.filter(r => !(v.result.runs.find(x => x.runId === r.id) || {}).waiting);
			const capped = runs.length > CAL_MAX_RUNS;
			runs = runs.slice(0, CAL_MAX_RUNS);
			const base = shared.buildInput(v.view);
			const out = [];
			for (const run of runs) {
				await new Promise(r => setTimeout(r, 0)); // let the page paint between runs
				const result = resultsCalc.compute({
					...base,
					route: { startStationId: run.route.startStationId, endStationId: run.route.endStationId, startRegionId: run.route.startRegionId, endRegionId: run.route.endRegionId },
					market: {}, window: { runId: run.id }
				});
				out.push({ run, rows: result.types });
			}
			return { runs: out, skipped: 0, waiting, capped };
		})();
		calCache = { key, promise, ledgers: state.ledgers, snapshots: state.snapshots };
		return promise;
	};

	const modelCalibration = (v, data) => {
		if (v.isUnplanned) return emptyWindow('Unplanned batches have no prediction', 'These hand-offs were not preceded by an export run, so there is nothing to compare. Pick a run, or a window that holds runs.', true);
		const points = ic.calibration(data.runs);
		if (points.length === 0) {
			return emptyWindow('Nothing to compare yet', `${v.isRun ? 'This run has no sale of an item from its plan yet.' : data.runs.length === 0 ? 'No export run with a hand-off in this window.' : 'The runs in this window have no sales or no item that appears in their plan yet.'}${data.waiting > 0 ? ` ${data.waiting} run${data.waiting === 1 ? ' is' : 's are'} still waiting for a hand-off.` : ''}`);
		}
		const runOrder = [...new Set(points.map(p => p.runId))];
		const newest = data.runs.map(r => r.run).filter(r => runOrder.includes(r.id)).sort((a, b) => Date.parse(b.copiedAt) - Date.parse(a.copiedAt));
		const slotOf = new Map(newest.map((r, i) => [r.id, i < 3 ? i : -1])); // scatter: the first three slots validate all-pairs
		const colored = points.map(p => ({ ...p, slot: slotOf.get(p.runId), color: slotOf.get(p.runId) >= 0 ? CAT[slotOf.get(p.runId)] : OTHER, symbol: SCATTER_SYMBOLS[slotOf.get(p.runId)] || 'circle' }));
		return { points: colored, runs: newest, slotOf, waiting: data.waiting, capped: data.capped };
	};

	const runName = (run) => `${stamp(run.copiedAt)} · ${run.route.start}${ARROW}${run.route.end}`;

	// Round ISK ticks for a symmetric-log axis: 0 and powers of ten from the axis constant up, both signs, thinned to about nine.
	const niceTicks = (lo, hi, constant) => {
		const first = Math.max(0, Math.ceil(Math.log10(constant * 10))); // the first decade clear of the near-zero stretch
		const powers = [];
		for (let p = first; 10 ** p <= Math.max(hi, -lo) * 1.0001; p++) powers.push(10 ** p);
		const step = Math.max(1, Math.ceil((powers.length * (lo < 0 ? 2 : 1)) / 8));
		const keep = powers.filter((_, i) => i % step === 0);
		return [0, ...keep.filter(v => v <= hi), ...keep.filter(v => -v >= lo).map(v => -v)].sort((a, b) => a - b);
	};

	const drawScatter = (m, width, cfg) => {
		const height = 340;
		const marginLeft = 60;
		const pts = m.points.filter(p => isNum(p[cfg.x]) && isNum(p[cfg.y]));
		if (pts.length === 0) return el('p', { class: 'dim', text: cfg.none });
		const all = pts.flatMap(p => [p[cfg.x], p[cfg.y]]);
		let lo = Math.min(0, ...all);
		let hi = Math.max(...all, cfg.log ? 1000 : 1);
		if (!cfg.log) { lo = 0; hi *= 1.06; }
		else if (lo < 0) lo *= 1.2;
		// the log axis is linear within `constant` of zero: the smallest typical magnitude among the points
		const mags = all.map(Math.abs).filter(a => a > 0).sort((a, b) => a - b);
		const constant = cfg.log ? Math.max(1, mags.length > 0 ? mags[Math.floor(mags.length * 0.1)] : 1) : null;
		const tickList = cfg.log ? niceTicks(lo, hi, constant) : null;
		const axis = cfg.log ? { type: 'symlog', constant, domain: [lo, hi], tickFormat: (d) => fmtIsk(d), ticks: tickList, tickSize: 0 } : { domain: [lo, hi], tickFormat: (d) => fmtDays(d), tickSize: 0, ticks: 6 };
		const solid = pts.filter(p => !cfg.hollow(p));
		const hollow = pts.filter(p => cfg.hollow(p));
		const plot = Plot.plot({
			width, height, marginLeft, marginRight: 16, marginTop: 28, marginBottom: 42,
			style: PLOT_STYLE,
			x: { ...axis, label: cfg.xLabel, labelAnchor: 'center' },
			y: { ...axis, label: cfg.yLabel, labelAnchor: 'center' },
			marks: [
				Plot.gridX(tickList || undefined, { stroke: GRID, strokeOpacity: 1 }), Plot.gridY(tickList || undefined, { stroke: GRID, strokeOpacity: 1 }),
				Plot.line([[lo, lo], [hi, hi]], { stroke: INK2, strokeWidth: 1 }),
				Plot.dot(solid, { x: cfg.x, y: cfg.y, r: 5.5, symbol: 'symbol', fill: 'color', stroke: SURFACE, strokeWidth: 2 }),
				Plot.dot(hollow, { x: cfg.x, y: cfg.y, r: 5.5, symbol: 'symbol', fill: SURFACE, stroke: 'color', strokeWidth: 2 })
			]
		});
		finishSvg(plot, cfg.label);
		const sx = plot.scale('x');
		const sy = plot.scale('y');
		const targets = pts.map(p => ({
			shape: 'circle', x: sx.apply(p[cfg.x]), y: sy.apply(p[cfg.y]), r: 12,
			tip: cfg.tip(p)
		}));
		attachTargets(plot, targets, { nearest: true, reach: 26, label: `${cfg.label}. Arrow keys move between points.` });
		return plot;
	};

	const drawCalibration = (m, width) => {
		const gap = 18;
		const two = width >= 700;
		const w = two ? Math.floor((width - gap) / 2) : width;
		const item = (p) => nameOfType(p.typeId);
		const profit = drawScatter(m, w, {
			x: 'predictedProfit', y: 'realizedProfit', log: true, hollow: () => false,
			xLabel: 'predicted profit per item →', yLabel: '↑ realized profit per item sold',
			label: 'Predicted against realized profit per item',
			none: 'No item sold yet, so there is no realized profit to compare.',
			tip: (p) => ({
				title: `${item(p)}`,
				rows: [
					{ color: p.color, value: fmtIsk(p.realizedProfit, true), name: 'realized per item sold' },
					{ value: fmtIsk(p.predictedProfit, true), name: 'predicted per item' },
					{ value: `${fmtQty(p.soldQty)} of ${fmtQty(p.boughtQty)}`, name: 'units sold' }
				],
				note: `${runName(m.runs.find(r => r.id === p.runId))}. ${p.realizedProfit >= p.predictedProfit ? 'At or above' : 'Below'} the line: ${p.realizedProfit >= p.predictedProfit ? 'at least as much as' : 'less than'} predicted.`
			})
		});
		const days = drawScatter(m, w, {
			x: 'predictedDays', y: 'actualDays', log: false, hollow: (p) => p.projected,
			xLabel: 'predicted days to clear →', yLabel: '↑ actual days (hollow: projected)',
			label: 'Predicted against actual days to clear',
			none: 'No item has a predicted and an actual number of days yet.',
			tip: (p) => ({
				title: `${item(p)}`,
				rows: [
					{ color: p.color, value: `${fmtDays(p.actualDays)} days`, name: p.projected ? 'projected from sales so far' : 'actual, sold out' },
					{ value: `${fmtDays(p.predictedDays)} days`, name: 'predicted' }
				],
				note: `${runName(m.runs.find(r => r.id === p.runId))}. ${p.actualDays > p.predictedDays + 0.05 ? 'Above the line: slower than predicted.' : p.actualDays < p.predictedDays - 0.05 ? 'Below the line: faster than predicted.' : 'On the line.'}`
			})
		});
		const panel = (title, sub, chart) => el('div', { class: 'panel' }, el('h3', { text: title }), el('p', { class: 'sub', text: sub }), chart);
		return el('div', { class: 'panels' },
			panel('Profit per item', 'Above the line: more profit per item than the run predicted.', profit),
			panel('Days to clear', 'Above the line: slower than predicted; below it, faster.', days));
	};

	const legendCalibration = (m) => {
		const items = m.runs.filter(r => m.slotOf.get(r.id) >= 0).map(r => ({ label: runName(r), color: CAT[m.slotOf.get(r.id)], kind: ['dot', 'square', 'triangle'][m.slotOf.get(r.id)] }));
		const rest = m.runs.filter(r => m.slotOf.get(r.id) < 0).length;
		if (rest > 0) items.push({ label: `${rest} older run${rest === 1 ? '' : 's'}`, color: OTHER, kind: 'dot' });
		items.push({ label: 'predicted = actual', color: INK2, kind: 'line' });
		items.push({ label: 'hollow: projected, stock left', color: INK2, kind: 'ring' });
		return items;
	};

	const tableCalibration = (m) => ({
		caption: 'Prediction against what happened, per run and item (units sold so far; days projected while stock is left)',
		columns: [{ label: 'run' }, { label: 'item' }, { label: 'sold of bought', numeric: true }, { label: 'predicted profit/item', numeric: true }, { label: 'realized profit/item', numeric: true }, { label: 'predicted days', numeric: true }, { label: 'actual days', numeric: true }],
		rows: m.points.slice().sort((a, b) => Date.parse(b.copiedAt) - Date.parse(a.copiedAt) || nameOfType(a.typeId).localeCompare(nameOfType(b.typeId))).map(p => ({
			cells: [runName(m.runs.find(r => r.id === p.runId)), nameOfType(p.typeId), `${fmtQty(p.soldQty)} of ${fmtQty(p.boughtQty)}`,
				isNum(p.predictedProfit) ? { t: fmtIsk(p.predictedProfit, true), title: fmtExact(p.predictedProfit) } : DASH,
				isNum(p.realizedProfit) ? { t: fmtIsk(p.realizedProfit, true), title: fmtExact(p.realizedProfit), neg: p.realizedProfit < 0 } : DASH,
				isNum(p.predictedDays) ? fmtDays(p.predictedDays) : DASH, isNum(p.actualDays) ? `${fmtDays(p.actualDays)}${p.projected ? ' (proj.)' : ''}` : DASH]
		}))
	});

	const footCalibration = (m) => {
		const lines = ['Profit is per item: the run’s predicted profit per item against the realized profit per unit sold so far (sales tax, listing and relist fees, haul and buy cost all in). The axes are stretched logarithmically around zero so cheap and expensive items fit one picture.'];
		if (m.runs.length > 3) lines.push('The three newest runs take a colour each, the rest are grey: a scatter with more colours stops being readable. The table lists every run.');
		if (m.waiting > 0) lines.push(`${m.waiting} run${m.waiting === 1 ? '' : 's'} in the window ${m.waiting === 1 ? 'is' : 'are'} still waiting for a hand-off and ${m.waiting === 1 ? 'is' : 'are'} left out.`);
		if (m.capped) lines.push(`Only the ${CAL_MAX_RUNS} newest runs are worked out.`);
		return lines;
	};

	//--- 5. capital at work

	const modelCapital = (v, withWallet) => {
		const res = v.result;
		const route = v.view.route;
		const fromMs = res.window.start === null ? null : Date.parse(res.window.start);
		const cap = ic.capital({ snapshots: state.snapshots, lots: res.facts.lots, couriers: res.couriers, route, fromMs, toMs: v.view.now });
		if (cap.days.length === 0) {
			return emptyWindow('No snapshots yet', 'This chart is built from the order, asset and wallet snapshots each sync keeps. Sync from the results page, then come back.', false);
		}
		if (cap.days.length < 2) {
			const d = cap.days[0];
			return emptyWindow('One day of snapshots so far', `The chart needs snapshots from two different days (${new Date(d.day).toISOString().slice(0, 10)} UTC: wallet ${fmtIsk(d.wallet)}, escrow ${fmtIsk(d.escrow)}, source ${fmtIsk(d.source)}, in transit ${fmtIsk(d.transit)}, destination ${fmtIsk(d.dest)}, listed ${fmtIsk(d.listed)}). It appears after the next day’s sync.`, false);
		}
		const keys = ic.CAPITAL_SERIES.filter(k => withWallet || k !== 'wallet');
		return { cap, keys, withWallet, route };
	};

	const drawCapital = (m, width, live) => {
		const height = 340;
		const marginLeft = 64;
		const marginRight = 18;
		const data = [];
		// one tick per day (every few days when the chart is long), never two ticks for one date
		const every = Math.max(1, Math.ceil(m.cap.days.length / Math.max(2, Math.floor((width - marginLeft) / 70))));
		const tickDates = m.cap.days.filter((_, i) => i % every === 0).map(d => new Date(d.day));
		for (const k of m.keys) for (const d of m.cap.days) data.push({ date: new Date(d.day), series: CAPITAL_LABELS[k], key: k, value: d[k], color: CAPITAL_COLORS[k] });
		const plot = Plot.plot({
			width, height, marginLeft, marginRight, marginTop: 28, marginBottom: 32,
			style: PLOT_STYLE,
			x: { type: 'utc', label: null, tickSize: 0, ticks: tickDates, tickFormat: (d) => d3.utcFormat('%b %-d')(d) },
			y: { label: '↑ ISK at work', tickFormat: (d) => fmtIsk(d), tickSize: 0, grid: false },
			marks: [
				Plot.gridY({ stroke: GRID, strokeOpacity: 1 }),
				Plot.areaY(data, { x: 'date', y: 'value', fill: 'color', z: 'series', fillOpacity: 0.9, stroke: SURFACE, strokeWidth: 2, curve: 'linear' }),
				Plot.ruleY([0], { stroke: AXIS })
			]
		});
		finishSvg(plot, 'Capital at work by day, stacked');
		const sx = plot.scale('x');
		const xs = m.cap.days.map(d => d.day);
		const spec = (x) => {
			const d = m.cap.days.find(r => r.day === x);
			const rows = [...m.keys].reverse().map(k => ({ color: CAPITAL_COLORS[k], value: fmtIsk(d[k]), name: CAPITAL_LABELS[k] }));
			const total = m.keys.reduce((a, k) => a + d[k], 0);
			rows.unshift({ value: fmtIsk(total), name: 'total shown' });
			return { title: `${new Date(x).toISOString().slice(0, 10)} (as of the end of the day, UTC)`, rows, note: d.unvaluedUnits > 0 ? `${fmtQty(d.unvaluedUnits)} units of ${d.unvaluedTypes} item${d.unvaluedTypes === 1 ? '' : 's'} have no purchase on record and are not valued.` : null };
		};
		attachCrosshair(plot, { x0: marginLeft, x1: width - marginRight, y0: 28, y1: height - 32 }, xs, (x) => sx.apply(new Date(x)), spec, 'Capital at work. Left and right arrow keys read each day.', live);
		return plot;
	};

	const legendCapital = (m) => m.keys.map(k => ({ label: CAPITAL_LABELS[k], color: CAPITAL_COLORS[k] }));

	const tableCapital = (m) => ({
		caption: 'ISK at work by day (UTC, end of day; the newest snapshot of each character at that time)',
		columns: [{ label: 'day' }, ...ic.CAPITAL_SERIES.map(k => ({ label: CAPITAL_LABELS[k].toLowerCase(), numeric: true })), { label: 'total', numeric: true }, { label: 'unvalued units', numeric: true }],
		rows: m.cap.days.map(d => ({
			cells: [new Date(d.day).toISOString().slice(0, 10), ...ic.CAPITAL_SERIES.map(k => ({ t: fmtIsk(d[k]), title: fmtExact(d[k]) })), { t: fmtIsk(d.total), title: fmtExact(d.total) }, d.unvaluedUnits > 0 ? fmtQty(d.unvaluedUnits) : DASH]
		}))
	});

	const footCapital = (m) => {
		const lines = ['Cash is the wallet balance; escrow is what open buy orders hold. Stock is valued at cost: the units of an item that are physically there (source, transit, destination, listed) are taken to be the newest ones its purchases up to that day account for, since the books sell the oldest first, and their average cost is the cost per unit. Stock at the source counts the buy price and buy-order fee; in transit, at the destination and listed also count the haul.'];
		lines.push('In transit is what open courier contracts carried that day (ESI hides courier packages, so it comes from the contracts, not from assets). Items with no purchase on record are left out of the value; the tooltip and the table count them.');
		const names = m.cap.characters.map(c => `${charName(c.id)} from ${new Date(c.firstAt).toISOString().slice(0, 10)}`).join(', ');
		lines.push(`Snapshots: ${names}. The chart starts on the first day every one of them has a snapshot${m.cap.earlierThan ? ' (earlier days would miss part of the capital)' : ''}; days between syncs repeat the last snapshot.`);
		return lines;
	};

	//--- the chart list: order, titles and controls

	const CHARTS = [
		{
			id: 'waterfall', title: 'Cost waterfall',
			sub: 'Where the sales of this window went: gross sales, then each cost, down to the profit. The same figures as the results page’s totals strip.',
			model: (v) => modelWaterfall(v), draw: (m, w) => drawWaterfall(m, w), legend: legendWaterfall, table: tableWaterfall, foot: footWaterfall
		},
		{
			id: 'heatmap', title: 'When sales happen',
			sub: 'Sales at the destination by weekday and hour, to see when buyers are about.',
			controls: [
				{ key: 'tz', label: 'Time', options: [{ value: 'utc', label: 'EVE time', title: 'UTC, the in-game clock' }, { value: 'local', label: 'Local' }], fallback: 'utc' },
				{ key: 'metric', label: 'Show', options: [{ value: 'isk', label: 'ISK' }, { value: 'units', label: 'Units' }], fallback: 'isk' }
			],
			model: (v, o) => modelHeat(v, o.tz !== 'local'), draw: (m, w, o) => drawHeat(m, w, o.metric), legend: (m, o) => legendHeat(m, o.metric), table: (m, o) => tableHeat(m, o.metric), foot: (m, o) => footHeat(m, o.metric)
		},
		{
			id: 'sellthrough', title: 'Sell-through per batch',
			sub: 'How fast each hand-off sold, from the day its courier delivered it: the share of its units sold, batches overlaid.',
			model: (v) => modelSellThrough(v), draw: (m, w, o, live) => drawSellThrough(m, w, live), legend: legendSellThrough, table: tableSellThrough, foot: footSellThrough
		},
		{
			id: 'calibration', title: 'Prediction against what happened',
			sub: 'The export page’s prediction for each item against the realized result, by run.',
			async: true, names: true, asyncModel: async (v) => modelCalibration(v, await calibrationRuns(v)),
			draw: (m, w) => drawCalibration(m, w), legend: legendCalibration, table: tableCalibration, foot: footCalibration
		},
		{
			id: 'capital', title: 'Capital at work',
			sub: 'ISK in the wallet, in escrow and tied up in stock along the route, by day, from the snapshots each sync keeps.',
			controls: [{ key: 'wallet', label: 'Wallet', options: [{ value: 'with', label: 'With cash', title: 'stack the wallet balance too' }, { value: 'without', label: 'Without' }], fallback: 'with' }],
			model: (v, o) => modelCapital(v, o.wallet !== 'without'), draw: (m, w, o, live) => drawCapital(m, w, live), legend: legendCapital, table: tableCapital, foot: footCapital
		}
	];

	//--- the cards

	const cards = new Map(); // chart id -> {root, body, live, token}

	const buildCard = (chart) => {
		const body = el('div', { class: 'chartBody' });
		const live = el('div', { class: 'sr', 'aria-live': 'polite' });
		const ctls = el('div', { class: 'ctls' });
		const root = el('section', { class: 'chart', id: `chart-${chart.id}`, 'aria-labelledby': `h-${chart.id}` },
			el('div', { class: 'chartHead' },
				el('div', {}, el('h2', { id: `h-${chart.id}`, text: chart.title }), el('p', { class: 'sub', text: chart.sub })),
				ctls),
			body, live);
		const card = { chart, root, body, live, ctls, token: 0, last: null };
		cards.set(chart.id, card);
		return card;
	};

	const options = (chart) => {
		const o = {};
		for (const c of chart.controls || []) o[c.key] = pref(chart.id, c.key, c.fallback);
		return o;
	};

	const renderControls = (card, hasTable) => {
		const { chart } = card;
		const o = options(chart);
		const kids = [];
		for (const c of chart.controls || []) {
			const group = el('span', { class: 'ctlGroup' }, el('span', { class: 'muted', text: c.label }),
				el('span', { class: 'seg', role: 'group', 'aria-label': `${chart.title}: ${c.label}` }, c.options.map(op => el('button', {
					type: 'button', 'aria-pressed': String(o[c.key] === op.value), 'data-chart': chart.id, 'data-key': c.key, 'data-v': op.value, text: op.label, title: op.title || null
				}))));
			kids.push(group);
		}
		if (hasTable) {
			const view = pref(chart.id, 'view', 'chart');
			kids.push(el('span', { class: 'ctlGroup' }, el('span', { class: 'muted', text: 'View' }),
				el('span', { class: 'seg', role: 'group', 'aria-label': `${chart.title}: view` }, ['chart', 'table'].map(vw => el('button', {
					type: 'button', 'aria-pressed': String(view === vw), 'data-chart': chart.id, 'data-key': 'view', 'data-v': vw, text: vw === 'chart' ? 'Chart' : 'Table', title: vw === 'chart' ? 'draw the chart' : 'the same figures as a table'
				})))));
		}
		card.ctls.replaceChildren(...kids);
	};

	const widenButton = (v) => {
		const next = widenNext(v ? v.view.sel : shared.resolveSelection());
		if (!next) return null;
		return el('button', { type: 'button', 'data-act': 'widen', text: `Widen to ${next.label}` });
	};

	const drawBody = (card, model, v) => {
		const { chart } = card;
		const o = options(chart);
		const view = pref(chart.id, 'view', 'chart');
		const width = Math.max(300, Math.min(1008, Math.floor(card.root.clientWidth - 30) || 900));
		// Nothing changed since the last drawing (a second pass with prices, item names for a chart that shows
		// none): keep the DOM, so a reader's focus and tooltip are not thrown away by a redraw.
		const sig = `${view}|${width}|${JSON.stringify(o)}|${chart.names ? Object.keys(state.names).length : ''}|${JSON.stringify(model)}`;
		if (card.sig === sig && card.root.dataset.ready === '1') {
			card.body.classList.remove('refreshing');
			return;
		}
		card.sig = sig;
		const kids = [];
		if (view === 'table') {
			kids.push(tableEl(chart.table(model, o)));
		} else {
			const lg = legendEl(chart.legend(model, o));
			if (lg) kids.push(lg);
			kids.push(chart.draw(model, width, o, card.live));
		}
		const foot = chart.foot(model, o).filter(Boolean);
		if (foot.length > 0) kids.push(el('div', { class: 'foot dim' }, foot.map(t => el('p', { text: t }))));
		card.body.replaceChildren(...kids);
		card.body.classList.remove('refreshing');
		card.root.dataset.ready = '1';
		card.last = model;
		void v;
	};

	const setBodyState = (card, node, keepLast = false) => {
		card.sig = null;
		card.body.classList.remove('refreshing');
		card.body.replaceChildren(node);
		if (!keepLast) card.last = null;
		card.root.dataset.ready = '0';
	};

	const renderCard = (card) => {
		const { chart } = card;
		const v = state.view;
		const token = ++card.token;
		renderControls(card, !!v && !state.computeError);
		if (!v || state.computeError) {
			if (state.computeError) setBodyState(card, stateCard('err', 'This chart could not be worked out', state.computeError, el('button', { type: 'button', 'data-act': 'retry', text: 'Try again' })));
			else if (state.fatal) setBodyState(card, stateCard('err', state.fatal.title, 'See the message above.', el('button', { type: 'button', 'data-act': 'retry', text: 'Try again' })));
			else setBodyState(card, el('div', { class: 'skeleton', role: 'status', text: state.busy || 'Loading trade data…' }));
			return;
		}
		const o = options(chart);
		const finish = (model) => {
			if (token !== card.token) return;
			if (model.empty) {
				const buttons = model.empty.widen ? [widenButton(v)].filter(Boolean) : [];
				setBodyState(card, stateCard('', model.empty.title, model.empty.text, ...buttons));
				renderControls(card, false);
				return;
			}
			try {
				drawBody(card, model, v);
			} catch (e) {
				console.error(e);
				setBodyState(card, stateCard('err', 'This chart could not be drawn', `${e && e.message ? e.message : e}. The table view may still work.`, el('button', { type: 'button', 'data-act': 'retry', text: 'Try again' })));
			}
		};
		if (chart.async) {
			if (card.last) card.body.classList.add('refreshing'); // refetch keeps the frame
			else setBodyState(card, stateCard('busy', 'Working out each run…', 'Every run in the window is worked out from the ledger, one after another.'));
			chart.asyncModel(v, o).then(finish, (e) => {
				if (token !== card.token) return;
				console.error(e);
				setBodyState(card, stateCard('err', 'This chart could not be worked out', e && e.message ? e.message : String(e), el('button', { type: 'button', 'data-act': 'retry', text: 'Try again' })));
			});
			return;
		}
		let model;
		try {
			model = chart.model(v, o);
		} catch (e) {
			console.error(e);
			setBodyState(card, stateCard('err', 'This chart could not be worked out', e && e.message ? e.message : String(e), el('button', { type: 'button', 'data-act': 'retry', text: 'Try again' })));
			return;
		}
		finish(model);
	};

	const renderCharts = () => {
		hideTip();
		if (page.charts.children.length === 0) for (const chart of CHARTS) page.charts.append(buildCard(chart).root);
		const blocked = !state.cfg || !state.cfg.configured || !state.characters || state.characters.length === 0;
		page.charts.hidden = blocked;
		if (blocked) return;
		const busyFirst = !state.view && !state.computeError && !state.fatal;
		if (busyFirst && [...cards.values()].every(c => c.root.dataset.ready === '1')) return;
		for (const card of cards.values()) renderCard(card);
	};

	//--- page chrome: banners, state box, status

	const bannerHtml = (b) => `<div class="banner ${b.kind}"><span class="sev">${b.kind === 'err' ? 'Error:' : b.kind === 'warn' ? 'Warning:' : 'Note:'}</span><span>${esc(b.text)}</span>${b.action || ''}</div>`;

	const renderBanners = () => {
		const list = [];
		if (state.loadError) list.push({ kind: 'warn', text: state.loadError });
		for (const c of state.characters || []) {
			if (c.status === 'relink') list.push({ kind: 'err', text: `${c.name || `character ${c.characterId}`} needs re-linking, so its newest trades are missing from these charts. Re-link it on the results page.`, action: '<a class="btn" href="results.html">Open results</a>' });
		}
		setHtml(page.banners, list.map(bannerHtml).join(''));
	};

	const cardHtml = (title, html) => `<div class="card"><h2>${esc(title)}</h2>${html}</div>`;

	const stateBoxHtml = () => {
		if (state.fatal) return cardHtml(state.fatal.title, `${state.fatal.html}<button type="button" data-act="retry">Try again</button>`);
		if (!state.cfg) return cardHtml('Loading…', '<p class="muted">Contacting the server.</p>');
		if (!state.cfg.configured) return cardHtml('EVE sign-in is not set up', '<p>The charts are built from your own wallet, orders, assets and contracts, which need EVE sign-in. The results page has the setup steps.</p><a class="btn" href="results.html">Open results</a>');
		if (!state.characters) return cardHtml('Loading…', '<p class="muted">Reading the linked characters.</p>');
		if (state.characters.length === 0) return cardHtml('Link the characters that buy and sell', '<p>The charts are worked out from the wallet, orders, assets and contracts of the characters you link. Link them on the results page.</p><a class="btn" href="/sso/login?return=/results.html">+ Add character</a>');
		return '';
	};

	const renderStateBox = () => setHtml(page.stateBox, stateBoxHtml());

	const renderStatus = () => {
		const parts = [];
		if (state.busy) parts.push(state.busy);
		if (state.typeProgress && state.typeProgress.total > 0) parts.push(`looking up item names and volumes ${state.typeProgress.done}/${state.typeProgress.total}`);
		setText(page.status, parts.join(' · '));
		page.charts.classList.toggle('stale', !!state.busy && !!state.view); // refetch keeps the frame: the last charts stay, dimmed
		const chars = state.characters || [];
		const times = chars.map(c => {
			const st = state.sync && state.sync.characters && state.sync.characters[c.characterId];
			return st && st.syncedAt ? `${c.name || c.characterId} ${ago(st.syncedAt)}` : null;
		}).filter(Boolean);
		setText(page.dataNote, chars.length > 0 ? `Data as of the last sync (${times.length > 0 ? times.join(', ') : 'not synced yet'}). Sync from the results page.` : '');
		// until the first results are in, the page body says what is loading (and each chart holds its place)
		if (!state.view) {
			renderStateBox();
			renderCharts();
		}
	};

	const render = () => {
		renderBanners();
		shared.renderWindowBar();
		renderStateBox();
		renderStatus();
		renderCharts();
	};

	//--- events

	document.addEventListener('click', (e) => {
		const act = e.target.closest('[data-act]');
		if (act) {
			if (act.dataset.act === 'retry') {
				state.fatal = null;
				state.computeError = null;
				init();
			} else if (act.dataset.act === 'widen') {
				const next = widenNext(shared.resolveSelection());
				if (next) shared.chooseWindow(next.sel);
				$('#windowSel').focus();
			}
			return;
		}
		const seg = e.target.closest('button[data-chart][data-key]');
		if (!seg) return;
		const c = cards.get(seg.dataset.chart);
		if (!c) return;
		setPref(seg.dataset.chart, seg.dataset.key, seg.dataset.v);
		renderCard(c);
		const again = c.root.querySelector(`button[data-key="${seg.dataset.key}"][data-v="${seg.dataset.v}"]`);
		if (again) again.focus();
	});

	// Charts follow the width of the page: redrawn when it changes.
	let lastWidth = 0;
	let resizeTimer = null;
	if (typeof ResizeObserver !== 'undefined') {
		new ResizeObserver(() => {
			const w = page.charts.clientWidth;
			if (Math.abs(w - lastWidth) < 24) return;
			lastWidth = w;
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => { if (state.view) renderCharts(); }, 150);
		}).observe(page.charts);
	}

	//--- init

	const init = async () => {
		try {
			state.cfg = await resultsShared.api('/api/config');
		} catch (e) {
			shared.loadFatal(e);
			render();
			return;
		}
		render();
		if (!state.cfg.configured) return;
		await shared.reloadData();
	};

	shared.renderWindowBar();
	render();
	init();

	// "synced 12 minutes ago" moves on without a poll.
	setInterval(renderStatus, 30000);
})();
