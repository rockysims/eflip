# Re-estimate the row for the factored quantity

- Situation: a table row recommends a quantity from a walk up an order book (cheapest first, stopping at an ROI floor) and has a per-row multiplier ("factor") that scales it. The money columns multiplied the scaled quantity by per-item figures averaged over the orders the recommendation walked, so a factor above 1 priced the extra units as if the book held more at the cheap prices.
- Proposed: keep the multiplication and price the extra units at the dearest order the recommendation walked.
- Chosen: on any factor other than 1, re-run the estimate with ceil(recommended × factor) as a target, bought for real up the source book past the ROI floor (the spend cap still applies), so cost/item, ROI, order totals, days to clear and daily profit are real for that quantity. A factor below 1 re-walks too and gets only the cheapest units. When the station lacks the target, the quantity shown and copied is what the book has, and the tooltip says so. The row's filtered state and its "recommended" figure stay those of the factor-1 estimate, so a factor never hides a row; sorting uses the re-estimated figures.
- Why: "so we see real numbers for the extra items" (owner's words); the four defaults above were confirmed as proposed.
- Pattern: none
- Status: ruling
