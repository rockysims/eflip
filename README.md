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
- `--rebuild`: rebuild `data/ledger/` from `data/raw/`; no ESI calls
- `--watch`: one watch refresh, the orders page's five-minute tick: your open orders, then the books and history of the types you have listed. No wallet, assets or contracts. It takes `--character` and `--region`, and cannot be combined with `--rebuild`, `--market-only`, `--no-market` or `--max-types`

`--watch` is optional. A launchd job for it can run every five minutes while the game is open, on a machine where the orders page is not; use `StartInterval` 300 in place of the daily calendar interval below.

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
- `ledger/market/<regionId>/<typeId>.json`: every competing order's price path, with the times the book was checked.
- `runs/`: export runs saved by "Copy orders" on `export.html`.
- `esi-cache/`: per-route ETag and expiry bookkeeping, sync state and rate-limit state.
- `esi-cache/public/_watch.json`: the last watch refresh, when it ran and what each character and type answered.
- `locks/`: one lock per character and one for the market, so the server and the script never sync the same owner at once.
- `samples/`: captured ESI responses used to write the test fixtures. The server does not read them.

Tokens never reach the browser or git. Refresh tokens stay in `tokens.json`; access tokens stay in server memory. Neither is sent to a page or written under `public/` or `cache/`. The pages call only the task-specific `/api` routes, never a general ESI proxy.

## Tests

From the repo root, run the bare command:

```sh
node --test
```

`node --test test/` is broken on Node 24; use the bare form.
