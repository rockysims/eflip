---
kind: plan
size: lg
depth: roadmap
status: active
repo: eflip
created: 2026-11-25
adr: none
---

# Export page: history-backed columns

Size `lg`: four milestones. M0 and M3 are one-shot; M1 and M2 are phased and each could run as its
own `sbs-implement`. No ADR: this repo records lasting decisions in `docs/*-plan.md` and
`docs/ui-decisions/`, and this plan adds to both.

## Goal

The export page's figures that describe other sellers and demand use what the book logs have
observed, and fall back to today's models where nothing was observed, prorated by covered time.
The list of opportunities gets steadier (Rocky: "a more steady picture of the export
opportunities") and more accurate for the items we trade, without a blank or a surprise for the
items we have never watched.

Acceptance:
- A row whose type has book-log coverage shows "avg days idle" (observed mean days between
  re-prices of in-band sellers) and blended rivals and demand, with the covered fraction, the
  observed and the model figures in the tooltips, and a visible mark on blended cells.
- A row with no coverage looks exactly as today.
- The "seller updated too recently" filter is gone; the "days idle" column stays.
- After M2 has run for a few days on Rocky's machine, candidate types (not only listed or held
  ones) have coverage, within the ESI budget and the storage rules below.
- Every figure stays traceable: the estimate and the stats module are pure and tested.

## Scope

In: `public/estimate.js`, `public/export.js`, `public/export.html`, a new `public/market-stats.js`,
`lib/api.js` (one route), and for M2 `lib/sync.js`, `lib/derive.js`, `lib/ledger.js`,
`scripts/sync.js`; tests beside each; `docs/export-improvements-plan.md`, `docs/ui-decisions/`,
`README.md`.

Out: the orders page and its verdicts (order monitor plan), competitor profiles, structure markets,
source-side (Jita) history, notifications, anything in `index.*`, `jack.js`, `missing.*`,
`resell.*`, `reprocess.js`.

## Discovery

See [notes.md](notes.md): data sources, measurements (Domain book 194 pages, 388 tokens, ~46 MB
raw; 358 book logs on this machine), Rocky's answers and the rough edges.

## Decisions

1. **Blend, prorated by covered time.** For a figure with an observed form `o` and a model `m`
   over the window `W`: `shown = f·o + (1 − f)·m`, where `f` = covered time inside `W` ÷ `W`.
   Covered time is the union of the intervals between consecutive book-log samples that are
   closer than the item's **acceptable gap**, clipped to `W`. A lone sample covers no time. `f = 0`
   gives exactly today's figure. (Rocky: "history is preferred but where history has blank spots
   we fall back to the old method (prorated)".)
   The acceptable gap depends on the item's pace, not a fixed two hours (Rocky, 2026-11-25:
   "it should depend on how many orders there usually are in a day"). `ordersPerDay` is the
   recency-weighted mean of the destination region's daily history `order_count` over the demand
   window (the same weights as demand; floor 1), which every row has, book log or not. Two
   coverage fractions:
   - `fEvents` for counted events (re-prices, undercuts): gap ≤ `clamp(0.5 / ordersPerDay days,
     10 min, 24 h)`, half the typical interval between orders, so a covered gap is unlikely to hide
     two moves of one order. A busy item sampled hourly is then mostly uncovered until the
     five-minute watch or M2's denser sampling reaches it; a slow item is covered by hourly samples.
   - `fVolume` for cumulative quantities (fills, stock trend): gap ≤ 24 h, because volume drops
     add up across a gap and only vanished orders are lost.
   `order_count` is region-wide, so it overstates the station's pace and shortens the gap: the
   conservative side (more model).
2. **Window.** `W = max(run days to clear, 3)` days, ending at the newest sample at or before
   `now`. The three-day floor keeps a one-day horizon from averaging over a handful of re-prices;
   Rocky asked for "at least a day or maybe the days to clear", so this is his to shorten.
3. **Observed figures**, per destination station and type, from the book log's sell orders at that
   station (`public/market-stats.js`, pure):
   - `repriceEvents`: path entries after an order's first whose `price` changed, while the order
     was in band (price ≤ best station sell price at that sample × (1 + SUPPLY_BAND)). Detected by
     price, not by `issued` (Q4).
   - `avgDaysIdle` = covered days ÷ `repriceEvents`; when there are none, `≥ covered days`
     (`censored: true`). Observed only; no model fallback (notes, rough edge 3).
   - `undercutsPerDay`: re-price events or new orders that set a new lowest station sell price,
     per covered day.
   - `fillsPerDay`: summed `volumeRemain` drops of orders present in both of two consecutive
     samples, per covered day (order-monitor decision 13: a drop is a fill). `vanishedUnitsPerDay`
     beside it, not counted (fill or withdrawal unknown).
   - `stockTrendPerDay`: least-squares slope of in-band sell volume over the covered samples.
   - `coverage: {windowDays, coveredDays, fraction, samples, medianGapHours, maxGapHours, from, to}`.
4. **Columns.** New `avg days idle` (observed only; blank without coverage; "≥ n" when censored;
   sorts by the number). `rivals` blends the model with `undercutsPerDay × max(daysToClear, 1)`.
   `dailyDemand` blends the history model with `fillsPerDay`, and everything downstream follows:
   the demand cap, days to clear, daily profit, the "too much competition" filter. `days of supply
   left` keeps its value and gains the stock trend in its tooltip. `days idle` is unchanged.
5. **Filter removed.** `applyFilters` and `limitBreaches` drop "seller updated too recently";
   `daysSinceInBandSellerUpdate` stays in the report for the "days idle" tooltip. (Q3, Q8.)
6. **Where computed.** `public/market-stats.js` (UMD like `estimate.js`, `node:test` beside it)
   runs on the server behind `POST /api/market-stats` (body `{regionId, stationId, windowDays, now?, types:
   [{typeId, ordersPerDay}]}`; a POST because each type carries its own pace)
   (≤ 500 ids a call, computed on request from the book logs; revisit caching when M2 multiplies
   the logs). The page fetches it in batches once the books are loaded, passes each type's answer
   to the estimate as `observed`, keeps it in the row's `inputs` for re-estimates, and saves
   `observedFraction` plus the observed figures with each run row.
7. **Marking.** A blended or observed cell gets class `observed` (dotted underline) and a tooltip
   "observed f=0.62 · observed 1.9/day · model 2.4/day" in that column's words. Never colour alone
   (`docs/ui-decisions/README.md`, a11y rule).
8. **M2 storage.** Hourly, the destination region's sell-order pages (`order_type=sell`, fewer than
   the 194 all-order pages) are stored raw and folded per type into the existing book logs, one
   sample per type per snapshot. Raw regional pages are kept 48 hours; the rebuild-from-raw
   invariant holds inside that window and the folded logs are the durable record. Path entries
   older than 90 days are pruned per type, after the measurement phase confirms the growth rate.
9. **M2 budget and manners.** At most ~400 `market-order` tokens a snapshot; the job defers while
   an export run is going (as the market sync does) and pauses under 20 % remaining.
10. **Coordination.** M2 changes files the order-monitor session is still changing; it starts
    after that session's Phases 3–4 land on `feature/export-rework`, or is handed to that session.

## Files and docs expected to change

Code: `public/estimate.js`, `public/export.js`, `public/export.html`, `public/market-stats.js`
(new), `public/export-persist.js`, `lib/api.js`, `lib/runs.js`; M2: `lib/sync.js`,
`lib/derive.js`, `lib/ledger.js`, `scripts/sync.js`. Tests: `test/estimate.test.js`,
`test/market-stats.test.js` (new), `test/runs.test.js`, `test/sync*.test.js`, `test/derive.test.js`.
Docs: `docs/export-improvements-plan.md` (filters, report shape, columns, the stats route),
`docs/ui-decisions/` (one file per ruling: no seller filter; avg days idle beside days idle;
blended cells marked), `README.md` (export page figures, the hourly destination job and its data).

## Conventions (so implementers need not rediscover them)

Vanilla HTML/JS, no framework or build step; page styles in the page's `<style>`; tabs; pure
modules are UMD and tested with `node --test test/*.test.js` (not `node --test test/`); every ESI
answer is stored raw first and derived data is rebuildable; no generic ESI proxy; dense 13 px
tables; terms get defined where first shown (tooltips and column helps); sub-agents never commit;
`feature/export-rework` is fast-forwarded after each green gate; the day-to-day server is another
computer on that branch.

## Validation

`node --test test/*.test.js` green; `node --check` on changed files; a browser smoke of
`export.html` through a search lookup for a covered type and an uncovered one; for M2, 24 hours of
the job on Rocky's machine with bytes and tokens per snapshot recorded in `notes.md`.

## Milestones

| Milestone | Size | Summary | Why this size | Needs own planning? | Notes |
|---|---|---|---|---|---|
| M0 | sm | Remove the "seller updated too recently" filter | One rule, its tests and docs | No | Can run now; independent of the rest |
| M1 | md | Observed figures from the existing book logs: stats module, route, estimate blend, columns, saved-run fields | Three bounded phases | No, phases are in its file | Covers types in play until M2 |
| M2 | md | Hourly destination-book series folded into book logs, with raw retention and pruning | Server job, storage rule, measurement | A short check after the 24 h measurement | After the order-monitor phases land |
| M3 | sm | "Sold before" column from the ledger | One route and one column | No | Any time after M1 |

Files: [00-remove-seller-updated-filter.md](00-remove-seller-updated-filter.md),
[01-observed-figures-from-book-logs.md](01-observed-figures-from-book-logs.md),
[02-destination-book-series.md](02-destination-book-series.md),
[03-sold-before-column.md](03-sold-before-column.md).
