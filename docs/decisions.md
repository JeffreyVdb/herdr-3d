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
| 5 | Small dialogs (confirm, hire, start-run, send-home, prompt, presets, open-PR) | **Unchanged**: the plate stays above them (hire and start-run also show the limits inline). Only the Changes panel steps it aside, as before. |

## 2026-09-30 — #51 (M11 #13): the shared prompt composer

Built as a standalone module (`game/src/ui/composer/`, `game/src/net/upload.ts`); the hire dialog, the P overlay and the start-run instructions are wired to it in a later round.

| # | Question | Decision |
|---|---|---|
| 1 | `contenteditable` with chips, or a textarea with a thumbnail strip? | **`contenteditable` with atomic chips.** #51 asks for the image inline, at the caret, in order with the text; a strip cannot say where in the text a picture was. One component for every prompt, not a hire-only fork. The editor is vanilla (no editor library): plain text and chips only, so the browser edits text natively and everything it cannot be trusted with goes through our model (chips, paste, drop, Enter, delete beside a chip, undo). If IME or history acceptance fails on the Mac browsers, the fallback is a framework-neutral editor core behind the same `Composer` API, not scattered browser hacks. |
| 2 | Model shape | **One string plus the occurrences.** The document is a string in which each image is one U+FFFC, and the list of image occurrences in that order. A caret or a selection is an offset; ranges are `slice`s; "between two chips" and "two chips side by side" need no cases. Text is cleaned at the boundary (CRLF/CR → LF, U+FFFC and U+200B dropped). An occurrence (one chip) points at a **resource** (the bytes and their upload): the two ids differ so one upload can serve two chips and every chip stays editable. The marker number is never stored: it is the occurrence's place in the document. The DOM is drawn from the model and read back on `input`; chips are `contenteditable=false` wrappers with separate preview, retry and remove buttons; an empty text run is a U+200B text node so a caret has a place beside a chip. |
| 3 | Serialiser | `[Image #n: <path>]` in **document order**, path exactly as Drop Zone returned it (absolute, no `]`, no control characters or line breaks, else an error and nothing is sent), text verbatim, brackets the user typed are never read. No trailing hint by default (an option adds one line; no experiment has said it is needed). Cap in UTF-8 bytes, checked on the final text: hire 32 KiB, `worker.prompt` 16 KiB, passed in by the host. `resolve()` never returns partial text. |
| 4 | Uploads | Per image, as soon as it is pasted (eager), at most 2 at a time, `pending → uploading → ready(path) \| error`, one `AbortController` and an `attempt` per resource so an answer for a removed or retried image is ignored. A removed chip cancels its upload; undoing the removal queues it again. `resolve()` waits for the images the document uses, and is `ok:false` with the failed images (never a partial prompt) if any failed; it does **not** retry a failed image by itself (a broken Drop Zone is not hit by every Enter): the chip's Retry does, and a ready image is never sent twice. HTTP `POST /upload` per the shared contract (`net/upload.ts`, like the logos). |
| 5 | Limits | 20 images per prompt (our opinion, not the ticket's), `UPLOAD_MAX_BYTES` = 25 MiB each, PNG/JPEG/GIF/WebP by type or (no type) extension, empty files refused, each with a friendly message; the bridge stays the authority (sniffed bytes). Object URLs are kept while the draft, its history or an open preview can show the image, then revoked. |
| 6 | Undo | **One history** in the draft for text and images (100 steps; typing within 1 s is one step); the browser's own undo is never used (`beforeinput` history types and Ctrl/⌘+Z, Shift+Z, Y are ours). Covered: typing, IME commit, text paste, chip insert/remove, selection replacement. Not covered: upload progress and preview open/close are not history. |
| 7 | Enlarged view | A second native modal `<dialog>` (top layer, so it shows over a modal host; inert below). **Esc closes only it**: a capture-phase keydown on `window` closes it and swallows the key, and `cancel` of the preview and of the host (capture, before the host's own handler) are refused while it is open (the research probe found two nested dialogs can both close on one Esc). Closes on its close button, Esc, or a press *and* release on the empty surface without a drag; never on the image. On close the caret (also a backward selection), scroll and focus come back from the draft's own record; nothing is edited while it is open. |
| 8 | Drafts | The host keeps the `Draft` object: text, caret, images (bytes and uploaded paths) and history survive closing the dialog, and uploads go on meanwhile. The composer never disposes a draft. `clearIf(revision)` clears only what was sent, so an edit made while a send was pending survives it. |
| 9 | Deliberately out | Recent drops, office-context markers and non-image `[File: …]` chips (#13's later parts); IndexedDB / localStorage persistence of pending images across a reload (a text-only save is left to the host); dragging chips to reorder (`moveImage` exists in the model, no gesture yet); zoom/pan and next/previous in the enlarged view; a drop-position indicator (the editor is highlighted); dedupe of identical images (two pastes are two chips); re-encoding or downscaling (bytes go up as pasted); HEIC/TIFF. Checked only in Chromium: macOS Safari/Chrome (clipboard screenshots, IME, VoiceOver) need the manual pass in research-composer.md. |

