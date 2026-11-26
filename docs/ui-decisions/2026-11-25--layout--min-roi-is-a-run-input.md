# Min ROI is a Run input

- Situation: one threshold serves three jobs: triage skips items before any per-type request, the book walk stops at the first order below it, and the table can hide rows below it. The first two happen when a run starts; the third is live.
- Proposed: drive all three from the ROI column's min/max filter.
- Chosen: the ROI floor is a Run input ("min ROI", left of Run, read when Run is pressed, shown in the report header), feeding triage, the walk and the saved run's config. The ROI column's min is a live display limit that follows the Run input until the owner sets their own; it can only tighten what a run produced, since a recommendation never buys below the floor.
- Why: a column filter cannot reach back into a finished run's triage; the owner asked to "add it now (at/near end of the plan)".
- Pattern: none (placement follows 2026-11-13--layout--run-inputs-left-live-controls-right)
- Status: ruling
