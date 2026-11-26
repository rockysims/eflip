// Pure market stats: the observed figures of one type at one destination station, from that
// type's book log (data/ledger/market/<regionId>/<typeId>.json, built by lib/derive.js foldBook).
// Only sell orders at the station count. Over a window of `windowDays` ending at the newest sample
// at or before `now`, it reports (plan: planning/2026-11-25-export-history-columns, decisions 1, 3):
//   repriceEvents       path entries after an order's first whose price changed, while the order
//                       was in band (price <= best station sell price at that sample x (1 + band))
//   avgDaysIdle         covered days / repriceEvents; with none, the covered days and censored
//   undercutsPerDay     re-prices or new orders priced below the previous sample's best, per day
//   fillsPerDay         volumeRemain drops of orders present in two consecutive samples, per day
//   vanishedUnitsPerDay volumeRemain of orders gone between two samples (fill or withdrawal), per day
//   stockTrendPerDay    least-squares slope of the in-band sell volume, units per day
// "Per day" is per covered day. Covered time is the union of the intervals between consecutive
// samples no further apart than an acceptable gap, clipped to the window; a lone sample covers
// nothing. Counted events use the events gap, half the typical interval between orders
// (clamp(12 / ordersPerDay h, 10 min, 24 h)); cumulative quantities use the volume gap, 24 h. An
// event counts when the pair of samples it falls between is covered, so nothing in a longer gap
// counts. A `stored: false` sample (a 304) saw the book unchanged since the last stored one.
// No network, no DOM, no clock: `now` and every `at` are ISO strings.
//
// Browser: <script src="market-stats.js"></script> defines `window.marketStats`.
// Node:    const marketStats = require('./public/market-stats.js');
(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory();
	else root.marketStats = factory();
})(typeof self !== 'undefined' ? self : this, () => {
	const DAY_MS = 24 * 60 * 60 * 1000;
	const HOUR_MS = 60 * 60 * 1000;
	const MIN_EVENTS_GAP_HOURS = 1 / 6;
	const MAX_EVENTS_GAP_HOURS = 24;
	const VOLUME_GAP_HOURS = 24;

	const round4 = (x) => {
		const r = Math.round(x * 1e4) / 1e4;
		return r === 0 ? 0 : r; // no -0
	};
	const clamp = (x, low, high) => Math.min(high, Math.max(low, x));
	const toMs = (value) => (value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value));

	// Two consecutive samples cover the time between them when they are no further apart than the gap.
	const pairCovered = (prevMs, nextMs, gapMs) => nextMs - prevMs <= gapMs;

	// The covered intervals of sorted sample times: consecutive samples no further apart than gapMs
	// cover the time between them; touching intervals merge; each is clipped to [fromMs, toMs].
	// Returns {intervals: [[startMs, endMs]], coveredMs}.
	const coveredIntervals = (timesMs, gapMs, fromMs, toMs) => {
		const intervals = [];
		for (let i = 1; i < timesMs.length; i++) {
			if (!pairCovered(timesMs[i - 1], timesMs[i], gapMs)) continue;
			const start = Math.max(timesMs[i - 1], fromMs);
			const end = Math.min(timesMs[i], toMs);
			if (end <= start) continue;
			const last = intervals[intervals.length - 1];
			if (last && start <= last[1]) last[1] = Math.max(last[1], end);
			else intervals.push([start, end]);
		}
		const coveredMs = intervals.reduce((sum, [start, end]) => sum + (end - start), 0);
		return { intervals, coveredMs };
	};

	const median = (values) => {
		const sorted = values.slice().sort((a, b) => a - b);
		const mid = sorted.length >> 1;
		return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	};

	// Least-squares slope of ys against xs; null with fewer than three points or no spread in x.
	const slope = (xs, ys) => {
		const n = xs.length;
		if (n < 3) return null;
		const mx = xs.reduce((a, b) => a + b, 0) / n;
		const my = ys.reduce((a, b) => a + b, 0) / n;
		let sxy = 0;
		let sxx = 0;
		for (let i = 0; i < n; i++) {
			sxy += (xs[i] - mx) * (ys[i] - my);
			sxx += (xs[i] - mx) * (xs[i] - mx);
		}
		return sxx === 0 ? null : sxy / sxx;
	};

	const computeMarketStats = ({ log, stationId, now, windowDays = 3, ordersPerDay = 1, supplyBand = 0.75 }) => {
		const nowMs = toMs(now);
		if (!Number.isFinite(nowMs)) throw new TypeError('computeMarketStats: now must be a time');
		if (!(Number.isFinite(windowDays) && windowDays > 0)) throw new RangeError('computeMarketStats: windowDays must be > 0');
		if (!(ordersPerDay >= 0)) throw new RangeError('computeMarketStats: ordersPerDay must be >= 0');
		if (!(Number.isFinite(supplyBand) && supplyBand >= 0)) throw new RangeError('computeMarketStats: supplyBand must be >= 0');

		// Every sample, oldest first; each knows the newest stored sample at or before it (an
		// unstored one saw the book as that stored one did).
		const all = ((log && log.samples) || [])
			.map(s => ({ ms: toMs(s && s.at), stored: !(s && s.stored === false) }))
			.filter(s => Number.isFinite(s.ms))
			.sort((a, b) => a.ms - b.ms);
		let lastStoredMs = null;
		for (const s of all) {
			if (s.stored) lastStoredMs = s.ms;
			s.effMs = lastStoredMs;
		}
		const upToNow = all.filter(s => s.ms <= nowMs);
		if (upToNow.length === 0) return null;

		const windowMs = windowDays * DAY_MS;
		const toWin = upToNow[upToNow.length - 1].ms;
		const fromWin = toWin - windowMs;
		const samples = upToNow.filter(s => s.ms >= fromWin);
		const times = samples.map(s => s.ms);
		const n = samples.length;

		const eventsGapHours = clamp(12 / ordersPerDay, MIN_EVENTS_GAP_HOURS, MAX_EVENTS_GAP_HOURS);
		const eventsGapMs = eventsGapHours * HOUR_MS;
		const volumeGapMs = VOLUME_GAP_HOURS * HOUR_MS;
		const eventsCoveredDays = coveredIntervals(times, eventsGapMs, fromWin, toWin).coveredMs / DAY_MS;
		const volumeCoveredDays = coveredIntervals(times, volumeGapMs, fromWin, toWin).coveredMs / DAY_MS;

		// The station's sell orders that can be present in the window, each path oldest first.
		const station = Number(stationId);
		const effs = samples.map(s => s.effMs).filter(ms => ms !== null);
		const minEff = effs.length ? effs[0] : null;
		const orders = [];
		for (const entry of Object.values((log && log.orders) || {})) {
			if (!entry || entry.isBuy !== false || Number(entry.locationId) !== station) continue;
			const firstMs = toMs(entry.firstSeen);
			const lastMs = toMs(entry.lastSeen);
			if (minEff === null || !(firstMs <= toWin) || !(lastMs >= minEff)) continue;
			const path = (entry.path || [])
				.map(p => ({ ms: toMs(p.at), price: p.price, volumeRemain: p.volumeRemain }))
				.filter(p => Number.isFinite(p.ms))
				.sort((a, b) => a.ms - b.ms);
			if (path.length > 0) orders.push({ firstMs, lastMs, path });
		}

		// state[i][k]: order k at sample i, {price, volumeRemain} or null when absent: present while
		// firstSeen <= (the stored sample that sample i stands for) <= lastSeen, priced by its newest path
		// entry at or before the sample.
		const state = samples.map(() => new Array(orders.length).fill(null));
		orders.forEach((order, k) => {
			let p = -1;
			for (let i = 0; i < n; i++) {
				while (p + 1 < order.path.length && order.path[p + 1].ms <= times[i]) p++;
				const eff = samples[i].effMs;
				if (p < 0 || eff === null || !(order.firstMs <= eff && eff <= order.lastMs)) continue;
				state[i][k] = order.path[p];
			}
		});
		const best = state.map(row => row.reduce((low, s) => (s && (low === null || s.price < low) ? s.price : low), null));
		const inBand = (i, k) => state[i][k] !== null && best[i] !== null && state[i][k].price <= best[i] * (1 + supplyBand);

		// Events: each path entry belongs to the pair of window samples it falls between, (sample
		// i - 1, sample i]; it counts when that pair is events-covered. A re-price is an entry after
		// the first whose price changed, counted when the order is in band at sample i; an undercut
		// is a re-price or a first entry priced below the best at sample i - 1.
		let repriceEvents = 0;
		let undercuts = 0;
		orders.forEach((order, k) => {
			let i = 0;
			order.path.forEach((entry, e) => {
				while (i < n && times[i] < entry.ms) i++;
				if (i === 0 || i === n || !pairCovered(times[i - 1], times[i], eventsGapMs)) return;
				const repriced = e > 0 && entry.price !== order.path[e - 1].price;
				if (repriced && inBand(i, k)) repriceEvents++;
				if ((e === 0 || repriced) && best[i - 1] !== null && entry.price < best[i - 1]) undercuts++;
			});
		});

		// Volume: over each volume-covered pair, drops of orders present in both and the remaining
		// volume of orders present only in the first.
		let fills = 0;
		let vanished = 0;
		const volumeSampleIdx = new Set();
		for (let i = 1; i < n; i++) {
			if (pairCovered(times[i - 1], times[i], volumeGapMs)) {
				volumeSampleIdx.add(i - 1);
				volumeSampleIdx.add(i);
				for (let k = 0; k < orders.length; k++) {
					const prev = state[i - 1][k];
					const next = state[i][k];
					if (prev === null) continue;
					if (next === null) vanished += prev.volumeRemain;
					else fills += Math.max(0, prev.volumeRemain - next.volumeRemain);
				}
			}
		}

		const trendIdx = [...volumeSampleIdx].sort((a, b) => a - b);
		const trend = slope(
			trendIdx.map(i => (times[i] - fromWin) / DAY_MS),
			trendIdx.map(i => state[i].reduce((sum, s, k) => sum + (inBand(i, k) ? s.volumeRemain : 0), 0))
		);

		const gaps = times.slice(1).map((t, i) => (t - times[i]) / HOUR_MS);
		const perEventsDay = (count) => (eventsCoveredDays > 0 ? round4(count / eventsCoveredDays) : null);
		const perVolumeDay = (units) => (volumeCoveredDays > 0 ? round4(units / volumeCoveredDays) : null);
		const censored = eventsCoveredDays > 0 && repriceEvents === 0;
		return {
			coverage: {
				windowDays,
				samples: n,
				medianGapHours: gaps.length ? round4(median(gaps)) : null,
				maxGapHours: gaps.length ? round4(Math.max(...gaps)) : null,
				from: new Date(fromWin).toISOString(),
				to: new Date(toWin).toISOString(),
				events: { gapHours: round4(eventsGapHours), coveredDays: round4(eventsCoveredDays), fraction: round4(eventsCoveredDays / windowDays) },
				volume: { gapHours: VOLUME_GAP_HOURS, coveredDays: round4(volumeCoveredDays), fraction: round4(volumeCoveredDays / windowDays) }
			},
			repriceEvents,
			avgDaysIdle: eventsCoveredDays > 0 ? round4(censored ? eventsCoveredDays : eventsCoveredDays / repriceEvents) : null,
			censored,
			undercutsPerDay: perEventsDay(undercuts),
			fillsPerDay: perVolumeDay(fills),
			vanishedUnitsPerDay: perVolumeDay(vanished),
			stockTrendPerDay: trend === null ? null : round4(trend)
		};
	};

	return {
		computeMarketStats,
		// exposed for tests
		_internal: { coveredIntervals, pairCovered, round4 }
	};
});
