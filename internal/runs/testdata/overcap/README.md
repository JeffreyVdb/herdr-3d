# Over-cap run (synthetic)

A write-code run at its review-pass cap, for the bridge's over-cap test
(`internal/server/runs_test.go`) and the game's fixture sim, which mirrors it.

- `workers.json`: the floor's workspaces as herdr shows them (label, status, `h3d_*` tokens). Floor repo:
  `example/lab`.
  - `w1` `ORCH|overcap`: `h3d_pass=3`, `h3d_phase=waiting_user` → `over_cap: true`, `issue: {example/lab, 3}` (from
    its freelancers' ticket).
  - `w2` `CODE|overcap|3|r3`: round 3, report ready with a summary.
  - `w3` `REVIEW|overcap|3|r3`: round 3, report ready, `CHANGES_REQUIRED`, 1 blocker of 2 issues.
  - `w4` `UX|overcap|3|r3`: round 3, report pending (no file).
- `runs/`: the runs directory (`--runs-dir`), one run `20260101-0900-overcap` with the two reports.
