// Trade results accounting: turns the ledgers of the linked characters (wallet transactions and
// journal, orders, contracts and their items, retained snapshots) into what an export really did:
// lots, batches (the buyer's hand-offs) and transfers (a seller passing units of a batch on to
// another linked character, which move no lot), couriers, FIFO sells, realized profit per type,
// what is left, and an event-level fact table every chart groups for itself (sells, fees, lots,
// transfers, relists). Pure: no network, no DOM, no clock (the caller passes `now`), so it runs
// under `node --test` and loads in the page with a plain <script>.
// The rules are docs/trade-results-plan.md, "Profit accounting rules" 1-12 (transfers: rule 2,
// decision 21) and "Comparison to the prediction"; the comments below name the rule they implement.
//
// Browser: <script src="results-calc.js"></script> defines `window.resultsCalc`.
// Node:    const resultsCalc = require('./public/results-calc.js');
(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory();
	else root.resultsCalc = factory();
})(typeof self !== 'undefined' ? self : this, () => {
	const DAY_MS = 24 * 60 * 60 * 1000;
	const HOUR_MS = 60 * 60 * 1000;
	const MIL = 1e6;

	const defaultOptions = Object.freeze({
		countHaulerBonuses: true, // the results page's "count hauler bonuses" toggle (rule 7)
		SALES_TAX: 0.08,          // only when no transaction_tax row was ever matched (rule 4)
		BROKER_FEE: 0.024,        // only for the "at market" value of unsold units (rule 9)
		brokerMatchSeconds: 2,    // a brokers_fee row within this of an order's `issued` is that order's (rule 5b)
		taxNearSeconds: 2,        // second-pass tax match window (rule 4)
		taxRateTolerance: 0.01,   // ...choosing among several sells by implied rate within 1 % (relative) of the expected one
		taxRateMax: 0.1,          // ...and a lone candidate's implied rate must be in (0, this]
		bonusWindowHours: 48,     // a hauler bonus is dated from date_accepted to date_completed + this (rule 7)
		runMaxAgeDays: 7,         // a batch belongs to a run copied at most this long before it
		courierVolumeTolerance: 0.01, // a courier's volume may exceed its batches' summed volume by 1 %
		netGmRefunds: true,       // a gm_cash_transfer of exactly a broker fee's amount voids that fee
		gmRefundDays: 30          // ...when dated within this many days after it
	});

	// Issuer-side courier rows (rule 6). `contract_price` is deliberately absent: within the pool
	// it is internal (rule 7).
	const CONTRACT_COST_REFS = new Set([
		'contract_reward_deposited', 'contract_reward_refund', 'contract_brokers_fee',
		'contract_deposit', 'contract_deposit_refund'
	]);
	const DEPOSIT_REFS = new Set(['contract_deposit', 'contract_deposit_refund']);
	const DEAD_STATUSES = new Set(['deleted', 'cancelled', 'rejected', 'reversed']);

	//--- helpers

	const toMs = (value) => {
		if (value === null || value === undefined || value === '') return null;
		if (typeof value === 'number') return Number.isFinite(value) ? value : null;
		if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
		const ms = Date.parse(value);
		return Number.isFinite(ms) ? ms : null;
	};
	// ESI style: whole seconds, no milliseconds.
	const iso = (ms) => (ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString().replace('.000Z', 'Z'));
	const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
	const sum = (list, f) => list.reduce((acc, x) => acc + f(x), 0);
	const days = (ms) => ms / DAY_MS;
	const groupBy = (list, keyOf) => {
		const map = new Map();
		for (const x of list) {
			const k = keyOf(x);
			if (!map.has(k)) map.set(k, []);
			map.get(k).push(x);
		}
		return map;
	};
	const addTo = (map, key, amount) => map.set(key, (map.get(key) || 0) + amount);

	const isFinished = (status) => typeof status === 'string' && status.startsWith('finished');
	const isOpenContract = (status) => status === 'outstanding' || status === 'in_progress';
	const isDead = (status) => DEAD_STATUSES.has(status);
	const rowKey = (row) => `${row.characterId}:${row.id}`;
	const sellKey = (tx) => `${tx.characterId}:${tx.transaction_id}`;
	const cmpLot = (a, b) => a.ms - b.ms || a.transactionId - b.transactionId || a.seq - b.seq;
	const cmpIssued = (a, b) => (toMs(a.date_issued) || 0) - (toMs(b.date_issued) || 0) || a.contract_id - b.contract_id;
	const m3Of = (ctx, typeId) => {
		const v = ctx.m3[typeId];
		return typeof v === 'number' && v > 0 ? v : null;
	};
	const marketOf = (ctx, typeId) => {
		const v = ctx.market[typeId];
		if (typeof v === 'number' && v > 0) return v;
		if (v && typeof v.bestSell === 'number' && v.bestSell > 0) return v.bestSell;
		return null;
	};

	// Spreads `cost` over the units in qtyByType (Map typeId -> qty) by packaged volume (rule 6):
	// per-unit cost of T = cost * m3_T / sum(qty * m3). With any m3 unknown it splits by units
	// instead and says so (est).
	const perUnitByM3 = (ctx, cost, qtyByType) => {
		const entries = [...qtyByType].filter(([, qty]) => qty > 0);
		const known = entries.every(([typeId]) => m3Of(ctx, typeId) !== null);
		const weight = (typeId) => (known ? m3Of(ctx, typeId) : 1);
		const total = sum(entries, ([typeId, qty]) => qty * weight(typeId));
		const perUnit = new Map();
		if (total > 0) for (const [typeId] of entries) perUnit.set(typeId, cost * weight(typeId) / total);
		return { perUnit, est: !known && entries.length > 0 };
	};

	// Newest-first candidates (at most 12); the subset whose summed contract volume comes closest to
	// the courier's volume without exceeding it by more than the tolerance. Ties prefer the subset
	// holding the newest batch. [] when nothing fits.
	const pickBatchesByVolume = (candidates, volume, tolerance) => {
		const list = candidates.slice(0, 12);
		const limit = volume * (1 + tolerance) + 1e-9;
		let best = null;
		for (let mask = 1; mask < (1 << list.length); mask++) {
			let vol = 0;
			for (let i = 0; i < list.length; i++) if (mask & (1 << i)) vol += num(list[i].volume);
			if (vol > limit) continue;
			const gap = Math.abs(volume - vol);
			const newer = best !== null && (mask & -mask) < (best.mask & -best.mask);
			if (best === null || gap < best.gap - 1e-9 || (Math.abs(gap - best.gap) <= 1e-9 && newer)) best = { mask, gap };
		}
		return best === null ? [] : list.filter((_, i) => best.mask & (1 << i));
	};

	// Pairs tax rows with sells of the same second: the most pairs with an allowed id gap, then the
	// smallest total gap (greedy smallest-gap-first mis-pairs two sales whose tax rows both sit at +2).
	// Seconds hold a handful of sales; past 6 it falls back to greedy. Returns [[taxIndex, sellIndex]].
	const assignByGap = (taxes, sells, gapOf) => {
		if (taxes.length > 6 || sells.length > 6) {
			const pairs = [];
			taxes.forEach((tax, ti) => sells.forEach((sell, si) => {
				const gap = gapOf(tax, sell);
				if (gap !== null) pairs.push([ti, si, gap]);
			}));
			pairs.sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);
			const usedT = new Set();
			const usedS = new Set();
			const out = [];
			for (const [ti, si] of pairs) {
				if (usedT.has(ti) || usedS.has(si)) continue;
				usedT.add(ti);
				usedS.add(si);
				out.push([ti, si]);
			}
			return out;
		}
		let best = { count: 0, total: 0, pairs: [] };
		const used = new Set();
		const walk = (ti, pairs, total) => {
			if (ti === taxes.length) {
				if (pairs.length > best.count || (pairs.length === best.count && total < best.total)) best = { count: pairs.length, total, pairs: pairs.slice() };
				return;
			}
			walk(ti + 1, pairs, total);
			for (let si = 0; si < sells.length; si++) {
				if (used.has(si)) continue;
				const gap = gapOf(taxes[ti], sells[si]);
				if (gap === null) continue;
				used.add(si);
				pairs.push([ti, si]);
				walk(ti + 1, pairs, total + gap);
				pairs.pop();
				used.delete(si);
			}
		};
		walk(0, [], 0);
		return best.pairs;
	};

	//--- stage 0: normalize the per-character ledgers into one pool (set L)

	const contractRank = (c) => (c.date_completed ? 4 : 0) + (c.date_accepted ? 2 : 0) + (c.status && c.status !== 'outstanding' ? 1 : 0);

	const normalize = (input) => {
		const opt = { ...defaultOptions, ...(input.options || {}) };
		const now = toMs(input.now);
		if (now === null) throw new Error('resultsCalc.compute: `now` is required (ms, ISO string or Date)');
		const ledgers = input.ledgers || {};
		const ids = [...new Set((input.characterIds || Object.keys(ledgers)).map(Number))]
			.filter(Number.isFinite).sort((a, b) => a - b);
		const route = input.route || {};
		const ctx = {
			opt, now, ids, L: new Set(ids), route,
			S: route.startStationId === undefined || route.startStationId === null ? null : Number(route.startStationId),
			D: route.endStationId === undefined || route.endStationId === null ? null : Number(route.endStationId),
			m3: input.m3 || {},
			market: input.market || {},
			runsIn: Array.isArray(input.runs) ? input.runs : [],
			windowIn: input.window || {},
			locationsIn: input.locations || {},
			txs: [], journal: [], contracts: new Map(), items: new Map(),
			snapshots: new Map(), openOrders: [], historyOrders: [],
			warnings: []
		};
		const seenTx = new Set();
		const seenRow = new Set();
		for (const id of ids) {
			const led = ledgers[id] || ledgers[String(id)] || {};
			for (const t of led.transactions || []) {
				const k = `${id}:${t.transaction_id}`;
				if (seenTx.has(k)) continue;
				seenTx.add(k);
				ctx.txs.push({ ...t, characterId: id, ms: toMs(t.date) });
			}
			for (const j of led.journal || []) {
				const k = `${id}:${j.id}`;
				if (seenRow.has(k)) continue;
				seenRow.add(k);
				ctx.journal.push({ ...j, characterId: id, ms: toMs(j.date) });
			}
			// A hand-off between two linked characters is in both ledgers: merge by contract_id,
			// keeping the copy that has progressed furthest.
			for (const c of led.contracts || []) {
				const prev = ctx.contracts.get(c.contract_id);
				if (!prev || contractRank(c) >= contractRank(prev)) ctx.contracts.set(c.contract_id, { ...prev, ...c });
			}
			const itemMap = led.contractItems || {};
			for (const cid of Object.keys(itemMap)) {
				const list = itemMap[cid];
				if (!Array.isArray(list)) continue;
				const key = Number(cid);
				if (!ctx.items.has(key) || ctx.items.get(key).length === 0) ctx.items.set(key, list);
			}
			const snaps = (led.snapshots || [])
				.map(s => ({ ...s, characterId: id, ms: toMs(s.syncedAt) }))
				.filter(s => s.ms !== null && s.ms <= now)
				.sort((a, b) => a.ms - b.ms);
			ctx.snapshots.set(id, snaps);
			for (const o of led.ordersHistory || []) ctx.historyOrders.push({ o, characterId: id });
			const open = Array.isArray(led.orders) ? led.orders : (snaps.length > 0 ? snaps[snaps.length - 1].orders || [] : []);
			for (const o of open) ctx.openOrders.push({ o, characterId: id });
		}
		ctx.txs = ctx.txs.filter(t => t.ms !== null).sort((a, b) => a.ms - b.ms || a.transaction_id - b.transaction_id || a.characterId - b.characterId);
		ctx.journal = ctx.journal.filter(j => j.ms !== null).sort((a, b) => a.ms - b.ms || a.id - b.id || a.characterId - b.characterId);
		return ctx;
	};

	// Rule 1: personal, and not a trade between two linked characters.
	const inScope = (ctx, tx) => tx.is_personal === true && !ctx.L.has(tx.client_id);

	//--- stage 1: orders (history, open, every snapshot) and locations

	// One record per order_id: its latest state, every `issued` it has been seen with (each is a
	// placement or modification that charged a broker fee), and the price path across snapshots.
	// A missing is_buy_order means a sell order.
	const indexOrders = (ctx) => {
		const orders = new Map();
		const get = (o, characterId) => {
			let rec = orders.get(o.order_id);
			if (!rec) {
				rec = {
					orderId: o.order_id, characterId, typeId: o.type_id, locationId: o.location_id,
					regionId: o.region_id === undefined ? null : o.region_id, isBuy: o.is_buy_order === true,
					duration: o.duration, range: o.range, volumeTotal: o.volume_total,
					price: o.price, volumeRemain: o.volume_remain, issuedMs: toMs(o.issued),
					state: 'open', closed: false, issuedSet: new Set(), path: [], firstSeenMs: null,
					fees: [], feeKind: null, filledLotIds: []
				};
				orders.set(o.order_id, rec);
			}
			const issuedMs = toMs(o.issued);
			if (issuedMs !== null) rec.issuedSet.add(issuedMs);
			return rec;
		};
		const pushPath = (rec, atMs, o, source) => {
			const entry = { atMs, price: o.price, volumeRemain: o.volume_remain, issuedMs: toMs(o.issued), source };
			const last = rec.path[rec.path.length - 1];
			if (last && last.price === entry.price && last.volumeRemain === entry.volumeRemain && last.issuedMs === entry.issuedMs) return;
			rec.path.push(entry);
		};
		const latest = (rec, o) => {
			rec.price = o.price;
			rec.volumeRemain = o.volume_remain;
			rec.issuedMs = toMs(o.issued);
			if (o.volume_total !== undefined) rec.volumeTotal = o.volume_total;
		};
		const allSnaps = [];
		for (const snaps of ctx.snapshots.values()) allSnaps.push(...snaps);
		allSnaps.sort((a, b) => a.ms - b.ms || a.characterId - b.characterId);
		for (const s of allSnaps) {
			for (const o of s.orders || []) {
				const rec = get(o, s.characterId);
				if (rec.firstSeenMs === null || s.ms < rec.firstSeenMs) rec.firstSeenMs = s.ms;
				pushPath(rec, s.ms, o, 'snapshot');
				latest(rec, o);
			}
		}
		for (const { o, characterId } of ctx.openOrders) {
			const rec = get(o, characterId);
			pushPath(rec, null, o, 'open');
			latest(rec, o);
		}
		for (const { o, characterId } of ctx.historyOrders) {
			const rec = get(o, characterId);
			rec.closed = true;
			rec.state = o.state || 'expired';
			pushPath(rec, null, o, 'history');
			latest(rec, o);
		}
		ctx.orders = orders;
	};

	const indexLocations = (ctx) => {
		const region = new Map();
		const system = new Map();
		for (const key of Object.keys(ctx.locationsIn)) {
			const info = ctx.locationsIn[key] || {};
			if (info.regionId !== undefined && info.regionId !== null) region.set(Number(key), Number(info.regionId));
			if (info.systemId !== undefined && info.systemId !== null) system.set(Number(key), Number(info.systemId));
		}
		for (const rec of ctx.orders.values()) {
			if (rec.regionId !== null && !region.has(rec.locationId)) region.set(rec.locationId, rec.regionId);
		}
		const r = ctx.route;
		if (ctx.S !== null && r.startRegionId) region.set(ctx.S, Number(r.startRegionId));
		if (ctx.D !== null && r.endRegionId) region.set(ctx.D, Number(r.endRegionId));
		if (ctx.S !== null && r.startSystemId) system.set(ctx.S, Number(r.startSystemId));
		if (ctx.D !== null && r.endSystemId) system.set(ctx.D, Number(r.endSystemId));
		ctx.regionOf = (loc) => (region.has(loc) ? region.get(loc) : null);
		ctx.systemOf = (loc) => (system.has(loc) ? system.get(loc) : null);
		// S or D, or a location in the same solar system (rule 6).
		const near = (station) => (loc) => {
			if (station === null || loc === null || loc === undefined) return false;
			if (loc === station) return true;
			const sys = ctx.systemOf(station);
			return sys !== null && ctx.systemOf(loc) === sys;
		};
		ctx.nearS = near(ctx.S);
		ctx.nearD = near(ctx.D);
		// Rule 1: the informational "elsewhere" tag of a lot.
		ctx.whereOf = (loc) => {
			if (ctx.S !== null && loc === ctx.S) return 'source';
			const rs = ctx.S === null ? null : ctx.regionOf(ctx.S);
			const rl = ctx.regionOf(loc);
			return rs !== null && rl !== null && rs === rl ? 'region' : 'other';
		};
	};

	// Journal rows of each contract id (contract_* ref_types only), and the market_transaction /
	// market_escrow row of each transaction (context_id is the transaction_id; journal_ref_id is
	// not used: it is wrong for most sells).
	const indexJournal = (ctx) => {
		ctx.rowsByContract = new Map();
		ctx.marketRowByTx = new Map();
		for (const j of ctx.journal) {
			if (typeof j.ref_type === 'string' && j.ref_type.startsWith('contract_') && j.context_id !== undefined && j.context_id !== null
				&& (j.context_id_type === undefined || j.context_id_type === 'contract_id')) {
				if (!ctx.rowsByContract.has(j.context_id)) ctx.rowsByContract.set(j.context_id, []);
				ctx.rowsByContract.get(j.context_id).push(j);
			}
			if ((j.ref_type === 'market_transaction' || j.ref_type === 'market_escrow') && j.context_id !== undefined && j.context_id !== null) {
				ctx.marketRowByTx.set(`${j.characterId}:${j.context_id}`, j);
			}
		}
		ctx.feeInfo = new Map(); // rowKey -> attribution, for the fees fact table and the cross-check
	};

	// gm_cash_transfer never counts as profit. But when a GM refunds a broker fee (the live sample:
	// a mistyped price charged a 999 804 720 ISK fee, refunded to the ISK by ticket a day later), the
	// fee did not really happen: a GM transfer equal to the cent to an earlier brokers_fee row of the
	// same character, within gmRefundDays, voids the latest such row. Both rows leave the accounting.
	const matchGmRefunds = (ctx) => {
		ctx.refundedFees = new Set();
		if (!ctx.opt.netGmRefunds) return;
		for (const gm of ctx.journal) {
			if (gm.ref_type !== 'gm_cash_transfer' || !(gm.amount > 0)) continue;
			let pick = null;
			for (const j of ctx.journal) {
				if (j.ref_type !== 'brokers_fee' || j.characterId !== gm.characterId || ctx.refundedFees.has(rowKey(j))) continue;
				if (j.ms > gm.ms || gm.ms - j.ms > ctx.opt.gmRefundDays * DAY_MS || Math.abs(j.amount + gm.amount) >= 0.005) continue;
				pick = j; // the journal is in date order: the latest matching fee wins
			}
			if (!pick) continue;
			ctx.refundedFees.add(rowKey(pick));
			ctx.feeInfo.set(rowKey(pick), { kind: 'refundedFee', refundId: gm.id });
			ctx.feeInfo.set(rowKey(gm), { kind: 'gmRefund', refundsId: pick.id });
		}
	};

	//--- stage 2: sales tax (rule 4)

	// transaction_tax rows carry no context_id. Pass 1: same character and the same second as a sell;
	// when a second holds several sells, the tax row's id is its market_transaction row's id + 1
	// (sometimes + 2). Pass 2 (an unmatched tax row): the unmatched sells of the character within
	// 2 s; a lone one is taken if its implied rate is plausible, several are told apart by an implied
	// rate within 1 % of the expected one (the nearest matched rate). The expected rate alone cannot
	// gate a lone candidate: the rate moved 7.5 % -> 3.75 % -> 2.1 % inside two weeks, so the first
	// sale after a change would never match. Sells still unmatched take the nearest matched rate in
	// time (same character first), else SALES_TAX, flagged est. Tax always comes from the row.
	const matchTax = (ctx) => {
		const { opt } = ctx;
		ctx.taxBySell = new Map();
		const rates = [];
		const perCharacter = [];
		for (const id of ctx.ids) {
			const sells = ctx.txs.filter(t => t.characterId === id && t.is_buy !== true && t.is_personal === true);
			const taxRows = ctx.journal.filter(j => j.characterId === id && j.ref_type === 'transaction_tax');
			const matchedSell = new Set();
			const usedTax = new Set();
			const link = (tax, sell, how) => {
				usedTax.add(tax.id);
				matchedSell.add(sell.transaction_id);
				const gross = sell.unit_price * sell.quantity;
				ctx.taxBySell.set(sellKey(sell), { row: tax, amount: -tax.amount, est: false, how });
				ctx.feeInfo.set(rowKey(tax), { kind: 'salesTax', sellTxId: sell.transaction_id, typeId: sell.type_id, how });
				if (gross > 0) rates.push({ ms: sell.ms, rate: -tax.amount / gross, characterId: id });
			};
			const sellsBySecond = groupBy(sells, t => t.ms);
			for (const [second, taxes] of groupBy(taxRows, j => j.ms)) {
				const candidates = sellsBySecond.get(second) || [];
				if (taxes.length === 1 && candidates.length === 1) {
					link(taxes[0], candidates[0], 'second');
					continue;
				}
				const gapOf = (tax, sell) => {
					const mt = ctx.marketRowByTx.get(sellKey(sell));
					const gap = mt ? tax.id - mt.id : null;
					return gap !== null && gap >= 1 && gap <= 2 ? gap : null;
				};
				for (const [ti, si] of assignByGap(taxes, candidates, gapOf)) link(taxes[ti], candidates[si], 'idGap');
				const leftTax = taxes.filter(t => !usedTax.has(t.id));
				const leftSell = candidates.filter(s => !matchedSell.has(s.transaction_id));
				if (leftTax.length === 1 && leftSell.length === 1) link(leftTax[0], leftSell[0], 'second');
			}
			perCharacter.push({ id, sells, taxRows, matchedSell, usedTax, link });
		}
		const rateNear = (ms, characterId) => {
			let best = null;
			for (const r of rates) {
				const d = Math.abs(r.ms - ms) + (r.characterId === characterId ? 0 : 1e15);
				if (best === null || d < best.d) best = { d, rate: r.rate };
			}
			return best === null ? opt.SALES_TAX : best.rate;
		};
		for (const p of perCharacter) {
			for (const tax of p.taxRows) {
				if (p.usedTax.has(tax.id)) continue;
				const expected = rateNear(tax.ms, p.id);
				const near = p.sells.filter(sell => !p.matchedSell.has(sell.transaction_id)
					&& Math.abs(sell.ms - tax.ms) <= opt.taxNearSeconds * 1000 && sell.unit_price * sell.quantity > 0);
				const implied = (sell) => -tax.amount / (sell.unit_price * sell.quantity);
				let best = null;
				if (near.length === 1) {
					if (implied(near[0]) > 0 && implied(near[0]) <= opt.taxRateMax) best = { sell: near[0] };
				} else if (expected > 0) {
					for (const sell of near) {
						const dev = Math.abs(implied(sell) - expected) / expected;
						if (dev <= opt.taxRateTolerance && (best === null || dev < best.dev)) best = { sell, dev };
					}
				}
				if (best) p.link(tax, best.sell, 'near');
				else ctx.feeInfo.set(rowKey(tax), { kind: 'salesTax', sellTxId: null, typeId: null, how: null, unmatched: true });
			}
		}
		rates.sort((a, b) => a.ms - b.ms);
		ctx.observedTaxRate = rates.length > 0 ? rates[rates.length - 1].rate : opt.SALES_TAX;
		ctx.taxOf = (sell) => {
			const hit = ctx.taxBySell.get(sellKey(sell));
			if (hit) return hit;
			const rate = rateNear(sell.ms, sell.characterId);
			return { row: null, amount: sell.unit_price * sell.quantity * rate, est: true, how: 'rate', rate };
		};
	};

	//--- stage 3: broker fees (rule 5, decision 2)

	// brokers_fee rows carry no context_id. Each is time-matched to an order of the same character
	// whose `issued` (any value seen in history, open orders or a snapshot) is within 2 seconds: the
	// fee row carries the timestamp of the order action that charged it, and `issued` is that same
	// timestamp for the latest action, so a wider window only mis-attributes fees in a relist burst.
	// Closest pairs first, one fee per (order, issued) event. Immediate orders (duration 0) paid no
	// fee and are skipped. The rest is the pro-rata remainder, flagged est. No broker rate is ever
	// derived from the fees.
	const matchBrokerFees = (ctx) => {
		const windowMs = ctx.opt.brokerMatchSeconds * 1000;
		const events = new Map();
		for (const rec of ctx.orders.values()) {
			if (!(rec.duration > 0)) continue;
			if (!events.has(rec.characterId)) events.set(rec.characterId, []);
			for (const issuedMs of rec.issuedSet) events.get(rec.characterId).push({ rec, issuedMs });
		}
		const feeRows = ctx.journal.filter(j => j.ref_type === 'brokers_fee' && !ctx.refundedFees.has(rowKey(j)));
		const pairs = [];
		for (const fee of feeRows) {
			for (const ev of events.get(fee.characterId) || []) {
				const d = Math.abs(fee.ms - ev.issuedMs);
				if (d <= windowMs) pairs.push({ fee, ev, d });
			}
		}
		pairs.sort((a, b) => a.d - b.d || a.fee.id - b.fee.id || a.ev.rec.orderId - b.ev.rec.orderId || a.ev.issuedMs - b.ev.issuedMs);
		const feeTaken = new Set();
		const eventTaken = new Set();
		for (const p of pairs) {
			const fk = rowKey(p.fee);
			const ek = `${p.ev.rec.orderId}@${p.ev.issuedMs}`;
			if (feeTaken.has(fk) || eventTaken.has(ek)) continue;
			feeTaken.add(fk);
			eventTaken.add(ek);
			p.ev.rec.fees.push(p.fee);
		}
		ctx.brokerRemainder = feeRows.filter(f => !feeTaken.has(rowKey(f)));
		for (const f of ctx.brokerRemainder) ctx.feeInfo.set(rowKey(f), { kind: 'brokerRemainder', est: true });
		// Sell orders at D: the first matched fee is the listing, later ones are relists.
		ctx.typeFeeEvents = [];
		for (const rec of ctx.orders.values()) {
			rec.fees.sort((a, b) => a.ms - b.ms || a.id - b.id);
			if (rec.isBuy) continue; // decided with the lots (assignBuyOrderFees)
			const atD = ctx.D !== null && rec.locationId === ctx.D;
			rec.fees.forEach((fee, i) => {
				const kind = atD ? (i === 0 ? 'listing' : 'relist') : 'otherOrder';
				ctx.feeInfo.set(rowKey(fee), { kind, orderId: rec.orderId, typeId: rec.typeId });
				if (atD) ctx.typeFeeEvents.push({ typeId: rec.typeId, ms: fee.ms, cost: -fee.amount, kind, key: rowKey(fee) });
			});
		}
	};

	//--- stage 4: lots (rule 2)

	const buildLots = (ctx) => {
		ctx.lots = [];
		ctx.splitCount = new Map();
		for (const t of ctx.txs) {
			if (t.is_buy !== true || !inScope(ctx, t)) continue;
			const escrow = ctx.marketRowByTx.get(sellKey(t));
			ctx.lots.push({
				lotId: String(t.transaction_id), transactionId: t.transaction_id, seq: 0,
				typeId: t.type_id, qty: t.quantity, unitPrice: t.unit_price, ms: t.ms,
				characterId: t.characterId, locationId: t.location_id, where: ctx.whereOf(t.location_id),
				journalId: escrow ? escrow.id : null,
				batchId: null, runId: null, courierId: null, buyOrderId: null,
				haulPerUnit: 0, buyFeePerUnit: 0, haulParts: [], est: false,
				arrivedMs: null, remaining: 0, soldQty: 0, lastSoldMs: null, firstListedMs: null
			});
		}
		ctx.lots.sort(cmpLot);
	};

	// The lot keeps `keepQty` units; the rest becomes a new lot placed right after it, carrying the
	// same per-unit costs.
	const splitLot = (ctx, lot, keepQty) => {
		const k = (ctx.splitCount.get(lot.transactionId) || 1) + 1;
		ctx.splitCount.set(lot.transactionId, k);
		const rest = { ...lot, lotId: `${lot.transactionId}.${k}`, seq: k, qty: lot.qty - keepQty, haulParts: lot.haulParts.map(p => ({ ...p })) };
		lot.qty = keepQty;
		ctx.lots.splice(ctx.lots.indexOf(lot) + 1, 0, rest);
		return rest;
	};

	// Fills of the user's own buy orders take the order's matched fees as buyFeePerUnit. Wallet
	// transactions carry no order id, so a fill is a lot of the same character and type, at the
	// order's station (range 'station'), bought at one of the order's known prices on or after its
	// earliest known placement, oldest first until the filled volume is covered. A buy order with
	// matched fees and no fill found is 'buyOrderUnfilled': its fee lands on the type's broker cost.
	const assignBuyOrderFees = (ctx) => {
		const recs = [...ctx.orders.values()].filter(r => r.isBuy && r.duration > 0 && r.fees.length > 0)
			.sort((a, b) => a.orderId - b.orderId);
		for (const rec of recs) {
			const cost = sum(rec.fees, f => -f.amount);
			const filled = num(rec.volumeTotal) - num(rec.volumeRemain);
			const prices = [rec.price, ...rec.path.map(p => p.price)].filter(p => typeof p === 'number');
			const startMs = Math.min(...rec.issuedSet, ...rec.fees.map(f => f.ms), rec.firstSeenMs === null ? Infinity : rec.firstSeenMs);
			const picked = [];
			let units = 0;
			if (filled > 0) {
				for (const lot of ctx.lots) {
					if (units >= filled) break;
					if (lot.characterId !== rec.characterId || lot.typeId !== rec.typeId || lot.buyOrderId !== null) continue;
					if (rec.range === 'station' && lot.locationId !== rec.locationId) continue;
					if (lot.ms < startMs) continue;
					if (!prices.some(p => Math.abs(p - lot.unitPrice) < 0.005)) continue;
					picked.push(lot);
					units += lot.qty;
				}
			}
			rec.feeKind = units > 0 ? 'buyOrder' : 'buyOrderUnfilled';
			rec.filledLotIds = picked.map(l => l.lotId);
			for (const lot of picked) {
				lot.buyFeePerUnit += cost / units;
				lot.buyOrderId = rec.orderId;
			}
			for (const fee of rec.fees) {
				ctx.feeInfo.set(rowKey(fee), { kind: rec.feeKind, orderId: rec.orderId, typeId: rec.typeId, lotIds: rec.filledLotIds });
				if (rec.feeKind === 'buyOrderUnfilled') ctx.typeFeeEvents.push({ typeId: rec.typeId, ms: fee.ms, cost: -fee.amount, kind: 'buyUnfilled', key: rowKey(fee) });
			}
		}
	};

	//--- stage 5: batches (rule 2) and runs (Comparison 2)

	const isHandoff = (ctx, c) => c.type === 'item_exchange' && ctx.L.has(c.issuer_id)
		&& (ctx.L.has(c.assignee_id) || ctx.L.has(c.acceptor_id));

	const includedQty = (items) => {
		const qty = new Map();
		for (const it of items || []) if (it.is_included === true) addTo(qty, it.type_id, num(it.quantity));
		return qty;
	};

	// Decision 21: a finished hand-off is a transfer when its issuer passes on units he himself
	// received through an earlier batch (a seller handing the last units of a batch to another
	// seller): every included type has a lot batched to an earlier finished hand-off whose receiver
	// is this issuer, and the issuer bought no not-yet-batched lot of any included type by its
	// date_issued (else he bought for this hand-off, and it is a batch). Per type, fromBatchIds are
	// those source batches, newest first. null when it is not a transfer.
	const transferOf = (ctx, c, issuedMs, qtyByType) => {
		if (qtyByType.size === 0 || issuedMs === null) return null;
		const issuer = c.issuer_id;
		if (ctx.lots.some(l => l.characterId === issuer && l.batchId === null && l.ms <= issuedMs && qtyByType.has(l.typeId))) return null;
		const items = [];
		for (const [typeId, qty] of qtyByType) {
			const ids = new Set(ctx.lots.filter(l => l.typeId === typeId && l.batchId !== null).map(l => l.batchId));
			const from = [...ids].map(id => ctx.batchById.get(id))
				.filter(b => b.receiverId === issuer && b.issuedMs < issuedMs)
				.sort((a, b) => b.issuedMs - a.issuedMs || b.batchId - a.batchId);
			if (from.length === 0) return null;
			items.push({ typeId, qty, fromBatchIds: from.map(b => b.batchId) });
		}
		return {
			contractId: c.contract_id, contract: c, issuerId: issuer,
			receiverId: ctx.L.has(c.assignee_id) ? c.assignee_id : c.acceptor_id,
			issuedMs, completedMs: toMs(c.date_completed), items, cost: 0
		};
	};

	// A batch is a finished hand-off: its included items, per type, consume the newest unbatched
	// lots bought by L before its date_issued (any location), splitting a lot if needed. A deleted
	// hand-off never happened. A transfer (transferOf) is not a batch: it consumes no lot (the lots
	// keep their batch, run, courier and haul, and FIFO is pooled anyway), so it goes to
	// ctx.transfers and never into ctx.batches, which runs, couriers and the insights read.
	const buildBatches = (ctx) => {
		ctx.handoffs = [...ctx.contracts.values()].filter(c => isHandoff(ctx, c)).sort(cmpIssued);
		ctx.batches = [];
		ctx.batchById = new Map();
		ctx.transfers = [];
		ctx.transferById = new Map();
		for (const c of ctx.handoffs) {
			if (!isFinished(c.status)) continue;
			const issuedMs = toMs(c.date_issued);
			const itemList = ctx.items.get(c.contract_id);
			const qtyByType = includedQty(itemList);
			const transfer = transferOf(ctx, c, issuedMs, qtyByType);
			if (transfer) {
				ctx.transfers.push(transfer);
				ctx.transferById.set(transfer.contractId, transfer);
				continue;
			}
			const batch = {
				batchId: c.contract_id, contract: c, issuedMs,
				completedMs: toMs(c.date_completed), issuerId: c.issuer_id,
				receiverId: ctx.L.has(c.assignee_id) ? c.assignee_id : c.acceptor_id,
				locationId: c.start_location_id !== undefined ? c.start_location_id : (c.end_location_id !== undefined ? c.end_location_id : null),
				volume: typeof c.volume === 'number' ? c.volume : null,
				items: [], unsourcedQty: 0, runId: null, courierId: null,
				handoffCost: 0, rolledIn: 0, est: false, noItems: itemList === undefined
			};
			for (const [typeId, qty] of qtyByType) {
				let need = qty;
				const candidates = ctx.lots.filter(l => l.typeId === typeId && l.batchId === null && l.ms <= issuedMs)
					.sort((a, b) => cmpLot(b, a));
				for (const lot of candidates) {
					if (need <= 0) break;
					if (lot.qty > need) splitLot(ctx, lot, need);
					lot.batchId = batch.batchId;
					need -= lot.qty;
				}
				batch.items.push({ typeId, qty, sourcedQty: qty - need, unsourcedQty: need, unplanned: false });
				batch.unsourcedQty += need;
			}
			ctx.batches.push(batch);
			ctx.batchById.set(batch.batchId, batch);
		}
	};

	// A batch belongs to the latest run on this route copied at or before its date_issued and at
	// most runMaxAgeDays before it; else runId null ("unplanned batch"). Batch types the run does
	// not list are unplanned.
	const mapBatchesToRuns = (ctx) => {
		const routeOk = (run) => {
			const r = run.route || {};
			if (ctx.S !== null && r.startStationId !== undefined && r.startStationId !== null && Number(r.startStationId) !== ctx.S) return false;
			if (ctx.D !== null && r.endStationId !== undefined && r.endStationId !== null && Number(r.endStationId) !== ctx.D) return false;
			return true;
		};
		ctx.runs = ctx.runsIn
			.filter(run => run && run.id !== undefined && run.id !== null && toMs(run.copiedAt) !== null && routeOk(run))
			.map(run => ({ id: run.id, run, copiedMs: toMs(run.copiedAt), batchIds: [], plannedTypes: new Set((run.rows || []).map(row => row.typeId)) }))
			.sort((a, b) => a.copiedMs - b.copiedMs || String(a.id).localeCompare(String(b.id)));
		ctx.runById = new Map(ctx.runs.map(r => [r.id, r]));
		const maxAge = ctx.opt.runMaxAgeDays * DAY_MS;
		for (const batch of ctx.batches) {
			let pick = null;
			for (const r of ctx.runs) if (r.copiedMs <= batch.issuedMs && batch.issuedMs - r.copiedMs <= maxAge) pick = r;
			batch.runId = pick ? pick.id : null;
			if (pick) pick.batchIds.push(batch.batchId);
			for (const item of batch.items) item.unplanned = pick === null || !pick.plannedTypes.has(item.typeId);
		}
		for (const lot of ctx.lots) if (lot.batchId !== null) lot.runId = ctx.batchById.get(lot.batchId).runId;
	};

	//--- stage 6: hauling (rules 6 and 7)

	// -sum of the issuer-side rows of a contract. While a contract is outstanding or in progress its
	// deposit is pending refund and not counted; on delivery deposit and refund net to zero; on
	// deletion the reward comes back and the deposit is lost.
	const contractCost = (ctx, c) => {
		const rows = (ctx.rowsByContract.get(c.contract_id) || []).filter(j => CONTRACT_COST_REFS.has(j.ref_type));
		const counted = rows.filter(j => !(DEPOSIT_REFS.has(j.ref_type) && isOpenContract(c.status)));
		return { cost: -sum(counted, j => j.amount), rows };
	};

	const addHaul = (lot, perUnit, source, contractId) => {
		if (!Number.isFinite(perUnit) || perUnit === 0) return;
		lot.haulPerUnit += perUnit;
		lot.haulParts.push({ source, contractId, perUnit });
	};

	// Rule 7: the hand-off's own fees (its broker fee) are haul cost on the batch's lots, split by
	// m3. Its contract_price is internal. A transfer's fees (decision 21) add to the hand-off cost of
	// the newest source batch among its types, so they reach the transferred units' lots the same
	// way. A dead hand-off's fees roll into the next finished hand-off of the same issuer (its
	// replacement); with none they stay unattributed.
	const attributeHandoffs = (ctx) => {
		for (const c of ctx.handoffs) {
			const { cost, rows } = contractCost(ctx, c);
			for (const j of ctx.rowsByContract.get(c.contract_id) || []) {
				if (j.ref_type === 'contract_price') ctx.feeInfo.set(rowKey(j), { kind: 'internal', contractId: c.contract_id });
			}
			const transfer = isFinished(c.status) ? ctx.transferById.get(c.contract_id) : undefined;
			if (transfer) {
				const sources = [...new Set(transfer.items.flatMap(it => it.fromBatchIds))].map(id => ctx.batchById.get(id))
					.sort((a, b) => b.issuedMs - a.issuedMs || b.batchId - a.batchId);
				const batch = sources[0];
				transfer.cost = cost;
				batch.handoffCost += cost;
				for (const j of rows) ctx.feeInfo.set(rowKey(j), { kind: 'transfer', contractId: c.contract_id, batchId: batch.batchId });
			} else if (isFinished(c.status)) {
				const batch = ctx.batchById.get(c.contract_id);
				batch.handoffCost += cost;
				for (const j of rows) ctx.feeInfo.set(rowKey(j), { kind: 'handoff', contractId: c.contract_id, batchId: batch.batchId });
			} else if (isDead(c.status)) {
				const issuedMs = toMs(c.date_issued);
				const next = ctx.batches.find(b => b.issuerId === c.issuer_id && b.issuedMs > issuedMs);
				if (next) next.rolledIn += cost;
				for (const j of rows) ctx.feeInfo.set(rowKey(j), { kind: 'deletedHandoff', contractId: c.contract_id, batchId: next ? next.batchId : null, unattributed: !next });
			} else {
				for (const j of rows) ctx.feeInfo.set(rowKey(j), { kind: 'pendingHandoff', contractId: c.contract_id, unattributed: true });
			}
		}
		for (const batch of ctx.batches) {
			const cost = batch.handoffCost + batch.rolledIn;
			if (cost === 0) continue;
			const qtyByType = new Map(batch.items.map(it => [it.typeId, it.qty]));
			const { perUnit, est } = perUnitByM3(ctx, cost, qtyByType);
			batch.est = batch.est || est;
			for (const lot of ctx.lots) {
				if (lot.batchId !== batch.batchId) continue;
				addHaul(lot, perUnit.get(lot.typeId) || 0, 'handoff', batch.batchId);
				if (est) lot.est = true;
			}
		}
	};

	// player_donation: payer first_party_id, receiver second_party_id; negative in the payer's
	// journal. Between two linked characters it is internal. To an outsider it is a hauler bonus
	// when the receiver is the acceptor of one of L's couriers and it is dated from that courier's
	// date_accepted to its date_completed + 48 h, open-ended while it has no date_completed (rule 7;
	// the most recently accepted courier wins); otherwise an "other donation", listed and never
	// counted. Donations received from outsiders are ignored.
	const matchDonations = (ctx) => {
		const couriers = [...ctx.contracts.values()].filter(c => c.type === 'courier' && ctx.L.has(c.issuer_id));
		const windowMs = ctx.opt.bonusWindowHours * HOUR_MS;
		ctx.bonuses = [];
		ctx.otherDonations = [];
		for (const d of ctx.journal) {
			if (d.ref_type !== 'player_donation') continue;
			const payer = d.first_party_id;
			const receiver = d.second_party_id;
			if (ctx.L.has(payer) && ctx.L.has(receiver)) {
				ctx.feeInfo.set(rowKey(d), { kind: 'internal' });
				continue;
			}
			if (!ctx.L.has(payer) || d.characterId !== payer) continue;
			let pick = null;
			for (const c of couriers) {
				if (c.acceptor_id !== receiver) continue;
				const accepted = toMs(c.date_accepted);
				const done = toMs(c.date_completed);
				if (accepted === null || d.ms < accepted || (done !== null && d.ms > done + windowMs)) continue;
				if (pick === null || accepted > pick.accepted || (accepted === pick.accepted && c.contract_id > pick.c.contract_id)) pick = { c, accepted };
			}
			if (pick) {
				const bonus = { row: d, courierId: pick.c.contract_id, amount: -d.amount };
				ctx.bonuses.push(bonus);
				ctx.feeInfo.set(rowKey(d), { kind: 'haulerBonus', courierId: pick.c.contract_id, counted: ctx.opt.countHaulerBonuses });
			} else {
				ctx.otherDonations.push(d);
				ctx.feeInfo.set(rowKey(d), { kind: 'otherDonation', unattributed: true });
			}
		}
	};

	// Rule 6. Couriers issued by L from S (or its system) to D (or its system), in date_issued order.
	// A dead courier (deleted, cancelled, ...) carried nothing; its cost (broker fee and lost
	// deposit) rolls into the next live courier on the route. A live courier claims batches:
	// - with an item list, each unclaimed batch issued at or before it whose types overlap its items;
	// - with an empty item list (every courier in the 2026-11-19 sample came back empty), the
	//   unclaimed batches issued at or before it at its start location whose summed contract volume
	//   best fits its own volume.
	// Its cost (+ rolled-in, + bonuses when counted) is split per m3 over its items, else over its
	// batches' items. With no batch: the oldest unhauled lots of each item type bought before it, or,
	// with no item list either, the issuer's unhauled lots at S, per m3.
	const buildCouriers = (ctx) => {
		const { opt } = ctx;
		const list = [...ctx.contracts.values()]
			.filter(c => c.type === 'courier' && ctx.L.has(c.issuer_id) && ctx.nearS(c.start_location_id) && ctx.nearD(c.end_location_id))
			.sort(cmpIssued);
		const bonusBy = groupBy(ctx.bonuses, b => b.courierId);
		ctx.couriers = list.map(c => {
			const { cost, rows } = contractCost(ctx, c);
			const bonuses = bonusBy.get(c.contract_id) || [];
			return {
				courierId: c.contract_id, contract: c, status: c.status, issuedMs: toMs(c.date_issued),
				acceptedMs: toMs(c.date_accepted), completedMs: toMs(c.date_completed),
				volume: typeof c.volume === 'number' ? c.volume : null,
				contractCost: cost, rows, bonus: sum(bonuses, b => b.amount), bonusRows: bonuses.map(b => b.row),
				rolledIn: 0, rolledFrom: [], rolledInto: null, totalCost: 0,
				batchIds: [], itemSource: 'none', carriedQty: new Map(), unattributed: false, est: false
			};
		});
		ctx.courierById = new Map(ctx.couriers.map(k => [k.courierId, k]));
		for (const k of ctx.couriers) {
			if (!isDead(k.status)) continue;
			const next = ctx.couriers.find(x => !isDead(x.status) && x.issuedMs > k.issuedMs);
			if (next) {
				next.rolledIn += k.contractCost;
				next.rolledFrom.push(k.courierId);
				k.rolledInto = next.courierId;
			}
			for (const j of k.rows) ctx.feeInfo.set(rowKey(j), { kind: 'deletedCourier', contractId: k.courierId, courierId: next ? next.courierId : null, unattributed: !next });
		}
		const claimed = new Set();
		for (const k of ctx.couriers) {
			if (isDead(k.status)) continue;
			const c = k.contract;
			k.totalCost = k.contractCost + k.rolledIn + (opt.countHaulerBonuses ? k.bonus : 0);
			const items = (ctx.items.get(k.courierId) || []).filter(i => i.is_included === true);
			const itemQty = includedQty(items);
			const unclaimed = ctx.batches.filter(b => !claimed.has(b.batchId) && b.issuedMs <= k.issuedMs);
			let batches;
			if (items.length > 0) {
				batches = unclaimed.filter(b => b.items.some(it => itemQty.has(it.typeId)));
			} else {
				const atStart = unclaimed.filter(b => b.locationId === null || c.start_location_id === undefined || b.locationId === c.start_location_id)
					.sort((a, b) => b.issuedMs - a.issuedMs || b.batchId - a.batchId);
				const volumesKnown = k.volume !== null && atStart.every(b => b.volume !== null);
				batches = volumesKnown ? pickBatchesByVolume(atStart, k.volume, opt.courierVolumeTolerance) : atStart;
				batches.sort((a, b) => a.issuedMs - b.issuedMs || a.batchId - b.batchId);
			}
			const arrive = (lot) => {
				lot.courierId = k.courierId;
				if (isFinished(k.status)) lot.arrivedMs = k.completedMs !== null ? k.completedMs : k.issuedMs;
			};
			let carried = [];
			let perUnit = new Map();
			if (batches.length > 0) {
				for (const b of batches) {
					claimed.add(b.batchId);
					b.courierId = k.courierId;
					k.batchIds.push(b.batchId);
				}
				const batchQty = new Map();
				for (const b of batches) for (const it of b.items) addTo(batchQty, it.typeId, it.qty);
				k.itemSource = items.length > 0 ? 'items' : 'batches';
				k.carriedQty = items.length > 0 ? itemQty : batchQty;
				({ perUnit, est: k.est } = perUnitByM3(ctx, k.totalCost, k.carriedQty));
				const ids = new Set(k.batchIds);
				carried = ctx.lots.filter(l => ids.has(l.batchId));
			} else if (items.length > 0) {
				k.itemSource = 'items';
				k.carriedQty = itemQty;
				for (const [typeId, qty] of itemQty) {
					let need = qty;
					const candidates = ctx.lots.filter(l => l.typeId === typeId && l.courierId === null && l.ms <= k.issuedMs);
					for (const lot of candidates) {
						if (need <= 0) break;
						if (lot.qty > need) splitLot(ctx, lot, need);
						lot.courierId = k.courierId; // claimed now so the next type's loop cannot reuse it
						carried.push(lot);
						need -= lot.qty;
					}
				}
				({ perUnit, est: k.est } = perUnitByM3(ctx, k.totalCost, k.carriedQty));
			} else {
				carried = ctx.lots.filter(l => l.courierId === null && l.characterId === c.issuer_id && ctx.nearS(l.locationId) && l.ms <= k.issuedMs);
				k.itemSource = carried.length > 0 ? 'lots' : 'none';
				const lotQty = new Map();
				for (const lot of carried) addTo(lotQty, lot.typeId, lot.qty);
				k.carriedQty = lotQty;
				({ perUnit, est: k.est } = perUnitByM3(ctx, k.totalCost, lotQty));
			}
			for (const lot of carried) {
				arrive(lot);
				addHaul(lot, perUnit.get(lot.typeId) || 0, 'courier', k.courierId);
				if (k.est) lot.est = true;
			}
			k.unattributed = carried.length === 0;
			for (const j of k.rows) ctx.feeInfo.set(rowKey(j), { kind: 'courier', contractId: k.courierId, courierId: k.courierId, unattributed: k.unattributed });
			for (const row of k.bonusRows) ctx.feeInfo.get(rowKey(row)).unattributed = k.unattributed;
			if (k.status === 'failed') ctx.warnings.push({ kind: 'failedCourier', courierId: k.courierId });
		}
		// A bonus whose courier is off the route or dead reaches no lot.
		for (const b of ctx.bonuses) {
			const k = ctx.courierById.get(b.courierId);
			if (!k || isDead(k.status)) ctx.feeInfo.get(rowKey(b.row)).unattributed = true;
		}
	};

	//--- stage 7: FIFO (rule 3)

	// Per type, pooled across L, lots in (date, transaction_id) order. A sell at D takes the oldest
	// units of lots that had arrived (finished courier) by the sell's time, then any lot bought by
	// then, flagged unarrived. Units with no lot left are uncovered.
	const runFifo = (ctx) => {
		ctx.dSells = ctx.txs.filter(t => t.is_buy !== true && inScope(ctx, t) && ctx.D !== null && t.location_id === ctx.D);
		ctx.otherSells = ctx.txs.filter(t => t.is_buy !== true && inScope(ctx, t) && !(ctx.D !== null && t.location_id === ctx.D));
		ctx.lots.sort(cmpLot);
		for (const lot of ctx.lots) {
			lot.remaining = lot.qty;
			lot.soldQty = 0;
		}
		const byType = groupBy(ctx.lots, l => l.typeId);
		ctx.allocations = [];
		ctx.uncovered = [];
		for (const sell of ctx.dSells) {
			let need = sell.quantity;
			const lots = byType.get(sell.type_id) || [];
			for (const arrivedPass of [true, false]) {
				for (const lot of lots) {
					if (need <= 0) break;
					if (lot.remaining <= 0 || lot.ms > sell.ms) continue;
					const arrived = lot.arrivedMs !== null && lot.arrivedMs <= sell.ms;
					if (arrived !== arrivedPass) continue;
					const qty = Math.min(need, lot.remaining);
					lot.remaining -= qty;
					lot.soldQty += qty;
					lot.lastSoldMs = sell.ms;
					need -= qty;
					ctx.allocations.push({ sell, lot, qty, unarrived: !arrived });
				}
			}
			if (need > 0) ctx.uncovered.push({ sell, qty: need });
		}
	};

	// lots.firstListedAt: the first snapshot that saw a sell order at D for the lot's type, among
	// orders first seen at or after the lot arrived (else, for a sold unarrived lot, its buy time).
	const setFirstListed = (ctx) => {
		const sellOrders = groupBy([...ctx.orders.values()].filter(r => !r.isBuy && r.duration > 0 && ctx.D !== null && r.locationId === ctx.D && r.firstSeenMs !== null), r => r.typeId);
		for (const lot of ctx.lots) {
			const base = lot.arrivedMs !== null ? lot.arrivedMs : (lot.soldQty > 0 ? lot.ms : null);
			if (base === null) continue;
			for (const rec of sellOrders.get(lot.typeId) || []) {
				if (rec.firstSeenMs >= base && (lot.firstListedMs === null || rec.firstSeenMs < lot.firstListedMs)) lot.firstListedMs = rec.firstSeenMs;
			}
		}
	};

	//--- stage 8: the window, per-type rows, totals and the fact table (rules 8-12)

	const inPlay = (lot) => lot.batchId !== null || lot.courierId !== null;

	const resolveWindow = (ctx) => {
		const w = ctx.windowIn;
		if (w.runId !== undefined && w.runId !== null) {
			const run = ctx.runById.get(w.runId) || null;
			return { mode: 'run', runId: w.runId, run, start: run ? run.copiedMs : ctx.now, end: ctx.now };
		}
		const since = toMs(w.since);
		const until = toMs(w.until);
		return { mode: 'since', runId: null, run: null, start: since === null ? -Infinity : since, end: until === null ? ctx.now : until };
	};

	// Physical view from each character's latest snapshot (rule 9): assets at S and at D (containers
	// resolved through item_id), open sell orders at D, and what live couriers carry.
	const physicalView = (ctx) => {
		const out = new Map();
		const row = (typeId) => {
			if (!out.has(typeId)) out.set(typeId, { atSource: 0, inTransit: 0, atDest: 0, listed: 0 });
			return out.get(typeId);
		};
		let known = false;
		for (const id of ctx.ids) {
			const snaps = ctx.snapshots.get(id) || [];
			const last = snaps[snaps.length - 1];
			if (!last) continue;
			known = true;
			const assets = last.assets || [];
			const byItem = new Map(assets.map(a => [a.item_id, a]));
			for (const a of assets) {
				let loc = a.location_id;
				let type = a.location_type;
				for (let guard = 0; type === 'item' && byItem.has(loc) && guard < 20; guard++) {
					const parent = byItem.get(loc);
					loc = parent.location_id;
					type = parent.location_type;
				}
				if (ctx.S !== null && loc === ctx.S) row(a.type_id).atSource += num(a.quantity);
				else if (ctx.D !== null && loc === ctx.D) row(a.type_id).atDest += num(a.quantity);
			}
		}
		for (const { o } of ctx.openOrders) {
			if (o.is_buy_order === true || ctx.D === null || o.location_id !== ctx.D) continue;
			row(o.type_id).listed += num(o.volume_remain);
		}
		for (const k of ctx.couriers) {
			if (!isOpenContract(k.status)) continue;
			for (const [typeId, qty] of k.carriedQty) row(typeId).inTransit += qty;
		}
		return { known, byType: out };
	};

	const summarize = (ctx) => {
		const { opt } = ctx;
		const win = resolveWindow(ctx);
		const inWin = (ms) => ms !== null && ms >= win.start && ms <= win.end;
		const inSpanAny = (ms) => Number.isFinite(ms) && ms >= win.start && ms <= win.end;
		const isRun = win.mode === 'run';
		const runId = win.runId;

		// --- selection
		const allocations = isRun ? ctx.allocations.filter(a => a.lot.runId === runId) : ctx.allocations.filter(a => inWin(a.sell.ms));
		const uncovered = isRun ? [] : ctx.uncovered.filter(u => inWin(u.sell.ms));
		const boughtLots = isRun ? ctx.lots.filter(l => l.runId === runId) : ctx.lots.filter(l => inPlay(l) && inWin(l.ms));
		const holdLots = isRun ? boughtLots : ctx.lots.filter(inPlay);
		const batches = isRun ? ctx.batches.filter(b => b.runId === runId) : ctx.batches.filter(b => inWin(b.issuedMs));
		const runCourierIds = new Set(batches.map(b => b.courierId).filter(id => id !== null));
		// Transfers (decision 21), dated by completion, else issue; a run's are those that moved
		// units of its batches.
		const runBatchIds = new Set(batches.map(b => b.batchId));
		const transfers = isRun
			? ctx.transfers.filter(t => t.items.some(it => it.fromBatchIds.some(id => runBatchIds.has(id))))
			: ctx.transfers.filter(t => inWin(t.completedMs !== null ? t.completedMs : t.issuedMs));

		// --- broker fees per type: matched sell-order fees, unfilled buy-order fees, and the
		// pro-rata remainder spread by gross sell value at D over the window's span.
		const spanStart = win.start;
		const spanEnd = win.end;
		const spanGross = new Map();
		for (const s of ctx.dSells) if (s.ms >= spanStart && s.ms <= spanEnd) addTo(spanGross, s.type_id, s.unit_price * s.quantity);
		const spanGrossTotal = sum([...spanGross.values()], v => v);
		const remainderRows = ctx.brokerRemainder.filter(f => f.ms >= spanStart && f.ms <= spanEnd);
		const remainderSplit = new Map(); // rowKey -> [{typeId, amount}]
		for (const f of remainderRows) {
			if (!(spanGrossTotal > 0)) continue;
			const split = [...spanGross].sort((a, b) => a[0] - b[0]).map(([typeId, g]) => ({ typeId, amount: -f.amount * g / spanGrossTotal }));
			remainderSplit.set(rowKey(f), split);
		}

		const allocByType = groupBy(allocations, a => a.lot.typeId);
		const typeIds = new Set();
		for (const a of allocations) typeIds.add(a.lot.typeId);
		for (const u of uncovered) typeIds.add(u.sell.type_id);
		for (const l of boughtLots) typeIds.add(l.typeId);
		for (const b of batches) for (const it of b.items) typeIds.add(it.typeId);
		if (isRun) {
			if (win.run) for (const t of win.run.plannedTypes) typeIds.add(t);
		} else {
			for (const l of holdLots) if (l.remaining > 0) typeIds.add(l.typeId);
			for (const ev of ctx.typeFeeEvents) if (inWin(ev.ms)) typeIds.add(ev.typeId);
		}

		// Run mode (Comparison 3): a type's fees from copiedAt to the run's sell-out of it (or now),
		// times the run's share of that type's units on the market in that span: units sold in the
		// span plus units held at its end, the run's lots against every exported lot.
		const runShare = new Map();
		const runEnd = new Map();
		if (isRun) {
			const allocsOfLot = groupBy(ctx.allocations, a => a.lot);
			const heldAt = (lots, endMs) => sum(lots.filter(l => l.ms <= endMs), l => l.qty
				- sum((allocsOfLot.get(l) || []).filter(a => a.sell.ms <= endMs), a => a.qty));
			for (const typeId of typeIds) {
				const own = allocByType.get(typeId) || [];
				const ownLots = holdLots.filter(l => l.typeId === typeId);
				const soldOut = own.length > 0 && sum(ownLots, l => l.remaining) === 0;
				const end = soldOut ? Math.max(...own.map(a => a.sell.ms)) : ctx.now;
				const inSpan = (ms) => ms >= win.start && ms <= end;
				const ownUnits = sum(own.filter(a => inSpan(a.sell.ms)), a => a.qty) + heldAt(ownLots, end);
				const allUnits = sum(ctx.allocations.filter(a => a.lot.typeId === typeId && inSpan(a.sell.ms)), a => a.qty)
					+ sum(ctx.uncovered.filter(u => u.sell.type_id === typeId && inSpan(u.sell.ms)), u => u.qty)
					+ heldAt(ctx.lots.filter(l => inPlay(l) && l.typeId === typeId), end);
				runShare.set(typeId, allUnits > 0 ? ownUnits / allUnits : 0);
				runEnd.set(typeId, end);
			}
		}
		const typeFeeWindow = (typeId, ms) => (isRun ? ms >= win.start && ms <= runEnd.get(typeId) : inWin(ms));
		const shareOf = (typeId) => (isRun ? runShare.get(typeId) || 0 : 1);
		const brokerFor = (typeId) => {
			const out = { listing: 0, relist: 0, est: 0, buyUnfilled: 0 };
			for (const ev of ctx.typeFeeEvents) {
				if (ev.typeId !== typeId || !typeFeeWindow(typeId, ev.ms)) continue;
				if (isRun && ev.kind === 'buyUnfilled') continue;
				out[ev.kind] += ev.cost * shareOf(typeId);
			}
			for (const f of remainderRows) {
				if (!typeFeeWindow(typeId, f.ms)) continue;
				const part = (remainderSplit.get(rowKey(f)) || []).find(p => p.typeId === typeId);
				if (part) out.est += part.amount * shareOf(typeId);
			}
			return out;
		};

		// --- sells fact rows (rule 12) and the per-type realized figures (rule 8)
		const physical = physicalView(ctx);
		const sells = [];
		const types = [];
		const sortedTypeIds = [...typeIds].sort((a, b) => a - b);
		for (const typeId of sortedTypeIds) {
			const own = allocByType.get(typeId) || []; // FIFO order: by sale, then the lots each sale took
			const broker = brokerFor(typeId);
			const soldQty = sum(own, a => a.qty);
			const listingTotal = broker.listing + broker.buyUnfilled;
			const relistTotal = broker.relist + broker.est;
			const flags = new Set();
			const rows = own.map(a => {
				const s = a.sell;
				const lot = a.lot;
				const tax = ctx.taxOf(s);
				const gross = s.unit_price * a.qty;
				const taxShare = tax.amount * a.qty / s.quantity;
				const mt = ctx.marketRowByTx.get(sellKey(s));
				if (tax.est) flags.add('est');
				if (a.unarrived) flags.add('unarrived');
				if (lot.est) flags.add('est');
				const row = {
					date: iso(s.ms), eveHour: new Date(s.ms).getUTCHours(), weekday: new Date(s.ms).getUTCDay(),
					typeId, characterId: s.characterId, sellTxId: s.transaction_id, journalId: mt ? mt.id : null,
					qty: a.qty, unitPrice: s.unit_price, gross,
					tax: taxShare, taxEst: tax.est,
					brokerShare: soldQty > 0 ? listingTotal * a.qty / soldQty : 0,
					relistShare: soldQty > 0 ? relistTotal * a.qty / soldQty : 0,
					haulShare: lot.haulPerUnit * a.qty,
					buyFeeShare: lot.buyFeePerUnit * a.qty,
					buyCost: lot.unitPrice * a.qty,
					lotId: lot.lotId, batchId: lot.batchId, runId: lot.runId, courierId: lot.courierId,
					unarrived: a.unarrived,
					daysSinceListed: lot.firstListedMs !== null && lot.firstListedMs <= s.ms ? days(s.ms - lot.firstListedMs) : null,
					daysSinceArrived: lot.arrivedMs !== null && lot.arrivedMs <= s.ms ? days(s.ms - lot.arrivedMs) : null
				};
				row.profit = row.gross - row.tax - row.brokerShare - row.relistShare - row.haulShare - row.buyFeeShare - row.buyCost;
				return row;
			});
			sells.push(...rows);

			const gross = sum(rows, r => r.gross);
			const tax = sum(rows, r => r.tax);
			const haul = sum(rows, r => r.haulShare);
			const buyFee = sum(rows, r => r.buyFeeShare);
			const buyCost = sum(rows, r => r.buyCost);
			const cogs = buyCost + haul + buyFee;
			const brokerTotal = broker.listing + broker.relist + broker.est + broker.buyUnfilled;
			if (broker.est > 0) flags.add('est');
			const realizedProfit = gross - tax - brokerTotal - cogs;

			const unc = uncovered.filter(u => u.sell.type_id === typeId);
			const uncoveredQty = sum(unc, u => u.qty);
			const uncoveredGross = sum(unc, u => u.sell.unit_price * u.qty);
			if (uncoveredQty > 0) flags.add('uncovered');

			const bought = boughtLots.filter(l => l.typeId === typeId);
			const boughtQty = sum(bought, l => l.qty);
			const boughtCost = sum(bought, l => l.unitPrice * l.qty);
			const landedCost = sum(bought, l => (l.unitPrice + l.haulPerUnit + l.buyFeePerUnit) * l.qty);

			// Remaining, accounting view.
			const held = holdLots.filter(l => l.typeId === typeId && l.remaining > 0);
			const remainingQty = sum(held, l => l.remaining);
			const atCost = sum(held, l => (l.unitPrice + l.haulPerUnit + l.buyFeePerUnit) * l.remaining);
			const best = marketOf(ctx, typeId);
			const marketNetPerUnit = best === null ? null : (best - 0.01) * (1 - ctx.observedTaxRate - opt.BROKER_FEE);
			const atMarket = marketNetPerUnit === null ? null : marketNetPerUnit * remainingQty;
			const unbatched = ctx.lots.filter(l => l.typeId === typeId && !inPlay(l) && l.remaining > 0);
			const unbatchedQty = sum(unbatched, l => l.remaining);
			// Physical view and the mismatch flag (every lot's remainder against what is physically there).
			const phys = physical.byType.get(typeId) || { atSource: 0, inTransit: 0, atDest: 0, listed: 0 };
			const physicalTotal = phys.atSource + phys.inTransit + phys.atDest + phys.listed;
			const accountingTotal = sum(ctx.lots.filter(l => l.typeId === typeId), l => l.remaining);
			const mismatch = physical.known && physicalTotal !== accountingTotal;
			if (mismatch) flags.add('mismatch');

			// Pace (rule 10).
			const paceLots = new Set([...own.map(a => a.lot), ...held]);
			const arrivals = [...paceLots].map(l => l.arrivedMs).filter(ms => ms !== null);
			const firstSellMs = own.length > 0 ? own[0].sell.ms : null;
			const lastSellMs = own.length > 0 ? own[own.length - 1].sell.ms : null;
			const listedAtMs = arrivals.length > 0 ? Math.min(...arrivals) : firstSellMs;
			const soldOut = soldQty > 0 && remainingQty === 0;
			const endMs = soldOut ? lastSellMs : ctx.now;
			const daysOnMarket = listedAtMs === null ? null : Math.max(0, days(endMs - listedAtMs));
			const soldFraction = soldQty + remainingQty > 0 ? soldQty / (soldQty + remainingQty) : null;
			const projectedDaysToClear = daysOnMarket === null ? null
				: soldOut ? daysOnMarket : soldFraction > 0 ? daysOnMarket / soldFraction : null;

			for (const b of batches) {
				for (const it of b.items) {
					if (it.typeId !== typeId) continue;
					if (it.unsourcedQty > 0) flags.add('unsourced');
					if (it.unplanned) flags.add('unplanned');
				}
			}
			for (const l of bought) if (l.est) flags.add('est');

			const typeRow = {
				typeId,
				flags: [...flags].sort(),
				boughtQty, boughtCost, boughtAvg: boughtQty > 0 ? boughtCost / boughtQty : null,
				landedCostPerItem: boughtQty > 0 ? landedCost / boughtQty : null,
				soldQty, gross, avgSellPrice: soldQty > 0 ? gross / soldQty : null,
				tax, broker: brokerTotal,
				brokerListing: broker.listing, brokerRelist: broker.relist, brokerEst: broker.est, brokerBuyUnfilled: broker.buyUnfilled,
				haul, buyFee, buyCost, cogs, realizedProfit,
				marginPct: gross > 0 ? realizedProfit / gross : null,
				netPerItem: soldQty > 0 ? (gross - tax - brokerTotal) / soldQty : null,
				uncoveredQty, uncoveredGross,
				unarrivedQty: sum(own.filter(a => a.unarrived), a => a.qty),
				remaining: {
					qty: remainingQty, atCost, atMarket, marketNetPerUnit, unbatchedQty,
					physical: { ...phys, total: physicalTotal, known: physical.known },
					accountingTotal, mismatch
				},
				unrealizedAtCost: atCost, unrealizedAtMarket: atMarket,
				listedAt: iso(listedAtMs), lastSoldAt: iso(lastSellMs), soldOut,
				daysOnMarket, sellRate: daysOnMarket === null ? null : soldQty / Math.max(daysOnMarket, 1),
				soldFraction, projectedDaysToClear
			};
			if (isRun && win.run) typeRow.predicted = predictedFor(win.run, typeId, typeRow, batches);
			types.push(typeRow);
		}

		// --- fees fact table
		const sellTxIds = new Set(allocations.map(a => sellKey(a.sell)));
		const fees = [];
		for (const j of ctx.journal) {
			const info = ctx.feeInfo.get(rowKey(j));
			if (!info) continue;
			let include;
			let share = null;
			if (!isRun) include = inWin(j.ms);
			else if (info.kind === 'salesTax') {
				const key = info.sellTxId === null ? null : `${j.characterId}:${info.sellTxId}`;
				include = key !== null && sellTxIds.has(key);
				if (include) {
					const own = allocations.filter(a => sellKey(a.sell) === key);
					share = sum(own, a => a.qty) / own[0].sell.quantity;
				}
			} else if (info.kind === 'handoff' || info.kind === 'deletedHandoff' || info.kind === 'transfer') include = info.batchId !== null && runBatchIds.has(info.batchId);
			else if (info.kind === 'courier' || info.kind === 'deletedCourier' || info.kind === 'haulerBonus') include = info.courierId !== null && runCourierIds.has(info.courierId);
			else if (info.kind === 'listing' || info.kind === 'relist') {
				include = typeIds.has(info.typeId) && typeFeeWindow(info.typeId, j.ms);
				share = include ? shareOf(info.typeId) : null;
			} else if (info.kind === 'brokerRemainder') include = j.ms >= win.start && j.ms <= win.end;
			else include = false;
			if (!include) continue;
			const split = info.kind === 'brokerRemainder' ? remainderSplit.get(rowKey(j)) || [] : null;
			const out = {
				id: j.id, characterId: j.characterId, date: iso(j.ms), refType: j.ref_type, amount: j.amount,
				cost: -j.amount, kind: info.kind,
				orderId: info.orderId === undefined ? null : info.orderId,
				typeId: info.typeId === undefined ? null : info.typeId,
				sellTxId: info.sellTxId === undefined ? null : info.sellTxId,
				batchId: info.batchId === undefined ? null : info.batchId,
				courierId: info.courierId === undefined ? null : info.courierId,
				contractId: info.contractId === undefined ? null : info.contractId,
				est: info.est === true,
				match: info.kind === 'salesTax' ? info.how || null : null,
				counted: info.kind === 'haulerBonus' ? info.counted : !['internal', 'otherDonation', 'refundedFee', 'gmRefund'].includes(info.kind),
				attributed: isAttributed(ctx, j, info, split)
			};
			if (split) out.split = isRun ? split.filter(p => typeIds.has(p.typeId)).map(p => ({ typeId: p.typeId, amount: p.amount * shareOf(p.typeId) })) : split;
			if (share !== null) out.share = share;
			fees.push(out);
		}

		// --- totals (UI 4) and the journal cross-check (rule 11)
		const totals = {
			spent: sum(boughtLots, l => l.unitPrice * l.qty),
			buyFees: sum(boughtLots, l => l.buyFeePerUnit * l.qty),
			boughtQty: sum(boughtLots, l => l.qty),
			soldQty: sum(types, t => t.soldQty),
			gross: sum(types, t => t.gross),
			tax: sum(types, t => t.tax),
			broker: sum(types, t => t.broker),
			brokerEst: sum(types, t => t.brokerEst),
			haul: sum(types, t => t.haul),
			cogs: sum(types, t => t.cogs),
			realizedProfit: sum(types, t => t.realizedProfit),
			unrealizedAtCost: sum(types, t => t.unrealizedAtCost),
			unrealizedAtMarket: sum(types.filter(t => t.unrealizedAtMarket !== null), t => t.unrealizedAtMarket),
			unpricedTypes: types.filter(t => t.remaining.qty > 0 && t.unrealizedAtMarket === null).length,
			uncoveredQty: sum(types, t => t.uncoveredQty),
			uncoveredGross: sum(types, t => t.uncoveredGross),
			haulPaid: sum(fees.filter(f => ['courier', 'handoff', 'transfer', 'deletedCourier', 'deletedHandoff'].includes(f.kind) || (f.kind === 'haulerBonus' && f.counted)), f => f.cost * (f.share === undefined ? 1 : f.share)),
			unbatchedLots: isRun ? 0 : ctx.lots.filter(l => !inPlay(l) && inWin(l.ms)).length,
			unsourcedUnits: sum(batches, b => b.unsourcedQty),
			transfers: transfers.length,
			transferredUnits: sum(transfers, t => sum(t.items, it => it.qty)),
			otherSells: isRun ? 0 : ctx.otherSells.filter(s => inWin(s.ms)).length,
			otherDonations: isRun ? 0 : ctx.otherDonations.filter(d => inWin(d.ms)).length,
			otherDonationsAmount: isRun ? 0 : sum(ctx.otherDonations.filter(d => inWin(d.ms)), d => -d.amount),
			// Orders placed in the span: immediate orders (duration 0) are not placements.
			ordersPlaced: [...ctx.orders.values()].filter(r => r.duration > 0 && (isRun ? typeIds.has(r.typeId) : true)
				&& inSpanAny(Math.min(...r.issuedSet, r.firstSeenMs === null ? Infinity : r.firstSeenMs))).length
		};
		totals.roi = totals.cogs > 0 ? totals.realizedProfit / totals.cogs : null;
		if (isRun && win.run) totals.predictedProfit = predictedProfitOf(win.run.run);
		const crossCheck = crossCheckOf(ctx, (ms) => ms >= win.start && ms <= win.end);

		return {
			window: { mode: win.mode, runId, start: Number.isFinite(win.start) ? iso(win.start) : null, end: iso(win.end), missingRun: isRun && !win.run },
			types,
			totals,
			crossCheck,
			batches: ctx.batches.map(b => batchOut(b)),
			couriers: ctx.couriers.map(k => courierOut(k)),
			runs: ctx.runs.map(r => runOut(ctx, r)),
			otherDonations: ctx.otherDonations.map(d => ({ id: d.id, characterId: d.characterId, date: iso(d.ms), to: d.second_party_id, amount: -d.amount })),
			uncoveredSells: uncovered.map(u => ({ sellTxId: u.sell.transaction_id, characterId: u.sell.characterId, typeId: u.sell.type_id, date: iso(u.sell.ms), qty: u.qty, unitPrice: u.sell.unit_price })),
			warnings: [...ctx.warnings, ...unsourcedWarnings(ctx, batches)],
			observedTaxRate: ctx.observedTaxRate,
			facts: {
				sells,
				fees,
				lots: ctx.lots.map(l => lotOut(l)),
				transfers: ctx.transfers.map(t => transferOut(t)),
				relists: relistsOut(ctx)
			}
		};
	};

	// A journal row counts as attributed when the rules attached it to something on the route:
	// a sell at D, a type's broker cost, a batch or courier that reached lots, a counted bonus.
	const isAttributed = (ctx, j, info, split) => {
		if (info.unattributed) return false;
		switch (info.kind) {
			case 'salesTax': {
				if (info.sellTxId === null) return false;
				const s = ctx.dSells.find(t => t.characterId === j.characterId && t.transaction_id === info.sellTxId);
				return Boolean(s);
			}
			case 'listing': case 'relist': case 'buyOrder': case 'buyOrderUnfilled': return true;
			case 'brokerRemainder': return Boolean(split && split.length > 0);
			case 'handoff': case 'transfer': case 'deletedHandoff': case 'courier': case 'deletedCourier': return true;
			case 'haulerBonus': return info.counted === true;
			case 'refundedFee': case 'gmRefund': return true;
			default: return false;
		}
	};

	// Rule 11: the window's market + tax + broker + contract + donation journal flows against what
	// the rules attributed; the difference is "unattributed". Internal flows (contract_price and
	// donations between linked characters) are left out of both sides.
	const crossCheckOf = (ctx, inSpan) => {
		const categories = ['market', 'tax', 'broker', 'contract', 'donation'];
		const journal = Object.fromEntries(categories.map(c => [c, 0]));
		const attributed = Object.fromEntries(categories.map(c => [c, 0]));
		let internal = 0;
		const dSellKeys = new Set(ctx.dSells.map(sellKey));
		for (const j of ctx.journal) {
			if (!inSpan(j.ms)) continue;
			const info = ctx.feeInfo.get(rowKey(j));
			let cat = null;
			let isAttr = false;
			if (j.ref_type === 'market_transaction') {
				cat = 'market';
				isAttr = j.context_id !== undefined && dSellKeys.has(`${j.characterId}:${j.context_id}`);
			} else if (j.ref_type === 'transaction_tax') cat = 'tax';
			else if (j.ref_type === 'brokers_fee' || (info && info.kind === 'gmRefund')) cat = 'broker';
			else if (typeof j.ref_type === 'string' && j.ref_type.startsWith('contract_')) cat = 'contract';
			else if (j.ref_type === 'player_donation') cat = 'donation';
			if (cat === null) continue;
			if (info && info.kind === 'internal') {
				internal += j.amount;
				continue;
			}
			if (cat === 'donation' && !info) continue; // received from an outsider: not a cost
			if (cat !== 'market') {
				if (!info) isAttr = false;
				else if (info.kind === 'brokerRemainder') isAttr = ctx.dSells.some(s => inSpan(s.ms));
				else isAttr = isAttributed(ctx, j, info, null);
			}
			journal[cat] += j.amount;
			if (isAttr) attributed[cat] += j.amount;
		}
		const journalTotal = sum(categories, c => journal[c]);
		const attributedTotal = sum(categories, c => attributed[c]);
		return { journal, attributed, journalTotal, attributedTotal, unattributed: journalTotal - attributedTotal, internal };
	};

	const predictedProfitOf = (run) => {
		if (run.totals && typeof run.totals.profitMil === 'number') return run.totals.profitMil * MIL;
		return sum(run.rows || [], r => num(r.profitPerItemMil) * num(r.qty) * MIL);
	};

	// Comparison 3: the run's prediction for a type next to what happened. ISK, not millions.
	const predictedFor = (r, typeId, row, batches) => {
		const pr = (r.run.rows || []).find(x => x.typeId === typeId) || null;
		const batchedQty = sum(batches, b => sum(b.items.filter(it => it.typeId === typeId), it => it.qty));
		const mil = (v) => (typeof v === 'number' ? v * MIL : null);
		const actualProfit = row.unrealizedAtMarket === null ? null : row.realizedProfit + row.unrealizedAtMarket;
		return {
			listed: pr !== null,
			qty: pr ? pr.qty : null,
			batchedQty,
			fillPct: pr && pr.qty > 0 ? batchedQty / pr.qty : null,
			costPerItem: pr ? mil(pr.costPerItemMil) : null,
			sellPrice: pr ? mil(pr.sellPriceMil) : null,
			revenuePerItem: pr ? mil(pr.revenuePerItemMil) : null,
			profit: pr && typeof pr.profitPerItemMil === 'number' ? pr.profitPerItemMil * MIL * row.boughtQty : null,
			actualProfit,
			daysToClear: pr && typeof pr.daysToClear === 'number' ? pr.daysToClear : null
		};
	};

	const unsourcedWarnings = (ctx, batches) => {
		const firstTx = ctx.txs.length > 0 ? ctx.txs[0].ms : null;
		const out = [];
		for (const b of batches) {
			for (const it of b.items) {
				if (it.unsourcedQty > 0) out.push({ kind: 'unsourced', batchId: b.batchId, typeId: it.typeId, qty: it.unsourcedQty, historyFrom: iso(firstTx) });
			}
		}
		return out;
	};

	const batchOut = (b) => ({
		batchId: b.batchId, issuerId: b.issuerId, receiverId: b.receiverId,
		dateIssued: iso(b.issuedMs), dateCompleted: iso(b.completedMs), locationId: b.locationId, volume: b.volume,
		runId: b.runId, courierId: b.courierId, handoffCost: b.handoffCost, rolledIn: b.rolledIn,
		items: b.items.map(it => ({ ...it })), unsourcedQty: b.unsourcedQty, est: b.est, noItems: b.noItems
	});

	const courierOut = (k) => ({
		courierId: k.courierId, issuerId: k.contract.issuer_id, acceptorId: k.contract.acceptor_id, status: k.status,
		dateIssued: iso(k.issuedMs), dateAccepted: iso(k.acceptedMs), dateCompleted: iso(k.completedMs),
		reward: num(k.contract.reward), volume: k.volume,
		contractCost: k.contractCost, bonus: k.bonus, rolledIn: k.rolledIn, rolledFrom: k.rolledFrom.slice(), rolledInto: k.rolledInto,
		totalCost: k.totalCost, batchIds: k.batchIds.slice(), itemSource: k.itemSource,
		carried: [...k.carriedQty].map(([typeId, qty]) => ({ typeId, qty })).sort((a, b) => a.typeId - b.typeId),
		arrived: isFinished(k.status), failed: k.status === 'failed', dead: isDead(k.status),
		unattributed: k.unattributed, est: k.est
	});

	const runOut = (ctx, r) => {
		const batches = r.batchIds.map(id => ctx.batchById.get(id));
		return {
			runId: r.id, copiedAt: iso(r.copiedMs), route: r.run.route || null, typeCount: (r.run.rows || []).length,
			predictedProfit: predictedProfitOf(r.run), batchIds: r.batchIds.slice(),
			waiting: r.batchIds.length === 0,
			hasUnsourced: batches.some(b => b.unsourcedQty > 0),
			unplannedTypes: [...new Set(batches.flatMap(b => b.items.filter(it => it.unplanned).map(it => it.typeId)))].sort((a, b) => a - b)
		};
	};

	// facts.transfers (decision 21): the contract, who handed what to whom, the source batches of
	// each type (newest first) and the contract's own fees.
	const transferOut = (t) => ({
		contractId: t.contractId, issuerId: t.issuerId, receiverId: t.receiverId,
		issuedAt: iso(t.issuedMs), completedAt: iso(t.completedMs),
		items: t.items.map(it => ({ typeId: it.typeId, qty: it.qty, fromBatchIds: it.fromBatchIds.slice() })),
		cost: t.cost
	});

	const lotOut = (l) => ({
		lotId: l.lotId, transactionId: l.transactionId, journalId: l.journalId, typeId: l.typeId, characterId: l.characterId,
		qty: l.qty, unitPrice: l.unitPrice, date: iso(l.ms), locationId: l.locationId, where: l.where,
		batchId: l.batchId, runId: l.runId, courierId: l.courierId, buyOrderId: l.buyOrderId,
		haulPerUnit: l.haulPerUnit, buyFeePerUnit: l.buyFeePerUnit, haulParts: l.haulParts.map(p => ({ ...p })),
		arrivedAt: iso(l.arrivedMs), soldQty: l.soldQty, remainingQty: l.remaining,
		firstListedAt: iso(l.firstListedMs), lastSoldAt: iso(l.lastSoldMs), inPlay: inPlay(l), est: l.est
	});

	// A finished order reads 'expired' whether it filled (volume_remain 0) or ran out of time (keeps
	// its volume_remain); a cancelled one reads 'cancelled'.
	const outcomeOf = (r) => (r.state === 'open' ? 'open' : r.state === 'cancelled' ? 'cancelled' : num(r.volumeRemain) === 0 ? 'filled' : 'expired');

	// relists: per order (duration > 0), its price path across snapshots and the fee rows matched to it.
	const relistsOut = (ctx) => [...ctx.orders.values()]
		.filter(r => r.duration > 0)
		.sort((a, b) => a.orderId - b.orderId)
		.map(r => ({
			orderId: r.orderId, characterId: r.characterId, typeId: r.typeId, locationId: r.locationId, isBuy: r.isBuy,
			state: r.state, outcome: outcomeOf(r), filledQty: num(r.volumeTotal) - num(r.volumeRemain),
			volumeTotal: r.volumeTotal, volumeRemain: r.volumeRemain, price: r.price,
			firstSeenAt: iso(r.firstSeenMs),
			pricePath: r.path.map(p => ({ at: iso(p.atMs), price: p.price, volumeRemain: p.volumeRemain, issued: iso(p.issuedMs), source: p.source })),
			fees: r.fees.map(f => ({ id: f.id, date: iso(f.ms), amount: f.amount, kind: (ctx.feeInfo.get(rowKey(f)) || {}).kind || null })),
			feeTotal: sum(r.fees, f => -f.amount),
			relistCount: Math.max(0, r.fees.length - 1)
		}));

	//--- entry point

	// Inputs (all plain ESI-shaped data, never mutated):
	//   characterIds: the linked characters (set L); defaults to the keys of `ledgers`.
	//   ledgers: {<characterId>: {transactions, journal, ordersHistory, orders (open, optional),
	//     contracts, contractItems: {<contractId>: items}, snapshots: [{syncedAt, orders, assets, balance}]}}
	//   route: {startStationId, endStationId, startSystemId?, endSystemId?, startRegionId?, endRegionId?}
	//   locations: {<locationId>: {systemId?, regionId?}} (optional; orders supply regions too)
	//   runs: persisted export runs (Comparison 1); m3: {<typeId>: packaged m3};
	//   market: {<typeId>: best destination sell price | {bestSell}}
	//   window: {since?, until?} or {runId}; options: overrides for defaultOptions; now (required).
	const compute = (input = {}) => {
		const ctx = normalize(input);
		indexOrders(ctx);
		indexLocations(ctx);
		indexJournal(ctx);
		matchGmRefunds(ctx);
		matchTax(ctx);
		matchBrokerFees(ctx);
		buildLots(ctx);
		assignBuyOrderFees(ctx);
		buildBatches(ctx);
		mapBatchesToRuns(ctx);
		attributeHandoffs(ctx);
		matchDonations(ctx);
		buildCouriers(ctx);
		runFifo(ctx);
		setFirstListed(ctx);
		return summarize(ctx);
	};

	return {
		defaultOptions,
		compute,
		// exposed for tests
		_internal: { toMs, iso, pickBatchesByVolume, perUnitByM3, assignByGap }
	};
});
