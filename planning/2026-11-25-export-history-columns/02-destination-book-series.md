# M2 — Hourly destination-book series folded into the book logs

Size: md, three phases. Dependencies: M1 (so the figures have a consumer), and the order-monitor
session's Phases 3–4 landed on `feature/export-rework` (plan decision 10: `lib/sync.js`,
`lib/derive.js`, `lib/ledger.js` are shared). Review gate: after P2.1's 24-hour measurement, a
short check of the numbers before retention is fixed; a follow-up `sbs-plan` pass is needed only if
the growth is far from the estimate in notes.md.

## Scope

Every type at the destination station gets book-log coverage, not only the types in play: once an
hour the server fetches the destination region's sell-order pages, stores them raw, and folds each
type's station orders into the existing per-type book log as one sample. Raw pages are kept 48 h;
the folded logs are durable, pruned to 90 days of path entries.

Out of scope: the source region (we buy there), buy orders, moving the export page's own book
loading to the server (a later follow-up noted in the trade-results plan), notifications.

## Amendments at the M1 review gate (2026-11-25)

- Fetch ALL orders (`order_type=all`, 194 pages for Domain), not sell-only: the per-type book logs
  hold buy orders too (the orders page carries them), and a sell-only sample would make every buy
  order look vanished until the next per-type check. Cost 388 tokens a snapshot, about 46 MB raw.
- The raw window to measure against is 24 hours (about 1.1 GB rolling), not 48. P2.1 deletes
  nothing; P2.2 sets the number from the measurement.

## Measured inputs (notes.md)

Domain all orders: 194 pages, ~238 KB each, 388 tokens a snapshot; sell-only pages are fewer
(measure in P2.1). The Amarr station holds most of the region's sell book. Change rate unmeasured.

## P2.1 — the job behind a flag, with measurement (sonnet, mirrors `doSyncMarket`)

- `lib/sync.js`: `doSyncRegionBook({ regionId, stationId })`: fetch `/markets/<regionId>/orders?
  order_type=sell&page=N` for every page through `esi.get` (raw-first, ETag aware), under the
  `market` lock, deferring while an export run is in progress exactly as `doSyncMarket` does,
  pausing under 20 % remaining. Then, per type present in the pages (station orders only), call
  `derive.updateBookLog` with `check = {at: fetchedAt, stored: true, rows}` where `rows` are that
  type's region orders from the snapshot (the same shape the per-type books give, so `foldBook` is
  unchanged); types with a log but no orders in the snapshot get a stored check with empty rows
  (their orders ended). Record per snapshot in the public sync log: pages, tokens used, bytes,
  types touched, log bytes before and after, elapsed.
- Raw slug: `markets-<regionId>-orders-sell-page-<n>` under `data/raw/public/`, as `esi.js` names
  things; `esi.js` state per page as usual.
- `scripts/sync.js --region-book` and `POST /api/sync` body flag `regionBook: true`; the hourly
  schedule only when `EFLIP_REGION_BOOK=1` for this phase.
- Tests (`test/sync.test.js` style, fake fetch): pages fold into logs; a type absent from the
  snapshot gets an empty sample; the lock and the deferral; the measurement entry.
- Run it on Rocky's machine for 24 h; write bytes per snapshot (raw and log growth), tokens, and
  sell-page count into `notes.md`. Review gate here.

## P2.2 — a storage budget with shares, and compression (sonnet, after the gate)

Rocky (2026-11-25): "assign things shares in a total amount of space allotted so for example I could
allocate 1GB and then it would save history until 1GB then trim old data ... the 1GB can be shared
among all the data we want to save while allowing different things to have different percentages."
This replaces the fixed windows (24 h raw, 90 days of log) with one budget.

- **Config.** `EFLIP_STORAGE_BUDGET` (e.g. `1GB`; absent: no trimming, and the pages' env notice says
  so while the region job is on) and `EFLIP_STORAGE_SHARES` (e.g.
  `regionPages:40,bookLogs:45,typeBooks:10,runContexts:5`, the defaults; percentages, sum ≤ 100).
- **Kinds in the budget** (bulky, replaceable or derived): `regionPages` = the hourly regional order
  pages (raw); `bookLogs` = `data/ledger/market/*`; `typeBooks` = the per-type raw books and
  histories under `raw/public` (market sync and watch refresh); `runContexts` = the `context` of
  saved runs (the rows stay). **Outside the budget**: character raw and ledgers, retained snapshots,
  sync logs, `esi-cache` bookkeeping: small, and irreplaceable (ESI serves only recent wallet and
  order history).
- **Soft shares.** The total is what is enforced. After each snapshot the job measures each kind's
  bytes on disk and, while the total exceeds the budget, trims the kind furthest over its share
  (bytes ÷ share), oldest first, in the unit natural to it: `regionPages` by whole snapshot;
  `typeBooks` by whole raw file, oldest stamps first; `bookLogs` by one time cutoff applied to path
  entries and samples across all logs, keeping each order's newest entry; `runContexts` by whole
  run. A kind under its share lends the room.
- **Floors trimming never crosses:** the newest regional snapshot; the newest raw file per slug; the
  last 3 days of every book log (M1's window floor); the newest run's context.
- **Compression.** Book logs and raw pages are written gzipped (`.json.gz`) and read in either form,
  so nothing migrates: measured 10.5x on a log (24,193 → 2,297 bytes) and 6x on a raw page, so 1 GB
  holds months of region-wide logs rather than weeks. Every reader (`readMarket`, the book reader,
  `rebuildBookLogs`, the raw store's `list`/`latest`) must accept both forms.
- **Code.** A pure planner `lib/storage-budget.js`: `planTrim({budgetBytes, kinds: [{name, share,
  bytes, items: [{at, bytes}]}], floors})` → per kind the items or the cutoff to drop, with tests
  (shares that lend, floors, a shrunk budget, sums over 100 rejected). The job applies the plan under
  the `market` lock (the watch refresh appends to the logs every five minutes). `scripts/sync.js
  --storage` prints usage per kind against its share and what the last trim removed; `/api/config`
  reports budget and usage; the pages' env notice shows "storage 62 % of 1 GB".
- **What is lost, said plainly in the README:** once trimmed, the oldest history is gone for good
  (the raw pages behind it went earlier); that is the budget's purpose. A lowered budget trims at
  the next run. The rebuild-from-raw invariant holds for whatever raw the budget still holds.

## P2.3 — on by default, docs (haiku: mechanical)

Default the hourly job on when SSO is configured; README (data directory sizes, the 48 h rule,
how to turn it off); `docs/trade-results-plan.md` cross-reference; `docs/order-monitor-plan.md`
note that its backlog item "station-level sell-side share from book differences" now has the data.

Sub-agent reminders (every phase): do not commit; do not expand scope; do not suppress warnings or
disable tests; stop and report if blocked; report what changed, what was validated and any
deviation; never delete raw files other than the regional pages named above.

## Definition of done

After a week on Rocky's machine, an unwatched type searched on the export page shows avg days idle
and blended figures with `f` near 1; disk growth is within the measured budget; gates green; docs
updated.
