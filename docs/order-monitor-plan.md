# Order monitor (orders.html) — plan

Branch: `claude/order-monitoring-undercut-8e457f`, fast-forwarded onto `feature/export-rework`
(fb4880a) on 2026-11-25. New: `public/orders.html`, `public/orders.js`, `public/orders-calc.js`,
`test/orders-calc.test.js`, `test/watch.test.js`, `test/order-log.test.js`. Changed: `lib/sync.js`
(watch refresh), `lib/derive.js` and `lib/ledger.js` (order log, book log), `lib/api.js`
(`/api/watch`, `/api/order-log`, `/api/market?log=1`, `/api/config` env report),
`public/results-shared.js` (env notice, page links), `public/results.html`, `public/insights.html`
(a link), `public/export.js` (env notice line), `scripts/sync.js` (`--watch`), `README.md`. Out of
scope: `index.*`, `jack.js`, `missing.*`, `resell.*`, `reprocess.js`, and everything under "Out of
scope" below.

Goal: while the game is open, see at a glance what has sold recently and what it made; which sell
orders have been undercut, by how much and for how long; whether updating each one is worth its
fee; how quickly others undercut after an update, so the gain from undercutting can be judged; and
what share of the item's volume was ours. Principles unchanged from the trade-results plan: every
figure comes from the user's own ESI data or ESI market data; every ESI answer is stored raw first
and everything else is derived from it and rebuildable; the browser never holds a token and there
is no generic ESI proxy.

The data mostly exists. The hourly sync already stores open orders and order history as raw and as
retained snapshots, the destination market snapshot already fetches the Domain book and daily
history of every listed type (listed types rank first within the 300-type cap), and
`results-calc.js` already produces one row per sale with its FIFO landed cost, tax and fees. What is
new: a faster refresh of just the listed types, two derived logs that keep the price paths of our
orders and of the competing orders, a pure analysis module with the verdict rule, and a page.

Terms used below:
- **watch refresh**: the light sync the orders page triggers: our open orders, then the books and
  daily history of the types we have listed, every five minutes while the page is open.
- **units ahead**: the summed `volume_remain` of sell orders at our station priced strictly below
  ours, plus equal-priced orders issued before ours (decision 12: the tie-break hardly matters, and
  the older order is the conservative reading).
- **days behind**: units ahead divided by daily volume: how long the queue in front of us takes to
  clear if nobody else lists.
- **daily volume**: the recency-weighted mean of the item's regional daily `volume` over the last
  30 days, with the export estimate's weights (`recencyWeight`, `RECENCY_HALF_LIFE_DAYS`,
  `DAYS_CONSIDERED`). It differs from the export page's `dailyDemand`, which keeps only profitable
  days; this one measures how fast the item moves at all.
- **typical trade**: the median units per sale of the item: our own sell transactions of it in the
  last 90 days when there are at least five, else the recency-weighted mean of the regional daily
  `volume / order_count`.
- **episode**: the period one of our orders held one price: from an `issued` to the next `issued`
  of that order, or to the order's end.
- **time on top**: within an episode, from our `issued` to the `issued` of the first competing
  order at our station priced below ours and issued after ours. Open (censored) while none has.
- **landed cost**: buy price plus haul plus buy-order fee per unit, from the FIFO lots of
  `results-calc.js`, taken over the unsold remainder of the item's lots (FIFO sells the oldest
  units first, so what is listed comes from the newest lots).

## ESI facts this plan relies on (confirmed in the 2026-11-19..22 samples and snapshots)

- `/characters/{id}/orders`: cache 1200 s, no rate group (legacy error limit). Fields used:
  `order_id, type_id, location_id, region_id, price, volume_remain, volume_total, issued, duration,
  range, is_buy_order` (absent on a sell). `issued` is the last placement or price change, so a
  price change keeps the `order_id` and resets `issued`.
- `/markets/{region}/orders?type_id=`: cache 300 s, `market-order` 12000 tokens per 15 min, 2 per
  call. Fields used: the same plus `system_id, min_volume`. Our own order appears here under its
  `order_id`, so it is matched exactly, never by price. Each competing order's `issued` dates its
  placement or last price change, so the moment of an undercut is read, not inferred.
- `/markets/{region}/history?type_id=`: cache 3600 s. Daily `average, highest, lowest,
  order_count, volume`.
- `/characters/{id}/wallet/transactions`: cache 3600 s, `char-wallet` 150 per 15 min (the tightest
  bucket). Sales therefore lag up to an hour. A fill shows sooner as a drop of `volume_remain`
  between two `orders` answers (up to 20 min).
- `orders/history`: a filled order reads `expired` with `volume_remain: 0`; one that ran out of
  time keeps its remainder; a withdrawn one reads `cancelled` (resolved 2026-11-19).
- Modifying an order changes its price only; raising the quantity means cancelling and placing a
  new order (Rocky, 2026-11-25). So `volume_remain` never rises on a persisting `order_id`, and a
  drop is a fill.
- Prices are not limited to four significant figures. Of 12,415 distinct Domain orders in the
  books stored up to 2026-11-22, 38 carry more (81,000.01 and 81,000.02 among them, issued that
  week), so the one-cent undercut of rule 6 (`bestPrice − 0.01`) is a real price. Most orders do
  use four figures or fewer, which is habit, not a rule.
- The fee for a price change is charged on the change, not at a rate: Grant's 214 `brokers_fee`
  rows in 13 days (up to 34 a day) ran from 0.1 % to 2.4 % of order value. Estimates come from an
  order's own past fees (rule 6), never from a rate.
- Budget of one watch tick: one `orders` call per character when due, and per listed type at most
  `MARKET_MAX_PAGES` book pages when due plus one history call an hour. Ten listed types cost
  about 20 of the 12000 `market-order` tokens per tick. A tick inside the cache windows makes no
  call at all, since every route honours `Expires`.

## Data model

Raw is unchanged in shape. Our orders already land under `data/raw/<characterId>/orders/`, books
under `data/raw/public/markets-<regionId>-orders-type-id-<typeId>/`, history beside them. The watch
refresh only adds files there, and only when a body changed (content hash). A type's book is 1–10
KB, so ten listed types refreshed every five minutes for a month stay under about 50 MB before the
unchanged bodies are skipped.

Two derived logs, built by `lib/derive.js` from raw alone and updated incrementally by `lib/sync.js`
through the same fold functions, under the existing invariant that a rebuild is byte-for-byte the
incremental result:

- `data/ledger/<characterId>/order-log.json`: `{<orderId>: {typeId, locationId, regionId, isBuy,
  volumeTotal, duration, firstSeen, lastSeen, path: [{at, price, volumeRemain, issued}], end: null |
  {state, volumeRemain, at}}}`. `path` gets an entry only when `price`, `volumeRemain` or `issued`
  changed; `at` is the raw `fetchedAt`. `end.state` comes from `orders-history`; `end.at` is the
  `fetchedAt` of the first `orders` answer that no longer lists the order (so it is late by at most
  one refresh interval). Folded from every raw `orders` file and `orders-history` row in
  `fetchedAt` order. This is finer than the retained snapshots, which need assets and balance to be
  current too and so follow the hourly sync.
- `data/ledger/market/<regionId>/<typeId>.json`: `{samples: [{at, stored}], orders: {<orderId>:
  {isBuy, locationId, systemId, volumeTotal, duration, minVolume, range, firstSeen, lastSeen, path:
  [{at, price, volumeRemain, issued}]}}}`. Same path rule. `samples` lists every time the book was
  checked, stored or answered 304, so a consumer knows when an order was last confirmed present and
  how long the gaps were. The watch and market syncs record their per-type check times in the
  public sync log for this; existing public sync logs give the hourly samples since 2026-11-20.
- `data/esi-cache/public/_watch.json`: the last tick (`tickedAt`, per-character and per-type
  outcomes, `stop`), read by `GET /api/watch`.

## Analysis rules (`public/orders-calc.js`, pure, UMD like `estimate.js`)

Inputs: `{characterIds, openOrders (newest raw orders per character), orderLogs, books (newest book
per type and region), bookLogs, history (per type), facts (the sells, lots and relists of a
results-calc compute over the whole ledger), observedTaxRate, stations, thresholds, now}`.
Thresholds and defaults: `LEAVE_HOURS 8`, `UNDERCUT_DAYS 2`, `MIN_ROI` (the export page's), `scope:
'station' | 'region'`.

1. **Rows.** One per open sell order of the pooled characters. Buy orders are carried through the
   logs and the module but not shown (decision 1). Per row: `orderId, characterId, typeId,
   locationId, price, volumeRemain, volumeTotal, issued, firstSeen` (from the log), `listedFor =
   now − firstSeen`, `relistCount` (price changes in the log path), `relistFees` (that order's
   `feeTotal` in `facts.relists`), `lastFillAt` (the last `volumeRemain` drop in the log).
2. **Position.** From the newest book of the type, over sell orders at our station (`scope:
   'station'`) or in the region (`'region'`): `unitsAhead`, `ordersAhead`, `rank`, `bestPrice`,
   `gapToBest = (price − bestPrice) / bestPrice`. With station scope the row also carries
   `cheaperElsewhere: {orders, units}` for the orders below ours at other stations of the region,
   shown as a note only.
3. **Undercut.** `undercutAt` is the earliest competing `issued` later than our `issued` among the
   orders ahead of us; null when none (we chose to list behind the orders ahead). `undercutBy` is
   that order's `{price, volumeRemain, gap}`. `reUndercuts` counts that order's price changes in the
   book log since our `issued` while it stayed below us: two or more in 24 h is the `price war`
   badge.
4. **Demand.** `dailyVolume`, `typicalTrade` (Terms), `daysBehind = unitsAhead / dailyVolume` (null
   when the volume is 0), `myRate7d` = our units of the type sold in the last 7 days over 7.
5. **Time on top.** Episodes come from the order log of every sell order of the type at the
   station, open or ended, within 90 days. For each, `timeOnTop` is the first competing `issued`
   inside the episode with a price below the episode's price, from the book log (an order whose path
   holds such a price and `issued`), else censored at the episode's end or at `now`. Per type:
   `episodes`, `undercutEpisodes`, `medianTimeOnTop` over the undercut episodes (flag `est` under
   three), `onTopFor` for a current episode that is still on top. Overall: the pooled median over
   every type's undercut episodes. Limits, stated in the tooltip: a competing order placed and gone
   between two samples is missed; before the watch refresh existed the books were sampled hourly.
6. **Economics.** `landedCost` per unit (Terms; null and flag `nocost` when no lot covers the
   item), `marginNow = price × (1 − observedTaxRate) − landedCost`, `matchPrice = bestPrice − 0.01`,
   `marginIfMatch = matchPrice × (1 − observedTaxRate) − landedCost`, `roiIfMatch = marginIfMatch /
   landedCost`. `feeEstimate` is the median of this order's past relist fees, else the median relist
   fee of the character's orders of this type, else null (flag `nofee`). `expectedSalesBeforeUndercut
   = dailyVolume × medianTimeOnTop / 24 h` and `expectedGainBeforeUndercut = that × marginIfMatch`,
   both null without a median.
7. **Verdict**, evaluated in this order, with its reason text:
   - `top`: nothing ahead.
   - `leave`: `daysBehind × 24 < LEAVE_HOURS`, or `unitsAhead ≤ typicalTrade`: the queue ahead
     clears on its own.
   - `reconsider` (red): `matchPrice × (1 − tax) ≤ landedCost` ("below cost"), or `matchPrice ×
     (1 − tax) < MIN_ROI × landedCost` ("below the ROI floor"; `MIN_ROI` is the export page's net
     revenue over cost, 1.5, so this is `roiIfMatch < MIN_ROI − 1`). Without a landed cost this
     branch is skipped and the row carries `nocost`.
   - `undercut`: `daysBehind ≥ UNDERCUT_DAYS`. Demoted to `maybe` with the reason "others undercut
     within ~h; the fee outweighs the expected sales" when `expectedGainBeforeUndercut` is known and
     below `feeEstimate`.
   - `maybe`: everything between, with the numbers.
   Sort order of the page: `undercut, maybe, reconsider, leave, top`, then `daysBehind` descending.
8. **Sold recently.** Every `facts.sells` row in the window (24 h, 2 d, 7 d, 30 d) becomes a sale
   `{date, typeId, characterId, qty, unitPrice, gross, net = gross − tax − brokerShare −
   relistShare, profit, orderId, daysSinceListed}`. `orderId` is the order of the same character,
   type and location whose log price at that time equals `unitPrice`; null when none or several.
   Grouped per type and day for the table. For the plot, sales of the same item are merged into
   **clusters** when each follows the previous within `clusterGapMs` (an input; the page passes the
   window length over 150, at least 10 minutes): `{typeId, start, end, qty, gross, net, profit,
   sales: [...]}`, so a burst of fills reads as one dot whose area is their total profit (decision
   10). Window totals: units, gross, net, profit, relist fees paid (fee rows in the window), and
   `asOf.transactions`, the newest transaction date, so the page can say what hour the sales are
   good to.
   **Pending fills.** Per open order, `filledPerLog = volumeTotal − volumeRemain` against
   `filledPerTx`, the units of the sales matched to it; the difference, when positive, is a pending
   sale at the order's price dated at the last drop in the log. Drawn hollow; it becomes a sale when
   the wallet catches up.
9. **Share.** Per type over the window's days: our units sold divided by the summed regional
   `volume` of those days, labelled "share of Domain volume"; null without history. The station-level
   sell-side share from book differences is backlog (Out of scope).
10. **Output.** `{rows, sales, salesClusters, pending, salesByTypeDay, share, timeOnTop: {overall,
    byType}, totals, asOf: {orders, books, transactions}, warnings}`. Every figure is traceable to
    an input row.

## UI (`public/orders.html`, `public/orders.js`)

Same idiom as `results.html`: vanilla JS, 13 px dense table, sticky header, right-aligned numbers,
`title` tooltips, `moment` from cdnjs, Plot 0.6.19 and d3 7.9.2 from jsdelivr with the same
integrity attributes as `insights.html`, and `results-shared.js` for the loader, the characters strip
and the formatters. The implementer loads the `ui-patterns` and `dataviz` skills first and lists
`docs/ui-decisions/`.

1. **Header.** The characters strip, then a status line: "orders as of hh:mm · books as of hh:mm ·
   sales as of hh:mm (ESI holds sales back up to an hour) · next refresh in m:ss", a "Refresh now"
   button and a "refresh while open" toggle (default on). The age turns amber past 25 min for orders
   and 10 min for books. Links to results and insights, and both of those pages get an "orders"
   link.
2. **Env notice** (shared through `results-shared.js`, and one line under the export page's sync
   note). When `GET /api/config` reports that `EFLIP_DATA_DIR` is unset: "Synced data is in
   `<resolved path>` because EFLIP_DATA_DIR is not set. Add `EFLIP_DATA_DIR=/path` to .env so every
   checkout shares one store." When `ESI_USER_AGENT` is unset: "ESI_USER_AGENT is not set; CCP asks
   for a contact in it." An amber bar under the header, not a dialog, not dismissible: it stays
   until the variable is set. The two required keys already have their own state (503 "not
   configured" and the setup steps); `EVE_CALLBACK_URL`, `HOST`, `PORT` and `ESI_COMPAT_DATE` have
   correct defaults and get no notice.
3. **Thresholds row.** "leave under [8] h · undercut over [2] d · ROI floor [MIN_ROI] % ·
   competition [this station ▾ | whole region]". Edits re-run the module at once; values persist in
   localStorage.
4. **Open orders table.** Default sort as rule 7. Columns: verdict (badge; the reason and the
   `price war` badge in the tooltip), item (type id and a copy-name button, as the export page),
   remaining / total, my price, best price, gap, units ahead (orders ahead and cheaper-elsewhere in
   the tooltip), days behind (shown in hours under a day), daily volume, typical trade, undercut
   since (relative time; the undercutter's units and gap in the tooltip), time on top (median and
   episode count; "on top for 3 h" while the current episode is uncut), margin now, margin if match
   (with ROI), fee est., relists (count · fees), listed for, last fill. `nocost` dims the margin cells;
   `est` figures get the usual tilde.
5. **Sold recently.** Window toggle (24 h / 2 d / 7 d / 30 d), a totals line (units, gross, net,
   profit, relist fees paid, overall share of Domain volume), then the **sales timeline**: x is time
   over the window, y is one row per item (newest sale on top), one dot per sale cluster (rule 8)
   whose **area is the total profit** of the sale or sales it stands for, placed at the cluster's
   midpoint; a loss is drawn in the palette's negative colour with the area of its size, a profit in
   the positive one; pending fills are hollow. Hover and keyboard focus (an own hit layer, as
   insights does) list each sale in the cluster: time (local, EVE time in parentheses), item, units
   × price, net per unit, profit, the order it filled and days since listing. A "show order events"
   toggle adds, on each item's row, a
   tick at every price change of ours and a hollow tick at every undercut against us, so an item's
   recent history reads in one line. Below the plot, the per-type-and-day table is the accessible
   alternative and carries the share column.
6. **States.** Not configured: the shared fatal panel. No characters: "Link the character that
   sells". No open sell orders: a line saying so, with the sold-recently section still shown. A type
   with no book yet: "no book yet; the next refresh takes one" in its position cells. Rate-limited
   or paused: "paused until hh:mm" in the status line. Server unreachable: the shared fatal panel
   with retry.

## Server changes

1. **`lib/sync.js`**: `syncWatch({characterIds?, regionIds?})`. Per linked character, under its
   lock (skipped when busy): `GET orders` when due, raw, then the order log fold. Then under the
   `market` lock (skipped when the hourly market snapshot holds it): for every type with an open sell
   order in the watch regions (the `marketRegions` rule), the book pages (at most `MARKET_MAX_PAGES`)
   and the history when due, raw, then the book log fold; the per-type check times go into the public
   sync log. The watch pauses under 20 % of the bucket like the market snapshot and never retries a
   401. `_watch.json` records the tick. A watch tick leaves the hourly sync intact: its `orders` call
   answers `not-due` after a recent tick, which `isCurrent` accepts, and the snapshot takes
   `raw.latestStamp`, which is the tick's file (a test pins this).
2. **`lib/derive.js`**: `buildOrderLog` (raw `orders` files and `orders-history` rows per
   character, in `fetchedAt` order) and `buildBookLog` (raw public books and public sync logs per
   region and type), both in `rebuildAll` and in the incremental sync through shared fold functions.
   `lib/ledger.js` reads and writes `order-log.json` and `market/<regionId>/<typeId>.json`.
3. **`lib/api.js`**: `POST /api/watch {characterIds?}` (16 kb JSON) runs one tick and answers its
   outcome; `GET /api/watch` answers `_watch.json` plus `running`; `GET /api/order-log?characterIds=`;
   `GET /api/market?typeIds=&regionIds=&log=1` adds `log` beside `orders` and `history`;
   `GET /api/config` adds `env: {dataDir, dataDirFromEnv, userAgentFromEnv}`. No secret and no token
   is ever reported; `dataDir` is a local path. `/api/config` stays outside `requireConfigured` so the
   notice shows before SSO is set up.
4. **`scripts/sync.js --watch`**: one watch tick from the command line, for an optional launchd job
   every five minutes while the game is open on a machine where the page is not. README documents it
   as optional.
5. **`public/results-shared.js`**: renders the env notice from `/api/config.env`; adds the orders
   link. **`public/export.js`**: the same notice text under its sync note (it already fetches
   `/api/config`).

## Phases

### Phase 1 — watch refresh, logs, routes, env report (sonnet: bounded, mirrors sync and derive)
Scope: Server changes 1–4, `test/watch.test.js` and `test/order-log.test.js` with
`test-support/esi-fake.js`. Tests: a tick stores a book per listed type and nothing for unlisted
ones; a second tick inside five minutes makes no call; the order log appends only on change and
closes an order from history; the book log's `samples` record a 304; a watch tick followed by an
hourly sync still writes a snapshot that names the tick's raw file; `--rebuild` reproduces both logs
byte for byte; `/api/config.env` reports the three flags; the `market` lock busy skips the market
step without failing the tick.

Gate: `node --test test/*.test.js` passes. Live, with this worktree's server on `PORT=5002`,
`.env` copied from the inventory-ui-updates worktree and `EFLIP_DATA_DIR` pointed at its `data/`:
`POST /api/watch` stores Grant's seven listed books and writes `order-log.json`; a second call
within five minutes reports no ESI call; `node scripts/sync.js --rebuild` leaves both logs
unchanged; the next hourly sync still writes a snapshot.

Done 2026-11-25: `lib/ledger.js` (order-log and book-log read/write, one order per line in numeric id
order, keys sorted), `lib/derive.js` (`foldOrders`, `applyHistory`, `foldBook`, the builders and the
`update*`/`ensure*` helpers sync.js calls), `lib/sync.js` (`syncWatch`, `watchStatus`, and the
market snapshot's per-pair loop moved into `fetchPairs`, shared with the watch), `lib/api.js`
(`POST|GET /api/watch`, `GET /api/order-log`, `/api/market?log=1`, `/api/config` `env`),
`scripts/sync.js` (`--watch`, and `--rebuild` also rebuilds both logs and lists the order log's
warnings), `test/watch.test.js` (13), `test/order-log.test.js` (13), four more API tests and five more
script tests. 288 tests before, 323 after (not counting `test/orders-calc.test.js`). The gate's live
half (`PORT=5002`, Grant's books) is not done here. As built, where it differs from the text above:
- **Raw page names.** A book's second page is `markets-<region>-orders-page-2-type-id-<type>`
  (`slugFor` sorts the query keys), not `...-type-id-<type>-page-2`.
- **Order log.** The history rows are an overlay applied to the whole log after the `orders` answers
  are folded, not interleaved by `fetchedAt`: history (cache 3600 s) can know of an ending before the
  next `orders` answer (cache 1200 s) drops the order, and the ledger's rows are last-write-wins, so
  the overlay is the same in a rebuild and step by step. `lastSeen` is the last stored answer that
  lists the order (raw skips unchanged bodies, so an untouched order's `lastSeen` lags until
  something changes; `end.at` is exact to a refresh). `warnings` come back from `buildOrderLog` and
  `--rebuild` prints them: `volume-rise`, and `reappeared` (an ended order listed again, which
  reopens it).
- **Public sync log.** The watch and the market snapshot add `source: 'watch' | 'market'` and `books:
  [{regionId, typeId, outcome, at, pages, stamps: {page: stamp of the raw file this check stored},
  history}]`. `outcome` is `stored`, `not-modified` (a 304, or a 200 with the stored body), `not-due`,
  or the failure's name; only the first two are samples, `at` is the first answer's time (a 304's
  `checkedAt`), and `pages` is capped at `MARKET_MAX_PAGES`. A page the check did not store is read
  as the newest file stored at or before the check's last stamp, so a book whose page 2 alone changed
  still folds whole. Entries written before `books` count each type they list as checked at
  `syncedAt` (stored when a page file falls in their window, and only for a type that has raw
  before it); a stored page file no entry names is a check of its own. For those, and only those, a
  book that shrank by a page is read with its stale page.
- **Existing data.** A log that does not exist is built from raw first (`ensureOrderLog` on a
  character's first fold, `ensureBookLog` on a type's first check), so the incremental and rebuilt
  logs agree on a data directory that predates them; a type's log appears at its first check. A
  crash between a raw write and its fold leaves a log one answer behind until `--rebuild`; a book log
  that will not fold is reported as a `bookLog` error (the raw is stored, the run goes `partial`).
- **Watch.** `_watch.json` is `{tickedAt, finishedAt, characters: {id: {name, status, reason?, orders,
  checkedAt, expires, openSellOrders}}, market: {status, reason?, regionIds, calls, truncated, types:
  [the `books` form], errors, stop}, stop}`. A tick writes a public sync log (unique `syncedAt`) only
  when it called ESI, no character sync log, no `_sync.json`. A 401 ends that character's step, an
  error-limit pause or a 420/429 ends the tick. `/api/market` without `regionIds` takes the regions of
  the newest public sync log, which a watch entry can now be.
- **`/api/config`** now carries `env.dataDir`, so `test/sso.test.js`'s "leaks nothing else" check
  allows that one path; the flags are booleans, the values are never sent.
- **`--watch`** is a usage error (exit 2) with `--rebuild`, `--market-only`, `--no-market` and
  `--max-types`; it exits 1 when a character failed, was busy or needs re-linking, a stop ended the
  tick or the market step was partial or failed; a busy or skipped market step is not a failure.

Live gate 2026-11-26 (Fable, this worktree's server on `PORT=5002` against the inventory-ui-updates
data): the first tick synced both characters and stored the books and history of Grant's four
listed types (8 calls); a second tick inside five minutes made no call (`not-due` ×4);
`order-log.json` appeared for both characters (Grant: 9 orders, 4 open, 5 ended, one of them already
closed from history) and `market/10000043/<typeId>.json` for the four types (the 47771 log holds 7
samples back to 2026-11-20, two of them 304s); `node scripts/sync.js --rebuild` left every existing
ledger file byte-identical and added book logs for the 354 other types in raw; a forced hourly sync
right after the tick wrote a snapshot whose refs name the tick's raw `orders` file. The market-order
bucket never dipped below 11,900 of 12,000.

### Phase 2 — analysis module (opus: semantics need care; writes the tests), parallel with 1
Scope: `public/orders-calc.js`, `test/orders-calc.test.js`. Hand-written fixtures shaped like the
live samples (Grant's order 7467834499 at 21.12 M behind no one; 7464705828 with 2 of 31 left).
Cover: position with equal prices and with region scope; `undercutAt` null when the orders ahead
predate ours; episodes with a censored current one, a missed sample and a price-war order; typical
trade from own sales and the history fallback; landed cost over the FIFO remainder, and `nocost`;
the fee estimate's three fallbacks; every verdict branch at its threshold, the demotion to `maybe`,
and the sort; sale-to-order matching unique and ambiguous; a pending fill that a later transaction
absorbs; sale clusters (two sales inside the gap merge, a third outside it starts a new cluster, a
loss and a profit keep their signs in the total); share with and without history; `asOf` values.

Gate: `node --test test/*.test.js`.

Done 2026-11-25: `public/orders-calc.js` (UMD, `window.ordersCalc` / `require`, `defaultThresholds`),
29 tests. `compute({characterIds, openOrders ({[characterId]: rows | {fetchedAt, orders}}),
orderLogs, books, bookLogs, history, facts: {sells, lots, relists}, observedTaxRate, stations,
thresholds, now})`, shapes as in Data model and the module header; output rule 10's plus `taxRate` and
`thresholds`; rows carry `verdict`, `reason` and `badges` (`priceWar, nocost, nofee, est, nobook,
nobooklog, nohistory, nolog`). As built, beyond the rules:

- `minRoi` keeps the export page's meaning (net revenue ÷ cost, 1.5x): `reconsider` when `matchPrice
  × (1 − tax) < minRoi × landedCost`, i.e. `roiIfMatch < minRoi − 1`; comparing the margin-based
  `roiIfMatch` with 1.5 would demand 150 % profit.
- Orders of any linked character are never competition: out of units ahead, best price, undercuts
  and episodes, reported as `ownAhead`. `matchPrice` is null on a `top` row.
- `undercutAt` dates the undercutter by its first logged price below ours issued after ours (its
  current `issued` when unlogged), so a re-pricing undercutter does not move "undercut since"
  forward. `reUndercuts` counts its changes after our `issued` that left it below us, the first
  included.
- `relistFees` is the fees after the first (`listingFee`, `feeTotal` beside it); `listedFor` runs
  from the earliest of `firstSeen`, the first logged `issued` and the fee facts' `firstSeenAt`.
- `expectedSalesBeforeUndercut` is capped at `volumeRemain`.
- Sales are one per wallet transaction (results-calc rows merged by `sellTxId`). Sell facts carry no
  location, so matching uses character, type and price (a location when a row has one).
- Pending fills count from the log's first sighting (its `volumeRemain` then, less now) against the
  matched sales after it: `volumeTotal − volumeRemain` would report fills from before the log, at
  prices it never saw, as pending.
- Share uses whole UTC days that have a history row, on both sides (today is not in the history yet).
- No book: `maybe`, "no book yet". No book log: no episodes for the type. No observed tax rate: 8 %,
  warned. `asOf.books` also counts book-log samples (a 304 confirms the book).

### Phase 3 — page (sonnet; loads `ui-patterns` and `dataviz` first; after 1 and 2)
Scope: `public/orders.html`, `public/orders.js`, the env notice and links in `results-shared.js`,
`results.html`, `insights.html`. Nothing in `lib/` or `results-calc.js`.

Gate: tests pass. In the browser against the local data: the open orders render with verdicts and
reasons; changing a threshold changes verdicts without a reload; the sales timeline shows the
window's sales with hover details and the order-events toggle; "Refresh now" posts a tick and the
status line's times move; the env notice shows with `EFLIP_DATA_DIR` unset and is gone once set;
every state in UI 6 looked at; keyboard reaches the plot's points.

### Phase 4 — export page notice, README (haiku: mechanical)
Scope: the notice line in `public/export.js`, README (the orders page, the watch refresh, `--watch`,
`EFLIP_DATA_DIR` and `ESI_USER_AGENT` in the setup steps, the `data/` map's two new entries).

Gate: tests pass; the export page shows the notice with the variable unset.

## Agent roster

- Phase 1 and 3: sonnet (clear briefs against existing patterns). Phase 2: opus (the verdict and
  time-on-top semantics are the crux). Phase 4: haiku.
- Sequencing: 1 and 2 in parallel (2 only adds files); 3 after both; 4 last. `lib/api.js` and
  `lib/sync.js` are touched by Phase 1 only.
- Fable: reviews `orders-calc.js` and the derive invariant, reruns the gates, smoke-tests the page in
  the browser against the local data, commits, and fast-forwards `feature/export-rework` after each
  green gate (decision 8). Briefs say "do not commit".

## Out of scope

- A buy-order view. The logs and the module carry buy orders so it can be added without new data.
- Notifications of any kind. The page is live while open; nothing runs in the background beyond the
  optional `--watch` job.
- Changing an order from the tool: ESI has no endpoint to place or modify market orders.
- Station-level sell-side share from book differences (a persisting competing order whose
  `volume_remain` drops is a fill; one that vanishes may have filled, been withdrawn or expired, so
  the figure is a range that narrows with five-minute samples). Backlog, after the logs have a few
  weeks of five-minute samples.
- Competitor profiles (the same `order_id` undercutting repeatedly across items), a price sparkline
  per order, structure markets, corporation orders.

## Decisions (2026-11-25)

1. Sell orders first; buy orders stay in the data, not in the UI.
2. A separate `orders.html` sharing the results pages' loader, linked from results and insights.
3. Thresholds: leave under 8 hours behind (Rocky changed the proposed one day to 8 hours), undercut
   over 2 days, ROI floor = the export page's `MIN_ROI`; all three editable on the page.
4. Competition is judged at our station, with cheaper orders elsewhere in the region as a note; a
   region scope is one select away.
5. Share is "share of Domain volume" from the history; the book-difference share is backlog.
6. Refresh every five minutes while the page is open, stored raw; no notifications.
7. One shared data directory through `EFLIP_DATA_DIR`, with an on-page reminder whenever it is not
   set (Rocky: "show a reminder alert when it isn't set so I don't forget"); the same for
   `ESI_USER_AGENT` (confirmed 2026-11-25).
8. This branch was fast-forwarded onto `feature/export-rework`; that branch is fast-forwarded after
   each green gate.
9. Time on top: measured per episode from our `issued` to the first competing `issued` below us, with
   a median per item and overall (Rocky: "how quickly other people undercut me so I have a sense of
   how long I'll stay on top if I do undercut"). It also feeds the verdict (rule 7's demotion).
10. Sold recently is a timeline: time on x, one row per item on y, a dot per sale with hover details
    (Rocky's design). Amended 2026-11-25: the dot's area is the total profit of the sale, or of
    several sales merged when they fell very close together in time; the per-type-and-day table
    stays as the accessible alternative.
11. The copy Rocky uses day to day runs on another computer from `feature/export-rework` with
    `npm run start`, so only what reaches that branch reaches him; the data on this machine (two
    characters, 2026-11-19 to 22) is for development and smoke tests.
12. Equal-priced orders: the sub-sort "doesn't really matter" (Rocky); the older order counts as
    ahead, which is also what a "days idle" tie-break gives.
13. An order's quantity never rises: raising it means cancelling and placing a new order (Rocky), so
    a drop in `volume_remain` is always a fill.

### Still open

1. Whether a competing order's `issued` moves on anything but a price change. Rocky does not know
   either; the book log will show it if it does.
