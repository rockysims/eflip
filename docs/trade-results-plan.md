# Trade results (results.html) — plan

Branch: a new `claude/trade-results-<hash>` off the `feature/*` branch that carries the export
rework. New: `lib/` (server modules), `public/results.html`, `public/results.js`,
`public/results-calc.js`, `test/{results-calc,sso,ledger,server-file}.test.js`, `.env.example`.
Changed: `server.js`, `.gitignore`, `package.json`, `public/export.js` (Copy persists the run),
`README.md`. Retired at the end: `public/exportAndSold.*`, `public/env.js`, util.js wallet
getters. Out of scope: `index.*`, `jack.js`, `missing.*`, `resell.*`, `reprocess.js`.

Goal and principle: after an export run (Copy orders → multibuy at the source → item-exchange
hand-off from buyer to seller → courier → list at the destination), show what really happened:
bought, hauled, sold, at what prices and fees, what is still unsold, realized profit, and how each
figure compares with the export page's prediction. Every figure comes from the user's own ESI data
(wallet, orders, assets, contracts), or from ESI market data for current prices. EVE tokens never
reach `public/`, the browser, git or `cache/`: the Express server holds them, and pages call a few
`/api/...` routes.

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

## ESI facts this plan relies on (checked 2026-11-12)

- **URL style.** Use base `https://esi.evetech.net` with no `/latest/`, no `datasource=` and no
  trailing slash. Send `X-Compatibility-Date: 2026-08-18`, the newest entry in
  `/meta/compatibility-dates`, pinned as `ESI_COMPAT_DATE`.
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
- **Scopes.** `esi-wallet.read_character_wallet.v1`, `esi-markets.read_character_orders.v1`,
  `esi-assets.read_assets.v1`, `esi-contracts.read_character_contracts.v1`. The character id and
  name come from the JWT, so no extra scope is needed.

| route `/characters/{id}/…` | scope | group, tokens/15 min | ESI cache | paging | retention |
|---|---|---|---|---|---|
| `wallet/transactions` | wallet | `char-wallet` 150 | 3600 s | `from_id` (rows before it) | ~30 days (community) |
| `wallet/journal` | wallet | `char-wallet` 150 | 3600 s | `page` + `X-Pages` | "30 days back" (spec) |
| `orders` | orders | none (error limit) | 1200 s | none | open orders |
| `orders/history` | orders | none (error limit) | 3600 s | `page` + `X-Pages` | 90 days, cancelled/expired |
| `assets` | assets | `char-asset` 1800 | 3600 s | `page` + `X-Pages` | snapshot |
| `contracts`, `contracts/{cid}/items` | contracts | `char-contract` 600 | 300 / 3600 s | `page` + `X-Pages` (list only) | 30 days or `in_progress` (spec) |

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
- To confirm in Phase 2 sample capture: that a completed hand-off and a delivered courier both
  read `finished`; which party of a `player_donation` is the payer; whether items stay readable
  once a contract drops off the 30-day list (sync fetches them on first sight either way).

**Gotchas.**
- `is_personal: false` marks a corporation-wallet trade: excluded.
- `client_id` is the counterparty. A trade between two linked characters is internal: excluded.
- `journal_ref_id` points at the `market_transaction` journal row, not at the tax row.
- Journal `context_id` means something different per `ref_type`; read `context_id_type`. For
  `contract_*` it is the contract id. For `transaction_tax` and `brokers_fee` it is undocumented,
  so the Phase 2 sample settles it.
- `brokers_fee` rows include relist fees, but an order's `issued` shows only its latest placement
  or modification.
- `market_escrow` is ignored: cost comes from transactions.

## Data model

Server files live under `data/` (gitignored; `EFLIP_DATA_DIR` overrides the location):

- `data/tokens.json`: `{version: 1, characters: {<id>: {characterId, name, ownerHash, scopes,
  refreshToken, linkedAt, refreshedAt, status: 'ok'|'relink', lastError}}}`.
- `data/ledger/<characterId>/{transactions,journal,orders-history,contracts}.json`. Arrays merged
  by `transaction_id` / `id` / `order_id` / `contract_id`. Rows only accumulate, and order/contract
  status is last-write-wins. This is the durable history that outlives ESI's 30-day window.
- `data/ledger/<characterId>/contract-items/<contractId>.json`: fetched once, never again.
- `data/ledger/<characterId>/snapshot.json`: `{syncedAt, orders, assets}`, replaced each sync.
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

The page keeps `util.getOrFetch` for public data: type names, `packaged_volume`, and destination
sell orders for "at market" values.

**Sync** (`lib/sync.js`) runs per character on page load when more than 60 min have passed, or on
"Sync now":
1. Transactions: without `from_id`, then `from_id = min(transaction_id)` until a batch is empty,
   all known, or older than the last sync.
2. Journal: page 1, then the rest of `X-Pages`.
3. Open orders, orders history, assets, contracts, and the items of each new courier or
   item-exchange contract.
4. Merge, then record `syncedAt`, errors and rate-limit headers.

**Budget.** One sync is about 3–5 `char-wallet` calls (≤ 10 of 150 tokens), 1–10 contract calls
and 1–3 asset pages. Syncs are at most hourly, which matches the cache timers. Price lookups take
2 tokens per held type from the 12000 market-order bucket. A group with `X-Ratelimit-Remaining`
below 20 % pauses until `Retry-After` or the window passes.

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
     only the split of cost between the two batches.
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

## Comparison to the prediction

1. **Persist runs** on "Copy orders" with `POST /api/runs`. This replaces `/file/`, which writes
   to the disposable cache without validation. Body:
   `{id, copiedAt, reportGeneratedAt (ISO), route: {start, end, startStationId, endStationId,
   startRegionId, endRegionId}, horizonDays (runDaysToComplete), config: {SELL_TAX, SALES_TAX,
   BROKER_FEE, HAULING_REWARD_FRACTION, MIN_ROI}, rows: [{typeId, name, m3, qty, factor,
   recommended (report.volume), costPerItemMil, revenuePerItemMil, sellPriceMil, profitPerItemMil,
   dailyProfitMil, daysToClear, dailyDemand, competingVolume}], totals: {costMil, revenueMil,
   profitMil, km3}}`.
   - `id = <route>-<reportGeneratedAt ISO>`. Re-copying the same report overwrites it (keeps the
     first `copiedAt`, sets `lastCopiedAt`); a new Run makes a new id.
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
     green (better) or red (worse).

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

## Server changes

1. **`lib/` modules.**
   - `lib/sso.js`: metadata/JWKS cache, authorize URL, code exchange, refresh, revoke,
     `verifyJwt`.
   - `lib/tokenStore.js`.
   - `lib/esi.js`: compat date, `User-Agent`, ETag cache, rate limits, paging.
   - `lib/ledger.js`, `lib/sync.js`.
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
   `POST|GET /api/runs`, `GET|DELETE /api/runs/:id`.
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
   "eFlip (local)" with connection type "Authentication & API Access". Add the four scopes and the
   callback `http://localhost:5001/sso/callback`, then copy the Client ID and Secret into `.env`.
   Adding a scope later means re-linking every character.
8. **Local only.** The tool runs on the user's machine only (decision 6): `Procfile` is deleted
   and nothing depends on `NODE_ENV`. The Host and Origin guards (item 4) still apply, for DNS
   rebinding and other local processes.

## Phases

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
Scope: `lib/sso.js`, `lib/tokenStore.js`, `/sso/*`, `/api/config`, `/api/characters` (GET and
DELETE), `.env.example`, `test/sso.test.js`. Tests: RSA and EC keys from
`crypto.generateKeyPairSync`; bad iss/aud/exp/signature; string `scp`; single-flight refresh and
token replacement, with `fetch` stubbed.

Gate:
- Tests pass.
- User + Fable: link a character. `data/tokens.json` has mode 0600 and `git status` is clean.
  Remove it (revoke returns 200), then re-link.
- Sample capture: an uncommitted script writes anonymized `brokers_fee`, `transaction_tax`,
  `market_transaction` and `contract_*` rows, plus matching transactions and orders, to
  `data/samples/`. Also a hand-off `item_exchange` and its `courier` contract, both with items,
  and a `player_donation` to that courier's hauler.
- Fable writes the observed `context_id_type` values and the Contracts "to confirm" answers into
  this doc before Phase 4 freezes rules 2 and 4–7.

### Phase 3 — ESI client, sync, ledger (sonnet)
Scope: `lib/esi.js`, `lib/ledger.js`, `lib/sync.js`, `/api/sync`, `/api/ledger`,
`test/ledger.test.js`. Tests: dedupe, `from_id` walk, X-Pages, 304 reuse, rate-limit stop, and
401 → relink without retry.

Gate: tests pass. On a second sync, no ESI calls go out before `Expires`, and the ledger grows
only by new ids.

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
- remaining in both views, days on market and projection, and the cross-check.

Gate: `node --test 'test/*.test.js'`.

### Phase 5 — persist runs (sonnet; after the in-flight export edits land)
Scope: `/api/runs` in `lib/api.js`, plus the Copy handler and an ISO `reportGeneratedAt` in
`public/export.js`. Nothing else in `export.*`.

Gate: two copies of one report leave one file in `data/runs/`, and a new Run adds a second. With
the server stopped, Copy still copies.

### Phase 6 — results page (sonnet; after 3, 4, 5)
Scope: `public/results.html`, `public/results.js`.

Gate:
- Tests pass.
- With two linked characters and the latest run, three types match the in-game wallet by hand:
  bought qty, sold qty, tax.
- The 30-day totals match `exportAndSold.html`, apart from the broker/tax it ignores.
- Every state shows correctly: unset `EVE_CLIENT_ID`, no characters, a revoked app (revoked on the
  EVE support site), an empty window.

### Phase 7 — retire and document (haiku: mechanical)
Delete `public/exportAndSold.*`, the `env.js` references, and util's
`getCharacterWalletTransactions` / `getCharacterWalletJournals` once grep finds no callers.
Update `README.md`: setup, `.env` keys, "sync at least every few weeks".

Gate: grep is clean and the tests pass.

## Agent roster

- **Models.** Phases 1, 3, 5 and 6: sonnet (bounded, clear briefs). Phases 2 and 4: opus (OAuth/JWT
  correctness; accounting semantics). Phase 7: haiku.
- **Sequencing.** Phase 4 runs in parallel with 2–3 because it only adds files. `lib/api.js` is
  touched by 1 → 2 → 3 → 5, in that order. Phase 5 waits for the agents now editing `export.js`.
- **Fable.** Reviews the `lib/sso.js` and `results-calc.js` cruxes, reruns the gates, does the live
  link and sample capture with the user, smoke-tests results.html in the browser, and commits.
  Briefs say "do not commit".

## Out of scope

- Corporation wallets, orders and assets.
- Citadel markets and structure names (`esi-universe.read_structures.v1`); a buy in a structure
  gets the lot tag "other".
- Background or cron sync.
- Lost or failed courier accounting beyond a banner.
- Selling through contracts.
- Skill modeling: the journal gives the actual amounts.
- Moving the public market URLs off `/latest/`.
- Any hosted deployment: Heroku is dropped. `cron.js` is dead code (it calls a Heroku URL and a
  route that no longer exists) and is left alone.
- Charts.

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

### Still open

None.

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
