# export.html improvements — plan

Branch: `claude/export-html-improvements-5cbab1`. Scope: `public/export.html`,
`public/export.js`, `public/util.js`, plus a new `public/estimate.js` and
`test/estimate.test.js`. `exportAndSold.*`, `missing.*`, `resell.*`, `index.*`,
`server.js` are out of scope.

Principle: every number shown to the user comes from ESI (station orders and
region history). Fuzzwork aggregates are used only to decide which types get a
full report; no Fuzzwork figure is displayed or used in a displayed figure.

## Phase 1 — fetch layer (`public/util.js`)

1. Fix `fetchWithRetries`: await `res.json()`; treat non-2xx as failures;
   handle fetch errors (no `error.response`); exponential backoff with jitter
   (0.5s, 1s, 2s, 4s, 8s); keep returning `null` after exhausting retries.
2. Add a request queue with a concurrency cap (default 30 in flight). All
   network calls (`fetch` inside `fetchWithRetries`, including POST) go through
   it. Local `/file/` cache reads and writes do not need the cap.
3. Honour ESI error-limit headers: read `X-ESI-Error-Limit-Remain` and
   `X-ESI-Error-Limit-Reset`; when remaining drops below 20, pause the queue
   until reset. Treat HTTP 420 as a pause-until-reset signal.
4. Support cancellation: queue accepts an `AbortSignal`; aborted tasks reject
   with a distinguishable error and are not retried.
5. `getTypeIds`: use the `X-Pages` header instead of a fixed 16 pages (fall
   back to 16 if the header is absent because the response came from cache).
6. Expose from `util`: `createQueue`, `queueStats()` (in flight, queued, done,
   failed, paused-until) for the progress UI.

## Phase 2 — estimate (`public/estimate.js`, `public/export.js`)

Extract the pure calculation into `public/estimate.js` so it can be unit
tested in Node (`node --test test/estimate.test.js`) and loaded by the page
with a plain `<script>`; UMD-style export (`window.estimate` or
`module.exports`).

Inputs stay the same: source station sell orders, destination station sell
orders, destination region history. Changes:

1. **Ordinary price window**: `getOrdinaryPrice` receives only the last 90
   days of history.
2. **Recency-weighted demand**: daily demand = weighted sum of each day's
   sell-side volume (`highVolume`) over the 30 considered days, weight
   `0.5 ^ (age / 30)`, divided by the weighted day count. Profitable-day
   gating and `activeDaysFraction` unchanged.
3. **Sell price**: `min(destBestSellPrice - 0.01, destRecentAverageSellPrice)`
   as today (minus the undercut tick), with `destRecentAverageSellPrice` as
   fallback when no destination orders exist.
4. **Competing volume**: sum of `volume_remain` over destination sell orders
   priced at or below `sellPrice * (1 + COMPETE_BAND)` with
   `COMPETE_BAND = 0.10`. Reported as `competingVolume`.
5. **Buy cap**: units to buy over the horizon =
   `max(0, dailyDemand * DAYS_TO_COMPLETE - competingVolume)`, cumulative per
   day as today. This replaces the `sellerCount` share divisor. `sellerCount`
   and `daysSinceSellerUpdate` are still computed and shown, and the
   "seller updated too recently" filter stays.
6. **Marginal stop rule**: while walking the source book, stop when the next
   order's `revenuePerItem / (price * (1 + HAULING_REWARD_FRACTION)) < MIN_ROI`.
   Replaces the `profitPerDayEstimate < 2000000` test.
7. **Days to clear**: `(volume + competingVolume) / dailyDemand`.
8. **Daily profit**: `(revenue - cost) / max(daysToClear, 1)`. Ranking uses
   this. For one release the old `(revenue - cost) / DAYS_TO_COMPLETE` is also
   reported as `dailyProfitOldMil` so the two can be compared in the table;
   remove after the user is happy.
9. Remove the dead "margin crashed" filter.
10. Report shape (all Mil values via `roundMils`): `volume`, `costPerItemMil`,
    `revenuePerItemMil`, `profitPerItemMil`, `roi`, `dailyProfitMil`,
    `dailyProfitOldMil`, `daysToClear`, `competingVolume`, `dailyDemand`,
    `activeSellers`, `daysSinceSellerUpdate`, `activeDaysFraction`,
    `filteredReason` (null when the item passes).
11. Page-level filters move into `estimate.js` as `applyFilters(report,
    config)` returning a reason string or null, so filtered items can be shown
    with their reason.

Tests cover: ordinary price window, recency weights, competing volume band,
buy cap with and without overhang, marginal stop, days to clear, filters.
Fixtures are small hand-written order/history arrays.

## Phase 3 — pipeline and UI (`public/export.html`, `public/export.js`)

1. Replace the batch loop with: triage chunks of 25 enqueued at once; each
   type that passes triage (or is in the always-show list) enqueues its report
   task immediately; results are rendered as they arrive.
2. Controls at the top: start station and end station dropdowns (Jita, Amarr,
   Dodixie, Rens, Stacmon; default Jita → Amarr), Run, Stop, global default
   factor, "show filtered" toggle, "Copy orders" button. Progress line:
   triaged / total, reports done / enqueued, in flight, paused-until if any,
   elapsed.
3. Table, sortable by any column, sticky header, numbers right-aligned with
   thousands separators. Columns: select, name (with type id), daily profit,
   profit/item, cost/item, revenue/item, ROI, days to clear, recommended
   volume, factor, order qty, order cost, order revenue, km3, competing
   volume, active sellers, days since update, active days, daily profit (old),
   reason (only with "show filtered"). Default sort daily profit desc; live
   re-sort as rows arrive, suspended while the user is editing a row.
4. Factor per row (default = global factor at the time the row appears).
   Order qty = `ceil(volume * factor)`; editing qty sets factor =
   `qty / volume`. Order cost and revenue scale with qty, km3 too.
5. Footer over selected rows: total cost, revenue, profit, km3 — same figures
   the paste box produced.
6. Copy: one line per selected row, `name + '\t' + orderQty`, no trailing
   space after the name. Button shows "Copied" for a second.
7. Persist per route in localStorage: selected set, per-row factor, global
   factor, sort column, show-filtered. Always-show list stays in `export.js`.
8. Remove the mark textarea and its script; remove the duplicate moment.js
   tag.
9. The always-show and ignore-one-seller lists remain in `export.js`.

## Gates

- `node --test test/estimate.test.js` passes (Node 22+ treats the argument as a glob, so a bare directory does not work).
- `npm run start`, open `localhost:5001/export.html`, run Jita → Amarr, confirm
  rows stream in, sort, factor/qty linkage, footer sums, copied text format,
  Stop halts the queue, reload restores selections.
- Compare top 20 rows against a run of the current page (same cache) and
  note the ranking differences caused by the estimate changes.

## Agent roster

- Phase 1: sonnet (bounded, clear spec).
- Phase 2: opus (estimate semantics need care; writes the tests too).
- Phase 3: sonnet, after phases 1 and 2 land, since it consumes both.
- Fable: reviews each diff, reruns tests, browser smoke test, commits.
