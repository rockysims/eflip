// storage-notice.js: the storage line of the pages' env notice (planning/2026-11-25-export-history-
// columns, M2 P2.2), from GET /api/config: `regionBook.enabled` (EFLIP_REGION_BOOK=1) and `storage`
// ({budget: bytes | null, usage, total, unmet, error, ...}, lib/api.js). results-shared.js (results,
// insights and orders pages) and export.js print the same sentences; scripts/sync.js uses sizeText.
//   - a budget or shares setting that does not parse (`error`): that no budget is applied, and why,
//     whether or not the region job is on
//   - region job on, no budget: a note that raw grows without bound, and the setting that stops it
//   - a budget: how much of it is used ("Storage 62 % of 1 GB."), and, when the last run could not
//     get under it, by how much it is over with nothing left to trim above the floors
// Text only: the pages escape it (results-shared.js) or set it as textContent (export.js).
//
// Browser: <script src="storage-notice.js"></script> defines `window.storageNotice`.
// Node:    const storageNotice = require('./public/storage-notice.js');
(function (root, factory) {
	if (typeof module === 'object' && module.exports) module.exports = factory();
	else root.storageNotice = factory();
})(typeof self !== 'undefined' ? self : this, () => {
	// Decimal units, as EFLIP_STORAGE_BUDGET reads them (1 GB = 1e9 bytes).
	const UNITS = [[1e12, 'TB'], [1e9, 'GB'], [1e6, 'MB'], [1e3, 'KB']];

	// A byte count in the largest unit it reaches, three significant digits at most: 1e9 -> "1 GB",
	// 46300000 -> "46.3 MB", 512 -> "512 bytes".
	const sizeText = (bytes) => {
		const n = Number(bytes);
		if (!Number.isFinite(n)) return '?';
		for (const [size, unit] of UNITS) {
			if (Math.abs(n) >= size) return `${Number((n / size).toPrecision(3))} ${unit}`;
		}
		return `${Math.round(n)} bytes`;
	};

	// [{kind: 'warn' | 'info', text}] for the /api/config answer; [] when there is nothing to say.
	const storageNoticeLines = (config) => {
		if (!config || typeof config !== 'object') return [];
		const storage = config.storage;
		if (!storage || typeof storage !== 'object') return [];
		const regionBookOn = Boolean(config.regionBook && config.regionBook.enabled);
		if (typeof storage.error === 'string' && storage.error !== '') {
			return [{ kind: 'warn', text: `EFLIP_STORAGE_BUDGET or EFLIP_STORAGE_SHARES did not parse (${storage.error}): no storage budget is applied.` }];
		}
		const budget = Number(storage.budget);
		if (storage.budget === null || storage.budget === undefined || !(budget > 0)) {
			return regionBookOn
				? [{ kind: 'warn', text: 'The hourly destination book is on with no storage budget: it adds about 8 MB an hour on disk (46 MB of order pages, gzipped). Set EFLIP_STORAGE_BUDGET (e.g. 1GB).' }]
				: [];
		}
		const total = Number(storage.total) || 0;
		const used = `Storage ${Math.round((total / budget) * 100)} % of ${sizeText(budget)}`;
		const unmet = Number(storage.unmet) || 0;
		if (unmet > 0) return [{ kind: 'warn', text: `${used}, over budget by ${sizeText(unmet)}: nothing left to trim above the floors.` }];
		return [{ kind: 'info', text: `${used}.` }];
	};

	return { sizeText, storageNoticeLines };
});
