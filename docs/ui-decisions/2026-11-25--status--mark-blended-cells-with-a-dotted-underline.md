# Mark blended cells with a dotted underline

- Situation: a figure on the export page can be partly observed (from the book log) and partly modelled (by the estimate), in a share that differs from row to row, so the number alone does not say what it stands on.
- Proposed: mark a blended cell with a colour or an icon.
- Chosen: a blended cell (rivals, daily profit) gets a dotted underline (class `observed`) and its tooltip states the covered fraction, the observed figure and the model figure ("observed f=0.62 (events gap 3 h): 1.9 observed · 2.4 model"). Colour stays reserved for limits (red), and the mark is never the only carrier of the meaning: the column help and the tooltip say it in words. A cell with no observation has neither the underline nor the sentence.
- Why: the owner accepted the blend "as suggested" and asked that history be preferred "but where history has blank spots we fall back to the old method (prorated)", so each cell has to say which it shows. The underline was the agent's proposal, confirmed in the review of 2026-11-25 (pending: if the owner changes it, amend this file).
- Pattern: a11y--never-let-colour-carry-meaning-alone
- Status: ruling
