# Avg days idle beside days idle

- Situation: the "days idle" column shows the time since the newest competing seller moved, an instantaneous figure that drops back to zero each time a seller re-prices and so says little about how often they do.
- Proposed: replace "days idle" with an average.
- Chosen: keep "days idle" and add an "avg days idle" column right after it: the observed mean days between in-band price moves over the covered part of the window (max(days to clear, 3) days); blank without observation; "≥ n" when nobody moved in the covered time. It is observed only, with no model fallback, so it carries no dotted underline.
- Why: "keep 'days idle' and add 'avg days idle' column" and "the main reasons for switching to 'avg days idle' are more accurate data and removing the annoyance that best pick items fluctuate more than necessary" (owner's words).
- Pattern: none
- Status: ruling
