# Timeline rows sort by profit and end in a total column

- Situation: a timeline chart with one row per item and dots whose area is the profit of each sale; rows were ordered newest sale first.
- Proposed: keep newest-first ordering; totals only in the table below.
- Chosen: rows sorted by the window's profit, highest first (items with only pending fills last); after the time axis a dashed divider and a "total" column, one dot (square for a loss) per item whose area is the item's profit over the window, on a scale of its own, with the figure beside it where there is room and the exact sums in its tooltip.
- Why: "it would be even better if there were a dot/square at the end to show the total (with a divider to show its now just another normal column) and also the items should be sorted from most to least profit" (owner, 2026-11-26). The separate scale is the agent's choice, so that one item's total does not shrink every sale dot to the floor.
- Pattern: none
- Status: ruling
