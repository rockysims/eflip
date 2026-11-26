# Colour a cell red when it breaks a filter limit

- Situation: a dense numeric table filters rows by thresholds on several columns. A factor above 1 and the one-unit floor can show figures past a threshold on rows that are not filtered, so the number alone no longer says whether it is acceptable.
- Proposed: colour only the ROI cell, against limits hard-coded in the estimate.
- Chosen: any cell whose value is outside its column's own min/max filter turns dark red (#b42318), and so does the rivals cell behind the "too much competition" heuristic, which does not fit one column, and days to clear beyond the Run horizon. (Until 2026-11-25 the days idle cell also turned red for the "seller updated too recently" filter; that filter was removed the same day, see 2026-11-25--status--no-seller-updated-too-recently-filter.) The tooltip says which limit. The single-column limits (daily profit 1M/day, the min ROI, active days 0.2) are seeded once into the column filters as defaults and are no longer hard-coded. Colour marks the value, not the row; the tooltip and the row's filter reason say it in words.
- Why: "Since shown ROI can now be below the limit, lets color the ROI number red or something when it violates a filter. Same for the other columns too maybe?" then "I'd like to use the min/max filters built into the table UI instead of hardcoded limits (where it makes sense / fits to do it that way)" (owner's words).
- Pattern: a11y--never-let-colour-carry-meaning-alone
- Status: ruling
