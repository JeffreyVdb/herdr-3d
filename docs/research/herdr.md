# herdr internals & API surface — for driving the herdr-3d game

Researcher: GROUND|herdr (w2, session `herdr-3d`) · 2026-09-28
Installed: **herdr 0.9.0** (protocol 22, schema_version 1) on server *and* Mac (Mac = Homebrew `/opt/homebrew/bin/herdr`).
Current stable upstream: **0.9.1** (2026-09-16). Source: https://github.com/herdrdev/herdr (public, Rust, Apache-2.0; I read tag `v0.9.0`).
Docs index: https://herdr.dev/llms.txt → raw mdx under `docs/next/website/src/content/docs/` (socket-api, session-state, plugins, persistence-remote, connecting-machines).

---

## TL;DR

- **Each herdr session is its own server process with its own Unix socket**: `~/.config/herdr/sessions/<name>/herdr.sock` (default session: `~/.config/herdr/herdr.sock`). No cross-session socket. Discover sessions with `herdr session list --json` (gives `name`, `running`, `socket_path`, `session_dir`).
- **Protocol**: newline-delimited JSON, `{"id","method","params"}` → `{"id","result":{…,"type":…}}` or `{"id","error":{"code","message"}}`. Not JSON-RPC 2.0. **One request per connection** (server reads one line, answers, closes; second pipelined request gets RST). 102 methods; full JSON Schema via `herdr api schema --json` (275 KB).
- **There IS a push stream**: `events.subscribe` keeps the connection open and pushes lifecycle events (workspace/tab/pane created/closed/updated/renamed/focused, layout.updated, pane.agent_detected, pane.exited, workspace.metadata_updated…). Server-side it polls an in-memory ring (512 events) every **100 ms**, so latency ≤ ~100 ms.
  - Gotcha: `pane.agent_status_changed` subscriptions **require a `pane_id`** (one entry per pane; re-subscribe when panes appear). Status changes do **not** emit `pane.updated`/`workspace.updated`.
- **Bridge recipe** (per running session): 1 lifecycle-subscription connection + 1 connection with per-pane `agent_status_changed` subs (rebuilt on pane create/close) + `session.snapshot` bootstrap (1.6 ms, ~8 KB) + optional 1–2 s `agent.list` safety poll (~1 ms). Watch `herdr session list --json` (or the sessions dir) for sessions starting/stopping.
- **Live screens**: hidden-but-documented `herdr terminal session observe <pane> --cols N --rows M` streams NDJSON `terminal.frame` records (base64 ANSI, first `full:true`, then diffs, only on change) — read-only, multiple observers OK. Cheap alternative: `pane.read` `source=visible format=ansi` ≈ **0.8 ms**, ~5–7 KB.
- **Custom data**: `workspace.report_metadata` / `pane.report_metadata` tokens (≤32 keys, values ≤80 chars, optional TTL) are visible in get/list/snapshot and emit events — but **not persisted across server restart**. Things that *do* persist in `session.json`: workspace label (`custom_name`), agent name, `managed_agent_kind`, native `agent_session` id, cwd, layout. **No herdr concept of groups/buildings, creators, or parent** → the game must own a small store (bridge DB / JSON file) and re-apply tokens on restart.
- **Parent/creator is not recorded.** Today the only link is the label convention from the write-code skill (`ORCH|…`, `CODE|…|r1`, `REVIEW|…`, `UX|…`, `GROUND|…`) in the **same session** as the orchestrator. Recommend: spawn freelancers with `--env H3D_PARENT=<session>/<pane>` + a `parent` workspace token, and record in the bridge store.
- **Hire flow** works end-to-end (verified on throwaway session): `workspace create` → `agent start --kind claude --pane … -- <native args>` (~4 s to ready) → `agent prompt --wait` → `agent read` → `workspace close`. Pitfalls: untrusted cwd → agent `blocked` on Claude's trust dialog; env leaks from the spawning process (see §5).
- **Remote**: the Mac runs `herdr --remote dev@devbox --session <X>` (one terminal per session) which execs `herdr --session X remote-client-bridge` over **Tailscale SSH** — that's the *binary client protocol*, not the JSON API. The JSON socket can be forwarded with `ssh -L /tmp/x.sock:<remote sock>` (verified: works, ~120 ms/request since each request = new SSH channel; RTT is 22 ms). 0.9.1 adds `herdr --machine <label> <cmd>` CLI forwarding (not in 0.9.0).
- **Recommendation**: write a small **server-side bridge daemon** on devbox that talks to every session socket locally (subscribe + snapshot + observe), owns the "buildings/roles/avatars" store, and exposes one WebSocket/HTTP API on the tailnet (203.0.113.10) for the Mac game. Don't make the Mac talk to herdr sockets directly.

---

## 1. Data model

```
server host
└─ session  (named, one server process + socket each; "default" + named ones)
   └─ workspace  wN        (label, cwd identity, tabs, agent_status rollup, tokens, worktree provenance)
      └─ tab      wN:tK     (label, pane_count, agent_status rollup)
         └─ pane  wN:pM     (terminal_id, cwd, foreground_cwd, agent fields, title, scroll, tokens)
            └─ terminal term_<hex>   (the PTY; changes on restart)
               └─ agent            (detected/managed program in the pane: claude/codex/…, name, status)
```

### IDs & stability
| ID | Example | Stable? |
|---|---|---|
| session | `herdr-3d` | name = directory; stable until `session delete` |
| workspace_id | `w1`, `w2`, … `wA`… (base-32 alphabet `123456789ABCDEFGHJKMNPQRSTVWXYZ0`) | Persisted in `session.json`; survives restart. **Counter is in-memory and reseeded from restored IDs**, so an ID closed before a restart can be **reused** afterwards (src/workspace.rs:104–170). Verified: after closing w1, next create gave `w3` (no reuse within a run). |
| number | `1`,`2` | positional sidebar index; **changes** when workspaces close/move. Don't key on it. |
| tab_id | `w2:t1` | public, per-workspace counter persisted (`next_public_tab_number`) |
| pane_id | `w2:p1` | public, per-workspace counter persisted (`next_public_pane_number`). Cross-workspace `pane.move` assigns a **new** public id. |
| terminal_id | `term_65c885d5b44972` | **changes on server restart** (new PTY) |
| agent name | `r-herdr`, `haiku-worker` | set by `agent start <NAME>` / `agent rename`; persisted as `agent_name`, but dropped if the agent isn't running after restore |
| agent_session | `{"source":"herdr:claude","agent":"claude","kind":"id","value":"<claude session uuid>"}` | persisted; used for native resume |

Recommended game key for a worker: `(session_name, workspace_id)` **plus** a bridge-generated UUID stored as a workspace token (re-applied on restart) to detect ID reuse.

### Fields (real output from this machine)

`herdr workspace list` (session herdr-3d):
```json
{"active_tab_id":"w2:t1","agent_status":"working","focused":false,"label":"GROUND|herdr","number":2,"pane_count":1,"tab_count":1,"workspace_id":"w2"}
```
WorkspaceInfo schema keys: `active_tab_id, agent_status, focused, label, number, pane_count, tab_count, tokens, workspace_id, worktree`.

`herdr agent get w2:p1`:
```json
{"agent":"claude","agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"1632506b-f5c2-476f-88cc-76e847fde8d7"},
 "agent_status":"working","cwd":"/home/dev/devel/herdr-3d","focused":false,"foreground_cwd":"/home/dev/devel/herdr-3d",
 "interactive_ready":true,"name":"r-herdr","pane_id":"w2:p1","revision":4,"state_change_seq":7,"tab_id":"w2:t1",
 "terminal_id":"term_65c885d5b44972","terminal_title":"◑ Research agent GROUND","terminal_title_stripped":"Research agent GROUND","workspace_id":"w2"}
```
AgentInfo keys: `agent, agent_session, agent_status, cwd, display_agent, focused, foreground_cwd, interactive_ready, launch_pending, name, pane_id, revision, screen_detection_skipped, state_change_seq, state_labels, tab_id, terminal_id, terminal_title, terminal_title_stripped, title, tokens, workspace_id`.
PaneInfo adds `label, scroll{offset_from_bottom,max_offset_from_bottom,viewport_rows}`; lacks `name/state_change_seq/interactive_ready`.

- `agent_status`: `idle | working | blocked | done | unknown`. **`done` = idle and not yet "seen"** (focusing the pane marks it seen). `unknown` = plain shell/no agent. Workspace/tab `agent_status` is a rollup.
- `revision`: per-pane counter bumped on pane-info changes (title, agent, metadata) — useful for "did anything change".
- `state_change_seq`: per-agent monotonic counter of status transitions (sortable "most recent activity").
- `terminal_title(_stripped)`: OSC title; Claude Code sets it to a task summary (e.g. `✳ Herdr 3D game world`, spinner glyph `◑` while working) → great "what is this worker doing" bubble text. Ephemeral.
- `display_agent`, `title`, `state_labels`, `tokens`: presentation metadata from `report_metadata` (§3).
- `launch_pending: true` while `agent start` hasn't reached readiness.

`session.snapshot` (`herdr api snapshot`) = `{agents[], layouts[], panes[], tabs[], workspaces[], focused_*_id, protocol, version}`; layouts give each tab's pane rects/splits (handy to lay out multiple screens on a desk).

### What survives what (docs: session-state.mdx + verified)
| Event | Processes | IDs/labels/layout | Tokens/metadata | Agent conversation |
|---|---|---|---|---|
| client detach / Mac disconnect | keep running | yes | yes | yes (process alive) |
| server restart (`session stop` + start) | **killed** | yes (from `session.json`) | **lost** | resumed via native restore: herdr types `claude --resume <id>` / `codex resume <id>` in the pane (needs current integration; Claude integration here is v8 "outdated (v8 < v9)" but ≥ v6 minimum) |
| `herdr update --handoff` | best-effort kept | yes | yes | yes |

Verified on throwaway session: after stop+start, workspaces `w1`,`w2`, labels, pane `w2:p1` came back; tokens gone; herdr auto-ran `claude --resume a766d05c-…` even with **no client attached** (headless server resumes). It failed there only because my probe claude had transcript saving off (inherited env, §5) — then the agent name also disappeared from `agent list`.
Not persisted: per-process `--env`, native agent args (`--model haiku` is **not** replayed on resume — only `--resume <id>`), metadata tokens, terminal titles. "Hibernation" in herdr terms = a stopped session (`running:false` in `session list`, `session.json` kept); there's no separate hibernate command in 0.9.0.

Optional: `[experimental] pane_history = true` stores screen history in `session-history.json` for replay after restart (off by default; secrets risk).

---

## 2. Socket API

- Transport: Unix domain socket, mode `srw-------` (owner only), NDJSON. Request `{"id":"x","method":"ping","params":{}}` → `{"id":"x","result":{"type":"pong","version":"0.9.0","protocol":22,"capabilities":{…}}}`.
- **One request per connection.** Source `src/api/server.rs:156` `handle_connection_with_stop` reads the initial line, dispatches, returns. Verified: two pipelined pings → first answered, then `ConnectionResetError`. Long-lived only for `events.subscribe`, `pane.graphics.stream`; blocking for `events.wait`, `agent.wait`, `agent.prompt` (with wait), `pane.wait_for_output`.
- Latency (local, fresh connection each): `ping` ≪1 ms, `pane.read` visible/ansi **0.77 ms** (6.8 KB), `session.snapshot` **1.58 ms** (8.2 KB) — measured with 50-call loops.
- Schema: `herdr api schema --json` → `schemas.{request,success_response,error_response,event,subscription_event}`. Methods (102): ping, server.*, notification.show, command.invoke, client.window_title.*, session.snapshot, workspace.{create,list,get,focus,rename,move,move_block,report_metadata,close}, worktree.*, tab.*, agent.{list,get,read,explain,send_keys,rename,view.set,view.clear,focus,start,prompt,wait}, pane.{split,swap,move,zoom,layout,process_info,neighbor,edges,focus_direction,resize,scroll,edit_scrollback,selection.read,copy_*,list,current,get,focus,input.set,link.activate,rename,send_text,send_keys,send_input,read,graphics.*,report_agent,report_agent_session,report_metadata,clear_agent_authority,release_agent,close,wait_for_output}, layout.{export,apply,set_split_ratio}, popup.close, events.{subscribe,wait}, integration.*, plugin.*.
- Socket resolution for CLI: `--session` > `HERDR_SOCKET_PATH` > `HERDR_SESSION` > default. **Careful**: inside a herdr pane `HERDR_SOCKET_PATH` is set, so `herdr …` targets *that* session; the bridge must set `HERDR_SOCKET_PATH`/`--session` explicitly per call (or talk to the socket directly).

### Event subscription (push)
Request (one connection, many subscriptions):
```json
{"id":"sub","method":"events.subscribe","params":{"subscriptions":[
  {"type":"workspace.created"},{"type":"workspace.closed"},{"type":"workspace.renamed"},{"type":"workspace.metadata_updated"},
  {"type":"tab.created"},{"type":"tab.closed"},{"type":"pane.created"},{"type":"pane.closed"},{"type":"pane.updated"},
  {"type":"pane.exited"},{"type":"pane.agent_detected"},{"type":"pane.focused"},{"type":"layout.updated"},
  {"type":"pane.agent_status_changed","pane_id":"w2:p1"}]}}
```
Ack `{"id":"sub","result":{"type":"subscription_started"}}`, then pushed lines. Real stream captured during a "hire" on the probe session:
```
[1.41] {"data":{"agent":"claude","pane_id":"w2:p1","type":"pane_agent_detected","workspace_id":"w2"},"event":"pane_agent_detected"}
[4.73] {"data":{"agent":"claude","agent_status":"idle","pane_id":"w2:p1","workspace_id":"w2"},"event":"pane.agent_status_changed"}
[10.46] {"data":{"agent":"claude","agent_status":"working","pane_id":"w2:p1","workspace_id":"w2"},"event":"pane.agent_status_changed"}
[12.57] {"data":{"agent":"claude","agent_status":"done","pane_id":"w2:p1","workspace_id":"w2"},"event":"pane.agent_status_changed"}
[0.50] {"data":{"type":"workspace_closed","workspace":{…"label":"FREELANCE|coder-1"…},"workspace_id":"w1"},"event":"workspace_closed"}
[7.01] {"data":{"type":"workspace_metadata_updated","workspace":{…"tokens":{"building":"Personal","parent":"herdr-3d/w1:p1","role":"coder"}…}},"event":"workspace_metadata_updated"}
```
Also: `pane_agent_detected` with `released:true, final_status` when an agent exits; `pane.agent_status_changed` carries `display_agent/title/state_labels` when set.

Implementation facts (src/api/subscriptions.rs, event_hub.rs):
- Lifecycle events come from an in-memory ring of **512** events; each subscription polls every 100 ms and emits at most one matching event per subscription per tick (bursts drain over a few ticks). No replay of events before the subscription started → use the documented bootstrap: open subscribe, wait for ack, then `session.snapshot`, then apply buffered events.
- `pane.agent_status_changed` needs `pane_id` (optional `agent_status` filter); it sends an initial event if the pane already matches. So the bridge must maintain a subscription set per pane and reconnect when panes are added (cheap: new connection, drop old).
- `pane.output_matched` (regex/substring on pane text) and `pane.scroll_changed` also exist per-pane.
- Subscriptions end silently (EOF) on server stop/handoff → reconnect + re-snapshot.

**Low-overhead bridge**: per running session → 2 long-lived sockets + event-driven refreshes; `herdr session list --json` every few seconds (or inotify on `~/.config/herdr/sessions/*/herdr.sock`) to attach/detach sessions. Stopped sessions can still be read offline from `sessions/<name>/session.json` (workspaces, labels, agent names) to render "dark floors".

---

## 3. Metadata tokens — can we store custom data?

`herdr workspace report-metadata <WS> --source <ID> --token k=v … [--clear-token k] [--seq N] [--ttl-ms N]`
raw: `{"method":"workspace.report_metadata","params":{"workspace_id":"w1","source":"h3d:bridge","tokens":{"building":"Personal","old":null},"ttl_ms":5000}}`

`herdr pane report-metadata <PANE> --source <ID> [--title T] [--display-agent T] [--state-label working=TEXT] [--token k=v] [--ttl-ms]`

Verified on the probe:
```json
workspace get → "tokens":{"building":"Personal","parent":"herdr-3d/w1:p1","role":"coder"}
agent get     → "display_agent":"Bob the coder","title":"Hiring test","state_labels":{"working":"typing furiously"},"tokens":{"avatar":"cat","harness":"claude"}
```
Rules (socket-api.mdx): display-only (never changes semantic status); ≤16 keys per report, ≤32 keys retained per pane/workspace; names `[A-Za-z0-9_-]{1,32}`; values ≤80 chars (normalized); `null` clears; TTL 1 ms–24 h per key; `seq` ordering per source; ≤32 distinct sequenced sources per resource lifetime. Tokens render in herdr's own sidebar as `$name` (nice: Theo sees the building/role in the TUI too). Changes emit `workspace.metadata_updated` / `pane.updated`.
**Not restored after server restart** (docs + verified). Session-level metadata: none.

Other durable places:
1. **Workspace label** (persisted `custom_name`) — already used as `ROLE|descr|ticket|rN`. Could append a short tag, but it's user-visible and 80-char-ish; brittle.
2. **Agent name** (persisted while agent alive).
3. **Session name** — could encode building (`<group>.<project>`)? Not recommended; sessions are already named by project.
4. **Plugin state dir** (`HERDR_PLUGIN_STATE_DIR`, plugin-owned files) + `[[startup]]` hook to re-apply tokens after every server start. Plugins are **global** (`~/.config/herdr/plugins.json`) so they load in every session.
5. **Bridge-owned store** (SQLite/JSON under e.g. `~/.local/share/herdr-3d/`) keyed by `(session, workspace_id, uuid-token)`. ← Recommended source of truth for buildings (session→building map), avatars, roles, parent links; bridge re-applies tokens after restart so herdr's sidebar matches.

---

## 4. Who created a workspace? (freelancer → orchestrator)

herdr does **not** record a creator/parent (no field in schema; `caller_pane_id` exists only for `pane.current`). Evidence of linkage available today:
- Same session: write-code skill spawns coders/reviewers/researchers as **workspaces in the orchestrator's session** (this session: `w1 ORCH|herdr-3d`, `w2..w5 GROUND|…`).
- **Label convention** (`~/.claude/skills/write-code/SKILL.md` "Workspace naming"): `ORCH|<descr>`, `CODE|<descr>|<ticket>|r<N>`, `REVIEW|…`, `UX|…`, `GROUND|<topic>`. Parse prefix → role; freelancer's parent = the `ORCH|` workspace in the same session. Ambiguous if a session ever has 2 orchestrators or a human-made workspace.
- Spawner env: every pane has `HERDR_SOCKET_PATH, HERDR_SESSION, HERDR_WORKSPACE_ID, HERDR_TAB_ID, HERDR_PANE_ID, HERDR_ENV=1, HERDR_BIN_PATH`. The orchestrator can pass `--env H3D_PARENT=$HERDR_SESSION/$HERDR_PANE_ID` on `workspace create`; the child sees it (verified: `PARENT=w1:p1 ROLE=coder`), and the bridge can read it from `/proc/<shell_pid>/environ` (`pane process-info` gives `shell_pid`). Env is **not persisted** across restart.

**Reliable recommendation** (in priority order):
1. Add to the write-code skill: after `workspace create`, run `herdr workspace report-metadata <new> --source h3d:orch --token parent=$HERDR_SESSION/$HERDR_WORKSPACE_ID --token role=coder` (and `--env H3D_PARENT=…`). Bridge sees `workspace.metadata_updated` immediately and persists the link in its store.
2. Fallback: label-prefix heuristic (ORCH| in same session).
3. Fallback: `/proc/<pid>/environ` of the pane's shell for `H3D_PARENT`.
"Freelancer disappears when done" = `workspace.closed` event (carries final workspace snapshot incl. label/tokens).

---

## 5. "Hire a worker" — exact commands (verified on throwaway session `h3d-probe-herdr`, since deleted)

**Session lifecycle**
- List: `herdr session list --json` → `{"sessions":[{"default":false,"name":"herdr-3d","running":true,"session_dir":"…/sessions/herdr-3d","socket_path":"…/sessions/herdr-3d/herdr.sock"}, …]}`
- Create/start headless: `herdr --session <name> server` (foreground; prints "herdr server running… api socket: …"). For a daemon: `setsid herdr --session <name> server </dev/null >/dev/null 2>&1 &` (herdr's own auto-spawn does setsid + stdio→/dev/null; src/server/autodetect.rs:194). A brand-new session starts with **zero workspaces**. `herdr session attach <name>` / `herdr --session <name>` also auto-create but launch the TUI.
- Stop: `herdr session stop <name> --json` → `{"session":{…,"running":false},"stopped":true}` (kills pane processes; state saved).
- Delete: `herdr session delete <name> --json` → `{"deleted":true,…}` (must be stopped).
- ⚠️ **Env leak**: a server started from inside a Claude Code pane inherits that env (e.g. `CLAUDE_CODE_CHILD_SESSION`, `HERDR_*`), and every agent in it does too — my probe Claude showed "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker", which then broke `--resume` after restart. The bridge must start servers with a **clean env** (`env -i` + PATH/HOME/…, or systemd user unit).

**Workspace**
```
herdr workspace create --cwd /home/dev/devel/herdr-3d --label "CODE|probe" --env H3D_PARENT=herdr-3d/w1 --no-focus
→ {"result":{"type":"workspace_created",
     "workspace":{"workspace_id":"w2","label":"…","number":2,"tab_count":1,"pane_count":1,"active_tab_id":"w2:t1","agent_status":"unknown","focused":false},
     "tab":{"tab_id":"w2:t1",…},
     "root_pane":{"pane_id":"w2:p1","terminal_id":"term_…","cwd":"…","agent_status":"unknown",…}}}
```
raw: `workspace.create {cwd,label,env,focus,source_workspace_id}`. Extra panes: `pane.split {direction:right|down, target_pane_id, ratio, cwd, env}`; extra tabs: `tab.create`.
Git worktree variant: `herdr worktree create --workspace <id> --branch <b> [--base <ref>] --label … --no-focus`.

**Start agent** (pane must be at a shell prompt):
```
herdr agent start haiku-worker --kind claude --pane w2:p1 --timeout 60000 -- --model haiku
→ {"result":{"type":"agent_started","argv":["claude","--model","haiku"],
     "agent":{"name":"haiku-worker","agent":"claude","agent_status":"idle","interactive_ready":true,
              "agent_session":{"source":"herdr:claude","kind":"id","value":"a766d05c-…"},…}}}      (≈4.2 s)
```
- `--kind`: pi, claude, codex, gemini, cursor, devin, agy, cline, omp, mastracode, opencode, copilot, kimi, kiro, droid, amp, grok, hermes, kilo, qodercli, qwen, maki, muse. Harness menu → `claude` / `codex`.
- Native args after `--` → model/effort/permissions, e.g. claude: `-- --model opus --dangerously-skip-permissions` (+ whatever effort flag the CLI version supports); codex: `-- -m <model> -c model_reasoning_effort=medium --yolo` (check CLI versions — not verified here).
- Failure seen: cwd `/tmp` (untrusted) → `{"error":{"code":"agent_not_ready","message":"agent probe-coder is blocked during startup and is not ready for prompts"}}`, screen showed Claude's "Is this a project you trust?" dialog; status `blocked`. Game should show that as a "blocked" worker and offer screen/keys (`agent send-keys <t> enter|esc`).
- Alternative w/o detection wait: `pane run w2:p1 "claude --model haiku"` (herdr auto-detects the agent anyway).

**Prompt / wait / read**
```
herdr agent prompt haiku-worker "Reply with exactly the word: pong." --wait --timeout 90000
→ {"result":{"type":"agent_prompted","agent":{…"agent_status":"done","terminal_title":"✳ Pong response",…}}}   (2.7 s)
herdr agent wait <t> --until idle --until blocked --timeout 600000
herdr agent read <t> --source recent --lines 60        # text; --format ansi for colors
→ {"result":{"type":"pane_read","read":{"pane_id":"w2:p1","source":"recent","format":"text","text":"…● pong\n✻ Brewed for 2s…","revision":0,"truncated":false}}}
```
Prompt rejected with `agent_blocked` if already blocked; `agent_prompt_stalled` if no working/blocked state within 5 s.
Non-interrupting input: `pane send-text` / `pane send-keys` / `pane.send_input {text,keys}`.

**Focus / close**
- `herdr agent focus <t>` / `workspace focus <id>` / `pane focus` — moves *attached TUI clients* (0.9.1 fixed agent focus moving clients); also marks `done`→`idle` (seen).
- `herdr workspace close <id>` → `{"type":"ok"}` + `workspace_closed` event (kills its panes). `pane close`, `tab close`. Primary workspace with open linked worktrees needs `close_group:true`.
- Rename: `workspace rename`, `agent rename`.

---

## 6. Showing a pane's screen in the game

| Method | Shape | Cost | Notes |
|---|---|---|---|
| `herdr terminal session observe <pane> --cols C --rows R` (hidden CLI, documented in persistence-remote.mdx) | NDJSON `{"type":"terminal.frame","seq":1,"full":true,"width":100,"height":30,"encoding":"ansi","bytes":"<base64>"}`, later `full:false` diffs; `terminal.closed` at end | push, only on change; ~4–6 KB/frame for a 100×30 Claude screen (observed 3 frames in 8 s on a working agent) | **read-only**, multiple observers, no input/resize ownership. 0.9.1: stalled observers are dropped after 30 s. Uses the binary client protocol under the hood (same-install), so run it on the server. Needs a VT emulator on the consumer side to apply diffs (or re-render ANSI into a texture). |
| `herdr terminal session control <pane> --takeover` | same frames + stdin JSON `terminal.input/resize/scroll/release` | | for an interactive "sit at the desk" mode; only one controller. |
| `pane.read {source:"visible", format:"ansi", strip_ansi:false}` | full screen as ANSI string | **0.8 ms**, ~5–7 KB | simplest; poll at 1–2 Hz only for the focused worker, trigger on `pane.updated`/status change for others. `source:"recent"`/`recent_unwrapped` for scrollback, `detection` = bottom buffer used by detection. |
| `herdr agent attach` / `terminal attach` | interactive TTY | | for "open in real terminal" button (Mac: `herdr --remote … ` or ssh + attach). |
| `pane.graphics.*` | draw images *into* herdr panes | | reverse direction (not needed). |

Recommendation: bridge renders cheap *summary* for all workers (status + `terminal_title_stripped` + last 3 lines via `pane.read recent --lines 3` on change), and opens an `observe` stream only for the worker(s) the player is zoomed in on, forwarding frames over WebSocket; the Mac decodes ANSI into a texture (e.g. a small VT parser) for the laptop screen.

---

## 7. Remote / how the Mac attaches

Observed on the Mac (`ps`): several `herdr --remote dev@devbox --session <name>` processes + local `herdr client` each, with Herdr-managed SSH ControlMaster sockets in `$TMPDIR/herdr-ssh-*`. On the server each maps to `tailscaled be-child ssh … --remote-ip=203.0.113.20 --cmd=exec herdr --session <X> remote-client-bridge`. `herdr machine list --json` on Mac = `[]` (no saved machines).
- `--remote` = stdio bridge of the **binary client protocol** (render/input), not the JSON API. One session per attach; saved machines (`herdr machine add … --remote-session <X>`) are also one session per profile.
- `--handoff`: opt-in live server replacement during update/remote attach (keeps PTYs alive; interrupts subscriptions). Mac install is Homebrew, so `herdr update` is disabled there.
- **JSON socket over SSH**: works via OpenSSH unix-socket forwarding (Tailscale SSH allowed it). Verified from the Mac:
  ```
  ssh -N -L /tmp/h3d-probe-fwd.sock:/home/dev/.config/herdr/sessions/h3d-probe-herdr/herdr.sock dev@devbox
  ping via ssh -L: 124.4 ms avg ; snapshot 121.1 ms, 2062 bytes      (tailscale RTT ≈ 22 ms)
  ```
  ~120 ms per request because each request is a new connection → new SSH channel. Subscriptions would be fine (long-lived), but you'd need N forwards (one per session) and can't run `observe` remotely this way (binary protocol, local CLI).
- 0.9.1 `herdr --machine <label> agent list|pane …|workspace …|api snapshot` forwards CLI commands via saved machine profile (needs 0.9.1 both sides).

→ Put the bridge on the server; expose one WebSocket over the tailnet (bind 203.0.113.10 only, or `tailscale serve`), auth via tailnet identity/token.

---

## 8. Notifications, integrations, plugins — hooks a bridge could use

- **Integrations** (`herdr integration status`): here `claude: outdated (v8 < v9)`, `codex: current (v8)`, `opencode: outdated`. Claude's hook (`~/.claude/hooks/herdr-agent-state.sh session`, SessionStart) reports the native session id via `pane.report_agent_session`; lifecycle state is screen-detected. `herdr integration install claude` would upgrade to v9 (left as an operator decision). Custom agents can report semantic state with `pane report-agent --source custom:x --agent x --state working|idle|blocked`.
- **Plugins** (global `~/.config/herdr/plugins.json`; a plugin such as `herdr-navigator` itself enumerates sessions via `herdr session list --json`): manifest `herdr-plugin.toml` with `[[startup]]` (runs after each server start/restore — could ping the bridge "session X up" and re-apply tokens), `[[events]] on = "<event>"` hooks for workspace.*/tab.*/pane.created|closed|focused|moved|exited|agent_detected|**agent_status_changed** (spawns a process per event with `HERDR_PLUGIN_EVENT_JSON` — fine for low-rate, heavier than a socket), `[[actions]]` (e.g. "Open in herdr-3d", bindable to keys), `[[panes]]` (TUI panes). `workspace.metadata_updated` does **not** fire plugin hooks.
- **notification.show** `{title, body, position, sound: none|done|request}` → toast/desktop notification via the foreground attached client (returns `shown`/`no_foreground_client`/…). The game could trigger these, e.g. "Bob finished".
- `agent.view.set` can customize herdr's own Agents sidebar (filter/sort by tokens) — optional nicety for keeping TUI and game consistent.
- `herdr status --json` exposes server/client versions & capabilities (`live_handoff`, `surface_interest`, `health_check`).

---

## Recommendation

1. **Bridge daemon on devbox** (Rust or Python/Node; it only needs Unix sockets + NDJSON):
   - Session discovery: `herdr session list --json` every ~3 s (+ inotify on `~/.config/herdr/sessions`).
   - Per running session: subscribe (lifecycle) → snapshot → apply; second subscription for `pane.agent_status_changed` over all agent panes, rebuilt on pane create/close/agent_detected; reconnect with backoff on EOF.
   - Stopped sessions: parse `session.json` for a static "lights off" floor.
   - Screen: `pane.read` on demand + `terminal session observe` for the zoomed worker.
   - Actions: hire (workspace.create → agent.start → optional agent.prompt), fire (workspace.close), prompt, focus, start/stop session — all via the local socket with explicit socket paths.
   - Own store for buildings (session→building), avatar/role/parent; re-apply as herdr tokens after restart (so `$building`, `$role` also show in herdr's sidebar).
   - Spawn herdr servers with a clean environment.
2. **Game ↔ bridge** over one WebSocket on the tailnet: `world_snapshot`, then diffs (`worker_status`, `worker_added/removed`, `floor_added`…), plus `screen_frame` streams on request.
3. **Freelancer linkage**: small change to the write-code skill to tag spawned workspaces with `parent`/`role` tokens + `H3D_PARENT` env; bridge falls back to label prefixes.
4. Consider upgrading to herdr 0.9.1 (both machines) for `--machine`, observer stall handling, focus fixes — not required for the bridge.

## Open questions

1. Where should the building↔session mapping live — bridge store only, or also mirrored into herdr (tokens/labels) so the TUI shows it? Can we modify the write-code skill to add `parent`/`role` tokens when spawning freelancers?
2. Should "hire" create a **new session** (new floor) or only workspaces in an existing session? And is starting/stopping sessions from the game allowed (stop kills processes)?
3. OK to upgrade the Claude integration (`herdr integration install claude`, v8→v9) and herdr to 0.9.1 on both hosts?
4. Is it acceptable for the bridge to listen on the tailnet IP (203.0.113.10) with a shared token, or do you want SSH-tunnel-only access?
5. Should the game be able to type into agents (control mode / takeover) or stay read-only + prompt box?
