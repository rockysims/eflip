// storage-budget.js: the storage budget with shares (planning/2026-11-25-export-history-columns,
// M2 P2.2). One allotment of disk (EFLIP_STORAGE_BUDGET, e.g. `1GB`) is shared by the bulky,
// replaceable kinds of data in percentages (EFLIP_STORAGE_SHARES); when their total is over the
// budget, the kind furthest over its share is trimmed, oldest first, until the total fits.
//
// Pure: no I/O and no clock. The caller measures each kind on disk, hands the pieces it could drop
// to planTrim, and applies the plan it answers (under the `market` lock).
//
// The kinds (the job maps them to files; the planner only knows their names):
//   regionPages   the hourly regional order pages (raw), trimmed by whole snapshot
//   bookLogs      the book logs (ledger/market), trimmed by one time cutoff across all logs
//   typeBooks     the per-type raw books and histories, trimmed by whole raw file
//   runContexts   the `context` of saved runs, trimmed by whole run
//
// Soft shares: the total is what is enforced. A kind under its share lends the room to the others;
// a share only decides which kind gives way first when the total is over.

const KINDS = Object.freeze(['regionPages', 'bookLogs', 'typeBooks', 'runContexts']);
const DEFAULT_SHARES = Object.freeze({ regionPages: 40, bookLogs: 45, typeBooks: 10, runContexts: 5 });

// Decimal units only: 1 KB = 1e3 bytes, 1 MB = 1e6, 1 GB = 1e9, 1 TB = 1e12 (no binary 1024s, and
// `GiB` and the like are refused rather than guessed at).
const UNITS = Object.freeze({ b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 });
const BUDGET = /^(\d+(?:\.\d+)?|\.\d+)\s*([a-z]*)$/i;

// The budget in bytes from text such as `1GB`, `1.5 GB`, `500MB` or `250000000` (bytes);
// case-insensitive. null, undefined or blank: no budget (null). Anything else, or a budget under
// one byte, throws a RangeError.
const parseBudget = (text) => {
	if (text === null || text === undefined) return null;
	const trimmed = String(text).trim();
	if (trimmed === '') return null;
	const m = BUDGET.exec(trimmed);
	const unit = m ? (m[2] === '' ? 'b' : m[2].toLowerCase()) : null;
	if (!m || !Object.hasOwn(UNITS, unit)) throw new RangeError(`storage budget: "${trimmed.slice(0, 40)}" is not a size such as 1GB, 500MB or a number of bytes`);
	const bytes = Math.round(Number(m[1]) * UNITS[unit]);
	if (!Number.isSafeInteger(bytes) || bytes < 1) throw new RangeError(`storage budget: "${trimmed.slice(0, 40)}" is not a usable size; leave it unset for no budget`);
	return bytes;
};

// The shares, percent by kind, from text such as `regionPages:40,bookLogs:45,typeBooks:10,
// runContexts:5`. null, undefined or blank: every kind at its default. Otherwise a kind left out
// gets 0 (it gives way first). Kind names are matched without regard to case. An unknown or
// repeated kind, a value that is not a number of 0 or more, or a sum above 100 throws a
// RangeError; a sum below 100 is allowed (the rest is headroom).
const parseShares = (text) => {
	if (text === null || text === undefined || String(text).trim() === '') return { ...DEFAULT_SHARES };
	const shares = Object.fromEntries(KINDS.map(kind => [kind, 0]));
	const seen = new Set();
	for (const part of String(text).split(',')) {
		const item = part.trim();
		if (item === '') continue;
		const m = /^([A-Za-z]+)\s*:\s*(\S+)$/.exec(item);
		if (!m) throw new RangeError(`storage shares: "${item.slice(0, 40)}" is not kind:percent`);
		const kind = KINDS.find(name => name.toLowerCase() === m[1].toLowerCase());
		if (kind === undefined) throw new RangeError(`storage shares: unknown kind "${m[1].slice(0, 40)}" (the kinds are ${KINDS.join(', ')})`);
		if (seen.has(kind)) throw new RangeError(`storage shares: ${kind} is given twice`);
		seen.add(kind);
		if (!/^(\d+(?:\.\d+)?|\.\d+)$/.test(m[2])) throw new RangeError(`storage shares: ${kind}:${m[2].slice(0, 20)} is not a percentage of 0 or more`);
		shares[kind] = Number(m[2]);
	}
	const sum = KINDS.reduce((total, kind) => total + shares[kind], 0);
	if (sum > 100 + 1e-9) throw new RangeError(`storage shares: they add up to ${sum} %, more than 100`);
	return shares;
};

const byTime = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const checkBytes = (value, what) => {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new RangeError(`storage plan: ${what} is not a number of bytes`);
	return value;
};

// The plan that brings the kinds within the budget.
//
// budgetBytes  the budget (parseBudget); null or undefined: no budget, nothing is trimmed.
// shares       percent by kind name (parseShares); a kind it does not name has share 0; a sum above
//              100 throws a RangeError.
// kinds        [{name, bytes, items?, buckets?, floorAt?}], each kind's measured bytes on disk and the
//              pieces it could give up:
//   items      discrete pieces, oldest first: [{id, at (ISO), bytes, floor?}]; an item with
//              `floor: true` is never trimmed (the newest snapshot, the newest raw file of a slug,
//              the newest run's context). Trimmed whole, oldest first, floors skipped.
//   buckets    a continuous kind's bytes by age, oldest first: [{from, to, bytes}], each the bytes
//              that dropping everything before `to` would free on top of the buckets before it.
//              Trimmed whole, oldest first; a bucket ending after `floorAt` never is (the last days
//              of every book log). No floorAt: every bucket may go.
//
// While the total is over the budget, the kind with the largest over-ratio, bytes ÷ (share % of
// the budget), that still has something to trim gives up its oldest piece; ties go to the kind
// with more bytes, then to the one listed first. A kind with share 0 and bytes left has an
// over-ratio of Infinity, so it goes first. When nothing trimmable is left, what is still over
// is `unmet`.
//
// Answers {budgetBytes, totalBefore, totalAfter, unmet, trims: {[name]: {itemIds, cutoffAt,
// bytesFreed}}}, an entry for every kind given: the ids of the items to drop, oldest first; the
// cutoff for the buckets (drop what is older than it: the `to` of the last bucket trimmed), or
// null; and the bytes the plan frees.
const planTrim = ({ budgetBytes = null, shares = DEFAULT_SHARES, kinds = [] } = {}) => {
	if (budgetBytes !== null && budgetBytes !== undefined) checkBytes(budgetBytes, 'the budget');
	if (!Array.isArray(kinds)) throw new TypeError('storage plan: kinds is not a list');
	const shareSum = Object.values(shares || {}).reduce((total, share) => total + Number(share), 0);
	if (shareSum > 100 + 1e-9) throw new RangeError(`storage plan: the shares add up to ${shareSum} %, more than 100`);
	const names = new Set();
	const states = kinds.map((kind, order) => {
		if (!kind || typeof kind.name !== 'string' || kind.name === '') throw new TypeError('storage plan: a kind without a name');
		if (names.has(kind.name)) throw new RangeError(`storage plan: ${kind.name} is given twice`);
		names.add(kind.name);
		const share = shares && Object.hasOwn(shares, kind.name) ? Number(shares[kind.name]) : 0;
		if (!Number.isFinite(share) || share < 0) throw new RangeError(`storage plan: the share of ${kind.name} is not a percentage`);
		const items = (kind.items || []).map((item, index) => ({ ...item, index, bytes: checkBytes(item.bytes, `an item of ${kind.name}`) }))
			.sort((a, b) => byTime(a.at, b.at) || a.index - b.index)
			.filter(item => item.floor !== true);
		const floorAt = kind.floorAt === undefined ? null : kind.floorAt;
		const buckets = (kind.buckets || []).map((bucket, index) => ({ ...bucket, index, bytes: checkBytes(bucket.bytes, `a bucket of ${kind.name}`) }))
			.sort((a, b) => byTime(a.from, b.from) || byTime(a.to, b.to) || a.index - b.index);
		return {
			name: kind.name,
			order,
			share,
			bytes: checkBytes(kind.bytes, `the bytes of ${kind.name}`),
			items,
			nextItem: 0,
			buckets,
			nextBucket: 0,
			floorAt,
			trim: { itemIds: [], cutoffAt: null, bytesFreed: 0 },
		};
	});

	const totalBefore = states.reduce((total, state) => total + state.bytes, 0);
	const result = (total, unmet) => ({
		budgetBytes: budgetBytes === undefined ? null : budgetBytes,
		totalBefore,
		totalAfter: total,
		unmet,
		trims: Object.fromEntries(states.map(state => [state.name, state.trim])),
	});
	if (budgetBytes === null || budgetBytes === undefined) return result(totalBefore, 0);

	const bucketTrimmable = (state) => {
		const bucket = state.buckets[state.nextBucket];
		return bucket !== undefined && (state.floorAt === null || bucket.to <= state.floorAt);
	};
	const trimmable = (state) => state.nextItem < state.items.length || bucketTrimmable(state);
	const overRatio = (state) => {
		if (state.bytes <= 0) return 0;
		const room = (state.share / 100) * budgetBytes;
		return room > 0 ? state.bytes / room : Infinity;
	};

	let total = totalBefore;
	while (total > budgetBytes) {
		let pick = null;
		let pickRatio = -1;
		for (const state of states) {
			if (!trimmable(state)) continue;
			const ratio = overRatio(state);
			if (pick === null || ratio > pickRatio || (ratio === pickRatio && state.bytes > pick.bytes)) {
				pick = state;
				pickRatio = ratio;
			}
		}
		if (pick === null) return result(total, total - budgetBytes);
		// its oldest piece: the older of the next item and the next trimmable bucket (a kind has one
		// or the other in practice)
		const item = pick.items[pick.nextItem];
		const bucket = bucketTrimmable(pick) ? pick.buckets[pick.nextBucket] : undefined;
		let freed;
		if (item !== undefined && (bucket === undefined || byTime(item.at, bucket.from) <= 0)) {
			pick.nextItem++;
			pick.trim.itemIds.push(item.id);
			freed = item.bytes;
		} else {
			pick.nextBucket++;
			pick.trim.cutoffAt = bucket.to;
			freed = bucket.bytes;
		}
		pick.trim.bytesFreed += freed;
		pick.bytes -= freed;
		total -= freed;
	}
	return result(total, 0);
};

module.exports = {
	KINDS,
	DEFAULT_SHARES,
	parseBudget,
	parseShares,
	planTrim,
};
