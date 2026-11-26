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

## P2.2 — retention and rebuild (sonnet, after the gate)

- Raw regional pages older than 48 h are deleted by the job (`data/raw/public/markets-<region>-
  orders-sell-page-*`), never other raw. Document in `lib/dataFiles.js`'s header and the README
  that the rebuild-from-raw invariant holds for regional pages inside 48 h, and that book logs are
  the durable record beyond it.
- Per-type pruning: path entries and samples older than 90 days are dropped when a log is written,
  keeping each order's latest entry; `derive --rebuild` applies the same cut. Tests for both.
- If the measured growth exceeds ~50 MB a day after pruning, stop and re-plan (bigger window
  trimming, or station-only storage).

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
