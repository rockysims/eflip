# export.html improvements — plan

Branch: `claude/export-html-improvements-5cbab1`. Scope: `public/export.html`,
`public/export.js`, `public/util.js`, plus a new `public/estimate.js` and
`test/estimate.test.js`. `exportAndSold.*`, `missing.*`, `resell.*`, `index.*`,
`server.js` are out of scope.

Principle: every number shown to the user comes from ESI (station orders and
region history). Fuzzwork aggregates are used only to decide which types get a
full report; no Fuzzwork figure is displayed or used in a displayed figure.
(2026-11-25: the observed figures of Phase 2, items 14 to 16, come from the server's
book logs, which are stored ESI market orders, so the principle holds.)

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
   and `daysSinceSellerUpdate` are still computed and shown. The "seller
   updated too recently" filter is gone (2026-11-25: it made the best picks
   come and go as sellers re-priced; see `docs/ui-decisions/`); the idle
   figures stay as information only.
6. **Marginal stop rule**: while walking the source book, stop when the next
   order's `revenuePerItem / (price * (1 + HAULING_REWARD_FRACTION)) < MIN_ROI`.
   Replaces the `profitPerDayEstimate < 2000000` test. The page sets `MIN_ROI`
   per run from its "min ROI" input (Phase 3, item 13). A `targetVolume` input
   makes the walk buy toward that many units instead of the demand cap,
   ignoring the ROI floor (spend cap kept); the page uses it for a factor
   other than 1.
7. **Days to clear**: `(volume + competingVolume) / dailyDemand`. For a
   factor other than 1 the page re-runs the estimate with the factored
   quantity as `targetVolume`, so this follows the factor with real book
   prices.
8. **Daily profit**: `(revenue - cost) / max(daysToClear, 1)`. Ranking uses
   this. For one release the old `(revenue - cost) / DAYS_TO_COMPLETE` is also
   reported as `dailyProfitOldMil` so the two can be compared in the table;
   remove after the user is happy. For a factor other than 1 the page re-runs
   the estimate with the factored quantity as `targetVolume`, so this follows
   the factor with real book prices.
9. Remove the dead "margin crashed" filter.
10. Report shape (all Mil values via `roundMils`): `volume`, `costPerItemMil`,
    `revenuePerItemMil`, `profitPerItemMil`, `roi`, `dailyProfitMil`,
    `dailyProfitOldMil`, `daysToClear`, `competingVolume`, `dailyDemand`,
    `activeSellers`, `daysSinceSellerUpdate` (idle days over every destination
    sell order), `daysSinceInBandSellerUpdate` (the same over the orders within
    `SUPPLY_BAND` above the sell price; the "days idle" cell tooltip),
    `activeDaysFraction`,
    `stopReason` (`'horizon' | 'roi' | 'book' | 'cost' | 'target'`: which
    limit bound the volume; `'target'` when a `targetVolume` was given and
    reached), `stopPriceMil` (the source order the walk stopped at, for
    `'roi'` and `'cost'`, else null), `stopRoi` (that order's ROI, for
    `'roi'`, else null), `horizonVolume` (the demand cap as whole units),
    `targetVolume` (the quantity asked for; null for a recommendation),
    `floored` (see 12), `filteredReason` (null when the item passes).
    (2026-11-25: the report also carries the observed-figure fields of item 16.)
11. Page-level filters move into `estimate.js` as `applyFilters(report,
    config)` returning a reason string or null, so filtered items can be shown
    with their reason. Reasons, in the order they are checked: `no report`,
    `nothing to buy`, `not profitable` (for a volume of 0 only: an empty
    source book, no sell price, a target of 0), `too much competition`. (A
    `seller updated too recently` reason existed until 2026-11-25.) The
    single-column limits (daily profit 1M/day, ROI, active days 0.2) are not
    estimate filters: they are the page's min/max column filters, seeded once
    with those values (Phase 3, item 12). The estimate keeps only what no one
    column can say.
12. **Floor of 1**: a recommendation of 0 units (a demand cap of 0, or the
    ROI floor on the cheapest order) shows 1 unit from the cheapest source
    order, so the row still has a real cost, ROI, days to clear and daily
    profit. The report has `floored: true`; `stopReason` stays what the walk
    recorded (`'horizon'` or `'roi'`). The floor changes the figures, not
    which rows pass: `applyFilters` returns `nothing to buy` for a floored
    report (always-show rows still pass). Only a recommendation is floored
    (a targeted walk buys what it was asked for, 0 included), and only when
    there is a sell price to value the unit at and the cheapest order is
    within `COST_LIMIT`; otherwise (an empty source book, no sell price) the
    volume-0 raw-prices fallback stays and the filter says `not profitable`.
13. `limitBreaches(report, config)` returns the report fields whose value
    breaks a limit of the estimate, in column order: `rivals` (too much
    competition) and `daysToClear` (beyond `DAYS_TO_COMPLETE`, the horizon: not
    a filter, a limit the user set). It shares its predicates with
    `applyFilters` so the two cannot drift, and ignores `isAlwaysShow` and `floored`: it describes
    the figures, not the row's filtered state. The column filters' limits
    (daily profit, ROI, active days) are the page's to check.
14. **Observed inputs and the blend rule** (2026-11-25;
    `planning/2026-11-25-export-history-columns`, M1). `computeItemReport`
    takes an optional `observed` (default null): what the destination
    station's book log saw for the type, the answer of `computeMarketStats`
    in `public/market-stats.js` (pure, UMD, tested in
    `test/market-stats.test.js`), which the page gets from
    `POST /api/market-stats` (Phase 3, item 15). It is never mutated, and the
    estimate stays pure: no network, no clock. Without `observed` every
    figure is the model's, exactly as before.
    For a figure with an observed form `o` and a model `m` over the window
    `W`: `shown = f·o + (1 − f)·m`, where `f` is the covered time inside `W`
    ÷ `W`. Covered time is the union of the intervals between consecutive
    book-log samples closer than the item's acceptable gap, clipped to `W`; a
    lone sample covers no time. `f = 0` is exactly the model. There are two
    acceptable gaps, because counted events and cumulative quantities lose
    different things across a gap:
    - events (re-prices, undercuts), fraction `observedFractionEvents`: a gap
      of at most half the typical interval between orders,
      `clamp(12 / ordersPerDay hours, 10 min, 24 h)`, with `ordersPerDay` from
      item 15. A covered gap is then unlikely to hide two moves of one order.
      A busy item sampled hourly is mostly uncovered, so it stays on the
      model, until denser sampling reaches it; a slow item is covered by
      hourly samples.
    - volume (fills, stock trend), fraction `observedFractionVolume`: a gap
      of at most 24 h, because volume drops add up across a gap and only the
      orders that vanished inside it are lost.
    `order_count` is region-wide, so it overstates the station's pace and
    shortens the events gap: the conservative side (more model).
    Blended figures:
    - `dailyDemand = fVolume × fillsPerDay + (1 − fVolume) × dailyDemandModel`,
      formed before the walk, so the demand cap, the walk, days to clear,
      daily profit, days of supply and the "too much competition" filter all
      follow it. `fillsPerDay` is the summed `volumeRemain` drops of orders
      present in two consecutive samples, per covered day (order monitor
      decision 13: a drop is a fill). Orders that vanished between samples
      (filled or withdrawn, unknown) are not counted; the stats module
      reports them as `vanishedUnitsPerDay`.
    - `rivals = fEvents × (undercutsPerDay × max(daysToClear, 1)) + (1 −
      fEvents) × rivalsModel`, formed after the walk because it needs days to
      clear. `undercutsPerDay` counts re-prices and new orders that set a new
      lowest station sell price, per covered day. Competing volume keeps the
      model's per-order rival weight: it is per order, the observed rate is
      per type.
    A null observed rate (nothing covered) or a fraction of 0 leaves the
    model's figure; fractions are clamped to [0, 1] and a malformed
    observation counts as none.
    Observed only, never blended: `avgDaysIdle` (covered days ÷ re-price
    events of the sellers within `SUPPLY_BAND` of the cheapest station
    listing; when nobody moved it is the covered days and
    `avgDaysIdleCensored` is true, a lower bound) and `stockTrendPerDay` (the
    least-squares slope of the in-band sell volume, units a day). `avgDaysIdle`
    has no model fallback: `daysSinceSellerUpdate` is a different quantity
    (time since the newest move, not the mean time between moves), so it stays
    its own column.
    The window is `W = max(run days to clear, 3)` days, at most 60 (the
    route's limit), ending at the newest sample at or before now. The
    three-day floor keeps a one-day horizon from averaging over a handful of
    re-prices. Until the hourly destination-book series (M2 of
    `planning/2026-11-25-export-history-columns`) runs, only types in play
    (listed, in transit, held, sold in the last 90 days) have book logs and so
    coverage; every other row has `f = 0` and looks as it did before.
    (Amended 2026-11-26, M2 P2.3: with `EFLIP_REGION_BOOK=1` the server takes
    the destination region's whole order book every hour and folds each
    type's orders into its book log, so after a few days every type at the
    destination station has a log, types never in play included, and `f` rises
    above 0 for them too. The job is opt-in. Its raw pages and the logs live
    under an optional storage budget, trimmed oldest first and never below the
    last 3 days of a log (this item's window floor). See the README, Syncing
    and Storage budget, and
    `planning/2026-11-25-export-history-columns/02-destination-book-series.md`.
    Without the flag nothing changes: only types in play have coverage.)
15. **`typicalOrdersPerDay(destDays, now, config)`** (2026-11-25), exported
    from `estimate.js`: the recency-weighted mean of the history's
    `order_count` over ages 1 to `DAYS_CONSIDERED`, with the demand weights
    (today's partial day counts as age 1, a missing day counts 0), floored at
    1 and rounded to 2 decimals. Every row has a history, so every row has a
    pace, book log or not. The page sends it with each type to
    `/api/market-stats`, where it sets the events gap of item 14.
16. **Observed-figure report fields** (2026-11-25), all null, 0 or false
    without observation:
    - `observedFractionEvents`, `observedFractionVolume`: the two fractions of
      item 14, 0 to 1 at 2 decimals.
    - `dailyDemandModel`, `dailyDemandObserved`: the history model's daily
      demand and the observed `fillsPerDay`; `dailyDemand` is their blend.
    - `rivalsModel`, `rivalsObserved`: the per-order model's rivals and the
      observed `undercutsPerDay × max(daysToClear, 1)`; `rivals` is their blend.
    - `avgDaysIdle`, `avgDaysIdleCensored`, `stockTrendPerDay`: observed only
      (item 14).
    - `observedCoverage`: the stats module's `coverage` object, `{windowDays,
      samples, medianGapHours, maxGapHours, from, to, events: {gapHours,
      coveredDays, fraction}, volume: {gapHours, coveredDays, fraction}}`,
      null without observation.

Tests cover: ordinary price window, recency weights, competing volume band,
buy cap with and without overhang, marginal stop, days to clear, filters,
the observed blend (f = 0 is the model, f = 1 the observed figure, f = 0.5 the
midpoint, a censored average passes through) and `typicalOrdersPerDay`; the
stats module has its own `test/market-stats.test.js`.
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
   At a factor other than 1 the row is re-estimated with `ceil(volume ×
   factor)` as `targetVolume`, bought for real up the source book past the
   ROI floor (spend cap kept), from the order books and history already in
   memory, so no request is made. The quantity shown and copied is what the
   book had; cost/item, ROI, order cost and revenue, days to clear and daily
   profit are those of that quantity, km3 scales with it. The filtered state
   stays the recommendation's, and the column filters test the
   recommendation's figures too (item 12), so a factor never hides a row;
   sorting uses the re-estimated figures. A blank row factor (cleared by the
   user) removes the row's own factor: the row follows the global factor again
   and is re-estimated; on commit a blank or invalid entry snaps back to the
   factor in force. The input is bold, with a tooltip, while the row has its
   own factor.
5. Footer over selected rows: total cost, revenue, profit, km3 — same figures
   the paste box produced.
6. Copy: one line per selected row, `name + '\t' + orderQty`, no trailing
   space after the name. Button shows "Copied" for a second.
7. Persist per route in localStorage: selected set, per-row factor, global
   factor, sort column, show-filtered. Always-show list stays in `export.js`.
8. Remove the mark textarea and its script; remove the duplicate moment.js
   tag.
9. The always-show and ignore-one-seller lists remain in `export.js`.
10. A cell turns dark red (`td.breach`) and its tooltip gains why when its
    displayed value is outside its column's min/max filter ("below the
    column's min 1.5", "above the column's max …"), or when `limitBreaches`
    names it: too much competition, beyond the N-day horizon. The colour marks
    the value, not the row's filtered state (filtered rows keep their
    dimming); the column helps say when a column goes red. A floored row's quantity tooltip says nothing was worth buying
    and the 1 unit is shown so the figures are real.
11. Saved run (Copy orders, `docs/trade-results-plan.md`): `recommended` is the
    factor-1 volume (`row.base.volume`), not the factored re-estimate's, and
    `recommendation` is the whole factor-1 estimate (`volume`, `floored`,
    `stopReason`, `horizonVolume` and the prediction fields), kept in case it
    is useful later. The row's own prediction fields are those of the copied
    quantity. `/api/runs` accepts a row without `recommendation` and saves it
    as `null`. The run's config carries the `MIN_ROI` the run used.
    (2026-11-25: each row also keeps its report's `OBSERVED_FIELDS`
    (`public/export-persist.js`) after the prediction fields:
    `observedFractionEvents`, `observedFractionVolume`, `avgDaysIdle`,
    `dailyDemandObserved`, `rivalsObserved`, numbers or null. `lib/runs.js`
    validates them like the prediction fields; a page from before they
    existed leaves them out and the run saves null.)
12. **Column filters carry the single-column limits.** The min/max filter
    under each numeric column is seeded once (flag `colFiltersSeeded`, so a
    bound the user clears stays cleared) with daily profit min 1, ROI min =
    the min ROI input's value, active days min 0.2 (only where the column has
    no min yet). A filter hides a row by its recommendation's figures (the
    factor-1 report), so a factor never makes a row vanish; the red cells
    (item 10) use the displayed figures. "show filtered" reveals the rows
    either the estimate or the column filters hide, dimmed, with their red
    cells visible; the name tooltip gives the estimate's reason, else the
    first column outside its range ("ROI below the column's min 1.5"). The
    totals line counts the rows only the column filters hide ("N hidden by
    column filters", "N outside column filters" while show filtered is on).
    A changed bound refreshes every row's dimming and red marks before the
    table re-renders (150 ms debounce). Selected and stocked rows ignore the
    filters; "clear" removes every bound, the seeded ones included.
13. **min ROI** Run input (left of Run, default 1.5, a number of at least 1,
    persisted): read when Run is pressed, like days to clear. It is the ROI
    floor of triage (skip an item whose Fuzzwork margin is below it), of the
    book walk (`MIN_ROI` in the estimate config, also for a factored
    re-estimate) and of the saved run's config, and the report header says
    which one the run used. The ROI column's min follows the input until the
    user sets their own (blank or another value stays as left). It can only
    tighten what a run produced, since a recommendation never buys below the
    floor.
14. **Avg days idle and the observed marks** (2026-11-25; the blend is
    Phase 2, item 14).
    - New column `avg days idle`, right after `days idle`: the observed mean
      days between price moves of the destination sellers priced within
      `SUPPLY_BAND` above the cheapest listing, over the observed part of the
      window. Shown like `days idle`, as "≥ n" when nobody moved in the
      observed time (`avgDaysIdleCensored`: a lower bound), blank without
      observation. It sorts and filters by the number. Its help says all of
      this; its tooltip says what the figure stands on ("2% observed (6
      samples)", the events coverage) or "no observation". It is observed only, so it carries no mark. `days idle`
      is unchanged and stays beside it.
    - `rivals` and `daily profit` cells get the class `observed` (a dotted
      underline, `td.observed` in `export.html`) when the fraction behind them
      is above 0: the events fraction for rivals, the volume fraction for daily
      profit (through demand). Their tooltips end with the observed share only:
      "40% observed" for rivals, "demand 40% observed" for daily profit (Rocky,
      2026-11-25: "make them more concise"; the figures behind the blend stay in
      the report and the saved run). A row without coverage has neither the
      mark nor the sentence. The mark is never the only carrier of
      the meaning: the column helps and the tooltips say it in words, and red
      (item 10) stays reserved for limits, so one cell can be both red and
      dotted.
    - The `days of supply left` tooltip gains "; stock trend +12/day" (the
      observed slope of the in-band sell volume) when there is one. Its value
      follows the blended demand.
15. **The stats fetch** (2026-11-25). `POST /api/market-stats` (`lib/api.js`,
    behind `requireConfigured`, so 503 while SSO is not set up; 1 MB body
    limit) takes `{regionId, stationId, windowDays, now?, types: [{typeId,
    ordersPerDay}]}`, 1 to 500 types, `windowDays` 1 to 60, and answers
    `{regionId, stationId, windowDays, now, types: {<typeId>: stats | null}}`,
    computed on each request from `data/ledger/market/<regionId>/<typeId>.json`
    (sell orders at that station only). A POST because each type carries its
    own `ordersPerDay`. A type answers null when it has no book log, when its
    entry is malformed, or when computing it fails; one bad type never fails
    the batch.
    The page makes one `createStatsFetcher` per run, for the end station, with
    `windowDays = min(60, max(days to clear, 3))`. Each report task asks
    `get(typeId, ordersPerDay)` once its history is in (`ordersPerDay` from
    `typicalOrdersPerDay`, Phase 2 item 15). Queued types go out as one request
    250 ms after the first is queued, or at 500 types; a type asked twice while
    queued shares one entry. After a failed request or any answer but 200 (the
    503 included) the fetcher answers null for everything queued and later,
    logs one line, and does not call the route again: observed figures are off
    for the rest of the run, and every row looks as it did before. A stopped
    run answers null quietly. `buildRow` passes the answer to the estimate and
    keeps it in the row's `inputs`, so a factor re-estimate uses the same
    observation without a request. A live refresh or a search lookup makes its
    own short-lived fetcher, so a route that was down is tried again. Report
    tasks hold a worker slot while they wait up to 250 ms for a batch, so
    batches hold about 40 types; ESI throughput stays the bottleneck.
    (Amended 2026-11-26: the logs are gzipped, `<typeId>.json.gz`, and read in
    either form. With the hourly destination book (M2, opt-in through
    `EFLIP_REGION_BOOK=1`) a type nobody trades has a log too, so the route
    answers null only for a type no snapshot has seen an order of. README,
    Syncing.)

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
