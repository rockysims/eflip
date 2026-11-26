# Presence lines differ by colour and weight, not by dashes

- Situation: the presence line under each timeline row was solid while on top and dotted while listed but undercut; short stretches of either looked alike.
- Proposed: keep the dashes.
- Chosen: both states solid; on top a 4 px line in the ink colour, listed a 2 px line in a mid grey, bottoms aligned so the dark line reads taller; the gap and the faded unknown stretch stay; the legend, the footnote and the toggle's title say so.
- Why: "the dotted line to indicate time undercut doesn't work well visually because solid lines can look like dots when short. lets make it solid instead of dotted and let the color change be the indicator. maybe also make dark solid line indicating we're in top position a pixel or 2 taller so its indicated by both color and shape still" (owner, 2026-11-26).
- Pattern: a11y--never-let-colour-carry-meaning-alone (the weight carries it too)
- Status: ruling; amends 2026-11-26--layout--presence-lines-not-event-ticks
