# Colour a cell red when it breaks a filter limit

- Situation: a dense numeric table filters rows by thresholds on several columns. A factor above 1 and the one-unit floor can show figures past a threshold on rows that are not filtered, so the number alone no longer says whether it is acceptable.
- Proposed: colour only the ROI cell, against limits hard-coded in the estimate.
- Chosen: any cell whose value is outside its column's own min/max filter turns dark red (#b42318), and so do the cells behind the two heuristics that do not fit one column (days idle for "seller updated too recently", rivals for "too much competition") and days to clear beyond the Run horizon. The tooltip says which limit. The single-column limits (daily profit 1M/day, the min ROI, active days 0.2) are seeded once into the column filters as defaults and are no longer hard-coded. Colour marks the value, not the row; the tooltip and the row's filter reason say it in words.
- Why: "Since shown ROI can now be below the limit, lets color the ROI number red or something when it violates a filter. Same for the other columns too maybe?" then "I'd like to use the min/max filters built into the table UI instead of hardcoded limits (where it makes sense / fits to do it that way)" (owner's words).
- Pattern: a11y--never-let-colour-carry-meaning-alone
- Status: ruling
