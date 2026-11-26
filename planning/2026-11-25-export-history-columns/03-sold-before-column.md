# M3 — "Sold before" column from the ledger

Size: sm. Dependencies: M1 (the page's per-row `observed` plumbing is reused for a second
per-type lookup). Review gate: none.

## Scope

A per-row figure from our own history: units of the type we sold at the destination in the last
90 days, with the realized net margin per unit and the median days on market in the tooltip. Blank
when none. It needs no ESI call and no fallback: it is a fact about us, not an estimate.

Out of scope: a per-type correction of the predicted sell price (calibration, insights page).

## Files

- `lib/api.js`: `GET /api/sold-before?stationId=&typeIds=` answers `{<typeId>: {units,
  netMarginMilPerUnit, medianDaysOnMarket, lastSoldAt}}` from `results-calc.js` facts over the
  pooled linked characters (`facts.sells`, `facts.lots`; days on market as `results-calc` already
  computes it). ≤ 500 ids a call. Behind `requireConfigured`.
- `public/export.js`: fetch in batches after the books load (beside the market-stats fetch of
  M1), keep per row as `soldBefore`, column `sold before` (units; tooltip with margin, days on
  market, last sale), filterable like other numeric columns, saved with each run row.
- `public/export-persist.js`, `lib/runs.js`, `test/runs.test.js`: the saved row gains
  `soldBeforeUnits` (number or null).
- `docs/export-improvements-plan.md`, `README.md`: the column and the route.
- `docs/ui-decisions/`: one ruling file if Rocky changes the proposed placement (after days to
  clear, last column).

## Validation

`node --test test/*.test.js`; a browser smoke with a type we have sold and one we have not.

## Definition of done

The column shows for sold types, blank for others; the route is tested with a fixture ledger;
docs updated; gates green.

Sub-agent reminders: do not commit; do not expand scope; do not suppress warnings or disable
tests; stop and report if blocked; report what changed, what was validated and any deviation.
