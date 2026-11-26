# Done — export page: history-backed columns

Implemented 2026-11-25/26 on `claude/days-to-clear-calculation-49d77d`, each piece fast-forwarded
onto `feature/export-rework` after a green gate; last commit 0732b64 (491 tests).

## Outcome

The export page's figures that describe other sellers and demand use what the book logs observed,
blended with today's models by covered time (history preferred, the model for the blank spots,
prorated), and say so with a dotted underline and "40% observed". "Avg days idle" sits beside
"days idle". The "seller updated too recently" filter is gone. An hourly destination-book snapshot
(opt-in, `EFLIP_REGION_BOOK=1`) gives every type at the destination station a book log, under a
storage budget with shares (`EFLIP_STORAGE_BUDGET`, `EFLIP_STORAGE_SHARES`), with raw pages and
logs gzipped. A "sold before" column shows the user's own realized sales per type.

## Completed work

- M0 (97c29d3): the filter removed; ruling logged.
- M1 (a26c42e, 87190fd, 8618547, 9bccd9f): `public/market-stats.js`; `POST /api/market-stats`; the
  estimate's blend and `typicalOrdersPerDay`; avg days idle, marks, concise tooltips; saved-run
  observed fields; docs and two rulings.
- M2 (c35e06b, 7a4c05c, de0acb3, cde0ee4): `doSyncRegionBook` with measurement; gzip; the budget
  planner and its application; the replaying rebuild (`--rebuild-book-logs`); the scheduler;
  `--storage`, `--region-book-report`; config fields; page notices; docs.
- M3 (0732b64): `POST /api/sold-before` on results-calc server-side; the last column; saved field.

## Validation

`node --test test/*.test.js`: 491 pass at the end (354 before this plan). Browser checks on the
export page through a scratch data directory holding the 358 Domain book logs: covered and
uncovered types, the marks, the concise tooltips, the new columns, both batched routes 200.
Not checked live: the hourly job against real ESI (Rocky runs it overnight on his machine), and
trimming on real data (fixtures only).

## Deviations from the plan

- Coverage gap scales with the item's pace (history `order_count`), two fractions (events,
  volume), per Rocky; the fixed 2 h gap was dropped before implementation.
- Tooltips carry the observed share only (Rocky: "more concise").
- M2 fetches all orders, not sell-only; retention is the storage budget, not 24 h / 90 d; the job
  is opt-in, not on by default; `--watch` has no loop (it is one launchd tick), so its hourly
  behaviour comes from the job's 55-minute rule; `--rebuild` leaves book logs alone unless asked.
- M3 adds `sourceStationId` so the haul is in the realized margin, and a 60 s cache.

## ADRs

None; the repo records decisions in `docs/*-plan.md` and `docs/ui-decisions/`.

## Follow-up work

- Tune `DEFAULT_SHARES` and the README's figures against the 8-hour measurement (Rocky's
  `--region-book-report` on 2026-11-26).
- The multi-page per-type raw trim's one remaining edge (the last check before the cutoff) and the
  `_storage.json`/sync-log volume (two small entries an hour) are noted in notes.md.
- Possible later: a per-type sell-price correction from calibration; competitor profiles.
