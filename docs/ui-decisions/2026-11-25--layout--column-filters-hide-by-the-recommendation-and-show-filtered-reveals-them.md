# Column filters hide by the recommendation, and "show filtered" reveals them

- Situation: a table hides rows by per-column min/max filters and, separately, dims or hides rows the estimate filtered. Rows can be re-estimated for a per-row factor, which moves their figures.
- Proposed: keep testing the column filters against the displayed (factored) figures, and keep "show filtered" limited to the estimate's own filters.
- Chosen: a column filter hides a row by its factor-1 figures, so editing a factor never makes the row vanish; the red marking uses the displayed figures. "show filtered" reveals rows hidden by either source, dimmed, with their red cells visible; the totals line keeps counting the rows outside the column filters.
- Why: the owner accepted both as proposed defaults; no further reason given.
- Pattern: none
- Status: ruling
