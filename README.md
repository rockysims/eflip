# eflip

eflip is a local EVE Online trading tool with four pages: `export.html` plans an export run, `results.html` shows what that run really did, from your own wallet, orders, assets and contracts, `insights.html` charts the same results data, and `orders.html` shows what has sold recently and which of your sell orders are worth updating (live while open, refreshing every five minutes). An Express server on your machine syncs that data from ESI and keeps the EVE tokens to itself: the pages read your synced data only through its `/api` routes, and fetch public market data and type names from ESI and Fuzzwork directly, cached through its `/file` routes, so no token ever reaches a page. It is meant to run on your own machine only; there is no hosted deployment.

## Setup

1. `npm install` (Node 24).
2. `cp .env.example .env` (`.env` is gitignored; never commit it).
3. Create the EVE developer application once, at https://developers.eveonline.com/applications:
   - Callback URL: `http://localhost:5001/sso/callback`. It must equal `EVE_CALLBACK_URL` exactly.
   - Scopes: the create form lists scopes grouped by prefix. Expand each group and tick its scope, one at a time. Tick all seven:
     - esi-wallet: `esi-wallet.read_character_wallet.v1`
     - esi-markets: `esi-markets.read_character_orders.v1`
     - esi-assets: `esi-assets.read_assets.v1`
     - esi-contracts: `esi-contracts.read_character_contracts.v1`
     - esi-skills: `esi-skills.read_skills.v1`
     - esi-characters: `esi-characters.read_standings.v1`
     - esi-universe: `esi-universe.read_structures.v1`

     A scope added later means re-linking every character, so take all seven now.
4. Copy the application's Client ID and Secret Key into `.env` as `EVE_CLIENT_ID` and `EVE_CLIENT_SECRET`.
5. Set `ESI_USER_AGENT` to the app name, version and your main character's name, for example `eflip/1.0 (Your Character)`. CCP asks for a contact in every ESI request.

Without `EVE_CLIENT_ID` and `EVE_CLIENT_SECRET`, every `/sso` route and every `/api` route that reads synced data (characters, sync, watch, order-log, ledger, snapshots, market, market-stats, sold-before) answers 503 "not configured"; `/api/config`, `/api/health` and `/api/runs` keep working. The optional keys (`EFLIP_DATA_DIR`, `HOST`, `PORT`, `EFLIP_REGION_BOOK`, `EFLIP_STORAGE_BUDGET`, `EFLIP_STORAGE_SHARES`, `ESI_COMPAT_DATE`) are explained in `.env.example`.

`EFLIP_DATA_DIR` sets one data directory that every checkout can share; without it, the synced data is in `data/` in this checkout. `ESI_USER_AGENT` (step 5) is the contact CCP asks for in every ESI request. The pages show a note while either one is unset; both still work without them.

## Running

```sh
npm start
```

Then open http://localhost:5001/export.html (export planning), http://localhost:5001/results.html (trade results), http://localhost:5001/insights.html (charts of the trade results) or http://localhost:5001/orders.html (order monitor). The bare http://localhost:5001/ redirects to `export.html`; there is no other landing page.

The server binds `127.0.0.1:5001` by default. To change `HOST` or `PORT`, set them in `.env` and make the callback URL match (`EVE_CALLBACK_URL` and the developer application).

With `EFLIP_REGION_BOOK=1` in `.env` the running server also takes the hourly destination book snapshot (see Syncing); it is off by default.

## Linking characters

On `results.html`, click "+ Add character". EVE signs you in and the page comes back with the character linked. Repeat for each character. Linked characters are pooled: the cost basis and totals span all of them.

Each character's chip shows its status (last sync, missing scope, or re-link needed). Its Sync button syncs that character. Remove asks for confirmation and revokes the character's token; the synced history stays unless you tick "also delete synced data".

## Export page

`export.html` ranks what to buy at the start station and sell at the end station, from the order books and daily history ESI reports. Where the server has watched a type's book at the end station (its book log, see Data), the page also uses what the log observed: daily demand from the units that sold, rivals from the undercuts that happened, and the "avg days idle" column, the mean days between price moves of the sellers near the best price (shown "≥ n" when nobody moved, blank when nothing was observed). Observed and modelled figures are blended by how much of the last max(days to clear, 3) days the log covers, and a blended figure (rivals, daily profit) has a dotted underline; its tooltip gives the observed share. A type the server has not watched shows the model alone. Without the hourly destination book (see Syncing), only types in play (listed, in transit, held or sold in the last 90 days) have a log. With `EFLIP_REGION_BOOK=1` the server snapshots the whole destination book every hour, so once that has run for a few days every type at the destination station has coverage, including types you have never traded, and the page can show observed figures for a type you search for. The page asks `POST /api/market-stats` for these figures; `public/market-stats.js` computes them from the book logs on each request. The last column, "sold before", is a fact about your own trades rather than an estimate: the units of that type your linked characters sold at the destination in the last 90 days (blank when none), with the sales, the realized net margin per unit and the median days on market in its tooltip, read from the synced ledger by `POST /api/sold-before`.

## Order monitor

`orders.html` gives each open sell order of your linked characters a verdict, with the figures behind it:

- `top`: nothing is ahead of the order at your station.
- `leave`: the orders ahead clear on their own: in less time than the leave threshold, or, while days behind is under the undercut threshold, in no more than one typical sale.
- `maybe`: between the others, with the numbers shown.
- `undercut`: the orders ahead would take days to clear, so matching the best price is worth a look.
- `reconsider`: matching the best price would sell below cost or under the ROI floor.

Beside the verdict is the one figure that decided it (`2.6d` behind, `1.1h` until the queue ahead clears, `50%` of a typical trade ahead, `1.21x` return against the ROI floor, `fee 3.3× gain`); the sentence is in the tooltip. Each row also shows units ahead, days behind (units ahead over the item's daily volume), time on top (the median time, over that item's past listings of yours, before someone undercut you), the margin now and the margin if you match, with its ROI. Columns sort on click; a character column appears when more than one character has orders. The three thresholds at the top set the verdicts and are kept in this browser. A row whose item was planned by an export run has a snapshot button: the export page's prediction for it (sell price, cost, profit, days to clear, demand, competition) against what the page sees now.

Below the table, what has sold in the last 24 hours, two days, seven days or 30 days is a timeline by item, most profitable item first, each dot's area the profit of a sale or burst of sales, with a total per item in a column at the right. A thin line along the bottom of each row says when you were listed: solid while one of your orders was the lowest at its station, dotted while someone was below you, blank while you had no sell order. A table under it gives the units sold per item and day, with each item's share of Domain volume, and the same snapshot button per row. The header shows how old the orders, books and sales data are.

While the page is open, it refreshes your open orders and the order books of the types you have listed every five minutes (the watch refresh). "Refresh now" does it at once. ESI serves your own orders from a 20-minute cache, so a refresh right after you change a price in the game shows the old price; the public book, cached for five minutes, lists your orders too, and the page takes a price, remaining count or `issued` from the book when the book is newer (those cells carry a dotted underline and say so in their tooltip). An order the newer book no longer lists reads "not in book" until the orders feed confirms the fill or the cancel. Nothing else runs in the background, unless you set up the optional job under Syncing or turn on the hourly destination book (`EFLIP_REGION_BOOK=1`, also under Syncing). EVE has no API that changes a market order, so the page only tells you what to update; you change the price in the game.

## Syncing

`results.html` and `export.html` sync the linked characters on load when one's last sync is more than an hour old (`export.html` without the market snapshot), and `orders.html` asks for a sync without the market snapshot on load and after each watch refresh; the server skips a character synced within the hour. "Sync all" on `results.html` syncs every character and the market snapshot now.

ESI keeps about 30 days of wallet history and 30 days of contracts. Rows older than that which were never synced cannot be recovered, so sync at least every few weeks, or run the daily job below. Everything synced is stored raw under `data/raw/`, so it stays on disk after ESI forgets it.

To sync from the command line without the server, run `node scripts/sync.js`. With no flags it syncs every linked character and the destination market snapshot. The header comment of `scripts/sync.js` lists all its flags and exit codes; the main ones are:

- `--character <id>` (repeatable): only that character
- `--region <id>` (repeatable): snapshot that region's market
- `--no-market` (no market snapshot and no destination book) or `--market-only`
- `--rebuild`: rebuild the character ledgers in `data/ledger/` from `data/raw/`; no ESI calls. The book logs are left as they are (see below); add `--rebuild-book-logs` to rebuild them too, or pass it alone to rebuild only them
- `--watch`: one watch refresh, the orders page's five-minute tick: your open orders, then the books and history of the types you have listed. No wallet, assets or contracts. It takes `--character` and `--region`, and cannot be combined with `--rebuild`, `--rebuild-book-logs`, `--market-only`, `--no-market` or `--max-types`. With `EFLIP_REGION_BOOK=1` it also takes the hourly destination book when one is due (below), and prints one line saying whether that is on

`--watch` is optional. A launchd job for it can run every five minutes while the game is open, on a machine where the orders page is not; use `StartInterval` 300 in place of the daily calendar interval below. With the destination book on, the tick that finds the last snapshot 55 minutes old takes a new one, which makes that run last a few minutes; launchd does not start a second copy of a job while one is running.

The destination book is opt-in. With `EFLIP_REGION_BOOK=1` in `.env`, one snapshot of the destination region's whole order book, every type and both sides, is taken every hour:

- by the server (`npm start`), while it is up: the first snapshot a minute after it starts (so it is listening and the rate limits are loaded), then every hour. A restart starts that clock over, and a snapshot is skipped when the last one was folded under 55 minutes ago, so a restart or a second process does not double it. A run that fails is logged and the next hour still runs; two runs never overlap. `GET /api/config` says in `regionBook` whether the schedule is running (`scheduled`), when it fires next (`nextRunAt`) and how the last scheduled run ended (`lastRun`).
- by `node scripts/sync.js --watch`, on the first tick that finds the last snapshot 55 minutes old (with none yet, the first tick takes one right away). A script has no clock of its own: a launchd job that runs `--watch` every five minutes (see Optional daily job) keeps the book hourly with the server stopped. `--watch` prints one line, `hourly region book: on` or `off`.
- by every sync that includes the market snapshot (a plain `node scripts/sync.js`, "Sync all", the results page's sync on load), which ends with one under the same 55-minute rule: a forced sync does not take a second snapshot inside the hour. A sync without the market snapshot (`--no-market`, the export and orders pages) takes none.
- by hand: `node scripts/sync.js --region-book` takes one snapshot now and prints what it cost, and `node scripts/sync.js --region-book-report` prints the last 24 hours of snapshots as a table, with totals and per-hour averages. That is also how to measure one run (pages, tokens, bytes, seconds) before turning the schedule on.

It is off by default because it is the biggest thing eflip stores and, without a storage budget, nothing limits it: every raw page and every log sample is kept, about 46 MB of order pages an hour for Domain before compression (about 8 MB on disk once gzipped, some 190 MB a day). Set `EFLIP_STORAGE_BUDGET` with it (see Storage budget under Data), and the pages' notice nags until you do.

A snapshot is `GET /markets/<region>/orders?order_type=all`, page by page, stored raw under `data/raw/public/` and folded into the per-type book logs as one sample per type (a type whose orders have all ended gets an empty sample). That gives types you do not trade a book log too. For Domain it is about 194 pages, 388 `market-order` tokens (the bucket holds 12,000 per 15 minutes) and 46 MB of orders. The job does not wait for an export run in progress (the server cannot tell one is going, and 388 tokens is a small share of the bucket), but it stops under 20 % of the bucket, takes the market lock (a watch tick that overlaps it reports its market step busy), and folds nothing from a snapshot with a page missing. The live book logs keep history after the budget has trimmed the raw behind it, so a rebuild from raw would shorten them to what raw still holds. `--rebuild` therefore leaves the book logs as they are and prints how far back their raw reaches (the oldest regional snapshot and per-type book still on disk). `--rebuild-book-logs` rebuilds them on purpose: it replays the regional snapshots whose pages are still in raw, in time order with the per-type checks, prints how many snapshots and per-type checks it could not replay because their raw was trimmed, and loses whatever history is older than the raw left. Use it to repair the logs, not as a routine step.

### Optional daily job (launchd)

Create `~/Library/LaunchAgents/space.eflip.sync.plist`, replacing `/Users/you/dev/eflip` with the absolute path to your checkout:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>space.eflip.sync</string>
	<key>ProgramArguments</key>
	<array>
		<string>/absolute/path/to/node</string>
		<string>/Users/you/dev/eflip/scripts/sync.js</string>
	</array>
	<key>WorkingDirectory</key>
	<string>/Users/you/dev/eflip</string>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>4</integer>
		<key>Minute</key>
		<integer>15</integer>
	</dict>
	<key>StandardOutPath</key>
	<string>/Users/you/Library/Logs/eflip-sync.log</string>
	<key>StandardErrorPath</key>
	<string>/Users/you/Library/Logs/eflip-sync.log</string>
</dict>
</plist>
```

Put the output of `which node` in place of `/absolute/path/to/node`. launchd does not read your shell profile, so a Node installed through nvm needs its full path here.

Load the job, and unload it before editing the plist:

```sh
launchctl load ~/Library/LaunchAgents/space.eflip.sync.plist
launchctl unload ~/Library/LaunchAgents/space.eflip.sync.plist
```

The job runs at 04:15 local time. `WorkingDirectory` is the checkout, and `scripts/sync.js` reads `.env` from there.

## Data

Everything eflip stores is in `data/` in the checkout (`EFLIP_DATA_DIR` moves it). The folder is gitignored and private: directories are 0700 and files 0600.

- `tokens.json`: linked characters and their refresh tokens.
- `raw/`: every ESI response body, verbatim, with its URL, status, fetch time and all its response headers (a body the same as the last one stored for that route is not stored again). Ledgers and snapshots are derived from it.
- `ledger/`: per-character ledgers and retained snapshots, derived from `raw/`.
- `ledger/structures.json`: structure names by id, shared by all characters.
- `ledger/<characterId>/order-log.json`: each of your orders' price path, and how it ended once it has.
- `ledger/market/<regionId>/<typeId>.json.gz`: every competing order's price path, with the times the book was checked. The export page's observed figures are computed from these.
- `runs/`: export runs saved by "Copy orders" on `export.html`.
- `esi-cache/`: per-route ETag and expiry bookkeeping, sync state and rate-limit state.
- `esi-cache/public/_watch.json`: the last watch refresh, when it ran and what each character and type answered.
- `esi-cache/public/_region-book.json`: the last destination book snapshot and how it ended. Each run also adds a `kind: "regionBook"` entry, with what it cost, to the public sync log under `raw/public/_sync-log/`.
- `esi-cache/public/_storage.json`: the last storage budget run and the last trim. Each run also adds a `kind: "storage"` entry to the public sync log.
- `locks/`: one lock per character and one for the market, so the server and the script never sync the same owner at once. A lock is taken over when its process is gone, when its pid belongs to another boot, or when it went untouched for 30 minutes (a live holder touches it every minute).
- `samples/`: captured ESI responses used to write the test fixtures. The server does not read them.

Tokens never reach the browser or git. Refresh tokens stay in `tokens.json`; access tokens stay in server memory. Neither is sent to a page or written under `public/` or `cache/`. The pages read synced data only through the task-specific `/api` routes, never a general ESI proxy; what they fetch from ESI and Fuzzwork themselves is public market data and type names, without a token, cached in `cache/` through the `/file` routes.

### Storage budget

`EFLIP_STORAGE_BUDGET` in `.env` (for example `1GB`; decimal units, `500MB` or a number of bytes also work) is one allotment of disk for the bulky data that can be fetched again or regrows. Unset, nothing is ever trimmed. `EFLIP_STORAGE_SHARES` splits it, in percent, between four kinds; the defaults are `regionPages:40,bookLogs:45,typeBooks:10,runContexts:5`:

- `regionPages`: the destination book job's raw order pages, trimmed a whole snapshot at a time.
- `bookLogs`: the book logs under `ledger/market/`, trimmed by one time cutoff across all of them. Samples older than the cutoff go, and so do orders last seen before it; an order still listed keeps its last price before the cutoff, so its state at the cutoff is known. When the first sample the cutoff would keep is a check that found the book unchanged (a 304), the log keeps back to the stored check it stands for, with that check's orders.
- `typeBooks`: the per-type books and histories under `raw/public/`, trimmed by one time cutoff across all of them. Files older than the cutoff go, except each book page's or history's newest file before it, which a later check that found that page unchanged still reads.
- `runContexts`: the market context saved with each export run (the order books and history behind each row). The run's rows, settings and totals stay.

The shares are soft: only the total is enforced, a kind under its share lends the room to the others, and when the total is over, the kind furthest over its share gives up its oldest piece first. Trimming never crosses these floors: the newest complete destination book snapshot, the newest raw file of each book or history (and of each regional page), the last 3 days of every book log, and the newest run's context. When the floors alone are over the budget, the pages' notice says by how much. Raw market pages and book logs are stored gzipped (about 6x and 10x smaller), and sizes are counted as they are on disk. Your characters' raw data and ledgers, the retained snapshots, the sync logs and `esi-cache/` are outside the budget and never trimmed.

When a budget is set, it is applied after each destination book snapshot and after each market snapshot, under the market lock. What it trims is gone for good: the oldest book log history goes with the raw pages behind it (which went first), and a rebuild cannot bring it back. A lowered budget trims at the next run. `node scripts/sync.js --storage` applies the budget now and prints each kind's size against its share, the share of the budget used and what the last trim removed; without a budget it only measures. `node scripts/sync.js --storage-report` prints the same from the last run without running one. Neither needs credentials or calls ESI.

## Tests

From the repo root, run the bare command:

```sh
node --test
```

`node --test test/` is broken on Node 24; use the bare form.
