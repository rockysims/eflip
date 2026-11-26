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

## P1.2 interpretations (agent, 2026-11-25; accepted at review) and the browser check

- A column may define `display(row)` for its cell text ("≥ 1.5" when censored); `text` was already
  the name column's alignment flag.
- `windowDays = min(60, max(days to clear, 3))`: the route rejects more than 60.
- Saved runs: an absent observed field saves as null (an older page); a present one must be a
  number or null.
- Coverage fractions are clamped to [0, 1]; a malformed observation counts as none.
- `/api/market-stats`: an entry without a positive-integer typeId has no key and is left out; a type
  named twice is answered once; `now` is echoed normalised; the ledger is reached as `sync.ledger`.
- The avg-days-idle help says "within 75 % above the cheapest listing": the stats measure the band
  from the cheapest station sell order, the estimate from its own sell price.
- After Stop, a report task checks the abort signal again after `buildRow` (stats answer null then).
- Report tasks hold one of the 40 slots while waiting up to 250 ms for a stats batch, so batches are
  about 40 types; ESI throughput stays the bottleneck.
- Live refresh and search lookups use a short-lived fetcher each, with `runDaysToComplete`.
- Browser check (scratch data dir holding only the 358 book logs, placeholder SSO settings, port
  5003): Standup Radar ECM Script (37824), 5-day window: POST /api/market-stats 200; avg days idle
  "≥ 0.12" with "observed 0.12 of 5 days (events gap 12 h, 6 samples, median gap 2.85 h)"; daily
  profit marked, "demand observed f=0.40 (volume gap 24 h): 2.01/day observed · 0.51/day model",
  and the days-of-supply tooltip shows the blended 1.11/day and "stock trend +23.3/day"; rivals
  marked, "observed f=0.02 (events gap 12 h): 0 observed · 1.21 model" → 1.18. Mark I Compact
  Reactor Control Unit (8263, no log): no marks, "no observation", every figure as before.

## Answers at the M1 review gate (Rocky, 2026-11-25)

1. Dotted underline as the mark: "agreed".
2. Window max(days to clear, 3), capped at 60: "sounds good".
3. Tooltips: "could be more concise. lets show 20% observed instead of '2/day observed · 0.50/day
   model' and just remove the volume gap part. basically make them more concise". Done the same
   day: rivals "40% observed", daily profit "demand 40% observed", avg days idle "2% observed (6
   samples)"; the figures behind the blend stay in the report and the saved run.
4. M2: "start when ready (not sure I understand about 'retention')". Retention = how long the raw
   hourly pages stay on disk before deletion (about 46 MB an hour, so not forever) and how far back
   each type's folded log keeps its history; the 24-hour measurement sets both from real growth.
   Two amendments made when briefing P2.1: fetch all orders (not sell-only) so buy orders never look
   vanished in the shared logs; measure against a 24-hour raw window rather than 48.

## Storage budget with shares (Rocky, 2026-11-25) and its rough edges

Rocky: "perhaps we should assign things shares in a total amount of space allotted so for example I
could allocate 1GB and then it would save history until 1GB then trim old data ... the 1GB can be
shared among all the data we want to save while allowing different things to have different
percentages of the allotted storage space." Written into M2 P2.2 and plan decision 8.

Measured here (a week, two characters): raw/public 63 MB (358 per-type books, 339 histories),
ledger/market 5.6 MB, character raw about 2 MB, esi-cache 2.9 MB. gzip: a book log 24,193 → 2,297
bytes (10.5x), a raw page 11,251 → 1,868 (6x).

Rough edges:
1. Replaceable vs irreplaceable: regional pages, per-type raw books and the logs can be refetched or
   regrow; character wallet/order raw cannot (ESI keeps only recent history). Only the first group
   is budgeted.
2. Trimming a log is a real loss: the raw behind it is gone first, so the oldest history past the
   budget cannot be rebuilt. That is the budget's purpose; the README says so.
3. Strict shares waste room (a quiet kind leaves its share empty); soft shares (enforce the total,
   trim the kind furthest over its share) use it. Proposed: soft.
4. Floors keep the system working under any budget: the newest snapshot, the newest file per slug,
   the last 3 days of every log (M1's window floor), the newest run context.
5. Book-log trimming must hold the market lock (the watch refresh appends every five minutes).
6. Gzip touches every reader of raw pages and logs; both forms must read, so nothing migrates.
7. Sizes are file bytes, not disk blocks; close enough. A lowered budget trims at the next run.
8. Without the budget set, the region job would grow unbounded: the env notice must say so.

## P2.1 as built (agent, 2026-11-25; accepted at review)

- `doSyncRegionBook` under the market lock; `order_type=all`, page 1's X-Pages (cap 400), raw slugs
  `markets-<region>-orders-order-type-all[-page-n]`; folds only a complete snapshot, one stored
  sample per type present (all stations, buy and sell), an empty stored sample for a type with a
  log but no orders; a type with per-type raw but no log is built first (`ensureBookLog`); yields to
  the event loop every 100 types. Statuses ok | partial | busy | deferred | paused | skipped |
  failed. An unforced run skips within 55 minutes of the last fold. State in
  `esi-cache/public/_region-book.json`; measurement as a `kind: 'regionBook'` public sync-log
  entry with `pageStamps` (the raw page files of the snapshot) for P2.2's replay and trimming.
- `updateBookLog` reads per-type raw, so `updateBookLogWithRows` folds given rows (byte-equal to
  foldBook + writeBookLog, tested). `readMarket` skips regionBook entries when choosing regions.
- Scale check: 194 pages, 193,500 orders, 12,000 types fold in about 3 s, ~450 MB RSS; the first
  fold made 63 MB of plain-JSON logs; a later hour grew them ~1 MB at 2.5 % of orders re-priced
  (so ~25 MB a day plain, ~2.5 MB gzipped: the budget defaults can be generous to the logs).
- Rebuild hazard until P2.2: `scripts/sync.js --rebuild` rebuilds a type's log from per-type raw
  only, so regional samples are lost for types that also have per-type raw (raw is kept, so
  recoverable once the replay exists). README warns not to run `--rebuild` while the job is on.
  P2.2 TODO: "`rebuildBookLogs` must learn to replay regional snapshots (the regionBook entries'
  `pageStamps` group the raw pages per snapshot) in time order with the per-type checks."
- Gzip in P2.2 must update `rawFileBytes`, `ledger.bookLogBytes`, `ledger.listBookLogs` (they
  assume `.json`).
- `EFLIP_REGION_BOOK=1` makes a full sync take the region book too, but nothing schedules hourly
  runs; the 24-hour measurement runs as a shell loop of `node scripts/sync.js --region-book`.

## Answers on the storage budget (Rocky, 2026-11-26)

- Q1–Q6: "all suggested" (soft shares; character data outside; 1 GB with regionPages 40 / bookLogs
  45 / typeBooks 10 / runContexts 5; gzip; the floors; `.env`).
- Measurement: "I don't think I can do 24 hours straight. Maybe 8 hours (while I sleep)?" Agreed:
  raw size and tokens per snapshot are fixed; seven hourly deltas give the log growth rate; a night
  window understates daytime activity, which with a size-based budget only shortens how far back
  history reaches. P2.2 starts without waiting for it; the report tunes the defaults afterwards.

## P2.2 as built (agents, 2026-11-26; accepted at review)

- Gzip: raw records of owner `public` with slug `markets-…` and every book log are `.json.gz`;
  readers take both forms; a plain log is replaced on its next write. 10.7x on 12,000 logs.
- `lib/storage-budget.js` plans; `lib/storage.js` measures and applies, under the market lock, at
  the end of a regional snapshot and of a full sync's market step when `EFLIP_STORAGE_BUDGET` is
  set; a `kind: 'storage'` public sync-log entry records each run; `_storage.json` keeps the last
  trim; `/api/config.storage` (usage cached 60 s, `measuredAt`); `scripts/sync.js --storage` and
  `--storage-report`; `public/storage-notice.js` gives the pages' sentences ("Storage 62 % of 1 GB";
  the no-budget nag when the hourly book is on; the over-budget line when only floors remain).
- Book-log trim rule: samples before the cutoff go; an order last seen before the cutoff goes whole;
  an order still listed keeps the newest entry before the cutoff (its state at the cutoff, so a
  re-price just after still reads as a re-price). Bucket bytes are dated by when a cutoff frees them,
  scaled to compressed size on disk; `unmet` is the real overage when only floors remain.
- typeBooks trims by a day cutoff across all per-type slugs, keeping each route's newest file and
  its newest file before the cutoff, so any later check still finds every page it read; the one
  exception is the last check before the cutoff on a multi-page book.
- regionPages trims whole snapshots; a 304 page's file belongs to the newest entry naming it; the
  newest file of each regional page route is never deleted.
- Rebuild: `--rebuild` leaves the book logs alone and says how far raw reaches; `--rebuild-book-logs`
  replays per-type checks and regional snapshots in time order (byte-identical when all raw is
  present) and counts snapshots whose pages were trimmed. The old README warning is gone.
- Not done yet (P2.3): nothing schedules the hourly snapshot by itself; `EFLIP_REGION_BOOK=1` only
  adds it to a full sync, which the pages do not request. P2.3 adds the server-side hourly timer
  (and the `--watch` loop's), keeps the job opt-in through the flag rather than on by default, and
  does the plan-doc cross-references.

## P2.3 as built (agent, 2026-11-26; accepted at review)

- `createRegionBookScheduler` in lib/sync.js: started by the server when `EFLIP_REGION_BOOK=1`
  (first run a minute after start, then hourly, timers unref'd, no overlap, errors logged, the job's
  55-minute rule still applies); `/api/config.regionBook` = {enabled, scheduled, nextRunAt, lastRun}.
- `scripts/sync.js --watch` is one tick per process (launchd, StartInterval 300), not a loop, so
  with the flag it runs the snapshot unforced after the tick and the 55-minute rule makes it hourly.
- Opt-in stays; README says why (about 8 MB an hour on disk after gzip, 46 MB of pages, some
  190 MB a day) and that the snapshot does not wait for an export run.
- The no-budget nag now quotes the on-disk figure (8 MB an hour, gzipped) rather than 46 MB.

## M3 as built (agent, 2026-11-26; accepted at review)

- `POST /api/sold-before {stationId, typeIds, days = 90, sourceStationId?}` pools the linked
  characters' ledgers and runs `results-calc.compute` server-side (the results page's inputs), so the
  realized net margin per unit (FIFO profit ÷ units) and the unit-weighted median days on market are
  the results page's own figures; `units`, `sales`, `lastSoldAt` come from the transactions. The
  source station matters: without it the haul cost drops out of the margin. Answers are cached 60 s
  per (station, source, days). Scope follows the results accounting: personal sales to clients outside
  the pool.
- Page: a shared `createBatchFetcher` behind the stats and the sold-before fetchers; `buildRow` asks
  both in parallel; last column "sold before" (units; tooltip "2 sales, last 2026-11-19; net
  0.84M/unit; median 8.4 days on market"; blank when none); saved runs gain `soldBeforeUnits`.
