# M0 — Remove the "seller updated too recently" filter

Size: sm. Dependencies: none; can run before M1. Review gate: none.

## Scope

The estimate drops the filter that hid a row because the newest in-band destination seller had
moved within a profit-dependent threshold (1–30 h). Rocky: the filter made "best pick items
fluctuate more than necessary ... I'd like a more steady picture". The "days idle" column, its
tooltip and `daysSinceInBandSellerUpdate` in the report stay.

Out of scope: anything about averages or history (M1), other filters, the orders page.

## Files

- `public/estimate.js`: in `applyFilters` remove the `sellerUpdatedTooRecently` check; in
  `limitBreaches` remove the `'daysSinceSellerUpdate'` entry; delete `sellerUpdatedTooRecently`
  if nothing else uses it. Keep `calcDestSellers` and both idle figures in `common`.
- `public/export.js`: `BREACH_TEXT` loses `daysSinceSellerUpdate`; the `daysSinceSellerUpdate`
  column help loses the sentence about the filter and the "Red when a seller updated too
  recently" clause; its tooltip keeps the in-band idle days.
- `test/estimate.test.js`: the filter's cases now pass (null); `limitBreaches` no longer names
  `daysSinceSellerUpdate`; keep the `daysSinceInBandSellerUpdate` value assertions.
- `docs/export-improvements-plan.md`: the filter list and the red-cells item.
- `docs/ui-decisions/2026-11-25--status--no-seller-updated-too-recently-filter.md`: Situation /
  Proposed (keep it) / Chosen (removed; "days idle" stays visible; "avg days idle" comes with M1) /
  Why (quote above) / Pattern none / Status ruling.

## Validation

`node --test test/*.test.js` green; `node --check public/estimate.js public/export.js` (one file
per call). Browser: a row that was filtered only by this rule now shows.

## Definition of done

The reason string "seller updated too recently" appears nowhere in `public/` or `test/`; the docs
and the ruling file are updated; gates green.

Sub-agent reminders: do not commit; do not expand scope; do not suppress warnings or disable
tests; stop and report if blocked; report what changed, what was validated and any deviation.
