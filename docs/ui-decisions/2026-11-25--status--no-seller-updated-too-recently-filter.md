# No "seller updated too recently" filter

- Situation: the export estimate hid a row, with the reason "seller updated too recently", when the newest in-band destination seller had moved within a threshold that shrank as daily profit grew (30 h for a low earner, 1 h for a high one). Sellers re-price their orders often, so a good item dropped off the list when someone updated, came back a while later, and dropped off again at the next update.
- Proposed: keep the filter, with the threshold on the in-band sellers' idle time (profit-dependent, 1 to 30 hours) and the "days idle" cell turning red when it fires.
- Chosen: the filter is removed. A row is no longer hidden or its "days idle" cell coloured because a seller updated recently. The "days idle" column stays visible, with its tooltip giving the in-band idle days, and the report keeps both idle figures. An "avg days idle" column (the observed mean time between re-prices) comes with the history-backed columns (M1 of planning/2026-11-25-export-history-columns).
- Why: "the annoyance that best pick items fluctuate more than necessary (people keep updating their order which means 'seller updated too recently' then some time goes by and it goes back on the list until a while later when they update again and it again disappears for a while because 'seller updated too recently') and I'd like a more steady picture of the export opportunities" (owner's words).
- Pattern: none
- Status: ruling
