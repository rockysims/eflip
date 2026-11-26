# Show listing state as lines along the row, not as event ticks

- Situation: a timeline chart with one row per item and a dot per sale; the owner also wants to read when we were listed, when we were the lowest seller, and when someone was below us.
- Proposed: a tick at each price change of ours and a hollow box at each undercut against us, behind a "show order events" toggle (off by default).
- Chosen: a thin line near the bottom of each row: solid while one of our orders is the lowest at its station, dotted while listed but undercut, nothing while we had no sell order; faded where the book log cannot say. Each stretch has a tooltip with its span, cause and the orders below. On by default, behind "show when we were listed and on top".
- Why: "sold and empty boxes doesn't seem to be working well as a visual language. how about a timeline (literal lines) near the bottom of each item row. maybe solid line means we're on top, dotted means we've got a sell order but its not on top, and no line (blank spots) means a time when we had no sell order" (owner, 2026-11-26).
- Pattern: a11y--never-let-colour-carry-meaning-alone
- Status: ruling; the dotted form was replaced by 2026-11-26--status--presence-lines-differ-by-colour-and-weight
