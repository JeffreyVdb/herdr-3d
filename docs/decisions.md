# Decisions log

## 2026-09-28 — answers to server-model open questions

| # | Question | Decision |
|---|---|---|
| 1 | Which devices may connect to the bridge? | Any device that has SSH access to the herdr server (devbox). Auth = SSH access, not a Tailscale device allowlist. Primary target: **great performance on MacBooks** (M2 Max). |
| 2 | Which terminal app on the Mac? | **Ghostty**. Used for "open in real terminal": game launches Ghostty running `herdr --remote dev@devbox --session <s>`. |
| 3 | How to show stopped sessions? | Workers **sleeping behind their desks (zZz)**. |
| 4 | "Fire" semantics / visual | Worker takes their laptop and **leaves the building carrying a cardboard box with their stuff**; workspace is closed. |
| 5 | Initial building seeding | **Manual**: user creates buildings and assigns sessions to them. |
| 6 | Bridge language | **Go** (fast compilation, good performance). |

Implications:
- (1) Bridge listens on localhost / a 0600 unix socket on the server only; clients reach it through an SSH tunnel. Anyone who can SSH in is authorized; nothing is exposed on the tailnet directly.
- (1)+(2) A plain browser tab cannot open an SSH tunnel or launch Ghostty → likely thin native shell (e.g. Tauri) or a small Mac helper. Pending follow-up research.

## 2026-09-28 — answers to engine open questions

| # | Question | Decision |
|---|---|---|
| 1 | Browser-based game OK? | Yes, **if performance is acceptable** on MacBooks (to be proven by benchmark). |
| 2 | Install `playwright-core` on the Mac (~/h3d-tools)? | **Approved.** |
| 3 | Install mesa on the server? | Approved if useful. Only needed for Godot pixel output on server, or possibly WebGPU-backend screenshots via lavapipe; not needed for the three.js WebGL2 test path. |
| 4 | Art style | **Cartoon, "Minions"-like**: small, round, goofy workers. Original characters inspired by that vibe — no Illumination/Minions IP (names, exact designs, likeness). |

## 2026-09-28 — write-code skill

| # | Question | Decision |
|---|---|---|
| 1 | Add h3d metadata conventions to write-code skill? | **Yes, small edits only — skill must stay lean and simple.** Design pending write-code verifier (80-char token value limit). |
| 2 | gpt-5.6 vs gpt-6 in research section | **gpt-6.** Fixed in `~/.agents/skills/write-code/SKILL.md` (lines 146-147). |
| 3 | Over the 3-pass review cap | Orchestrator worker **sweats, red clock above desk, "needs you" bubble**. |
| 4 | Codex vs Claude ORCH run-dir location | Bridge scans both locations. |
- write-code skill edit **applied**: "Game metadata (herdr-3d)" section — run id + durable run dir `~/.local/state/write-code/runs/<run_id>/`; `h3d_*` tokens on ORCH (role/run/phase/pass) and workers (role/run/round/report basename/harness/model/effort). Parent link = shared `h3d_run`. Backup of original in orchestrator scratchpad.

## 2026-09-28 — Ghostty + herdr upgrade

- **Ghostty is optional**, not part of the core loop. herdr servers run headless on the server; all play happens in-game
  (live laptop screens, prompt/approve/keys through the bridge). Ghostty only backs an optional "open raw terminal" button.
- **herdr 0.9.1 upgrade approved.** Mac upgraded via brew (0.9.0 → 0.9.1). Server `herdr update` refuses to run inside a
  herdr pane → Theo runs it from a plain SSH shell, then `herdr integration install claude`.

## 2026-09-28 — architecture proposal decisions

| # | Question | Decision |
|---|---|---|
| 2 | Mac shell | **Go helper + Chrome `--app` window.** Tauri deferred. |
| 3 | Frame-rate policy | **Agreed**: 120 Hz interacting, 30–60 Hz idle, paused when hidden, battery-saver toggle. |
| 4 | Worker art | **Procedural rigid-part workers** now; hand-modelled Blender parts optional later. |
| 5 | Godot benchmark | **Skip.** three.js stays. |

## 2026-09-28 — identity marker, build team, repo

- **Pane-label identity marker** (`h3d-<short uuid>` on each worker's root pane): **approved**.
- **Build team** (write-code): coders = claude `claude-opus-5-5` effort medium; reviewers = codex `gpt-6-sol` reasoning high.
- **Repo**: own git repo at `herdr-3d/`, private GitHub repo `JeffreyVdb/herdr-3d` + GitHub Project.

## 2026-09-29 — M6b (#28): arrival style and the desk monitor

| # | Question | Decision |
|---|---|---|
| 1 | Drop from the sky, or step out of a void? | **Drop from above.** The hire falls into its chair from 1.6 m over the seat (0.36 s, a little stretched, its shadow growing on the seat), lands flattened, springs back and settles, with a puff of dust round the chair: 0.85 s in all, one `drop` phase. It suits the cartoon crew and needs no new material (a portal wants transparency and a shader). The desk is the worker's from the first frame (never `away`): look-at, the card, sitting at its screen and prompts work while it plays; only the figure moves. Only the floor you are on shows it; anywhere else it resolves at once. |
| 2 | Where the monitor sits, how big | **Centred, facing the chair; the dock on the pod's outer side.** Glass 0.74 × 0.40 m (a 32" monitor; the M5 lid was 0.31 × 0.2) under the worker's hat line: its top is at 1.17 m, so the hat (the model cue) shows over it from across the pod, and the cards (1.62 m) and the empty desk's "+" (raised to 1.45 m) stay clear. The docks sit at the pods' outer corners, so every docked laptop's lid (and sticker) faces an aisle; the worker's photos, mug and plant stand on the other side, towards the neighbour. |
| 3 | Readable at a glance | Standing, a monitor shows the **glance view**: the last lines that say something (no blank rows, empty frames or agent footer), wrapped at 22 columns, 5 lines, bold and lifted to 4.5:1, under a status bar with the status's word. At the Mac's 3024 × 1890 that is ~12 px text at 4 m, ~16 px at 3 m. Straight behind a worker its own body hides its monitor (it sits right in front of it), so monitors read diagonally along the aisles. Seated, the whole terminal. |
| 4 | A new worker at a desk someone is still leaving | **The walk-out gives the desk up for good.** The bridge frees a desk as its worker goes, so a hire (or a freelancer re-seated by its orchestrator) can land on it while the old worker is still packing. From the moment the world seats someone else there, the older walk never shows that desk `away` again, not even after the 0.85 s drop is over (`Arrivals.yieldDesk`). It gets up and walks off at once (no more packing or waving in the new worker's chair); its box keeps what it had packed, the laptop on top, and the rest of the desk's things stay put as the new worker's. |

## 2026-09-29 — M10 follow-up (#47): the plan-limits HUD and screen-filling dialogs

| # | Question | Decision |
|---|---|---|
| 1 | Pill or fold away? | **An edge tab where there is room, else fold away.** Over a screen-filling dialog (`dialog.panel`, the Issues / Pull requests boards and the item modal) the plate would hide the close button and the first row, at any width. The dialogs are centred and sized to the viewport, so no spot in the top bar or a corner is guaranteed free (at 1280 px the board leaves 50 px each side, at 1200 px 16). The widget measures the gap right of the widest open dialog: with ≥ 48 px it slides into a 32 px tab at the right edge (worst percentage over a severity bar, so never colour alone); with less it folds away like the narrow-viewport case. Both are recomputed on resize. |
| 2 | Shift+L over such a dialog | **Peek.** Shift+L and a click on the tab open the expanded panel above the dialog without touching the saved `open` pref; Shift+L again, the plate's header, a pointer-down outside it, or closing the dialog ends the peek. A peek belongs to the topmost screen dialog when it started: closing that one ends it even if another (the board under a closed item modal) stays open, and opening another on top ends it too; the plate then docks for the dialog that is on top. A meter the user hid stays hidden (Shift+L does nothing). Narrow viewports (< 760 px) keep the old fold: Shift+L is a no-op there. Shift+L is handled before the dialog guard in `App.onKey`, since dialogs otherwise own the keys. |
| 3 | On close | The plate is back in the saved state (strip or expanded) in the same task the dialog closes, with no animation and no focus move (focus only follows when it was on the tab or the plate). |
| 4 | Clicking over a modal | A modal `<dialog>` makes the rest of the page inert, top layer included, so a tab or peeking plate left in the page can't be clicked. While a screen dialog is open the widget therefore lives *inside* it (still a fixed-position popover in the top layer) and goes home when the last one closes. |
| 5 | Small dialogs (confirm, hire, start-run, send-home, prompt, presets, open-PR) | **Unchanged**: the plate stays above them (hire and start-run also show the limits inline). Only the Changes panel steps it aside, as before. **Amended 2026-09-30 (#51): hire is no longer small**, see below. |

## 2026-09-30 — #51: dialogs never close by accident; the hire dialog is a full-screen sheet

The bug: `click` with `e.target === dialog` closed a dialog when a press inside (a text selection) was released on the backdrop, because the click lands on the two targets' common ancestor, the `<dialog>`. Ten dialogs had that check; all are replaced by one helper, `backdropPolicy` in `game/src/ui/dismiss.ts`.

| # | Question | Decision |
|---|---|---|
| 1 | Backdrop policy per dialog | **`none`** (only the close button and Esc close it) for every dialog that holds typed text or a consequential choice. **`sheet`** (closes on the backdrop only when the primary-button press AND the click both landed on the `<dialog>` element itself, outside its box; a press that began inside, on its padding or with another button never counts; a pointer cancel, a second press or closing resets it) for the read-only ones. |
| 2 | The table | `none`: hire, start-run (extra instructions), presets, the P prompt, open-PR (title and body), the Changes / settings panels (`panels.ts`, typed fields), send-home (a worktree choice with a delete in it: a stray click must not confirm anything, and dismissing is not the safe default), the board item modal (comment box). `sheet`: About, credits, the HUD sheet, the Issues / Pull requests board list. |
| 3 | `closedby` | Set to `closerequest` on `none` dialogs as progressive enhancement only (Chrome 134, Firefox 141; Safari has no stable support, and `closedby="none"` would also take Esc away). The policy never depends on it: not adding a backdrop listener is the fix. |
| 4 | Esc | Unchanged, with each dialog's own guard (hire: "the hire is still on its way"; presets: editor / delete confirmation first). |
| 5 | Drafts | What is typed in the hire dialog stays until a hire is acknowledged: per desk (`<session>:<desk>`, not the desk number alone), in memory and in `localStorage` (`h3d.draft.hire.<key>`, every access in try/catch, memory only when storage is blocked, full or corrupt), saved on each edit, restored on reopen. Stored as `{ text, fields?, segments? }` (`ui/drafts.ts`) so the shared composer (#13) stores its document in `segments` under the same key. The task and a label the user typed are kept; the folder is not (it is re-checked against the bridge, so restoring it silently would skip that). An acknowledged hire clears the draft **only if it is unchanged** since it was sent, so a hire answered after Esc and a new dialog never eats the newer text; a failed hire keeps it; a hire acknowledged with `prompted: false` (the worker exists, the task did not arrive) keeps the text (the toast says so). A first task handed in by "Ask a worker…" / "Review with a worker" wins over a draft for that open and is not saved until edited, so the old draft stays until then. Moving to another desk ("Hire at Desk N instead") takes what is typed along; an empty form takes that desk's own draft. Not done: presets' editor draft on Esc (Esc still goes back to the list, as before) and start-run / open-PR / P-prompt persistence (the P prompt already keeps its own in-memory draft per worker). |
| 6 | Hire layout | A near-full-screen sheet (12 px gutter, none on a phone; `dvh` and safe-area aware), header / tabs / body / footer as rows of the shell, so **Hire and Cancel never scroll away** (no sticky inside a scroller). The body is two panes: the first-task editor (no 180 px cap, grows with the window) and the options (harness, model, effort, label, folder, worktree) beside it (from 760 px wide) or under it. Every pane says `min-width/min-height: 0`; on desktop the options pane scrolls on its own, on a phone the whole body does. |
| 7 | The editor slot | The task editor is a small class (`TaskEditor` in `hire.ts`: text, focus, busy) in its own pane that re-rendering the options never touches, so its caret, selection and scroll survive a model or limits update. The composer replaces that one class. |
| 8 | Model list | Up to 10 models: the same chips. More: a filter above chips in a multi-column grid, with the count (`12 of 26`), no inner scroll box (the options pane scrolls as a whole), the checked model always visible (a filter never looks like a changed choice), a "no model matches" line. Enter in the filter does not hire; Esc clears it first. A harness switch clears it. Native radios: arrows still pick. |
| 9 | Limits plate (amends #47 row 5) | **Hire is a screen dialog now.** A sheet with a 12 px gutter leaves no room for the edge tab, so over it the plate is away (`data-dock="away"`); Shift+L (outside a text field, where it types an L) still peeks it, and the dialog's own inline limits line stays. The start-run, send-home, prompt, presets and open-PR dialogs stay small: the plate keeps above them. |
