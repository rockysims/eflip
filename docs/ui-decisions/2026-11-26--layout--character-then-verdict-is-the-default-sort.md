# Character first, then verdict, is the default sort

- Situation: the open-orders table pooled several characters' orders; it sorted by verdict by default, with a sortable character column.
- Proposed: keep verdict as the default and the character as one sortable column among the others.
- Chosen: the default sort is the character column ascending with the verdict as its tie-break; under any other column the character is the tie-break; the "default order" button restores it; while one character has rows the verdict header carries the arrow.
- Why: "default sort should be character as primary sort and verdict as sub sort (in fact lets make character always be the sub sort unless primary sort is character in which case it should be verdict that is used as the sub sort)" (owner, 2026-11-26).
- Pattern: none
- Status: ruling; reverses the default of 2026-11-26--layout--character-is-a-sortable-column
