# Export page: history-backed columns — discovery notes

Repo `eflip`, plan folder `planning/2026-11-25-export-history-columns/` (moved here from the Skybridge workspace on 2026-11-25: that workspace is work, this project is personal). Branch `claude/days-to-clear-calculation-49d77d` (fast-forwarded onto
`feature/export-rework` after each green gate). Planning started 2026-11-25.

## Initial understanding and goals

Rocky's ask (2026-11-25): "we should be thinking of 'average days idle' instead of 'days idle' now
that we have historical data stored. Maybe other columns could benefit from access to history too?"
Then: "Rivals can be calibrated against the observed undercut rate ... I'd say we still need
recency-times-proximity as a fallback since only some periods of time will be observed. Basically
the same issue with Demand (needs fallback when history isn't available). Go ahead with
design/planning."

So: every history-backed figure on the export page has an observed form and keeps today's model as
its fallback, because observed history covers only some types and some windows. The row must say
which it is showing.

## Current state

- `public/estimate.js` (pure): rivals = recency (0.75^idle days) × proximity (within SUPPLY_BAND,
  else 1/multiple²) summed over destination sell orders; demand = recency-weighted sell-side volume
  from the regional daily history (high-fraction split per day, profitable days only); days idle =
  hours since the newest destination sell order's `issued` / 24 (instantaneous; the in-band variant
  feeds the 'seller updated too recently' filter); competing volume and days of supply from the
  current book. New this week: stop reasons, factor re-estimate (`targetVolume`), 1-unit floor,
  column filters hold the single-column limits, min ROI is a Run input.
- Order monitor (merged into `feature/export-rework` at 2d3e6a8/300f653, 2026-11-25): a **book log**
  per (region, type) at `data/ledger/market/<regionId>/<typeId>.json` = `{samples: [{at, stored}],
  orders: {<orderId>: {isBuy, locationId, systemId, volumeTotal, duration, minVolume, range,
  firstSeen, lastSeen, path: [{at, price, volumeRemain, issued}]}}}`, folded from raw per-type books
  (`lib/derive.js foldBook`): a path entry whenever price, volumeRemain or issued changed. Samples:
  every five minutes for listed types while `orders.html` is open (watch refresh); hourly for the
  ≤300 types in play (listed, in transit, held, sold in 90 days; `lib/sync.js marketTypes`); hourly
  public samples exist since 2026-11-20. Served by `GET /api/market?typeIds=&regionIds=&log=1`
  (`lib/sync.js readMarket`), capped at 500 type ids per call.
- Order-monitor decisions that matter here: 13 "an order's quantity never rises, so a drop in
  `volume_remain` is always a fill"; still open 1 "whether a competing order's `issued` moves on
  anything but a price change" (days idle leans on `issued`); backlog "station-level sell-side share
  from book differences ... a range that narrows with five-minute samples".
- Regional books: an export Run downloads both regions' complete order books through the browser's
  `/file` cache (overwritten each run, 0.5 h stale). The server stores no regional pages. So the
  book log covers types in play only; the export table's thousands of candidates have no series.
- Data volumes on this machine after a week: `data/raw` 64 MB, `data` 75 MB, browser cache 662 MB.
- Rocky's day-to-day server runs on another computer from `feature/export-rework` (order-monitor
  decision 11): the history that matters accrues there, with its own `EFLIP_DATA_DIR`.
- ESI: the `market-order` bucket is 12,000 tokens per 15 min per IP, 2 per 2xx; regional order
  pages have no group of their own (memory `esi-rate-limits`). Page counts measured below.

## Files inspected

`public/estimate.js`, `public/export.js`, `lib/sync.js` (marketTypes, doSyncMarket, readMarket),
`lib/derive.js` (foldBook, createBookReader), `lib/ledger.js` (book log files), `lib/api.js`
(`/api/market`), `docs/order-monitor-plan.md` (data model, rules 3–5, out of scope, decisions 11
and 13, still open), `docs/trade-results-plan.md` (market snapshot, budget, server-side market
note), `docs/export-improvements-plan.md`, `docs/ui-decisions/`.

## Documentation surfaces likely to change

`docs/export-improvements-plan.md` (estimate inputs, columns, report shape), `README.md` (export
page section, data directory), `docs/order-monitor-plan.md` (cross-reference: the book-difference
fills backlog item becomes this plan's), `docs/ui-decisions/` (column rulings).

## Design sketch (to be confirmed by the questions below)

Observed inputs per (region, station, type) from the book log, over a window W (default 14 days):
- `repriceIntervalDays`: median gap between consecutive price changes among sell orders at the
  station that were within SUPPLY_BAND of the best sell price at the time; also `repricesPerDay`.
- `undercutsPerDay`: price changes or new orders that set a new lowest price at the station.
- `fillsPerDay`: summed `volumeRemain` drops of persisting sell orders at the station (decision
  13); vanished orders are reported separately as `vanishedUnitsPerDay` (fill or withdrawal unknown).
- `stockTrendPerDay`: slope of in-band sell volume over W.
- `coverage`: `{firstAt, lastAt, samples, coveredDays, maxGapHours}`.
Blend rule, per figure: `w = min(1, coveredDays / FULL_DAYS)`, reduced when `maxGapHours` is large;
`shown = w × observed + (1 − w) × model`; the tooltip states observed, model, w, samples. Below a
minimum (say 2 samples or 1 day) the model shows alone and the cell carries no "observed" mark.
Where: a pure, tested module (`public/market-stats.js`, UMD like `estimate.js`) run on the server
behind `GET /api/market-stats?regionId=&stationId=&typeIds=`; the page passes the answer into the
estimate as `observed`. The estimate keeps its models and does the blend, so it stays testable.
Coverage extension (the big question): (A) the page posts a per-run digest of the destination
station's book (every type, cheapest N orders) to the server, giving a series at run cadence; (B)
an hourly server job snapshots the destination region's book (page count below), fed through the
same fold into book logs for every type; (C) neither: observed figures only for types in play.

## Questions

See the chat message of 2026-11-25 (batched, with suggested answers). Answers get recorded here.

## Future work

- Competitor profiles across items (order-monitor backlog); per-order price sparkline.
- Realized own figures per export row ("sold before": units, margin, days on market) from the
  ledger; a per-type sell-price correction from calibration (Phase 8 data).

## Measurements (2026-11-25, ESI live and this machine)

- Domain (10000043) all orders: 194 pages × 1,000 orders, page 1 is 238 KB (~46 MB per full
  snapshot), so a snapshot costs 388 `market-order` tokens (3.2 % of the 15-minute budget) and an
  hourly job 9,300 tokens a day. Of page 1's 1,000 orders, 557 were sell orders at the Amarr station
  (60008494): the station holds most of the region's sell book.
- The Forge (10000002) all orders: 419 pages. Not needed for history (we buy there; seller activity
  at the source is not a column).
- Book logs here: 358 Domain types, 5.6 MB total, 10 hourly public sync logs over six days (a sample
  log: 4 samples, 68 orders, 91 path entries). Cadence on this machine is sparse; Rocky's other
  computer runs the real hourly sync and the five-minute watch.
- Storage estimate for a region-wide fold (unmeasured change rate): ~100k station sell orders, at
  10–20 % changing per hour, ~15k path entries an hour at ~80 bytes = ~1.2 MB an hour, ~30 MB a day
  before pruning. Raw pages at 46 MB an hour cannot be kept beyond a short window. The first phase
  of any region-wide job should measure the real rate for a day before retention is fixed.
- Re-price intervals do not need regular sampling: each path entry carries the order's `issued`, so
  the gap between re-prices is read from the orders themselves as long as samples are frequent
  enough not to skip an intermediate price. Fills (volumeRemain drops) do depend on cadence.

## Answers (Rocky, 2026-11-25)

- Blend: "I was imagining more of a blend where history is preferred but where history has blank
  spots we fall back to the old method (prorated)." Taken as the rule: over the window, the share
  of time covered by observations uses the observed figure, the uncovered share uses today's
  model. A lone sample covers no time, so it carries no weight (this is why no "2 samples" minimum
  is needed; Q5's wording was the agent's, now dropped).
- Planning location: not `~/dev/skybridge` ("that's work stuff whereas eflip is my personal
  project"); a local planning folder under `~/dev/eflip/`. Done: `planning/` in the repo, tracked.
- Q1: B, the hourly server job, "provided it's not too big of a lift / hard to do".
- Q2: blend, as suggested.
- Q3: keep "days idle" and add an "avg days idle" column. Remove the "seller updated too recently"
  filter, which depends on the non-averaged figure. Reasons: more accurate data, and "the annoyance
  that best pick items fluctuate more than necessary (people keep updating their order which means
  'seller updated too recently', then some time goes by and it goes back on the list ...) and I'd
  like a more steady picture of the export opportunities (averaged over at least a day or maybe
  averaged over the 'days to clear' entered?)".
- Q4, Q6, Q7, Q9: as suggested. Q5: as suggested minus the sample minimum (see Blend).
- Q8: remove that filter (see Q3).
- Q10: yes, except not in Skybridge: the plan lives in `planning/`, settled decisions go into
  `docs/export-improvements-plan.md` as they land.

## Rough edges raised by the blend (agent, 2026-11-25; resolutions proposed in plan.md)

1. Covered time needs a definition: the union of intervals between consecutive samples closer than a
   gap threshold (2 h for hourly sampling; the five-minute watch is denser). Longer gaps are blank
   spots the model fills.
2. Re-prices inside a gap are undercounted: between two samples only an order's latest `issued` is
   seen, so a seller who moved three times shows once. Hourly samples therefore bias "avg days idle"
   upward for very active sellers. Stated in the tooltip with the median sample gap.
3. "Avg days idle" has no prorated fallback: the instantaneous "days idle" is a different quantity
   (time since the last move, censored), so the new column shows the observed mean only, blank when
   nothing is covered, and "≥ N" when the covered time holds no re-price at all (censored).
4. Rivals and demand do blend, because each has a model and an observed figure in the same unit:
   rivals (expected undercutters during the listing) = observed undercuts per day × days to clear;
   demand (units per day) = fills per day from persisting orders' volume drops (decision 13 of the
   order monitor). Vanished orders are filled-or-withdrawn: reported beside, not counted.
5. Window: Rocky suggested at least a day, or the days-to-clear horizon. Proposed: the horizon,
   floored at 3 days, because a one-day window of hourly samples holds too few re-prices to average.
6. Until M2 has run for a while, candidate types have no coverage and the page looks exactly as
   today; only types in play (listed, held, sold) change. M2 is the enabler.
7. Removing the "seller updated too recently" filter means nothing stops a listing right after an
   active seller moved; "days idle" stays visible for that, and blended rivals carries sustained
   activity into the "too much competition" filter.
8. M2 touches `lib/sync.js`, `lib/derive.js`, `lib/ledger.js`, which the order-monitor session is
   still changing (its Phases 3–4): sequence M2 after that work lands, or coordinate the files.

## Answers (Rocky, 2026-11-25, second round)

- Covered time: "yes except rather than a fixed 2 hours it should depend on how many orders there
  usually are in a day". Interpreted as the item's typical order activity per day, taken from the
  ESI daily history's `order_count` (recency-weighted like demand; region-wide, so conservative),
  which every row already has. Events (re-prices, undercuts) accept a gap of half the typical
  interval between orders, clamped to 10 min–24 h; cumulative quantities (fills, stock trend)
  accept 24 h. Plan decision 1 and M1's P1.1/P1.2 amended; the stats route became a POST so each
  type carries its pace. If "orders in a day" meant book depth instead, say so: the swap is one
  input.
- "go ahead when ready": M0 started 2026-11-25; M1 follows, stopping at P1.2's review gate.

## P1.1 interpretations (agent, 2026-11-25; accepted at review)

- The acceptable gap is inclusive: two samples at most the gap apart cover the time between them.
- An event belongs to the pair of window samples it falls between, (previous, this], and counts
  only when that pair is covered; so nothing first seen at the end of a long gap counts.
- A `stored: false` sample (a 304) stands for the newest stored sample before it: an order is
  present there when that stored time lies within firstSeen..lastSeen. The literal rule would mark
  every order vanished at a 304 after its last stored check.
- Only pairs with both samples inside the window count; the pair straddling the window start is
  ignored, so a window that starts before the log's first sample has a fraction below 1.
- A new order on an empty book is not an undercut; an order already best that lowers its price is.
- With events coverage 0: `avgDaysIdle` null and `censored` false. Covered but nothing undercut:
  `undercutsPerDay` 0. Bad inputs throw, so the route validates and catches per type.
- Real logs on the dev machine are sampled about daily, so events coverage is mostly 0 at a pace of
  2 orders a day; volume coverage is small but present. Expected until M2.
