# herdr follow-up: sleeping floors, supervised start/stop, firing, 0.9.1

Researcher: GROUND|herdr (session `herdr-3d`, w2) · 2026-09-28 · herdr 0.9.0 installed, source read at tags v0.9.0 and v0.9.1.
Context: `docs/decisions.md` (bridge in Go, local-only plus SSH tunnel, stopped sessions show as zZz floors, firing = workspace closed) and the verifier's notes in `docs/research/herdr.verify.md`. I have not edited the first doc (`herdr.md`).
Probes ran on throwaway sessions `h3d-probe-herdr2` and `h3d-probe-herdr3`. Both were stopped and deleted afterwards, with no leftover processes or units. I did not touch any other session. `h3d-probe-server` is another researcher's session and I left it alone.

## TL;DR

1. **Stopped sessions can be read offline** from `~/.config/herdr/sessions/<name>/session.json` (`version: 3`). It holds workspace ids and labels, tabs, split layout, each pane's cwd, pane label, agent name, managed agent kind and native `agent_session` id. That is enough to draw a sleeping floor with a worker per workspace. The format is internal and has no docs. It is the same in 0.9.0 and 0.9.1 (`SNAPSHOT_VERSION = 3`, serde defaults, so fields only get added). herdr refuses to load newer versions. Guard on `version == 3` and ignore unknown fields. Don't treat a leftover `herdr.sock` file as "running"; stopped sessions keep theirs.
2. **Supervised start from a daemon.** Run `systemd-run --user --unit=herdr-s-<name> --collect -p KillMode=process --working-directory=$HOME /bin/fish -l -c 'exec herdr --session <name> server'`. The server gets Theo's normal login environment (same PATH and variables as his existing servers) and none of the `CLAUDE*`/`HERDR_*` leakage. Stop with `herdr session stop <name> --json`, never `systemctl stop`.
   - **Starting a stopped session resumes its agents on its own, with no client attached.** I verified this twice and the server log shows it (see §2). The verifier's HIGH item (a) doesn't match what the binary does: pending resumes start 750 ms after start at the default 120×40 size. The bridge should still confirm each resume and have a fallback (§2c).
3. **Firing (`workspace close`)** sends **SIGHUP → 250 ms → SIGTERM → 250 ms → SIGKILL** to every process in each pane's session (`src/pane.rs` `shutdown_pane_processes`). Codex exits on SIGHUP. The Claude pane consistently needed **SIGKILL** (~0.57 s). A gentler sequence works: `/exit` (Claude, ~1.6 s) or `/quit` + pause + Enter (Codex), confirm the agent was released, then close. A graceful exit **removes the pane's `agent_session`/`agent_name` from `session.json`**. So use it for firing, never for putting a floor to sleep.
4. **0.9.1**: the API is almost unchanged (protocol 22 in both; the only new method is `pane.link.resolve`). The session format and resume code are unchanged. Bridge-relevant changes: observers are dropped after **30 s without write progress**, possibly without a `terminal.closed`; `agent focus` now moves attached clients; macOS server service-context fix; `--machine` CLI forwarding; stricter session delete. **Upgrading is advisable but not required**; do it at a quiet time with a normal client update. Don't use `--handoff` on bridge-supervised servers until that's tested (§4).
5. **Durable identity** (verifier item b): the bridge should key workers by its own record plus a fingerprint it checks against `session.json`. Optionally it can put a persistent marker in the **pane label**. Unlike tokens, the pane label survives restart (verified). See §5.

---

## 1. Reading a session that isn't running

Directory contents of stopped sessions (read-only listing):

```
sessions/personal/:  herdr-server.log  session.json            (987 B)
sessions/pastry/:    herdr-client.sock herdr-server.log herdr.sock session.json   ← stale sockets, running:false
```
Optional extra files: `session-history.json` (only with `[experimental] pane_history = true`, not enabled here) and `session-backups/` (0.9.1 keeps copies of files it couldn't load).

Real `personal/session.json` (stopped, last saved 09-04):
```json
{"version":3,
 "workspaces":[{"id":"w1","custom_name":"Ansible Home","identity_cwd":"/home/dev",
   "public_pane_numbers":{"1":1},"next_public_pane_number":2,
   "public_tab_numbers":[1],"next_public_tab_number":2,
   "tabs":[{"custom_name":null,"layout":{"Pane":1},
            "panes":{"1":{"cwd":"/home/dev",
                          "agent_session":{"source":"herdr:codex","agent":"codex","kind":"id","value":"01a0663b-61cd-73a0-a3a0-034ca9fc6c48"}}},
            "zoomed":false,"focused":1,"root_pane":1}],
   "active_tab":0}],
 "active":0,"selected":0,"sidebar_width":26,"sidebar_section_split":0.5,"collapsed_space_keys":[]}
```

All keys seen across the 20 `session.json` files on this machine (script that walks them):
```
.version .active .selected .sidebar_width .sidebar_section_split .collapsed_space_keys
.workspaces[].{id, custom_name, identity_cwd, active_tab, public_pane_numbers{<internal>:<public>},
               next_public_pane_number, public_tab_numbers[], next_public_tab_number,
               worktree_space{checkout_path,is_linked_worktree,key,label,repo_root}}
.workspaces[].tabs[].{custom_name, focused, root_pane, zoomed,
                      layout = {"Pane":<internal>} | {"Split":{direction,ratio,first,second}}}
.workspaces[].tabs[].panes{<internal id>}.{cwd, label, agent_name, managed_agent_kind,
                      agent_session{source,agent,kind,value}}     (+ launch_argv, in source, not seen here)
```

**Mapping to live/public IDs** (checked against the running `herdr-3d` session, whose saved `w2` has `public_pane_numbers {"2":1}` and pane key `"2"` → live `w2:p1`):
- workspace id is `workspaces[i].id`.
- tab id is `<ws>:t<public_tab_numbers[tab_index]>`.
- pane id is `<ws>:p<public_pane_numbers[<internal key>]>`. Pane map keys are **internal** ids, not public numbers.
- If `custom_name` is null, herdr shows an automatic label (git repo or cwd basename). Compute a fallback from `identity_cwd`.
- Agent kind comes from `managed_agent_kind`, falling back to `agent_session.agent`. A pane without `agent_session` won't resume (shows as an empty desk).
- Codex panes with a stored id, per session, show which workers can wake up. For example, `code-review` has 6 and `common` has 9, all with ids.

**Freshness caveat**: a *running* server saves on a debounce (I saw ~10–15 s after changes), and a final save on shutdown. So read the file only for stopped sessions and use the socket for running ones. Detect "running" by connecting and `ping`ing with a short timeout, or with `herdr session list --json`, not by the socket file existing.

**Stability**: the schema is `src/persist/snapshot.rs` (`SNAPSHOT_VERSION: u32 = 3`). It is byte-identical between v0.9.0 and v0.9.1 except for a header-only version probe. Fields use `#[serde(default)]`, and legacy v1/v2 workspace shapes get migrated in (`migrate_workspace`). Newer versions are rejected (`version > SNAPSHOT_VERSION`) and the original preserved. It isn't a documented public API; the docs only mention it for restore and recovery. The Go reader should be tolerant (unknown fields OK), refuse `version != 3` with a clear "unknown session format" state, and use `herdr api snapshot` output whenever the session is running.

## 2. Supervised headless start/stop

### 2a. Environment check
Existing servers (started by Theo's attaches) carry his login-shell environment, e.g. `PATH=/home/dev/.cargo/bin:…:/home/dev/.local/bin:…`, `SHELL=/bin/fish`, `SSH_AUTH_SOCK` and his API variables. Panes run `$SHELL` (fish), and herdr *types* `claude …`/`codex …` into it. So Theo's fish wrappers `~/.config/fish/functions/{claude,codex}.fish` (which inject `PARALLEL_API_KEY`) apply. **The server must run in a login fish environment**, or agents lose credentials.

Leak confirmed earlier: a server started from a Claude tool shell inherited `CLAUDE_CODE_CHILD_SESSION` and similar, which turned transcript saving off and broke `--resume`. 0.9.1 strips only `OMPCODE` from pane environments (`src/pane.rs` diff), so hygiene is still the bridge's job.

### 2b. Recipe (tested)
```bash
systemd-run --user --unit=h3d-probe-herdr2 --collect -p KillMode=process \
  --working-directory=/home/dev /bin/fish -l -c 'exec herdr --session h3d-probe-herdr2 server'
```
- systemd user manager is running and `Linger=yes`, so this survives SSH logout. The unit's environment starts from `systemctl --user show-environment` (HOME, PATH, SHELL=/bin/fish, …), then `fish -l` layers config.fish on top. The resulting server environment had the same key set as Theo's normal servers plus systemd's `INVOCATION_ID/JOURNAL_STREAM`, and **no `CLAUDE*`**.
- Every pane process lives in the unit's cgroup (`systemd-cgls` showed fish shells, `claude --resume`, `codex resume` and MCP children), which is handy for accounting and orphan checks.
- **Stop**: `herdr session stop <name> --json` → `{"session":{…,"running":false},"stopped":true}`. The server logs `server shutdown initiated … headless server exiting`, runs the per-pane HUP/TERM/KILL sequence (§3) and exits 0, and the transient unit disappears (`--collect`). Avoid `systemctl --user stop`: it sends SIGTERM straight to the unit and skips herdr's orderly save and pane shutdown path.
- `KillMode=process`: the idea is that live handoff (`update --handoff` replaces the server process) isn't cut down when the old main PID exits. **Handoff under systemd is untested.** Probes used `KillMode=mixed` (first start) and the default/`process` (later starts); stop/start behaved identically in all cases.
- Discovery after start: the API socket is ready within about 0.3 s (the log shows `api server listening` 5 ms after restore, and the client socket 250 ms later).
- In Go: `exec.Command("systemd-run", "--user", "--unit=herdr-s-"+name, "--collect", "-p", "KillMode=process", "--working-directory="+home, "/bin/fish", "-l", "-c", "exec herdr --session "+shellQuote(name)+" server")`. Since the bridge itself runs as a systemd user service, it never leaks its own environment. Then poll `ping` on the socket (backoff up to ~5 s).
- Alternative without systemd: `setsid` + stdio to /dev/null (what herdr's own auto-spawn does, `src/server/autodetect.rs`) with an environment captured from `fish -l -c 'env -0'`. It works but loses cgroup visibility.

### 2c. Does start resume agents? **Yes, headless, no client** (verified twice)
Probe 2: Claude (`--model haiku`, session `8cb4e8a5…`) and Codex (session `01a0e795…`) each ran one turn, then `session stop`, then a fresh `systemd-run` start. No client ever connected, and there is no client line in the log:
```
10:36:31.034 persist.restore outcome=ok workspaces=2
10:36:31.287 herdr server started …
10:36:32.038 spawning pane terminal pane_id=1 rows=40 cols=120      ← ~750 ms later (PENDING_AGENT_RESUME_THEME_WAIT)
10:36:32.593 agent changed pane=1 agent=Some(Claude) process=claude
10:36:32.596 agent changed pane=2 agent=Some(Codex)  process=codex
```
`pgrep`: `claude --resume 8cb4e8a5-…` and `codex resume 01a0e795-…`. `agent list` showed `cl claude idle` and `cx codex working` with the same names and session ids. Both screens showed the old conversation (`● pong-claude`, `• pong-codex`), and both kept their model (Haiku 4.5 / GPT-6-Sol medium) even though herdr replays only `--resume <id>`. Probe 1 (earlier) behaved the same way.

Source path: `src/server/headless.rs:3372–3378`. The headless scheduled-task loop calls `start_pending_agent_resumes(pending_agent_resume_due(now))` whenever geometry isn't dirty. After the 750 ms theme wait it proceeds with `allow_empty_theme = true`. With no client the view area is the headless default 120×40, so `pending_agent_resume_candidates` doesn't bail on zero size. **Response to verifier (a)**: the doc wording ("after a client attaches") describes the normal case, but the headless server doesn't actually wait for one. The cost is that resumed agents may miss terminal theme and colour hints and get sized 120×40 until a client attaches.

Pitfalls the bridge must handle on wake:
- **Codex didn't report its session id** in my fresh probe: `agent_session` stayed `None` after a full turn. Yet 25 other Codex panes on this machine have ids, so it looks intermittent (Codex hook trust or timing; `~/.codex/hooks.json` SessionStart hook present; unresolved). Without an id there's no resume. **Backfill works**: `herdr pane report-agent-session w2:p1 --source herdr:codex --agent codex --agent-session-id <id>` (id from the newest `~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl` whose cwd matches). After that, restart resumed it. The bridge can check after each hire that `agent_session` is set, and show a small "no resume" warning icon otherwise.
- Resume fails if the transcript doesn't exist (e.g. the env-leak case) and the pane falls back to a shell (`No conversation found…`), dropping the agent name. Detect it: after start, expect a `pane.agent_detected` per pane that had `agent_session`, within about 10 s. Any that don't arrive become "didn't wake up" workers, and the bridge can offer a fallback `pane run <pane> "claude --resume <id>"`.
- Wake cost: every agent in the session starts at once (MCP servers and all). Fine for a floor, but don't wake a whole building at once.

**Sleep and wake sequence**: sleep = `herdr session stop` (don't `/exit` agents first, see §3). Wake = `systemd-run …`, then subscribe, snapshot, watch `pane.agent_detected`, then mark workers awake. zZz floors are rendered from `session.json` while stopped.

## 3. Firing: what `workspace close` does

`workspace.close` drops every pane in the workspace. Each pane runs `shutdown_pane_processes` (v0.9.0 `src/pane.rs:1493`):
1. Collect every pid in the pane's **process session** (`platform::session_processes(child_pid)`, i.e. the shell's sid, which includes claude/codex and their MCP children). Processes that `setsid`'d away (daemonised dev servers) are **not** included and survive.
2. Send `SIGHUP` and wait up to 250 ms, then `SIGTERM` and 250 ms, then `SIGKILL` and 250 ms. It logs which signal ended it, or `still alive after forced shutdown`.

Observed (server log, probe 2):
```
workspace close w1 (claude live) → 10:38:32.968 pane session terminated pane=1 signal=Kill     (≈0.57 s after close)
workspace close w2 (codex live)  → 10:38:33.140 pane session terminated pane=2 signal=Hangup
session stop                     → pane=2 (codex) Hangup, pane=1 (claude) Kill               (same pattern)
```
So the Claude pane (Claude plus its MCP/node children) doesn't exit within 500 ms of HUP and TERM and gets killed. Its transcript stays usable: `8cb4e8a5` was SIGKILLed at stop and still resumed. No orphans stayed in the cgroup after close.

**Gentler fire sequence** (tested; also matches the "packs a box" animation timing):
1. Optionally, if the agent is `working`, first ask (non-interrupting) for a wrap-up, or `agent wait --until idle,done,blocked --timeout …`.
2. Claude: `pane send-text <p> "/exit"` then `pane send-keys <p> enter`. The event `pane_agent_detected {released:true, final_status:"idle"}` arrived after **1.6 s**, and the foreground process was back to `fish`.
3. Codex: `pane send-text <p> "/quit"`, **wait ~300–500 ms** (the slash-command popup takes the first Enter if sent immediately; my first attempt stalled), `send-keys enter`. It exited and printed token usage, and the shell came back.
4. Fallback if not released within ~5 s: `send-keys ctrl+c` twice (500 ms apart), then close anyway.
5. `workspace close <ws>`. Now only the idle shell gets HUP.
6. Keep the last-known workspace state in the bridge. The `workspace_closed` payload may lack the workspace object (verifier item c).

⚠ A graceful exit **erases the resume link**. After `/exit`, `session.json` went from `{"agent_name":"z","managed_agent_kind":"claude","agent_session":{…}}` to `{"cwd": "…"}`. That's right for firing. For **sleep**, just stop the session so herdr kills the agents but keeps `agent_session`.

## 4. herdr 0.9.1 (2026-09-16) vs installed 0.9.0

Source diff of `src/api` shows only `pane.link.resolve` added (plus its response type). Protocol is `22` in both. `subscriptions.rs`, `event_hub.rs`, `persist/snapshot.rs` (format), `persist/restore.rs`, `app/agent_resume.rs` and `server/autodetect.rs` are unchanged. Relevant CHANGELOG items:

| Change | Bridge impact |
|---|---|
| Terminal observers that stop accepting output are **disconnected after 30 s without write progress** (`OBSERVER_WRITE_TIMEOUT`, `client_transport.rs:45`); the stream may end **without** `terminal.closed` | The Go reader must drain `observe` stdout continuously (never block on the WebSocket to the Mac: bounded channel, drop or merge frames), and treat EOF as "reopen and wait for a `full:true` frame". Worth having even on 0.9.0. |
| `herdr --machine <label> …` CLI forwarding over saved SSH machines | Not needed (bridge is on the server), but handy for Mac-side debugging. |
| `agent focus` / `pane move --focus` move attached clients; window titles and background activation no longer disturb other clients | Makes "click worker → focus in Ghostty's `herdr --remote`" behave correctly. **Main reason to upgrade.** |
| Session delete requires the exact name (case), names starting with `-` after `--`; unreadable `session.json` preserved in `session-backups/` | Bridge should pass names exactly, and ignore `session-backups/` when scanning. |
| "Newly started macOS servers retain access to user lookup and DNS across logout" (`prepare_server_process`) | macOS-host only; irrelevant for the Linux server. |
| Live agent names survive detection uncertainty (#3225) | Fewer transient "worker vanished" flickers. |
| Codex state fixes (static titles, queued follow-ups, idle not shown as blocked), Claude spinner detection | Better status accuracy for desk animations. |
| OpenCode lifecycle fixes, Grok/Claude integration hook narrowing ("reinstall Claude integration") | `herdr integration install claude` after upgrading (currently v8 < v9). |
| Handoff > 64 panes; remote bandwidth/CPU fixes | Nice for Theo's `--remote` use. |

**Advice**: upgrade both machines to 0.9.1. The server uses herdr's own updater (`~/.local/bin/herdr`): run `herdr update` without `--handoff`. Running compatible servers keep going on 0.9.0 until they're restarted; each session picks up 0.9.1 on its next stop/start (e.g. a sleep/wake cycle). The Mac uses `brew upgrade herdr`. Then reinstall the Claude integration. Nothing in the bridge design depends on 0.9.1, and the protocol and session format are identical, so a mixed 0.9.0/0.9.1 fleet is fine. Avoid `--handoff` for bridge-supervised units until it's tested under systemd.

## 5. Durable worker identity (verifier item b) and event notes (item c)

What's durable in `session.json`: `(session name, workspace id, custom_name, identity_cwd, tab/pane public numbers, pane cwd, pane label, agent_name, agent_session.value)`. Not durable: tokens, env, terminal ids, titles.
Workspace-id reuse only happens across a restart, for ids above the highest surviving id that were closed *before* the restart. In the probe, `w1`/`w2` were closed, `w3` stayed, and after restart the next create got `w4`, not `w1`. It's still possible, so don't trust `wN` alone.

**Proposal**
- The bridge store (SQLite) has `worker(uuid PK, session, workspace_id, created_at, created_by, role, avatar, building…)` and `worker_fingerprint(uuid, label, identity_cwd, agent_session_ids[], pane_label_marker, last_seen_at, last_seen_session_generation)`.
- **Marker**: at hire (or first sight), `pane rename <root pane> "h3d-<short uuid>"`. The pane label is saved as `panes{…}.label` and **survived a restart** in the probe (`w3:p1 label h3d-7f3a9c`, new terminal id). It shows only as the pane's label (a small border title), not the workspace sidebar name. If Theo finds it ugly on borders, skip it and rely on the fingerprint.
- **Session generation**: record the server pid and start time (`status server --json` / the socket `ping`) per session. When a generation changes, or after bridge downtime, reconcile each `(session, wN)`:
  1. marker matches → same worker;
  2. else `agent_session.value` matches a recorded id → same worker (unique, survives restart; note that Claude `/clear` or Codex `/new` change it, so update on `pane.updated`);
  3. else label + identity_cwd match **and** the id wasn't seen closing → probably the same worker, mark it `reconciled_weak`;
  4. else it's a new worker (new uuid, default avatar), and the old record is archived as having "left".
- Never reapply old tokens to a `wN` before it has been reconciled. After reconciling, re-send the `building/role/avatar/parent` tokens (they're display-only mirrors).

**Event notes (item c), accepted as corrections**:
- A per-pane `pane.agent_status_changed` subscription without an `agent_status` filter sends **no** initial event. Take initial status from `session.snapshot` and use events only as deltas. My first doc's "initial event if already matches" applies only to filtered subscriptions.
- The 100 ms is a poll interval, not a latency bound (one event per subscription per pass). Re-snapshot after reconnects and periodically (e.g. every 30 s), since that's cheap.
- `workspace_closed` may come without a workspace snapshot, so keep the last-known state.
- The observe stream can end without `terminal.closed` (0.9.1 stall timeout), so reconnect.
- `herdr agent read` / `pane read` CLI output is **plain text**. Use raw socket `pane.read` for JSON (my first doc labelled the CLI output as JSON by mistake).

## Open questions for Theo
1. Is a small pane-border label like `h3d-7f3a9c` on each worker's pane OK as a durable identity marker, or should identity be fingerprint-only?
2. Codex sometimes doesn't report its session id, which means no resume after sleep. Should the bridge backfill it from `~/.codex/sessions` rollout files (tested, works), or just show a warning badge?
3. "Wake floor" starts every agent in the session at once (with their MCP servers). OK, or should the game offer per-worker wake? That would mean stripping `agent_session` for sleepers the user doesn't want to wake, which is irreversible.
4. OK to run bridge-started sessions as `systemd --user` transient units (`herdr-s-<name>`)? Sessions Theo starts himself via `herdr --remote` would stay outside systemd.
