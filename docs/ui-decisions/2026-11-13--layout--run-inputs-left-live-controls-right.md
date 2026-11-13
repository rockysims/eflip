# Run inputs left of the Run button, live controls right of it

- Situation: the export page's control row mixes inputs that are only read when Run is pressed (From, To, days to clear) with controls that take effect at once (global factor, show filtered, search, Copy orders) and a setting for the next load (auto-run on load).
- Proposed: order of arrival (From, To, Run, Stop, auto-run, global factor, days to clear, show filtered, search, Copy orders).
- Chosen: everything that must be set before Run sits to its left, in reading order; Run and Stop follow; everything that can change without another Run sits to the right.
- Why: no reason given beyond the grouping itself.
- Pattern: none in the library covers grouping controls by when they take effect; closest intent is layout (controls ordered by workflow).
- Status: ruling
