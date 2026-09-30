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

## 2026-09-30 — #51 (and #13): images reach the agents through Drop Zone, over HTTP

| # | Question | Decision |
|---|---|---|
| 1 | The transport of an image: the `/ws` chunks #13 specified, or HTTP? | **HTTP: `POST /upload` with the raw bytes**, through the helper to the bridge, beside the logos (M3d). The WebSocket reads whole messages up to 256 KiB (`maxClientMsg`; fragmenting one message does not get round that cap), so an image of up to 25 MiB would need base64 or binary chunks with an offset protocol, a per-connection transfer state, acks, cancellation and audit redaction. HTTP gives the streaming, the status codes, the body cap and the cancellation (a closed request) for free, does not queue behind or block the control traffic of the one socket, and the logo routes are the precedent for the topology (URL derived from the WebSocket URL, token kept, Host/Origin guards, the token and `Origin` not forwarded). It changes #13's stated transport; the rest of #13 (Drop Zone, one file per request, 25 MB, markers) stands. |
| 2 | Drop Zone's contract | Facts read from its source (`internal/upload/handler.go`, `store.go`): `POST /upload` multipart with the `file` part; an optional `name` field **only counts if it comes before the file part**; one file is stored under its sanitised stem and original extension, **two or more file parts become a `tar.zst`** (so one request per image); the file is spooled and claimed into a date folder **only after the whole body parsed**, with `-2`, `-3` for a collision (so the path is never predicted); success is `200 text/plain` with the absolute path and **one** line feed. It has no authentication, size cap or type check: the bridge owns those. The client never supplies the upstream URL (`--dropzone-url`, default `http://127.0.0.1:8080`) and the bridge never writes the drop directory itself. |
| 3 | Size | **25 MiB** (`25 << 20` = 26214400 bytes), counted on the bytes read (`http.MaxBytesReader` in the bridge, plus one byte past the cap as a sentinel in the streaming), never on `Content-Length`. A screenshot is a few MB; a retina PNG with a lot of detail can pass 10. MiB not MB, so the number is a power of two the game can show and compare exactly. Over the cap is `413`, and the request to Drop Zone is **aborted without the multipart footer**: a plain `LimitReader` would cut the image short and still finish the body, storing a truncated file. The helper allows the cap plus 4 KiB (also for chunked bodies) and leaves the exact verdict to the bridge. |
| 4 | Type checking | **Sniff, do not decode.** The first 512 bytes go through `http.DetectContentType`; only PNG, JPEG, GIF and WebP pass, the extension follows the sniff (`.jpg` for JPEG), the part carries the sniffed type, and the client's `Content-Type` and file name are hints nobody looks at (an SVG or HTML labelled `image/png` is `415`). Decoding would cost memory for a 25 MiB screenshot and prove little; the agents' own readers say if a file is corrupt. |
| 5 | Name | `h3d-<label>-<n>`: the label a hint from the client, cut down to `[a-z0-9-]` and 24 characters (`hire` when empty), `n` the image's sequence in the draft. Not the client's file name. The number in the stored name need not match the `[Image #n]` marker (that is document order); no file is renamed after a reorder. |
| 6 | Lost answer | **An orphan is accepted.** If the connection drops after Drop Zone stored the file, nobody references it and a retry stores another (`-2`). The bridge cannot delete it (Drop Zone has no delete, and the bridge does not write its directory) and should not guess what is its own. |
| 7 | Concurrency and time | At most 4 uploads at once (a fifth is `429` `upload_busy`, not queued: a queue would hold a client's body open), 2 minutes for the whole upload (`504` `upload_timeout`), 5 s to connect, 30 s for Drop Zone's answer after the last byte, no redirects (an image is never replayed elsewhere). The pipe to Drop Zone is closed when the context ends: the HTTP transport waits for its writer, which waits on the pipe, so cancelling a context alone would hang. |
| 8 | Audit | Rows `image.upload` with label, `n`, size, type and outcome; never the bytes, and not the path (an audit row is not where a path is needed). |
