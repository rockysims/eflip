# Colour a cell red when it breaks a filter limit

- Situation: a dense numeric table filters rows by thresholds on several columns (ROI floor, daily profit, active days, seller idle time, rivals). A factor above 1 and the one-unit floor can now show figures past a threshold on rows that are not filtered, so the number alone no longer says whether it is acceptable.
- Proposed: colour only the ROI cell.
- Chosen: any cell whose value breaks a limit turns dark red (#b42318) and its tooltip says which limit: daily profit below 1M/day, ROI below the floor, active days below 0.2, seller updated too recently, too much competition, and days to clear beyond the horizon. The colour marks the value, not the row's filtered state (dim rows keep their dimming). Colour never carries the meaning alone: the tooltip and the row's filter reason say it in words.
- Why: "Since shown ROI can now be below the limit, lets color the ROI number red or something when it violates a filter. Same for the other columns too maybe?" (owner's words). The extension to the other columns is the agent's proposal, pending the owner's verdict.
- Pattern: a11y--never-let-colour-carry-meaning-alone
- Status: open
