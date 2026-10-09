# Synthetic write-code run dirs

Two made-up runs on a lab repo (`JeffreyVdb/lab`), laid out like
`<runs-dir>/<h3d_run>/`: `workspaces.json` is the herdr side (each workspace's
label, agent and the `h3d_*` tokens the skill reports with
`workspace report-metadata`), the other files are the reports the freelancers
published. `tools/gen-fixtures.mjs` reads them the way the bridge does
(contract §1.2: verdict, blocker and issue counts, `input_required` cut to 8 KiB
(`input_truncated`), `input_for`, `summary` to 300 bytes) to build the `lab` floor of `demo-m6`. Nothing here
comes from a real run.

- `20260928-1400-overcap`: the over-cap orchestrator. `h3d_pass=3`,
  `h3d_phase=waiting_user`; REVIEW r3 says `CHANGES_REQUIRED` with 2 blockers
  (5 issues), UX r3 `PASS`, CODE r3 handed in its summary. All four sit in the
  first pod. The bridge's `TestOverCapFixture` (`internal/server/runs_test.go`) reads this
  directory in place, so bridge and game exercise the same run.
- `20260928-1500-lobby`: every other lifecycle state (pass 1, in review): a
  researcher and a coder reporting, a reviewer `INCOMPLETE`, a UX reviewer
  blocked on `input_required`, a coder working, a researcher onboarding
  (agent up, no report yet), a coder just hired (no agent yet).

A report request the orchestrator resolved without resuming the worker (#215) is a
`<stem>.resolved.json` sidecar next to the report, e.g. `code-lobby-r1.resolved.json`:
`{"report":"code-lobby-r1.json","resolved_by":"orchestrator","note":"accepted as AC4 evidence"}`
(`report` must equal the report's file name; a sidecar without it, or with a non-string
field, is ignored). The generator reads it like the bridge does, except that fixtures have no meaningful mtimes, so any valid sidecar
naming the report resolves the report (`input_resolved` on the worker). No fixture run ships one (it would
change the demo floor's counts); the simulator shows it live: `sim.crew` step `report` with
`input_required` (and `input_for`), then step `resolve` (`by`, `note`), see
`tools/fixture-crew.ts` and `e2e/m6-crew.spec.ts`.
