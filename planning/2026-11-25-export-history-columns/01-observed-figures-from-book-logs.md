# M1 — Observed figures from the existing book logs

Size: md, three phases (P1.1–P1.3), each sm. Dependencies: M0 merged (not strictly, but the
filter's removal simplifies the estimate tests). No further `sbs-plan` run needed: the phases below
are concrete. Review gate: end of P1.2 (a browser check with Rocky of the tooltips and the mark).

## Scope

Compute the observed figures of plan decision 3 from the book logs that already exist
(`data/ledger/market/<regionId>/<typeId>.json.gz`), serve them, blend them into the estimate per
decision 1, show "avg days idle", mark blended cells, save the observed figures with runs. Until
M2 runs, only types in play (listed, in transit, held, sold in 90 days) have coverage; the rest of
the page is unchanged by construction (`f = 0`).

Out of scope: fetching anything new from ESI (M2), the orders page, source-side history.

## P1.1 — `public/market-stats.js` and its tests (opus or a careful sonnet: semantics matter)

A UMD module like `estimate.js`, no DOM, no network. One export:

```js
// log: a book log {samples: [{at, stored}], orders: {<id>: {isBuy, locationId, path: [{at, price, volumeRemain, issued}], firstSeen, lastSeen}}}
// Returns the observed figures of plan decision 3 for sell orders at stationId, or null when the log has no samples.
computeMarketStats({ log, stationId, now, windowDays = 3, ordersPerDay = 1, supplyBand = 0.75 })
// -> { coverage: {windowDays, samples, medianGapHours, maxGapHours, from, to,
//                 events: {gapHours, coveredDays, fraction}, volume: {gapHours, coveredDays, fraction}},
//      repriceEvents, avgDaysIdle, censored, undercutsPerDay, fillsPerDay, vanishedUnitsPerDay, stockTrendPerDay }
```

Rules:
- Window: `to` = the newest `samples[].at` ≤ `now`, `from = to − windowDays`. Samples outside are
  ignored. Two acceptable gaps (plan decision 1): `events.gapHours = clamp(12 / ordersPerDay, 1/6,
  24)` (half the typical interval between orders, in hours) and `volume.gapHours = 24`. For each,
  consecutive samples closer than the gap form covered intervals; their union, clipped to the
  window, is `coveredDays`; `fraction = coveredDays / windowDays`; a lone sample covers nothing.
  Counted events (re-prices, undercuts) use `events`; cumulative quantities (fills, vanished,
  stock trend) use `volume`. Every "per covered day" below divides by the matching `coveredDays`.
- State per sample: replay `path` entries in `at` order to know each station sell order's price and
  volumeRemain at every sample time (an order is present from `firstSeen` to `lastSeen`). `stored:
  false` samples confirm presence without change.
- In band at a sample: `price ≤ bestSellPrice(sample) × (1 + supplyBand)`, best over station sell
  orders present.
- `repriceEvents`: path entries after an order's first, inside events-covered time, whose `price`
  differs from the previous entry, for orders in band at that sample. `avgDaysIdle =
  events.coveredDays / repriceEvents`; with zero events `avgDaysIdle = events.coveredDays` and
  `censored = true`.
- `undercutsPerDay`: events (a re-price, or a new order's first entry) whose price is below the best
  station sell price of the previous sample, divided by `coveredDays`.
- `fillsPerDay`: for each covered pair of consecutive samples, the sum over orders present in both of
  `max(0, prev.volumeRemain − next.volumeRemain)`, divided by `coveredDays`. `vanishedUnitsPerDay`:
  the `volumeRemain` of orders present in the earlier sample and absent in the later, divided the
  same way.
- `stockTrendPerDay`: least-squares slope (units per day) of the in-band sell volume across covered
  samples; null with fewer than three samples.
- Every division by `coveredDays` is null when `coveredDays = 0`; the whole result's `fraction` is 0
  then.

Tests (`test/market-stats.test.js`): build logs by hand with `foldBook` from `lib/derive.js` or
literal objects. Cases: no samples → null; one sample → fractions 0, all rates null; hourly samples
over 5 days with one order re-pricing every 12 h and `ordersPerDay = 4` (events gap 3 h) →
`avgDaysIdle ≈ 0.5`, `undercutsPerDay` for the undercutting ones; the same log with `ordersPerDay
= 48` (events gap 15 min) → events fraction 0 but volume fraction unchanged, so fills still count
while re-prices do not; a gap of 10 h in the middle shrinks the events coverage but not the volume
coverage, and nothing in the gap counts;
fills from a persisting order's drops vs a vanished order; `censored` when nothing re-prices;
`stockTrendPerDay` sign; `windowDays` clipping; buy orders and other stations ignored.

## P1.2 — route, page wiring, estimate blend, columns, saved runs (sonnet, after P1.1)

- `lib/api.js`: `POST /api/market-stats` with body `{regionId, stationId, windowDays, now?, types:
  [{typeId, ordersPerDay}]}` (≤ 500 types, `windowDays` 1–60, `ordersPerDay` ≥ 0) behind
  `requireConfigured` and the JSON body limit; for each type with a book log (`ledger.hasBookLog`)
  answers `computeMarketStats(...)`, else `null`, keyed by type id. A POST because each type
  carries its own pace. Tested in `test/sync-api.test.js` style with a temp data dir holding one
  fabricated log.
- `public/estimate.js`: a new pure helper `typicalOrdersPerDay(destDays, now, config)` (the
  recency-weighted mean of `order_count` over DAYS_CONSIDERED with the demand weights, floor 1,
  exported and tested) so the page can send each type's pace. `computeItemReport` takes `observed =
  null`. With `observed`: `fV = observed.coverage.volume.fraction`, `fE =
  observed.coverage.events.fraction`; `dailyDemand = fV × fillsPerDay + (1 − fV) × dailyDemandModel`
  (null `fillsPerDay` → the model alone); after the walk, `rivals = fE × (undercutsPerDay ×
  max(daysToClearRaw, 1)) + (1 − fE) × rivalsModel` (and the
  competing-volume weighting keeps using the model's per-order `rivalWeight`: it is per order, the
  observed rate is per type). Report gains `observedFractionEvents`, `observedFractionVolume`, `dailyDemandModel`,
  `dailyDemandObserved`, `rivalsModel`, `rivalsObserved`, `avgDaysIdle`, `avgDaysIdleCensored`,
  `stockTrendPerDay`, `observedCoverage` (the coverage object). Without `observed` every existing
  number is unchanged: the regression fixture test must pass untouched except for the new keys.
  Tests: f = 0 identity; f = 1 takes the observed; f = 0.5 is the midpoint; censored passes through.
- `public/export.js`: after `loadBooks` resolves (and before reports are built; `booksPromise` is
  where to chain), fetch `/api/market-stats` for all triaged + always-show ids in batches of 500
  for the end station, `windowDays = max(runDaysToComplete, 3)`, each type with its
  `ordersPerDay` from `estimate.typicalOrdersPerDay(destDays)` (so the history must be fetched before
  the stats call: fetch stats per report task after `getDays`, batched through a small coalescing
  queue that flushes every 250 ms or at 500 ids); a failure or a 503 (not configured) leaves
  `observed` empty and logs one line. `buildRow` takes `observed` and passes it
  to the estimate and into `inputs`; the search lookup and always-show refresh fetch one id. New
  column `avg days idle` after `days idle` (val `report.avgDaysIdle`, fmt like days idle but "≥ n"
  when censored; help: "mean days between price moves of in-band destination sellers over the last
  W days of observation; blank without observation, ≥ when none moved"). `rivals` and
  `dailyProfitMil` (through demand) cells get class `observed` when the matching fraction is above 0, with the
  tooltip suffix "observed f=0.62 (events gap 3 h): 1.9 observed · 2.4 model"; `daysOfSupply` tooltip gains "stock
  trend +12/day". Style `td.observed { text-decoration: underline dotted; text-underline-offset:
  2px; }`.
- `public/export-persist.js`, `lib/runs.js`, `test/runs.test.js`: the saved row gains
  `observedFractionEvents`, `observedFractionVolume`, `avgDaysIdle`, `dailyDemandObserved`, `rivalsObserved` (numbers or null),
  validated like the other prediction fields.
- Review gate: show Rocky a covered row (a listed type) and an uncovered one in the browser;
  questions: is the dotted mark enough, is the window right, are the tooltip words right.

## P1.3 — docs and cleanup (haiku: mechanical)

`docs/export-improvements-plan.md` (report shape, columns, the route, the blend rule, filters),
`README.md` (the new column and route), `docs/ui-decisions/` (two files: "avg days idle beside days
idle", "blended cells marked with a dotted underline"). Grep for TODOs, debug prints, scratch files,
stale mentions of the removed filter. Gates green.

Sub-agent reminders (every phase): do not commit; do not expand scope; do not suppress warnings or
disable tests; stop and report if blocked by ambiguity; report what changed, what was validated
and any deviation.

## Definition of done

All three phases merged on `feature/export-rework` with green gates; a listed type shows avg days
idle and blended figures with marks and tooltips; an unwatched type is unchanged; the saved run
carries the observed fields; docs and rulings updated.
