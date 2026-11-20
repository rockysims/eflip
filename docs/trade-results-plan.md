# Trade results (results.html) — plan

Branch: a new `claude/trade-results-<hash>` off the `feature/*` branch that carries the export
rework. New: `lib/` (server modules, including `lib/derive.js`), `scripts/sync.js`,
`public/results.html`, `public/results.js`, `public/results-calc.js`, `public/insights.html`,
`public/insights.js`, `test/{results-calc,sso,ledger,derive,server-file}.test.js`,
`.env.example`. Changed: `server.js`, `.gitignore`, `package.json`, `public/export.js` (Copy
persists the run and its market context), `README.md`. Retired at the end:
`public/exportAndSold.*`, `public/env.js`, util.js wallet getters. Out of scope: `index.*`,
`jack.js`, `missing.*`, `resell.*`, `reprocess.js`.

Goal and principle: after an export run (Copy orders → multibuy at the source → item-exchange
hand-off from buyer to seller → courier → list at the destination), show what really happened:
bought, hauled, sold, at what prices and fees, what is still unsold, realized profit, and how each
figure compares with the export page's prediction. Every figure comes from the user's own ESI data
(wallet, orders, assets, contracts), or from ESI market data for current prices. EVE tokens never
reach `public/`, the browser, git or `cache/`: the Express server holds them, and pages call a few
`/api/...` routes.

Data principle (2026-11-13): save raw first, derive later. Every ESI response is stored verbatim,
with its fetch time and the headers that matter (`ETag`, `Expires`, `Last-Modified`, `X-Pages`,
`X-Ratelimit-*`), under `data/raw/<characterId>/<route-slug>/<fetchedAt>.json`; public routes go
under `data/raw/public/...`. A 304 stores nothing, and a body whose content hash equals the last
stored one is not stored again. Ledgers and snapshots are derived views that `lib/derive.js`
rebuilds from raw, so a wrong rule is fixed by re-deriving, never by re-fetching. ESI forgets
wallet rows after about 30 days; raw is the one copy that keeps everything that might be useful
later, including data no rule uses yet.

Terms used below:
- **run**: the export report snapshot saved when the user presses "Copy orders" on the export
  page; `copiedAt` is that moment.
- **batch**: the finished item-exchange contract from the buying character to the selling
  character, which says what was actually exported.
- **courier**: the courier contract that carries a batch from S to D.
- **bonus**: a player donation to that courier's hauler.

## Recommendation

1. **Confidential client run by the Express server** (your prior, confirmed). CCP describes the
   client-secret Authorization Code flow as "suitable for web applications that can securely store
   the client secret on the server side", and PKCE as for apps that cannot. Further reasons:
   - The revocation endpoint requires client auth (the metadata lists only
     `client_secret_basic|post|jwt`), so only a confidential client can revoke a token when a
     character is removed.
   - A leaked `data/tokens.json` is useless without `EVE_CLIENT_SECRET`.
   - PKCE-in-browser would keep refresh tokens in browser storage, which is what we are removing.
2. **Token lifecycle.**
   - Refresh tokens live in `data/tokens.json`: gitignored, mode 0600, written atomically (temp
     file + rename).
   - Access tokens stay in server memory only. CCP's example gives `expires_in: 1200`. Refresh on
     demand when less than 60 s remain.
   - Refresh is single-flight per character. Always store the returned `refresh_token`: CCP says it
     "MIGHT change when it is refreshed".
   - A 4xx from the token endpoint (`invalid_grant`) sets `status: 'relink'` and stops syncing that
     character, keeping its ledger. Only network errors are retried.
3. **JWT verification with zero new dependencies.** Node 24 provides `fetch`,
   `crypto.createPublicKey({key: jwk, format: 'jwk'})` and `crypto.verify`.
   - Find `jwks_uri` in `https://login.eveonline.com/.well-known/oauth-authorization-server`.
     Cache the JWKS for 5 min and refetch once on an unknown `kid`.
   - The live JWKS (2026-11-12) holds an RS256 key (`kid: JWT-Signature-Key`) and an ES256 key, so
     verify both. ES256 needs `dsaEncoding: 'ieee-p1363'`.
   - Checks: `iss` ∈ {`https://login.eveonline.com`, `login.eveonline.com`} (the scheme was added
     on 1 Nov 2023; CCP still says to accept both); `aud` contains `EVE_CLIENT_ID` and
     `"EVE Online"`; `exp` > now − 30 s; `sub` matches `^CHARACTER:EVE:(\d+)$`.
   - Keep `name`, `owner` and `scp`. Normalize `scp` to an array: the community reports a single
     scope arriving as a string (undocumented). If `owner` changes, the character was transferred:
     treat it as relink.
4. **Characters.** All linked characters form one pool, so buyer and seller may differ or be the
   same character.
   - "Add character" re-runs SSO, and re-linking replaces the token.
   - "Remove" revokes at CCP (`POST /v2/oauth/revoke`, `token_type_hint=refresh_token`, Basic auth;
     it returns 200 even for unknown tokens) and drops the token. The synced ledger stays unless
     "delete synced data" is ticked.
5. **The browser never sees access tokens, and there is no generic ESI proxy.** Wallet history has
   to be persisted server-side anyway (ESI keeps about 30 days), so the server fetches it itself
   behind task-specific routes. A token-attaching `GET /api/esi/*` or a `GET /api/token/:id` would
   let anything that can reach localhost act as the character: other local processes, DNS
   rebinding, today's open CORS relay.
6. **Hardening first.** Three verified problems in today's server must be fixed before any token
   touches disk (the first is already fixed on this branch, see Phase 1):
   - `GET /file/..%2F.env` resolves to `cache/../.env`. Express decodes `%2F` in `:path` (tested
     with the installed express 4.22.3), so any file can be read or overwritten through `POST`.
   - The unused `cors-anywhere` on :4000 relays any web page's requests to `localhost:5001` with
     CORS headers added.
   - `app.listen(port)` binds every interface.

## ESI facts this plan relies on (checked 2026-11-12; groups, cache timers and journal shapes confirmed live 2026-11-19)

- **URL style.** Use base `https://esi.evetech.net` with no `/latest/`, no `datasource=` and no
  trailing slash. Send `X-Compatibility-Date: 2026-08-18`, pinned as `ESI_COMPAT_DATE`. It was the
  newest entry in `/meta/compatibility-dates` when the spec was checked; `2026-11-19` has since been
  added and is not adopted until the spec is re-checked against it.
  - The response header `X-Compatibility-Date` names the route version that answered, not the
    request: every route tried on 2026-11-19 echoed `2020-01-01` whatever date was sent (and with
    none), with `vary: X-Compatibility-Date`. Do not read it as "header ignored".
  - Old `/latest/...?datasource=tranquility` URLs still answer 200 with identical `X-Pages`, and
    CCP says versioned routes "will work for the foreseeable future". They are no longer in the
    OpenAPI spec.
  - util.js's wallet URLs become `/characters/{id}/wallet/transactions` and
    `/characters/{id}/wallet/journal?page=N`, and move to the server. Migrating the public market
    URLs is a separate follow-up.
- **Rate limits.** Floating 15-min token buckets keyed by (group, `applicationID:characterID`), so
  they never compete with the export page's IP-keyed `market-order` bucket.
  - Cost: 2xx = 2 tokens, 3xx = 1, 4xx = 5, 5xx = 0.
  - Headers: `X-Ratelimit-Group/Limit/Remaining/Used`, `Retry-After` on 429.
  - Routes with no group fall under the legacy limit: 100 non-2xx/3xx responses per minute, then
    420.
  - A 401/403 costs 5 tokens: never retry a bad token in a loop.
  - Observed live 2026-11-19 (Ivan): every 200 cost 2 tokens; the groups and limits are as in the
    table below; `orders`, `orders/history` and `/universe/structures` carry only
    `X-Esi-Error-Limit-Remain/Reset`. `Expires` deltas: wallet balance 2 min, `orders` 20 min,
    `contracts` 5 min, `skills` 60 s, every other route 60 min.
- **Scopes.** `esi-wallet.read_character_wallet.v1`, `esi-markets.read_character_orders.v1`,
  `esi-assets.read_assets.v1`, `esi-contracts.read_character_contracts.v1`. The character id and
  name come from the JWT, so no extra scope is needed for them.
  - Added 2026-11-13, because a scope added later means re-linking every character (Server
    changes 7): `esi-skills.read_skills.v1` (the trade skills explain the real broker and tax
    rates the export page assumes as constants), `esi-characters.read_standings.v1` (the broker
    fee depends on standings) and `esi-universe.read_structures.v1` (structure names). All three
    confirmed against the OpenAPI spec (compatibility date 2026-08-18) on 2026-11-13.

| route `/characters/{id}/…` | scope | group, tokens/15 min | ESI cache | paging | retention |
|---|---|---|---|---|---|
| `wallet/transactions` | wallet | `char-wallet` 150 | 3600 s | `from_id` (rows before it) | ~30 days (community) |
| `wallet/journal` | wallet | `char-wallet` 150 | 3600 s | `page` + `X-Pages` | "30 days back" (spec) |
| `orders` | orders | none (error limit) | 1200 s | none | open orders |
| `orders/history` | orders | none (error limit) | 3600 s | `page` + `X-Pages` | 90 days, cancelled/expired |
| `assets` | assets | `char-asset` 1800 | 3600 s | `page` + `X-Pages` | snapshot |
| `contracts`, `contracts/{cid}/items` | contracts | `char-contract` 600 | 300 / 3600 s | `page` + `X-Pages` (list only) | 30 days or `in_progress` (spec) |
| `skills` | skills | `char-detail` 600 | 60 s (event-based) | none | snapshot; refreshed daily |
| `standings` | standings | `char-social` 600 | 3600 s | none | snapshot; refreshed daily |
| `/universe/structures/{id}` (not under `/characters/`) | structures | none (error limit) | 3600 s | none | fetched once per structure id |

**Contracts.** Batches and couriers (rules 2, 6, 7) rely on these:
- `/characters/{id}/contracts` (`esi-contracts.read_character_contracts.v1`) returns a contract
  only if the character is its issuer, acceptor or assignee, and only if it is no older than 30
  days or `in_progress` (spec). A hand-off between two linked characters is in both ledgers:
  merge by `contract_id`.
- Fields used: `contract_id, type, status, issuer_id, assignee_id, acceptor_id, start_location_id,
  end_location_id, date_issued, date_accepted, date_completed, reward, collateral, volume`.
  - `type` includes `item_exchange` and `courier`. `status` has `finished`, `finished_issuer` and
    `finished_contractor` besides `outstanding`, `in_progress`, `failed` and others.
  - The spec marks `reward`, `collateral` and both locations "for Couriers"; `date_accepted` and
    `date_completed` are optional.
- `/characters/{id}/contracts/{cid}/items` has no paging. Fields used: `type_id, quantity,
  is_included, is_singleton, record_id`. `is_included: true` means the issuer put the item in;
  `false` means the issuer asks for it.
- Journal: `player_donation` and the `contract_*` ref_types are in the spec's enum, but the spec
  says `first_party_id`/`second_party_id` have no consistency across ref_types.
- Confirmed in the Phase 2 sample (Ivan, 2026-11-19): a completed hand-off reads `finished` with
  `date_completed` equal to `date_accepted`; a hand-off deleted before acceptance reads `deleted`
  with no `date_accepted`/`date_completed`, and its items are still readable. `player_donation`:
  the payer is `first_party_id` and the receiver `second_party_id`; the row is positive in the
  receiver's journal and has no `context_id`. Grant's capture (same day) adds: a delivered
  courier reads `finished` with `date_accepted` and `date_completed` set (accepted 1–8 min after
  issue, delivered 1.5–3 h later); a courier deleted unaccepted reads `deleted`; the items of all
  nine contracts, deleted ones included, were readable. Still open: whether items stay readable
  once a contract drops off the 30-day list (no contract that old yet; sync fetches items on first
  sight either way).

**Gotchas.**
- `is_personal: false` marks a corporation-wallet trade: excluded.
- `client_id` is the counterparty. A trade between two linked characters is internal: excluded.
- Do not rely on `journal_ref_id`. For sells it matched the `market_transaction` row for only 3 of
  106 transactions; the other 103 pointed two ids past it, at a row absent from the seller's
  journal (the buyer's side, by the look of it). The reliable link runs the other way: the
  `market_transaction` row's `context_id` is the `transaction_id` (106 of 106, amount equal to
  `unit_price` × `quantity`). For buys there is no `market_transaction` row at all: the fill
  posts as a `market_escrow` row ("Market escrow release", negative, `context_id_type:
  market_transaction_id`, amount equal to `unit_price` × `quantity`); there `journal_ref_id` did
  point at that row (73 of 74), but the `context_id` link works too.
- Journal `context_id` means something different per `ref_type`; read `context_id_type`.
  Observed: `contract_price` and `contract_brokers_fee` → `contract_id` (every row matched the
  contract list); `market_escrow` → `market_transaction_id`; `skill_purchase` → `type_id`;
  `brokers_fee`, `transaction_tax` and `player_donation` carry no `context_id` at all. A tax row
  is matched to its sale by timestamp: 102 of 106 tax rows shared their second with exactly one
  transaction, and the tax row's `id` is the `market_transaction` row's `id` + 1 (101 cases) or
  + 2 (3), which settles the few seconds holding two sales. A broker fee can only be time-matched.
- `brokers_fee` rows include relist fees, but an order's `issued` shows only its latest placement
  or modification. Seen: of four `brokers_fee` rows, two fell within two minutes of an order's
  `issued` and two matched nothing (earlier modifications of the same order). Grant's side is
  worse: 214 fee rows in 13 days (up to 34 a day, from relisting), only 85 within two minutes of
  any order's `issued`, and the fee divided by `price` × `volume_total` gives no single rate
  (0.1 % to 2.4 %), because a modification charges on the price change. Read fees from the
  journal; never derive a broker rate from them.
- `market_escrow` is ignored for cost (cost comes from transactions), but it is the only journal
  footprint of a buy; escrow deposits and refunds for limit buy orders appear as further
  `market_escrow` rows with no matching transaction.
- Immediate orders (buying straight from the book, `duration: 0`) appear in `orders/history` as
  `expired` with `volume_remain: 0`, exactly like a filled limit order. They paid no broker fee, so
  the relist view and any "orders placed" count must skip `duration: 0`.
- Sell orders omit `is_buy_order`, `escrow` and `min_volume` in both `orders` and
  `orders/history`: a missing `is_buy_order` means a sell.
- The sales tax rate moved twice inside one 13-day window (7.5 % until 2026-11-10, 3.75 % to
  2026-11-16, 2.1 % after: skill training). Take tax from the `transaction_tax` row, never from a
  constant; skills explain the rate only for the prediction.
- Courier journal rows on the issuer's side: `contract_reward_deposited` (minus the reward at
  creation), `contract_deposit` (0.1 % of the reward, 10 000 ISK at least, returned as
  `contract_deposit_refund` on delivery and kept on deletion), `contract_brokers_fee` (11 000 ISK
  flat in the sample) and, on deletion, `contract_reward_refund` (plus the reward). So a delivered
  courier costs reward + broker fee and a deleted one broker fee + deposit. The hand-off's
  `contract_price` is negative on Grant's side and positive on Ivan's, and its broker fee falls
  on the issuer (Ivan).
- Hauler bonuses in the sample: two `player_donation` rows to the courier's `acceptor_id`, 4 min
  and 49 min after `date_completed`, 19–36 % of the reward; the third donation was a 1 B ISK
  transfer to Ivan (internal, excluded). Rule 7's 24-hour window holds.
- `orders/history` reached back 144 days (an order issued 2026-06-28 that expired 2026-09-26 was
  still listed 54 days later), so "90 days" counts from the order's end, not its start.
- Other ref_types turn up (`gm_cash_transfer`, `skill_purchase`): ignore for profit, keep in raw.

## Data model

Server files live under `data/` (gitignored; `EFLIP_DATA_DIR` overrides the location):

- `data/tokens.json`: `{version: 1, characters: {<id>: {characterId, name, ownerHash, scopes,
  refreshToken, linkedAt, refreshedAt, status: 'ok'|'relink', lastError}}}`.
- `data/raw/<characterId>/<route-slug>/<fetchedAt>.json` (public routes: `data/raw/public/...`):
  every 200 response verbatim with its headers (Data principle). `lib/derive.js` builds everything
  under `data/ledger/` from these and can rebuild it from scratch.
- `data/ledger/<characterId>/{transactions,journal,orders-history,contracts}.json`. Arrays merged
  by `transaction_id` / `id` / `order_id` / `contract_id`. Rows only accumulate, and order/contract
  status is last-write-wins. This is the durable history that outlives ESI's 30-day window.
- `data/ledger/<characterId>/contract-items/<contractId>.json`: fetched once, never again.
- `data/ledger/<characterId>/snapshots/<syncedAt>.json`: `{syncedAt, orders, assets, balance}`,
  one file per sync, kept (2026-11-13; it used to be one file replaced each sync). A sync whose
  content hash equals the previous snapshot's writes nothing. Keeping them gives: the first sync
  that saw an `order_id`, which is the true listing time (ESI's `issued` is the last
  modification); the price path and relist count per order; fill timing between snapshots as a
  cross-check on transactions; stock aging per station; and capital at work over time (Phase 8).
- `data/ledger/<characterId>/profile.json`: `{fetchedAt, skills, standings}`, refreshed daily; the
  raw copies keep the history.
- `data/esi-cache/<characterId>/<route-slug>.json`: `{etag, expires, body, pages}`.
  - Keyed by path and query, never by token.
  - Sends `If-None-Match` (a 304 costs 1 token) and skips the call while `Expires` is ahead.
- `data/runs/<runId>.json`: persisted export runs (see Comparison).

**Why not `getOrFetch` for character data.** Its file name is the URL with non-alphanumerics
stripped, and the token travels only in the header, so no token lands in a name or body
(checked). But:
- the bodies would sit in disposable `cache/`, readable through `/file/`;
- cache hits lose `X-Pages`/`ETag`;
- the journal loop probes up to 100 pages and costs 5 tokens per 4xx.

The page keeps `util.getOrFetch` for type names and `packaged_volume`. "At market" values come
from `GET /api/market`, the destination market snapshot the last sync stored raw (Sync 5), so the
results page shows nothing that is not on disk.

**Sync** (`lib/sync.js`) runs per character when export.html or results.html loads and more than
60 min have passed since the last sync, on "Sync now", or from `node scripts/sync.js`: the same
modules without the server, for a launchd job (README gives an optional plist that runs it daily,
so a long break does not lose a month of wallet history):
1. Transactions: without `from_id`, then `from_id = min(transaction_id)` until a batch is empty,
   all known, or older than the last sync.
2. Journal: page 1, then the rest of `X-Pages`.
3. Open orders, orders history, assets, wallet balance, contracts, and the items of each new
   courier or item-exchange contract.
4. Skills and standings, at most once a day.
5. Destination market snapshot: for every type that is held, listed, in transit or sold in the
   last 90 days, the destination region's current orders for that type and its daily history,
   stored raw. At most 300 types per sync, and only after any export run in progress finishes,
   since it draws on the IP-keyed `market-order` bucket the export page shares. Gives: competition
   at listing time against days to sell, the user's share of regional daily volume, and realized
   price against the daily average (Phase 8).
6. Store raw, derive, then record `syncedAt`, errors and rate-limit headers.

**Budget.** One sync is about 3–5 `char-wallet` calls (≤ 10 of 150 tokens), 1–10 contract calls,
1–3 asset pages, and once a day one skills and one standings call. The destination market
snapshot adds up to 300 order calls (≤ 600 of the 12000 `market-order` tokens, 2 per call, which
is why it waits for a run in progress) and up to 300 history calls (no bucket: the legacy error
limit).
Syncs are at most hourly, which matches the cache timers. Price lookups take 2 tokens per held
type from the same market-order bucket. A group with `X-Ratelimit-Remaining` below 20 % pauses
until `Retry-After` or the window passes.

Added by Phase 3 (2026-11-19), beside the files above:

- `data/esi-cache/<characterId|public>/<route-slug>.json`: per-route bookkeeping `{url, etag,
  expires, pages, checkedAt, status}` with no body, plus a remembered 403 (`forbiddenUntil`, 30 days)
  or a remembered 404 (`notFound`; market history also answers 400 "not tradable" for a type with no
  market, treated the same). `data/esi-cache/<owner>/_sync.json` holds each owner's last sync
  (`syncedAt`, status, errors, walk completeness, `profileCheckedAt`); `data/esi-cache/_limits.json`
  holds the rate-limit state the server and `scripts/sync.js` share.
- `data/raw/<owner>/_sync-log/<syncedAt>.json`: one entry per sync that called ESI, naming the raw
  files behind that sync's snapshot; derive rebuilds the retained snapshots from it. A sync that
  made no call writes none, and `syncedAt` moves only when a call went out, so a page-load sync
  that found nothing due does not delay the next one. A snapshot is written only when orders,
  assets and balance were all current in that sync.
- `data/locks/<name>.lock`: one lock per character and one for the market, so the server and the
  script never sync the same owner at once; a lock whose process is gone is taken over.
- `data/ledger/structures.json`: structure names by id, shared by all characters; `/api/ledger`
  returns it beside the characters. `profile.skills` is the skills array (`total_sp` stays in raw).
- Market snapshot: the cap of 300 counts (region, type) pairs, chosen by priority (listed, in
  transit, held, sold in 90 days) then least recently checked, so successive runs rotate through
  the candidates; order calls are budgeted at twice the type count with at most five pages per
  book. The destination region is the end region of the newest run in `data/runs/`, else the
  region holding most of the characters' sell orders. Types with no market are remembered and
  no longer take a slot.
- Routes: `POST /api/sync` takes `{characterIds?, force?, market? (default true), regionIds?}`,
  runs the characters one after another and then the market, and without `force` skips an owner
  synced within the hour (`market: false` lets the export page defer the market step during a
  run); `GET /api/sync` reports per-character status and progress; `/api/ledger` keys are
  camelCase (`ordersHistory`, `contractItems`) plus `sync` and `profile`, and `since` filters by
  `date`, `issued` or `date_issued`; `/api/market?typeIds=&regionIds=` answers
  `{regionIds, syncedAt, types: {typeId: {regionId: {orders, history}}}}` from raw.
- Removing a character with `?purge=1` deletes its ledger, raw and ESI bookkeeping together (a
  ledger deleted alone would be rebuilt from raw) and answers 409 while that character syncs.

## Profit accounting rules (`public/results-calc.js`, pure, UMD like `estimate.js`)

Inputs: the merged ledgers of the selected characters (set L), the route (source station S,
destination station D), the runs, packaged m3 per type, the window, and the bonus toggle.

1. **Scope.** Count transactions of L with `is_personal: true` and `client_id` ∉ L.
   - Every buy, at any location, becomes a lot. Batches (rule 2) decide what counts as exported.
   - Sell: `!is_buy && location_id === D`. Other sells show as a count and stay out of P&L.
   - Each lot keeps an informational "elsewhere" tag: at S, same region, or other.
2. **Lots and batches.** Each buy becomes `{typeId, qty, unitPrice, date, characterId, locationId,
   batchId, runId, courierId, haulPerUnit, buyFeePerUnit}`.
   - Buying from sell orders carries no broker fee and no tax.
   - Fills of the user's own buy orders at S take that order's attributed `brokers_fee` (rule 5).
   - A **batch** is a `finished` `item_exchange` contract whose issuer and assignee or acceptor are
     both in L: the buyer handing the goods to the seller. Its items with `is_included: true` give
     `{typeId, qty}` per type.
   - Batches are taken in `date_issued` order. For each type, a batch consumes the **newest**
     not-yet-batched lots of that type bought by L before its `date_issued`, newest first (any
     location), splitting a lot if needed: the buyer bought them for this hand-off, and older
     unbatched lots are something else. Consumed lots get its `batchId`. Units the lots cannot
     cover are the batch's `unsourcedQty`: shown, flagged `unsourced`, and warned about (UI 2).
   - No unit is counted twice: once a batch has taken units of a lot, no later batch can take them,
     so two hand-offs issued back to back split the lots between them. If both contain the same
     type, newest-first may hand the first contract the later purchase; the totals are unchanged,
     only the split of cost between the two batches. Accepted (decision 10).
   - Lots no batch consumes stay unbatched and show as a count, not as P&L exclusions.
3. **FIFO per type, pooled across L.** Order lots by `date`, then `transaction_id`. Each sell at D
   consumes the oldest units and records `{sellTxId, lotId, qty}`.
   - Lots that have arrived go first: carried by a `finished` courier (rule 6), through their
     batch. Then any lot of that type, flagged `unarrived`.
   - Sold units with no lot left are `uncoveredQty`: shown, but kept out of realized profit.
   - FIFO is preferred over average cost because each run's lots stay distinct, which gives
     per-run profit and sell-out time directly. Averaging would blur back-to-back runs bought at
     different prices.
4. **Sales tax.** Each sell takes its `transaction_tax` row: by `context_id === transaction_id`
   if the sample confirms it, else same character, |Δt| ≤ 2 s and amount within 1 % of the
   expected rate. Unmatched sells use the median matched rate (else `SALES_TAX`), flagged `est`.
5. **Broker fees.** Each `brokers_fee` row of L is matched to an order:
   - (a) by `context_id`, if the sample shows it holds an order id;
   - (b) else the same character's order (open or history) at S or D whose `issued` is within 2 s;
   - (c) unmatched rows (mostly older relists) are spread over types pro rata by gross sell value
     at D in the window, flagged `est`.

   Sell orders at D add to the type's sell fees; buy orders at S add to `buyFeePerUnit`.
6. **Hauling.** Counts courier contracts (`type === 'courier'`) issued by L from S (or S's solar
   system) to D (or D's system), taken in `date_issued` order. A courier carries each batch with
   no courier yet whose `date_issued` ≤ its own and whose types overlap its items.
   - Cost = −Σ journal rows of L with `context_id === contract_id` and ref_type in
     `contract_reward_deposited`, `contract_reward_refund`, `contract_brokers_fee`,
     `contract_deposit`, `contract_deposit_refund`, plus its bonuses when counted (rule 7).
   - Split by packaged volume over the courier's items (`is_included: true`), else over its
     batches' items: `share_T = qty_T × m3_T / Σ qty × m3`. The per-unit cost goes to the lots of
     the batches it carries, so several batches in one courier share it by m3.
   - A courier with no batch works as before: the per-unit cost goes to the oldest
     not-yet-hauled lots of T bought before `date_issued`; with no item list, it is spread per m3
     over the issuer's unhauled lots at S.
   - A `failed` contract shows a banner; losses are out of scope.
7. **Internal flows and hauler bonuses.** Ignore `player_donation` between L characters and the
   price of item-exchange contracts within L; their fees are haul cost on that batch's lots, split
   by m3 as in rule 6.
   - A **bonus** is a `player_donation` from L to a character not in L whose `second_party_id` is
     the `acceptor_id` of one of L's courier contracts, dated from its `date_accepted` to
     `date_completed` + 48 h (the user pays within 24 h of completion; open-ended while in
     progress). It adds to that courier's cost; if several couriers qualify, the most recently
     accepted one takes it.
   - The results-page toggle "count hauler bonuses" (default on) includes them.
   - Other donations to outsiders are listed as "other donations" and never counted.
8. **Realized**, per type, over sells in the window:
   - `gross = Σ unit_price × qty`, plus `tax`, and `broker` (the type's sell fees dated in the
     window).
   - `cogs = Σ consumed (unitPrice + haulPerUnit + buyFeePerUnit) × qty`.
   - `realizedProfit = gross − tax − broker − cogs`; `netPerItem = (gross − tax − broker) /
     soldQty`.
9. **Remaining.** Two views:
   - Accounting: lot units left after FIFO, valued at cost and "at market" (best D sell − 0.01,
     × (1 − observed tax rate − `BROKER_FEE`)).
   - Physical, from the snapshot: `atSource` (assets at S, containers resolved through `item_id`),
     `inTransit` (outstanding or in-progress courier items), `atDest` (assets at D), `listed`
     (open sell orders at D).
   - If the views disagree the row gets a `mismatch` flag: pre-existing stock, use elsewhere, or a
     missed sync.
10. **Pace.** `daysOnMarket` runs from `listedAt` (the carrying contract's `date_completed`, else
    the first sell) to the sell that used the last unit, or now. `sellRate = soldQty /
    max(daysOnMarket, 1)`.
11. **Window.** "Since <date>" (presets 7/30/90 days) or one run. FIFO always runs over the whole
    ledger; the window only selects what is summed. Totals include a journal cross-check like
    today's `exportAndSold` line: the window's market + tax + broker + contract + donation flows,
    against the attributed sum, with the difference shown as "unattributed".
12. **Outputs** (2026-11-13). Besides the per-type rows the table shows, `results-calc.js`
    returns the **fact table**: event-level arrays that every chart groups for itself, so no
    chart has accounting of its own.
    - `sells`: one row per sell allocation (a sell transaction split over the lots it consumed):
      `{date, eveHour, weekday, typeId, characterId, qty, unitPrice, tax, brokerShare,
      relistShare, haulShare, buyCost, lotId, batchId, runId, courierId, daysSinceListed,
      daysSinceArrived}`.
    - `fees`: one row per journal fee row (`brokers_fee`, `transaction_tax`, `contract_*`,
      counted donations) with its attribution (order, type, batch or courier) and the `est` flag.
    - `lots`: rule 2's lots plus `soldQty`, `firstListedAt` (the first snapshot that saw the sell
      order) and `lastSoldAt`.
    - `relists`: per `order_id`, the price path across snapshots and the fee rows matched to it.

## Comparison to the prediction

1. **Persist runs** on "Copy orders" with `POST /api/runs`. This replaces `/file/`, which writes
   to the disposable cache without validation. Body:
   `{id, copiedAt, reportGeneratedAt (ISO), route: {start, end, startStationId, endStationId,
   startRegionId, endRegionId}, horizonDays (runDaysToComplete), config: {SELL_TAX, SALES_TAX,
   BROKER_FEE, HAULING_REWARD_FRACTION, MIN_ROI}, rows: [{typeId, name, m3, qty, factor,
   recommended (report.volume), costPerItemMil, revenuePerItemMil, sellPriceMil, profitPerItemMil,
   dailyProfitMil, daysToClear, dailyDemand, competingVolume}], totals: {costMil, revenueMil,
   profitMil, km3}, lastCopiedAt, copyCount, context}`.
   - `id = <route>-<reportGeneratedAt ISO>-<contentHash>`, where the content hash covers the
     copied rows' `typeId` and `qty` only. A later click with identical content updates
     `lastCopiedAt` and `copyCount` on the same file (Rocky: "don't save 3 times for 3 clicks if
     the copied orders didn't change between the clicks"). A changed selection, factor or filter
     makes a new run; a new Run makes a new `reportGeneratedAt`.
   - A run is the plan, not the truth. Rocky: "A copy orders click definitely cannot be depended
     on to match up one to one with actually purchased orders." The batch (the hand-off contract)
     says what was exported; the run is only what it is compared against (item 2).
   - `context` (2026-11-13): for each copied row, the top 20 of each order book the estimator
     used (source and destination, buy and sell: `price, volume_remain, issued, duration, range`)
     and the destination daily history rows it used. Written with the first copy of a run id.
   - If the POST fails the button shows "Copied (run not saved)" and the clipboard still works.
2. **Batches to runs.** A batch (accounting rule 2) belongs to the latest persisted run with
   `copiedAt` ≤ its `date_issued` and at most 7 days before it; otherwise it gets `runId: null`
   and shows as an "unplanned batch". Its lots inherit its `runId`; batch types the run does not
   list are flagged `unplanned`.
   - A run with no batch yet (the hand-off not issued, or not synced) shows "waiting for the
     hand-off contract": its predicted rows, no actuals.
3. **Per run, per type:**

   | predicted | actual |
   |---|---|
   | `qty` | batched (fill %) |
   | `costPerItemMil` (includes the 10 % haul allowance) | landed cost/item (buy + haul + fee) |
   | `sellPriceMil` | average gross sell price |
   | `revenuePerItemMil` (net of `SELL_TAX`) | `netPerItem` |
   | `profitPerItemMil × bought` | realized + unrealized at market |
   | `daysToClear` | `daysOnMarket`; while unsold, `daysOnMarket / soldFraction` shown as "proj." |

   Run-mode broker fees: the type's fees from `copiedAt` to sell-out (or now) × the run's share of
   that type's units sold or listed in that span.

## UI (`public/results.html`, `public/results.js`)

Same idiom as `export.html`: vanilla JS, its CSS (sticky header and totals, right-aligned numbers,
sortable headers, `dim`, explanatory tooltips), `moment` from cdnjs, and `util.js` for public
lookups.

1. **Characters strip.** One chip per character: 32 px portrait (`images.evetech.net`), name, and
   a status: "ok · synced 12 min ago", "missing scope: …", "re-link needed" (button), or "sync
   failed: …" (retry).
   - Each chip has Sync and Remove. Remove asks to confirm and offers "also delete synced data".
   - The strip ends with "+ Add character" (link to `/sso/login`) and "Sync all".
2. **Window bar.** Run dropdown (`copiedAt · route · n types · predicted profit`), or "since"
   (7/30/90 days or a date) with a route selector, plus search, "show sold out" and "count hauler
   bonuses" (default on).
   - In run mode, the run's batches are shown under it with their item-exchange and courier
     contract ids and the courier's reward. Unplanned batches get their own dropdown entry.
   - A batch with `unsourcedQty` gets a warning line under it, one per type: "n × <type> in
     contract <id> has no matching purchase (synced through <date>)", and the run's dropdown entry
     carries a warning mark. Usual causes: a buy older than the synced history, a buy by a
     character that is not linked, or stock that was never bought on the market.
3. **Table, one row per type:**
   - name + type id, with flags `unplanned` / `unsourced` / `unarrived` / `est` / `uncovered` /
     `mismatch`;
   - bought qty/avg, sold qty/avg gross, tax, broker, haul, COGS, realized profit, margin %;
   - remaining (source/transit/hangar/listed, broken down in the tooltip), unrealized at cost and
     at market, days on market, sell rate/day;
   - run mode adds predicted vs actual for qty, net rev/item, days to clear and profit, with Δ in
     green (better) or red (worse);
   - Phase 8 adds an inline profit bar per row and a stacked cost bar (buy / haul / tax / broker /
     relist against gross), CSS only.

   Default sort: realized profit, descending.
4. **Totals strip.** Spent, gross sales, tax, broker, haul (with bonuses if counted), realized
   profit and ROI, unrealized at cost and at market, predicted profit (run mode), the cross-check
   remainder, and the counts of unbatched lots, unsourced units and other donations.
5. **States.**
   - Empty: SSO not configured (`GET /api/config`) shows the setup steps. No characters shows
     "Link the characters that buy and sell". No trades in the window offers "widen window".
   - Loading: a per-character progress line ("Ivan: journal 2/3"), with the last synced data kept
     visible.
   - Error: a token failure shows "Re-link Ivan" on the chip and the rest still renders. 429/420
     shows "rate-limited, retrying at hh:mm". ESI 5xx shows a "stale since" banner. If `syncedAt`
     is older than 25 days, warn "older trades and contracts may be lost (ESI keeps 30 days)".
   - Overflow: sort, search, sold-out rows hidden by default, sticky header, no pagination.
6. **Retire** `exportAndSold.*` once the 30-day totals match it.
7. **Insights page** (`public/insights.html`, Phase 8): the charts, on a separate page that shares
   this window bar and `results-calc.js`. The table above stays the at-a-glance view.

## Server changes

1. **`lib/` modules.**
   - `lib/sso.js`: metadata/JWKS cache, authorize URL, code exchange, refresh, revoke,
     `verifyJwt`.
   - `lib/tokenStore.js`.
   - `lib/esi.js`: compat date, `User-Agent`, ETag cache, rate limits, paging.
   - `lib/ledger.js`, `lib/sync.js`, `lib/derive.js` (raw → ledger, snapshots and profile;
     rebuildable from scratch).
   - `scripts/sync.js`: one sync from the command line without the server, same modules (for the
     optional launchd job).
   - `lib/api.js`: an express Router mounted once in `server.js`, so later phases do not collide
     there.
2. **SSO routes.**
   - `GET /sso/login?return=/results.html` stores a random `state` in an HttpOnly, SameSite=Lax
     `eflip_sso` cookie and server-side for 10 min. It then 302s to `/v2/oauth/authorize` with
     `response_type=code`, `client_id`, `redirect_uri`, space-separated `scope` and `state`.
   - `GET /sso/callback` checks `state` against the cookie and the map. It exchanges the code with
     `grant_type=authorization_code` and Basic `base64(id:secret)`, falling back to
     `client_secret_post`, which the metadata also lists. It then verifies the JWT, stores the
     token, and 302s to `/results.html?linked=<id>` or `?ssoError=<code>`.
3. **API routes.** `GET /api/config`, `GET /api/characters`, `DELETE /api/characters/:id[?purge=1]`,
   `POST /api/sync {characterIds?, force?}`, `GET /api/ledger?characterIds=&since=`,
   `GET /api/snapshots?characterIds=&since=` (retained snapshots), `GET /api/market?typeIds=`
   (the latest destination market snapshot), `POST|GET /api/runs`, `GET|DELETE /api/runs/:id`.
4. **Guards.**
   - `/api` and `/sso` reject a `Host` other than `localhost:<port>` or `127.0.0.1:<port>`, and
     an `Origin` that is present but not same-origin. No CORS headers are sent.
   - Listen on `process.env.HOST || '127.0.0.1'`.
   - `/file/:path` (done, `lib/cache-files.js`) answers 400 unless the name matches
     `^[A-Za-z0-9][A-Za-z0-9._-]*$` and resolves inside `cache/`.
   - Remove `cors-anywhere` (no page uses :4000).
5. **`.env` keys** (documented in a committed `.env.example`): `EVE_CLIENT_ID`,
   `EVE_CLIENT_SECRET`, `EVE_CALLBACK_URL=http://localhost:5001/sso/callback`, `ESI_USER_AGENT`
   (app/version/contact, as CCP asks), and optional `EFLIP_DATA_DIR`, `HOST`, `PORT`. With
   `EVE_CLIENT_ID` unset, these routes answer 503 `not configured`.
6. **`.gitignore`:** add `data/`. Then delete the stale `cache/*characters*wallet*` files that
   `exportAndSold` wrote.
7. **Developer app (the user, once).** At `https://developers.eveonline.com/applications`, create
   "eFlip (local)". The create form (as of 2026-11-19) has no connection-type choice: it lists
   scopes grouped by prefix (esi, esi-access, esi-activities, esi-wallet, ...). Expand a group and
   tick the scope; the seven live under esi-wallet, esi-markets, esi-assets, esi-contracts,
   esi-skills, esi-characters and esi-universe (`read_structures` is under esi-universe, not the
   newer esi-structures group). Add the callback `http://localhost:5001/sso/callback`, then copy the Client ID and Secret
   into `.env`. Adding a scope later means re-linking every character, which is why the three
   extra scopes go in now (decision 13).
8. **Local only.** The tool runs on the user's machine only (decision 6): `Procfile` is deleted
   and nothing depends on `NODE_ENV`. The Host and Origin guards (item 4) still apply, for DNS
   rebinding and other local processes.

## Phases

Widened on 2026-11-13 (decisions 11–19): Phase 2 adds scopes, 3 the raw store and snapshots, 4
the fact table, 5 the run context and dedupe, 7 the launchd note; Phase 8 is new.

### Phase 1 — server hardening (sonnet: small, exact spec)
Landed (commit 1dd687d): the `/file/:path` guard, as
`lib/cache-files.js` (`safeCachePath` + `mountCacheRoutes`), with `test/server-file.test.js`.

Remaining scope: `lib/api.js` (empty router + Host/Origin guards), the `HOST` bind to 127.0.0.1,
dropping `cors-anywhere` from `server.js` and `package.json`, deleting `Procfile`, `data/` in
`.gitignore`, and a README note on `HOST`/`PORT` and local-only use. No `public/` edits.

Gate:
- `node --test` passes.
- Regression check: `curl -i localhost:5001/file/..%2F.env` still returns 400, and normal cache
  reads still work.
- `/api` rejects a foreign `Host` or `Origin`.
- The export page still runs, `lsof -i :5001` shows 127.0.0.1 only, and nothing listens on :4000.

### Phase 2 — SSO and token store (opus: security-sensitive, verify live)
Scope: `lib/sso.js`, `lib/tokenStore.js`, `/sso/*` (requesting all seven scopes; verify the three
added strings against the spec first), `/api/config`, `/api/characters` (GET and DELETE),
`.env.example`, `test/sso.test.js`. Tests: RSA and EC keys from
`crypto.generateKeyPairSync`; bad iss/aud/exp/signature; string `scp`; single-flight refresh and
token replacement, with `fetch` stubbed.

Gate:
- Tests pass.
- User + Fable: link a character. `data/tokens.json` has mode 0600 and `git status` is clean.
  Remove it (revoke returns 200), then re-link. Done 2026-11-19: Ivan linked
  with all seven scopes, `tokens.json` 0600 inside a 0700 `data/`, status clean, removed with the
  revoke accepted, re-linked; Grant linked. `/universe/structures/{id}` answered 200 for both
  tokens on a public structure, so that scope works.
- Sample capture: an uncommitted script writes anonymized `brokers_fee`, `transaction_tax`,
  `market_transaction` and `contract_*` rows, plus matching transactions and orders, to
  `data/samples/`. Also a hand-off `item_exchange` and its `courier` contract, both with items,
  and a `player_donation` to that courier's hauler, plus `orders/history` rows including one sell
  order that sold out.
- Fable writes the observed `context_id_type` values, the Contracts "to confirm" answers, the
  filled-order reading of `orders/history` and the new routes' rate-limit groups (Still open) into
  this doc before Phase 4 freezes rules 2 and 4–7. Buy side written 2026-11-19 from Ivan's
  capture: `data/samples/raw/<id>/<route>/<fetchedAt>.json` holds every 200 body with all its
  headers, `summary-*.json` the aggregates and `shapes.json` the field types per route. Grant's
  capture the same day covered the sell side (Gotchas, Still open).

### Phase 3 — ESI client, raw store, sync, ledger (sonnet)
Scope: `lib/esi.js`, `lib/ledger.js`, `lib/derive.js`, `lib/sync.js`, `scripts/sync.js`,
`/api/sync`, `/api/ledger`, `/api/snapshots`, `/api/market`, `test/ledger.test.js`,
`test/derive.test.js`. Includes the raw store, retained snapshots with the content-hash skip, the
daily skills and standings refresh, and the capped destination market snapshot (Data model, Sync
4–5). Tests: dedupe, `from_id` walk, X-Pages, 304 reuse (nothing stored), rate-limit stop, 401 →
relink without retry, an unchanged snapshot writes no file, the 300-type cap, and re-deriving from
raw gives the same ledger as the incremental build.

Gate: tests pass. On a second sync, no ESI calls go out before `Expires`, the ledger grows only by
new ids, `data/raw/` holds every 200 body, and `node scripts/sync.js` runs with the server
stopped.

Done 2026-11-19: 83 tests. Live, the first sync of both characters made 33 calls and a second
run none; `--rebuild` reproduced the ledger byte for byte; `data/` is owner-only; a 40-type market
snapshot stored 79 bodies and read back through `/api/market`. Courier `/items` answered 200 with
an empty list for all four live couriers (ESI hides courier packages), so rule 6's type overlap
never fires on real data and Phase 4 matches couriers to hand-offs by volume instead. Extra files
and route shapes are listed under Data model ("Added by Phase 3").

### Phase 4 — accounting (opus: semantics need care; writes the tests), parallel with 2–3
Scope: `public/results-calc.js`, `test/results-calc.test.js`. Hand-written fixtures, shaped like
the Phase 2 samples, cover:
- FIFO across two characters; uncovered sells; arrived lots first, the `unarrived` fallback;
- tax match and fallback; broker time-match, buy-side fees and the pro-rata remainder;
- batches from item-exchange contracts: lot assignment per type, a split lot, `unsourcedQty`;
- batch → run mapping: the 7-day edge, two runs, an unplanned batch, a run with no batch yet
  (waiting state);
- courier matching to batches; one courier split by m3 over two batches; a courier with no batch,
  with and without an item list;
- hauler bonus matched by acceptor, inside and outside its dates; other donations; the toggle;
  internal flows ignored;
- remaining in both views, days on market and projection, and the cross-check;
- the fact table (rule 12): every `sells` row ties back to a lot and a sell transaction, the
  `sells` sums equal the per-type rows, `firstListedAt` from two snapshots, and one `relists`
  entry with a price path.

Gate: `node --test 'test/*.test.js'`.

Done 2026-11-19: `public/results-calc.js` (UMD, `window.resultsCalc` / `require`), 31 tests. Public
entry `compute(input)` with `input = {characterIds, ledgers (the `/api/ledger` shape plus
`snapshots`), route, locations?, runs, m3, market?, window ({since, until} or {runId}), options,
now}`; output `{window, types, totals, crossCheck, batches, couriers, runs, otherDonations,
uncoveredSells, warnings, observedTaxRate, facts: {sells, fees, lots, relists}}`. Rules sharpened
against the live samples, now binding:

1. **GM refunds** (`netGmRefunds`, default on): a `gm_cash_transfer` equal to the cent to an
   earlier `brokers_fee` of the same character within 30 days voids that fee (Grant's 999.8 M
   price-typo listing fee was refunded by a GM the next day); the GM row itself never counts.
   Confirmed by Rocky 2026-11-19 (decision 20); off, the sample shows a 1 B loss instead of +689 M.
2. **Courier items** come back empty from ESI, so a courier with an empty list claims the
   unclaimed hand-offs issued at or before it at its start location whose summed `volume` best
   fits its own (at most 1 % over; ties prefer the newest). All three live couriers matched.
3. **Dead contracts** (deleted, cancelled, rejected, reversed) claim nothing: a dead courier's
   broker fee and lost deposit roll into the next live courier on the route, a deleted hand-off's
   broker fee into the issuer's next finished hand-off; with no successor the cost stays
   unattributed. An outstanding contract's deposit is pending, not cost.
4. **Tax fallback**: a lone sell within 2 s is accepted when its implied rate is in (0, 10 %];
   the 1 % test only chooses among several; unmatched sells take the nearest matched rate in
   time, same character first, else `SALES_TAX`.
5. **Broker fees**: 2 s window (rule 5b), one fee per (order, `issued`) event, `issued` values
   from history, open orders and every snapshot; the first matched fee on a destination sell order
   is the listing and later ones relists; the pro-rata remainder goes to `relistShare`; fees on
   sell orders elsewhere are `otherOrder`, outside the P&L. Only 32 of Grant's 214 fees match
   from a single snapshot (one known `issued` per order); retained snapshots raise that over time.
6. **Buy-order fees**: a fill is a lot of the same character and type at the order's station at
   one of its known prices on or after its earliest placement, oldest first; a buy order with fees
   and no fill is `buyOrderUnfilled` (its fee counts in "since" mode, is skipped in run mode).
7. **FIFO**: arrived is judged at the sale's time; the fallback lot must predate the sale;
   uncovered units stay out of gross, tax and COGS.
8. **Remaining**: accounting and unrealized figures cover exported lots only; the mismatch flag
   compares every lot's remainder with the physical total (assets at the two stations with
   containers resolved, live couriers' loads, open sell orders at the destination).
9. **Run-mode broker share**: units sold in [copiedAt, end] plus units held at the end, the run's
   lots against every exported lot; overlapping runs do not sum to 100 %.
10. A missing m3 splits haul by units, flagged `est`; `firstListedAt` is the first snapshot after
    arrival that saw any sell order of the type at the destination; `historyFrom` (the earliest
    synced transaction) replaces the ambiguous "synced through".

### Phase 5 — persist runs (sonnet; after the in-flight export edits land)
Scope: `/api/runs` in `lib/api.js`, plus the Copy handler, an ISO `reportGeneratedAt`, the
content hash and the saved market context (Comparison 1) in `public/export.js`. Nothing else in
`export.*`.

Gate: three clicks on an unchanged report leave one file in `data/runs/` with `copyCount: 3`;
changing the global factor and copying again adds a second file; a new Run adds a third. The saved
file holds the context books for every copied row. With the server stopped, Copy still copies.

Done 2026-11-19: `lib/runs.js`, `public/export-persist.js` (UMD shared by page, server and tests:
content key and hash, run id, `marketContext`, `buildRun`, `syncIsStale`), `POST|GET /api/runs`
outside `requireConfigured`, 58 tests. As built:

- The id keeps the literal ISO time (`Jita-Amarr-2026-11-20T02:35:48.386Z-<16 hex>`), so run file
  names hold `:` and `.`; fine on macOS and Linux. The server recomputes the id and answers 400
  when the body disagrees; `lastCopiedAt` and `copyCount` are the server's and never move back.
- `GET /api/runs` lists newest first without `context` unless `?context=1`; `GET /api/runs/:id`
  and `DELETE` are not built yet (Phase 6 or 8 adds them if a page needs one run's context).
- Context orders keep `order_id`, `volume_total` and `min_volume` beyond the plan's five fields;
  history keeps the rows the estimator read (90 days). A run is about 18 KB per row; the POST cap
  is 4 MB (about 220 rows), below `server.js`'s 5 MB parser.
- Rows with `qty` under 1 are left out; a copy with no such row posts nothing. A failed save
  shows "Copied (run not saved)" on the button and the clipboard still works.
- The page-load sync fires when any linked character is stale (the server skips fresh ones), with
  `market: false`.

### Phase 6 — results page (sonnet; after 3, 4, 5)
Scope: `public/results.html`, `public/results.js`.

Gate:
- Tests pass.
- With two linked characters and the latest run, three types match the in-game wallet by hand:
  bought qty, sold qty, tax.
- The 30-day totals match `exportAndSold.html`, apart from the broker/tax it ignores.
- Every state shows correctly: unset `EVE_CLIENT_ID`, no characters, a revoked app (revoked on the
  EVE support site), an empty window.

Done 2026-11-19: `public/results.html`, `public/results.js`; checked against the real ledger on
2026-11-19: the 30-day strip read spent 613.3M, gross 1.49B, tax 68.05M, broker 157.2M, realized
+683.1M, and reconciles with the ledger once the rules are applied (gross and tax leave out the
1,291 uncovered units sold with no purchase in the synced history; spent covers only the lots a
hand-off took, the 50 unbatched lots being Ivan's buys still awaiting a contract; broker excludes
the GM-refunded typo fee, decision 20). As built, beyond the UI section:

- `/api/ledger` is read without `since` (FIFO needs the whole history); the window only selects
  what is summed. Snapshots are read from the window start minus 7 days.
- The run dropdown offers "Unplanned batches (hand-offs with no run)", summed in the page from
  `facts.lots` and `facts.sells` of batches with `runId` null (compute has no such window yet; a
  `{unplanned: true}` window would move it into the module).
- Quantity Δ stays neutral; net/item and profit Δ carry a sign and a colour; days Δ says
  "faster"/"slower", "~" while projected. The route selector is hidden in run mode.
- Sold-out rows are hidden by default, so a wallet check of sold quantity needs "show sold out".
- Tooltips are `title` text like the export page (no keyboard route). Times are local.
- A chip's Sync posts `{characterIds, force: true, market: false}`; Sync all `{force: true, market:
  true}`; the page-load sync is unforced and includes the market.
- Amounts show abbreviated (4.56M) with the exact ISK in the tooltip.
- Known gaps: `STATIONS` is duplicated from `export.js` (unify later); stations carry no solar
  system id, so rule 6's same-system match cannot fire for a courier starting at a structure;
  `/api/snapshots` returns whole snapshots (about 180 KB each for Ivan), fine for now.

### Phase 7 — retire and document (haiku: mechanical)
Delete `public/exportAndSold.*`, the `env.js` references, and util's
`getCharacterWalletTransactions` / `getCharacterWalletJournals` once grep finds no callers.
Update `README.md`: setup, the seven scopes, `.env` keys, "sync at least every few weeks", and the
optional launchd plist that runs `node scripts/sync.js` daily.

Gate: grep is clean and the tests pass.

### Phase 8 — insights page (sonnet; after 6)
Scope: `public/insights.html`, `public/insights.js`, plus the inline bars in the results table.
The implementer loads the `dataviz` skill before writing chart code.

- **Library.** Observable Plot from a pinned CDN script tag with its d3 peer, the way the pages
  load `moment`. Pin the newest release that is at least two weeks old at implementation time
  (Plot 0.6.19 was published 2026-11-05, d3 7.9.2 on 2026-11-03).
- **Placement.** A separate page sharing the results page's window bar (run or since-date, route,
  "count hauler bonuses") and `results-calc.js`; every chart groups the fact table (rule 12). The
  results table stays the at-a-glance view.
- **Build order**, the first five:
  1. Cost waterfall for the window or run: gross sales → sales tax → listing fees → relist fees →
     haul (with bonuses when counted) → buy cost → net profit; plus, in the results table, an
     inline profit bar per row and a stacked cost bar (buy / haul / tax / broker / relist against
     gross).
  2. Sales heatmap, weekday × hour, in EVE time with a local-time toggle, as ISK and as units.
  3. Sell-through curves per batch: cumulative share sold against days since arrival, the
     predicted days to clear marked, all batches overlaid.
  4. Prediction calibration: predicted vs realized profit per item, and predicted vs actual days
     to clear, by run.
  5. Capital at work: stacked area of ISK in wallet, escrow, source stock, in transit,
     destination hangar and listed, by day (from the retained snapshots).
- **Backlog**, after those: margin vs days-to-sell scatter (bubble = profit); weekly stacked cost
  bars; relist view per item (count, cost, price decay from first listing to sale); time-to-sell
  histogram; daily sales timeline with batch arrivals marked; dead stock (unsold past a threshold,
  cost vs best price); competition at listing time vs days to sell (from the run context); run
  scorecard; the user's share of regional daily volume; realized price vs the daily average.

Gate: tests pass; each chart checked in the browser against the results table's totals for one
run; empty, loading and error states looked at.

## Agent roster

- **Models.** Phases 1, 3, 5, 6 and 8: sonnet (bounded, clear briefs; Phase 8 is declarative
  charts over the fact table). Phases 2 and 4: opus (OAuth/JWT correctness; accounting semantics).
  Phase 7: haiku.
- **Sequencing.** Phase 4 runs in parallel with 2–3 because it only adds files. `lib/api.js` is
  touched by 1 → 2 → 3 → 5, in that order. Phase 5 waits for the agents now editing `export.js`.
  Phase 8 follows 6.
- **Fable.** Reviews the `lib/sso.js` and `results-calc.js` cruxes, reruns the gates, does the live
  link and sample capture with the user, smoke-tests results.html and insights.html in the
  browser, and commits. Briefs say "do not commit".

## Out of scope

- Corporation wallets, orders and assets.
- Citadel markets (`esi-markets.structure_markets.v1`); a buy in a structure gets the lot tag
  "other", named through the structures scope (decision 13).
- A hosted scheduler. The only background sync is the optional launchd job running
  `scripts/sync.js` (decision 14).
- Lost or failed courier accounting beyond a banner.
- Selling through contracts.
- Skill modeling in the accounting: the journal gives the actual amounts; skills and standings are
  synced only to explain the rates.
- Moving the public market URLs off `/latest/`.
- Any hosted deployment: Heroku is dropped. `cron.js` is dead code (it calls a Heroku URL and a
  route that no longer exists) and is left alone.

## Decisions (2026-11-12, updated 2026-11-13)

1. Cost basis: FIFO, pooled across linked characters.
2. Broker fees: time-match to orders, pro-rata remainder flagged `est`.
3. Characters: link Ivan and Grant, pooled.
4. Hauler donations: yes, bonuses on the matching courier, behind "count hauler bonuses" (rule 7).
5. Which buys count: superseded by 7; buys anywhere make lots, the hand-off contract decides.
6. Heroku: dropped (2026-11-13); the tool runs locally only.
7. Runs: Ivan → Grant item exchange = batch, taking the newest buys before it, then a courier.
   No time-window attribution. Default view: latest run.
8. Removed character: revoke the token, keep the history.
9. `ESI_USER_AGENT` contact: app name + main character name.
10. Newest-first stays (2026-11-13). When two hand-offs are issued back to back and share a type,
    the lots may be mixed between them; Rocky: "in that kind of scenario where I double buy then
    double create contract its ok for source items to be mixed."
11. Raw-first store and retained snapshots (2026-11-13): every ESI response is kept verbatim;
    ledgers and snapshots are derived and rebuildable.
12. Market context (2026-11-13): the books and history behind each run are saved with it; each
    sync takes a capped destination market snapshot for the types in play.
13. Scopes (2026-11-13): skills, standings and structures are added at link time.
14. Sync (2026-11-13): on any page load after an hour, and from `scripts/sync.js` for an optional
    launchd job.
15. Charts (2026-11-13): Observable Plot from a pinned CDN build.
16. Insights page (2026-11-13): a separate page sharing the results page's window bar.
17. Chart build order (2026-11-13): cost waterfall and table bars, sales heatmap, sell-through
    curves, prediction calibration, capital at work.
18. Time axis (2026-11-13): EVE time, with a local-time toggle.
19. Copy orders (2026-11-13): one run per distinct content (hash of `typeId`, `qty`); later
    identical clicks only bump `copyCount`. Runs are a weak signal; the hand-off contract is the
    truth.
20. GM refunds (2026-11-19): a `gm_cash_transfer` equal to the cent to an earlier `brokers_fee`
    of the same character within 30 days voids that fee, and the GM row itself never counts
    (Rocky: "GM refund can be ignored if you also ignore the matching broker fee").

### Still open

- Resolved 2026-11-19: a fully filled order, buy or sell, appears in `orders/history` as
  `state: expired` with `volume_remain: 0` (19 of Grant's 20 expired sells, 63 of Ivan's buys);
  an order that ran out of time keeps its `volume_remain`, and a cancelled one reads `cancelled`.
  Immediate orders (`duration: 0`) are listed the same way.
- Whether contract items stay readable once the contract drops off the 30-day list (Contracts).

## Sources

- SSO flows, claims: https://developers.eveonline.com/docs/services/sso/
- SSO metadata (endpoints, auth methods, revoke): https://login.eveonline.com/.well-known/oauth-authorization-server
- JWKS: https://login.eveonline.com/oauth/jwks
- Refresh request, rotation: https://docs.esi.evetech.net/docs/sso/refreshing_access_tokens.html
- Revocation: https://docs.esi.evetech.net/docs/sso/revoking_refresh_tokens.html
- JWT validation: https://docs.esi.evetech.net/docs/sso/validating_eve_jwt.html
- Refresh token "MIGHT change": https://developers.eveonline.com/blog/sso-endpoint-deprecations-2
- `iss` scheme (Nov 2023): https://forums.eveonline.com/t/complete-eve-sso-jwt-token-update-on-1-november-11-00-utc/424277
- Compatibility date: https://developers.eveonline.com/docs/services/esi/overview/
- Versions merged: https://developers.eveonline.com/blog/changing-versions-v42-was-getting-out-of-hand
- Rate limiting: https://developers.eveonline.com/docs/services/esi/rate-limiting/
- Caching, User-Agent: https://developers.eveonline.com/docs/services/esi/best-practices/
- OpenAPI (routes, scopes, groups, cache, contract and journal fields): https://esi.evetech.net/meta/openapi.json?compatibility_date=2026-08-18
- 30-day transactions (community): https://forums.eveonline.com/t/wallet-transaction-route-limited-to-30-days/488424
