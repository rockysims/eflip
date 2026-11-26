# The type id lives in the tooltip, not beside the name

- Situation: item names in tables (orders, results) were followed by the EVE type id in dim text.
- Proposed: keep the id visible for copy and lookup.
- Chosen: the cell shows the name only; the id is in the name's tooltip. Search by id on the results page still works.
- Why: "I think we should hide the item id (add it to the tooltip maybe?) when displaying item names (orders, insights, results, and export)" (owner, 2026-11-26). Insights and export never showed it.
- Pattern: none
- Status: ruling
