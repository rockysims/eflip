# eflip

eflip is a local EVE Online trading tool with three pages: `export.html` plans an export run, `results.html` shows what that run really did, from your own wallet, orders, assets and contracts, and `orders.html` shows what has sold recently and which of your sell orders are worth updating (live while open, refreshing every five minutes). An Express server on your machine syncs that data from ESI and keeps the EVE tokens to itself; the pages only call its `/api` routes. It is meant to run on your own machine only; there is no hosted deployment.

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

Without `EVE_CLIENT_ID` and `EVE_CLIENT_SECRET`, the `/sso` and `/api/characters` routes answer 503 "not configured". The optional keys (`EFLIP_DATA_DIR`, `HOST`, `PORT`, `ESI_COMPAT_DATE`) are explained in `.env.example`.

`EFLIP_DATA_DIR` sets one data directory that every checkout can share; without it, the synced data is in `data/` in this checkout. `ESI_USER_AGENT` (step 5) is the contact CCP asks for in every ESI request. The pages show a note while either one is unset; both still work without them.

## Running

```sh
npm start
```

Then open http://localhost:5001/export.html (export planning), http://localhost:5001/results.html (trade results) or http://localhost:5001/orders.html (order monitor).

The server binds `127.0.0.1:5001` by default. To change `HOST` or `PORT`, set them in `.env` and make the callback URL match (`EVE_CALLBACK_URL` and the developer application).

## Linking characters

On `results.html`, click "+ Add character". EVE signs you in and the page comes back with the character linked. Repeat for each character. Linked characters are pooled: the cost basis and totals span all of them.

Each character's chip shows its status (last sync, missing scope, or re-link needed). Its Sync button syncs that character. Remove asks for confirmation and revokes the character's token; the synced history stays unless you tick "also delete synced data".

## Export page

`export.html` ranks what to buy at the start station and sell at the end station, from the order books and daily history ESI reports. Where the server has watched a type's book at the end station (its book log, see Data), the page also uses what the log observed: daily demand from the units that sold, rivals from the undercuts that happened, and the "avg days idle" column, the mean days between price moves of the sellers near the best price (shown "≥ n" when nobody moved, blank when nothing was observed). Observed and modelled figures are blended by how much of the last max(days to clear, 3) days the log covers, and a blended figure (rivals, daily profit) has a dotted underline; its tooltip gives the observed share. A type the server has not watched shows the model alone. Only types in play (listed, in transit, held or sold in the last 90 days) have a log so far. The page asks `POST /api/market-stats` for these figures; `public/market-stats.js` computes them from the book logs on each request.

## Order monitor

`orders.html` gives each open sell order of your linked characters a verdict, with the figures behind it:

- `top`: nothing is ahead of the order at your station.
- `leave`: the orders ahead clear on their own, in less time than the leave threshold or in no more than one typical sale.
- `maybe`: between the others, with the numbers shown.
- `undercut`: the orders ahead would take days to clear, so matching the best price is worth a look.
- `reconsider`: matching the best price would sell below cost or under the ROI floor.

The reason is in each verdict's tooltip. Each row also shows units ahead, days behind (units ahead over the item's daily volume), time on top (the median time, over that item's past listings of yours, before someone undercut you), the margin now and the margin if you match, with its ROI. The three thresholds at the top set the verdicts and are kept in this browser.

Below the table, what has sold in the last 24 hours, two days, seven days or 30 days is a timeline by item. A table under it gives the units sold per item and day, with each item's share of Domain volume. The header shows how old the orders, books and sales data are.

While the page is open, it refreshes your open orders and the order books of the types you have listed every five minutes (the watch refresh). "Refresh now" does it at once. Nothing else runs in the background, unless you set up the optional job under Syncing. EVE has no API that changes a market order, so the page only tells you what to update; you change the price in the game.

## Syncing

Every page syncs each linked character on load when its last sync is more than an hour old. "Sync all" on `results.html` syncs every character now.

ESI keeps about 30 days of wallet history and 30 days of contracts. Rows older than that which were never synced cannot be recovered, so sync at least every few weeks, or run the daily job below. Everything synced is stored raw under `data/raw/`, so it stays on disk after ESI forgets it.

To sync from the command line without the server, run `node scripts/sync.js`. With no flags it syncs every linked character and the destination market snapshot. The header comment of `scripts/sync.js` lists all its flags and exit codes; the main ones are:

- `--character <id>` (repeatable): only that character
- `--region <id>` (repeatable): snapshot that region's market
- `--no-market` or `--market-only`
- `--rebuild`: rebuild the character ledgers in `data/ledger/` from `data/raw/`; no ESI calls. The book logs are left as they are (see below); add `--rebuild-book-logs` to rebuild them too, or pass it alone to rebuild only them
- `--watch`: one watch refresh, the orders page's five-minute tick: your open orders, then the books and history of the types you have listed. No wallet, assets or contracts. It takes `--character` and `--region`, and cannot be combined with `--rebuild`, `--market-only`, `--no-market` or `--max-types`

`--watch` is optional. A launchd job for it can run every five minutes while the game is open, on a machine where the orders page is not; use `StartInterval` 300 in place of the daily calendar interval below.

The destination book job is off by default. With `EFLIP_REGION_BOOK=1` in `.env`, every full sync (the one that includes the market snapshot) ends with one snapshot of the destination region's whole order book, every type and both sides: `GET /markets/<region>/orders?order_type=all`, page by page, stored raw under `data/raw/public/` and folded into the per-type book logs as one sample per type (a type whose orders have all ended gets an empty sample). That gives types you do not trade a book log too. `node scripts/sync.js --region-book` takes one snapshot now and prints what it cost; `node scripts/sync.js --region-book-report` prints the last 24 hours of snapshots as a table, with totals and per-hour averages. For Domain a snapshot is about 194 pages, 388 `market-order` tokens (the bucket holds 12,000 per 15 minutes) and 46 MB of raw. The job waits while an export run is going, stops under 20 % of the bucket, takes the market lock (a watch tick that overlaps it reports its market step busy), and folds nothing from a snapshot with a page missing. Set a storage budget with it (see Storage budget under Data): without one it keeps every raw page and every log sample, about 46 MB of raw an hour, and the pages' notice says so. The live book logs keep history after the budget has trimmed the raw behind it, so a rebuild from raw would shorten them to what raw still holds. `--rebuild` therefore leaves the book logs as they are and prints how far back their raw reaches (the oldest regional snapshot and per-type book still on disk). `--rebuild-book-logs` rebuilds them on purpose: it replays the regional snapshots whose pages are still in raw, in time order with the per-type checks, prints how many snapshots it could not replay because their pages were trimmed, and loses whatever history is older than the raw left. Use it to repair the logs, not as a routine step.

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
- `raw/`: every ESI response body, verbatim, with its fetch time and the headers that matter. Ledgers and snapshots are derived from it.
- `ledger/`: per-character ledgers and retained snapshots, derived from `raw/`.
- `ledger/<characterId>/order-log.json`: each of your orders' price path, and how it ended once it has.
- `ledger/market/<regionId>/<typeId>.json.gz`: every competing order's price path, with the times the book was checked. The export page's observed figures are computed from these.
- `runs/`: export runs saved by "Copy orders" on `export.html`.
- `esi-cache/`: per-route ETag and expiry bookkeeping, sync state and rate-limit state.
- `esi-cache/public/_watch.json`: the last watch refresh, when it ran and what each character and type answered.
- `esi-cache/public/_region-book.json`: the last destination book snapshot and how it ended. Each run also adds a `kind: "regionBook"` entry, with what it cost, to the public sync log under `raw/public/_sync-log/`.
- `esi-cache/public/_storage.json`: the last storage budget run and the last trim. Each run also adds a `kind: "storage"` entry to the public sync log.
- `locks/`: one lock per character and one for the market, so the server and the script never sync the same owner at once.
- `samples/`: captured ESI responses used to write the test fixtures. The server does not read them.

Tokens never reach the browser or git. Refresh tokens stay in `tokens.json`; access tokens stay in server memory. Neither is sent to a page or written under `public/` or `cache/`. The pages call only the task-specific `/api` routes, never a general ESI proxy.

### Storage budget

`EFLIP_STORAGE_BUDGET` in `.env` (for example `1GB`; decimal units, `500MB` or a number of bytes also work) is one allotment of disk for the bulky data that can be fetched again or regrows. Unset, nothing is ever trimmed. `EFLIP_STORAGE_SHARES` splits it, in percent, between four kinds; the defaults are `regionPages:40,bookLogs:45,typeBooks:10,runContexts:5`:

- `regionPages`: the destination book job's raw order pages, trimmed a whole snapshot at a time.
- `bookLogs`: the book logs under `ledger/market/`, trimmed by one time cutoff across all of them. Samples older than the cutoff go, and so do orders last seen before it; an order still listed keeps its last price before the cutoff, so its state at the cutoff is known.
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
