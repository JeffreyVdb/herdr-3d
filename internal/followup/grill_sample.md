Round 2. Your Q1 answer (fresh hire + optional handoff) opens hire-parameter questions. One finding first: nothing today hires *from* a handoff. Handoffs are only `.md` files in `~/handoff/<floor>/` with DB/FTS rows, so attaching one is new wiring.

❓ **Q8** - **Hire params captured at creation**: A `worker.hire` needs floor, desk, harness/model/effort, cwd and the worktree flag. Should the schedule store a full hire spec, prefilled from the source worker when it comes from a suggestion?
- cwd: source worker's cwd. If that was a worktree that's gone by fire time, then what?
- worktree flag: the default?

➡️ Store the full spec (floor, harness, model, effort, cwd, worktree), prefilled from the source worker and editable. If the stored cwd has disappeared at fire time, fall back to the worktree's repo root plus `worktree: true` (fresh `h3d/` branch). Default `worktree: false` when the source wasn't a worktree, otherwise as above. Desk is picked at fire time, not stored.

❓ **Q9** - **Asleep floor at fire time**: A hire on an asleep floor returns `invalid_state`. `floor.wake` resumes **every** worker on the floor, which is a side effect.
- (a) Auto-wake the floor, then hire.
- (b) Mark the schedule `failed: floor_asleep` and notify.
- (c) Per-schedule checkbox "wake floor if asleep", default on.

➡️ (c), default on. The whole point is not having to remember. Resuming the floor's other workers is acceptable collateral, and users who object can turn it off.

❓ **Q10** - **Desks full at fire time**:
- (a) Fail immediately with `failed: no_desk`.
- (b) Wait in a `waiting_desk` state until a desk frees, shown in the display, with "run now" still available. This counts toward lateness under `max_lateness`.

➡️ (b). A soak follow-up running an hour late beats one that never runs.

❓ **Q11** - **How the handoff reaches the new agent**: The prompt limit is 32 KiB and a handoff can be larger.
- (a) Inline the handoff text into the prompt.
- (b) Append "Context from earlier session: read `~/handoff/<floor>/<file>.md` first" to the explicit prompt.

➡️ (b). Size-safe, the file is already on the bridge host, and it reuses the handoff as-is. If the file was deleted before firing, run without it and add a note to the prompt.

❓ **Q12** - **Handoff source on create**:
- From the suggestion chip: auto-create a **literal** handoff (no AI call) of the source message when the schedule is saved, with a checkbox to opt out?
- Manual create: pick an existing handoff from the filing cabinet (optional), or none?
- Should LLM/agent handoff modes be offered too?

➡️ Chip: literal handoff, checkbox on by default. Manual: optional picker over existing handoffs. Literal only in this epic; the user can make an LLM handoff separately first and then pick it.

❓ **Q13** - **Detection pipeline & toggle**: Reuse the follow-ups (#90) turn-end hook with a second classifier question ("Does the message say something must be done after a wait or at a later time?"). The LLM then extracts `{due_at, draft_prompt, title}` and is given the current time in UTC plus the user's tz so it can resolve "10:45 UTC tomorrow". Separate settings toggle or shared with follow-ups? Default?

➡️ A separate bridge setting, "Schedule suggestions", off by default like follow-ups, with the same 0.7 gate and the same once-per-message dedup. If the LLM can't produce a concrete `due_at`, show no chip.

❓ **Q14** - **Office display form**: A new prop on each floor, e.g. a wall "departures board" showing the next ~3 schedules with countdowns. Clicking it opens a HUD dialog with the full list, plus create/edit/cancel/run-now. Scope:
- (a) Per-floor board showing only that floor's schedules.
- (b) A single global board in the lobby/lounge.
- (c) Per-floor board, with an "all floors" toggle in the dialog.

➡️ (c). Schedules belong to a floor (that's where they hire), but the overview needs to cover all floors.

❓ **Q15** - **Manual creation entry points**: Where can you create one without a chip?
- The display dialog's "+ New".
- "Schedule follow-up…" on any transcript message (next to Handoff), even unclassified.
- A keyboard shortcut?

➡️ The first two. The second reuses the chip's prefill path minus the LLM draft. No shortcut for now.

❓ **Q16** - **Notifying outcomes**: When a schedule fires, runs late, is skipped, or fails, how do you hear about it? Toast in game, the display's status, a system/push notification?

➡️ Game toast plus display status. The hired worker appearing at a desk is the main signal. No OS-level push in this epic.

❓ **Q17** - **Defining "missed"**: The bridge's Go timers use a monotonic clock, which stops while the host is suspended (laptop lid closed). Proposal: a wall-clock check every 30 s rather than one long timer, plus a check on startup. A schedule counts as **missed** when it is first checked more than a grace period after `due_at`, and the `on_miss` policy then applies. Grace period?

➡️ 5 min grace. Under that it just runs, with no late note. The scan on startup covers a bridge restart.