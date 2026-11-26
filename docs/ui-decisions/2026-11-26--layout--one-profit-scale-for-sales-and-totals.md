# One profit scale for the sale dots and the total column

- Situation: the sales timeline sizes each sale dot by its profit on one sqrt scale and each item's total on a scale of its own, so a total cannot be compared with the sales that make it up by eye.
- Proposed: keep the two scales (the agent's choice in the previous round, so that one item's total would not shrink every sale dot).
- Chosen: one scale for sales, pending marks and totals, the largest absolute profit among them at the maximum radius; rows keep their height; the footnote and the total tooltip no longer speak of a separate scale.
- Why: "profit circle size should be on the same scale for both totals and individual/groups of sale(s) so I can compare them visually (maybe make the rows taller when needed? or rescale individual/groups to be smaller? not sure)" (owner, 2026-11-26). Rows did not need to grow: the largest mark already fits.
- Pattern: none
- Status: ruling; reverses the separate scale of 2026-11-26--layout--timeline-rows-by-profit-with-a-total-column
