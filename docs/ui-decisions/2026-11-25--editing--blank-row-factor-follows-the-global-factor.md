# A blank row factor follows the global factor

- Situation: a table has a global multiplier and a per-row multiplier that overrides it; once a row has its own value there was no way back to following the global one.
- Proposed: keep ignoring a blank or invalid entry (the row kept its own factor).
- Chosen: clearing a row's factor removes its own value, the row follows the global factor again and is re-estimated; on commit a blank or invalid entry snaps back to the value in force. The input says which state it is in (title) and a row's own factor is set in bold.
- Why: "if I change the local factor to '' it should revert to following the global factor" (owner's words)
- Pattern: editing--accept-what-the-reader-types-validate-after
- Status: ruling
