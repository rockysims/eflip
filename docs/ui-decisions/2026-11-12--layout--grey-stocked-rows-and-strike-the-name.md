# Grey stocked rows and strike the name

- Situation: the export table marks items the user already has in stock (the "always show" list, which bypasses triage and filters) so they are not re-bought by mistake.
- Proposed: whole row greyed only (opacity 0.3), under the label "marked items" (the ruling of 2026-11-06, which had itself replaced a struck-through name).
- Chosen: the list is called "stocked items" everywhere in the UI; the row stays greyed and the item name is additionally struck through. The type id and the copy-name button are not struck.
- Why: no reason given.
- Pattern: a11y--never-let-colour-carry-meaning-alone (the strike-through gives the greyed row a second, non-colour cue)
- Status: ruling
