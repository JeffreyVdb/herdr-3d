# The Codex terminal beside a second app-server client (#154, phase 1)

Date 2026-10-06. Installed and verified: **codex-cli 0.160.1**, **herdr 0.9.0**, fish 4.2.0, direnv 2.37.1. The Codex source cited is
tag `rust-v0.160.1`. Parent epic: #153.

**Labels.** **[R]** marks a runtime-verified claim. The fixture test that shows it is named, and its captured screens and
messages are in [`codex-shared-tui-evidence/`](codex-shared-tui-evidence/), one directory per test, with files numbered
in capture order. The text cites a file by test and label, for example `Questions/active-after-steer-not-yet-delivered`.
**[S]** marks a claim that rests on reading the source only. **[R-live]** marks a read-only observation of the user's real
machine. **[R-real]** marks a claim from the real-model smoke test (§9), whose evidence is in
[`codex-shared-tui-evidence/RealModelSmoke/`](codex-shared-tui-evidence/RealModelSmoke/).

The fixture tests use mock inference. One bounded real-model smoke test (§9) ran the phase-2 launch, a per-worker
server on the user's real `~/.codex`, with `gpt-6.1-sol` at low effort, through Herdr only. The user's shared daemon was
left alone; the test never connected to it.

## 0. The answer: does the terminal still work with a shared app server?

**Yes.** Codex's own TUI keeps working, for a person and for Herdr orchestration, when it is attached with `--remote`
to an app-server that a second protocol client also uses. This holds on (a) a worker-owned `codex app-server --listen
unix://…` and (b) the managed daemon mechanism (`codex app-server daemon start`, CODEX_HOME-scoped, run from a
throwaway home). It holds **provided that the server is started from the worker's own initialized pane**. The shared
daemon breaks the worker's environment and its Herdr identity. Phase 2 must also own lifecycle and resume, because
Herdr's resume does not keep `--remote`.

**With a real model too [R-real].** On a per-worker server started from the test pane, with herdr-3d's hire args, Herdr
saw working → idle on every real turn, including across a shell tool call and a 25 s command, and `agent read` showed
the answer (`OK`). Ctrl+C interrupted a running turn, and the session id reached the test pane. `codex resume ID
--remote` brought the history back. The real model behaved as the mock did, with two new breaks (B9, B10) in the launch
and resume arguments, not in the terminal. Interrupting while a model-run command is executing was not covered with the
real model (§9).

What works [R], mock model, real TUI in a Herdr pane:

| Capability | Evidence |
|---|---|
| `herdr agent start … -- --remote unix://SOCK -C DIR`: Codex is detected and `interactive_ready`; typing a prompt runs a model turn | every test, e.g. `Lifecycle/*` |
| `agent prompt --wait` sees working → idle/done during a model turn; `agent wait`, `agent read`, `pane send-keys` | `Lifecycle`, `MixedHarness/agent-read` |
| Turns typed in the terminal appear in the bridge client, and bridge `turn/start` turns appear in the terminal | `Lifecycle/bridge-turn-in-terminal` |
| Ctrl+C interrupts a running turn (`turn/completed status:"interrupted"`); Herdr goes back to done | `Lifecycle/ctrlc*` |
| Slash commands (`/status` names the shared server and the thread, makes no model request) and skills (`$h3d-fixture` injects its SKILL.md) | `Lifecycle/slash-status`, `Lifecycle/skill-turn` |
| Approvals reach the TUI and every subscribed client; the TUI answers; Herdr shows blocked meanwhile | `Approvals/*` |
| Exiting the TUI (idle Ctrl+C; one press is enough, §9) and `codex resume ID --remote … -C …` reopen the thread with its history | `Lifecycle/tui-resumed` |
| The bridge disconnecting during a turn, reconnecting and rejoining leave the terminal untouched | `Lifecycle/terminal-after-bridge-left` |
| The server restarting: the TUI shows "Reconnecting to server…", and works again after `resume --remote` | `Lifecycle/tui-after-server-killed`, `Lifecycle/after-server-restart` |
| The session id reaches Herdr through its SessionStart hook when the server was started from the TUI's own pane | `Identity/same-pane-agent`, `MixedHarness/agent-get` |
| Async questions: suggested answers and free text answered from the terminal or the bridge, both reaching one conversation | `Questions/*` (§1) |

What breaks, and the fix for each:

| # | Break | Evidence | Fix (phase 2) |
|---|---|---|---|
| B1 | **A shared daemon runs every thread's tools and MCP children in the environment of whoever started it.** A ws-b worker saw ws-a's direnv value, pane and `HERDR_PANE_ID`. After `daemon restart` from ws-b, ws-a saw ws-b's | [R] `Environment/probe-daemon-ws-b`, `mcp-daemon-*`, `probe-daemon-ws-a-after-restart-from-ws-b` | Use a **per-worker server started from the worker's pane** (§6). Never point a worker at the CODEX_HOME daemon |
| B2 | **Plain `codex` (no `-c`) already auto-starts and joins that shared daemon** (feature `daemon_auto_start`, stable, on by default). herdr-3d's hire passes `-c model_reasoning_effort=…`, which excludes the daemon (embedded server, correct environment) | [R] `Environment/probe-plain-codex-ws-b`, `plain-codex-daemon-process-env`, `probe-herdr3d-launch-ws-a`; [S] `tui/src/daemon_startup.rs`, `features/src/lib.rs` | Keep explicit `--remote` to the worker's own socket. Never rely on an argument-free `codex` |
| B3 | **Herdr's session-id hook runs inside the app-server.** It reports to the pane in the *server's* `HERDR_PANE_ID`. With the server started from another pane, the TUI pane gets no id and the server pane gets it | [R] `Identity/split-summary`, `split-server-pane` | Start the server **from the TUI's own pane**, immediately before the TUI (`Identity/same-pane-agent`) |
| B4 | **Herdr's own resume drops `--remote` and the workspace `--env`, and calls Codex by absolute path** (`$HOME/.local/bin/codex resume ID`, which bypasses fish wrapper functions). That plain resume auto-starts the CODEX_HOME daemon. While the old detached worker server still holds the thread, the TUI opens it read-only: "This conversation is open in another app" | [R] `Identity/restored-argv`, `restored-pane`, `orphan-server-still-loads-thread` | herdr-3d owns Codex resume for shared-mode workers (§6, D5) |
| B5 | **A detached server outlives its pane and Herdr's session stop** | [R] `Lifecycle/server-after-panes-closed`, `Identity/server-survived-herdr-stop` | The bridge records and stops each worker's server on sleep, send-home and fire (§6, D2) |
| B6 | **Herdr shows a TUI that lost its server as `working`** ("Reconnecting to server…"), so `agent wait` runs until its timeout | [R] `Lifecycle/herdr-after-server-killed` | The bridge watches server liveness (pid and socket) and reports it. Orchestrator waits keep their timeouts |
| B7 | **Herdr shows an unanswered async question as `blocked`** (OSC title "Action Required"), so `agent prompt` is refused with `agent_blocked` while the worker is still working | [R] `Questions/idle-question-herdr-state-at-prompt-return` | Answer through the app-server (`turn/steer`, not refused) or `send-keys`. Document this for orchestrators. Probably not specific to `--remote` (the title is drawn by the TUI) [S] |
| B8 | **Codex's "Hooks need review" startup dialog reads as `idle`/`interactive_ready`**, so a prompt sent then stalls | [R] `Identity/*-herdr-state-during-hook-review` | Hooks are trusted once per CODEX_HOME (`[hooks.state]` in config.toml, `Identity/config-after-hook-trust`). The launcher checks the screen for the dialog, as hire already does for the trust dialog |
| B9 | **`codex resume ID --remote …` refuses hire's `--dangerously-bypass-approvals-and-sandbox`**: "Error: Permission overrides are not supported when resuming a remote task." Codex exits at once, but `herdr agent start` waits for its full `--timeout` (60 s) and then reports `timeout`, not the exit | [R-real] `RealModelSmoke/18-*`, `19-tui-resumed` | The resume launcher drops the bypass flag (and any other permission override). The thread keeps the permissions it was started with: the resumed TUI still shows `permissions: YOLO mode`. `-m` and `-c model_reasoning_effort=…` are accepted (`20-*`, `21-tui-resumed`) |
| B10 | **A fresh, untrusted cwd shows Codex's "Trust this folder?" dialog even with the bypass flag**, and `herdr agent start` fails with `agent_not_ready` ("blocked during startup"). Accepting saves the decision into the server's `config.toml`. Ctrl+C on it (and Esc, by the dialog's own `esc back` label) opens Codex's **Agent command center**, which lists the threads of the server's CODEX_HOME, the user's other workers' threads included; a second Ctrl+C quits | [R-real] `RealModelSmoke/00-first-attempt-trust-dialog` | Keep hire's existing trust handling (the dialog is the same with `--remote`), or start the server with an in-memory override for that one cwd, `codex app-server -c 'projects={"<cwd>"={trust_level="trusted"}}' …`. That override suppressed the dialog and left `config.toml` unchanged. It replaces the `projects` table for that server only. Launchers must not send Esc or Ctrl+C to a dialog they did not expect |

**User's machine, today [R-live].** The running `~/.codex` daemon (pid file `~/.codex/app-server-daemon/app-server.pid`)
has `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_SESSION` and `HERDR_SOCKET_PATH` in its environment. Its cwd is a herdr
worktree, `github-code-review/review-100-written-feedback-r3`. `~/.codex/hooks.json` holds Herdr's SessionStart hook.
Read only those variable names were read; values were not printed. Together with B1–B3, this means every argument-free
`codex` TUI the user starts today probably runs its tools with that pane's environment and reports its session id
**to that pane**. That is the misrouting the fixture reproduces, but it is not observed on the live session.

## 1. Async questions: external and terminal answers (A1, A2)

`TestCodexShareQuestions` [R]. The mock asks with `request_user_input_async` (`MOCK:ask-options`, `ask-free`,
`ask-both`). The TUI renders the questions and, while the asking turn is live, a badge: `Queued follow-up inputs / ? N
questions / shift+← to answer` (in a Herdr pane the binding shows as `shift+←`). The bridge receives the same question
as `item/completed` with `type:"agentMessage"`, `delivery:"async"`, `questions:[…]`, and `id = call_N` (the function
call id) (`Questions/*-question-live-item`).

- **The reply format is the native one.** Answered in the terminal, the TUI sends exactly
  `<send_user_message_question_reply>[{"answer":…,"question":…,"questionItemId":"[\"request_user_input_async\",\"call_8\",1]"}]</send_user_message_question_reply>`.
  Only the key order differs from the bridge's `ReplyEnvelope` (`Questions/active-replies-as-the-model-got-them`).
  Both reach the model as an ordinary user message.
- **The terminal renders a bridge reply as an answer**, not as the raw envelope: `› > Which fixture color? / Green`
  (`Questions/idle-answer-rendered`, `active-done`).
- **Active turn, bridge `turn/steer` [R]:** the badge stays (`2 questions`) until the steered input is actually
  delivered, at the next model request (`active-after-steer-not-yet-delivered`). On delivery it clears **only the
  answered question**: `1 question` remains while the turn is still running (`active-after-delivery-turn-still-working`;
  the mock holds the reply request, so the turn is provably active). The association is native and per question; it
  is not cleared by the turn ending.
- **Terminal answer [R]:** `shift+←` opens the question editor (`Any context…? / Type your answer / enter submit`).
  The typed text plus Enter queue the answer under "Messages to be submitted after next tool call"
  (`terminal-answer-submitted`), and it is delivered as above.
- **Idle [R]:** the asking turn's end **clears the TUI's pending questions**. The question stays in the transcript,
  the badge goes, and `shift+←` has nothing to open (`idle-after-asking-turn-ended`, `idle-terminal-shift-left`).
  Herdr reads idle/done then. A later bridge `turn/start` with the envelope still reaches the model and renders as an
  answer (`idle-answer-rendered`, `idle-second-answer-rendered`). After the turn ends, then, only the bridge can still
  answer; the terminal cannot answer natively. This matches the source comment "Pending async questions retain drafts
  until handled locally, answered by another client, or a live turn ends" [S] (`bottom_pane/async_questions/state.rs`).
- **Unrelated input does not resolve a question [R]:** a plain steer (`MOCK:say …`) delivered during the turn left the
  badge at 1 (`unrelated-badge`).
- **Countdown [R]:** a collapsed question shows a 30 s countdown (`? 1 question · 10s`). When it expires, the countdown
  disappears, the question **stays pending**, and nothing is sent to the model (`countdown-expired`,
  `countdown-requests`). The user's screenshot of this fixture showed the same badge with `· 19s`.

## 2. Semantics: active vs idle, ids, double submit (A4)

- **Active turn:** use `turn/steer` with `expectedTurnId`. A stale id is refused (`expected active turn id … but
  found …`, seen during development). Delivery waits for the next model request, and the TUI clears that question
  then [R]. **Idle:** use `turn/start` with no overrides. It starts a model turn of its own [R].
- **Ids [R]:** the question's agentMessage id is the function `call_id`, the same in the live `item/completed`,
  `thread/read` with `includeTurns`, a rejoining `thread/resume`, and a **cold resume after the 60 s unload** (history
  rebuilt from the rollout): `Lifecycle/cold-resume-question-id` says "live id call_3; present in cold resume: yes".
  The legacy history builder's `item-N` ids [S] did not show up on any of these paths. Phase 3 still takes the id from
  the representation it renders.
- **Double submit [R]:** the same envelope sent twice idle makes two turns, two model requests and two rendered
  answers. Bridge and terminal answering one question in one active turn deliver **both** answers into one model
  request (`double-submit*`, `both-*`). The server does not deduplicate, so phase 3 must, per question id.

## 3. Lifecycle and settings (A3, A5)

`TestCodexShareLifecycle` [R]:

- **Joining keeps the thread's settings and starts no turn.** A third client's `thread/resume` asked for another model,
  cwd, approval policy, sandbox and developer instructions while the TUI and the bridge were subscribed. The response
  kept `mock`, the workspace cwd, `never` and `dangerFullAccess`. The next model request still carried the configured
  `developer_instructions` and not the override, and the mock counted **0** model requests for the joins
  (`join-settings`).
- **Bridge disconnect** in mid-turn: the turn finishes and the terminal stays usable. The **reconnect** finds the
  thread with `thread/loaded/list` and picks out the TUI's persistent root thread among the loaded ones. Codex also
  loads an *ephemeral* side thread per TUI, `originator:"codex-tui"`, `ephemeral:true`, `path:""`, which does not
  support `includeTurns`. The rejoin's history has the latest turn and the live question id.
- **Closing the TUI while the bridge is subscribed** keeps the thread loaded; a bridge `turn/start` runs headless.
  `codex resume ID --remote … -C …` then shows that turn.
- **60 s unload:** with the TUI gone and the bridge unsubscribed (`unsubscribed`), the thread is still loaded at 30 s
  and unloaded by 90 s. Cold `thread/resume` reloads it with no model request.
- **Stopping a worker** (closing its panes) does not stop its detached server (B5).
- **Approvals** (`TestCodexShareApprovals`): `item/commandExecution/requestApproval` goes to the bridge as well. A
  passive bridge only sees `serverRequest/resolved` once the TUI answers `y`. When the bridge answers first, the
  command runs and the TUI's modal closes. The first answer wins.

## 4. Environment gates (A6)

`TestCodexShareEnvironment` [R]. Sentinels: a per-workspace `.envrc` (allowed, or `blocked-c` left unallowed, in the
fixture's own direnv allow list), the pane's Herdr `--env`, an exported fish-config variable, a `codex` **wrapper
function** that exports `H3D_WRAPPER_SENTINEL` (modelled on the user's real `~/.config/fish/functions/codex.fish`,
which exports `PARALLEL_API_KEY` for Codex only), `h3d-tool` on fish's PATH, and a fish-only function. Each launch was
checked with a **model-driven `exec_command`** (`probe-*`) and an **env-dumping stdio MCP child** (`mcp-*`, the test
binary). The MCP child gets only the variables `env_vars` forwards [S] (`rmcp-client/src/utils.rs`), so the fixture
forwards the sentinels.

| Launch | Model shell | MCP child |
|---|---|---|
| herdr-3d's hire args (`-m … -c model_reasoning_effort=… --dangerously-bypass-approvals-and-sandbox`): embedded server | the pane's: direnv, pane, wrapper, fish, PATH tool, own `HERDR_PANE_ID` | same |
| plain `codex`: auto-started CODEX_HOME daemon | the pane that **first** started it; the daemon keeps running after the TUI exits | same |
| **worker-owned server from the pane** (`setsid -f fish -c 'codex app-server --listen unix://SOCK'`, then the TUI in the same pane): three workspaces at once | each its own, no leak; blocked `.envrc` gives an empty value | each its own |
| the same after the server is killed and restarted from the pane, with `resume --remote` | unchanged | unchanged |
| `setsid -f codex app-server …` (no `fish -c`) | **no wrapper variable**: the wrapper function is bypassed | same |
| managed daemon `daemon start` from ws-a, TUIs from ws-a and ws-b | **both get ws-a's** (B1); cwd follows `-C` | both get ws-a's |
| `daemon restart` from ws-b | ws-a's TUI reconnects by itself and now gets **ws-b's** | ws-b's |

- **Startup order.** The server inherits the shell's exported environment at the moment it is started. Started from a
  prompt where direnv's `fish_prompt` hook has already exported, it has the directory's values. `fish -l -c` / `-i -c`
  alone do not run that hook (ground evidence). A server already running keeps its old environment (B1).
- **The model's shell is bash, not fish** (`model-shell: bash`, `<shell>bash</shell>` in the context), in every mode.
  Fish functions are never available to model commands (`fishfn=no`); exported variables and PATH entries are. This is
  Codex's fish-unsupported shell detection [S] (`shell-command/src/shell_detect.rs`). `shell_environment_policy` stayed
  at its default (`inherit = "all"`). A policy that filters would apply equally in every mode [S].
- **Failures do not surface [R].** A blocked `.envrc` only prints `direnv: error …/.envrc is blocked. Run 'direnv
  allow'…` at the prompt (`Environment/blocked-pane-before-launch`). The server starts anyway without the values, and
  its log has nothing about it (`blocked-server-log`). Codex reports nothing. The launcher must check before starting
  (D1).
- **Rollouts** land under the server's `CODEX_HOME/sessions` (the `thread.path` in every resume response). A worker
  server started with the user's normal `CODEX_HOME` therefore writes where herdr-3d's transcript and usage readers
  already look (`internal/codex/sessions.go`).

## 5. Mixed harness (A9)

`TestCodexShareMixedHarness` [R]. A scripted stand-in for a Claude orchestrator uses only the Herdr CLI and a run
directory, as write-code does. It launches a Codex worker with the candidate launch in one pane, dispatches a task with
`agent prompt`, and reads the JSON report the worker publishes through a model-driven shell call: the report carries
`direnv-ws-a` and the worker's own pane. It sends a follow-up, checks `agent read` and `agent wait`, takes the session
id from `agent get` (`agent_session.value`, set by the hook), stops the TUI and resumes it with `codex resume ID
--remote … -C …`. The second report has the same environment, the same pane and the same thread, and Herdr keeps the
session id.

**Reverse direction [R], as far as possible without inference.** The Codex worker, as orchestrator, ran Herdr CLI calls
from its model shell (`h3d-orchestrate`). It reached its own session through the inherited `HERDR_SOCKET_PATH`,
created a workspace, had a stand-in worker publish a report, and read it back (`reverse-orchestration`). It works
because the server inherited the pane's Herdr context. On the shared daemon, the Herdr context would be the starter's
(B1). **Not run:** a real Claude worker (its prompt means real inference). Starting one is `herdr agent start … --kind
claude`, unchanged.

## 6. Phase 2: the launcher change and the decisions (A7)

| # | Question | Decision |
|---|---|---|
| D1 | Server ownership | **One app-server per Codex worker**, started from the worker's pane after its shell and direnv are initialized, immediately before the TUI and in the same pane: `setsid -f fish -c 'codex app-server --listen unix://$SOCK' </dev/null >$LOG 2>&1`, then `herdr agent start … -- --remote unix://$SOCK -C $CWD <model args>`. The `fish -c` keeps wrapper functions; `setsid -f` keeps the server off the pane's foreground job. A server typed with `&` left the pane `agent_pane_busy` in the ground probe. Socket: a short per-worker path under `$XDG_RUNTIME_DIR` (the 108-byte limit). In the real-model run, Codex made the `--listen` path a symlink to a socket of its own, `/tmp/codex-daemon-1000/<hash>` [R-real]; whether that lifts the limit is unverified. A new worker cwd needs trust before the TUI starts (B10). Before starting, the launcher checks `direnv status` for the cwd and refuses or reports a blocked `.envrc`. Never use the CODEX_HOME daemon (B1, B2). |
| D2 | Server lifetime | The bridge records each worker's socket and server pid. It stops the server when the worker is sent home or fired and before a floor sleeps, because a detached server survives its pane and `herdr session stop` (B5). On wake it starts the server again from the pane (D5). The bridge reports a dead server; Herdr would show "working" (B6). |
| D3 | Subscription lifetime | The bridge joins with `thread/resume {threadId}`, never with overrides, while it has a reason to watch (transcript open, question pending), and leaves with `thread/unsubscribe`. Reconnecting uses Herdr's `agent_session.value` as the thread id. Herdr clears that value when the TUI exits, and after a resume it is only reported again with the first turn [R-real] (`RealModelSmoke/17-*`, `22-*`, `28-*`). The bridge therefore keeps the id it last saw and does not read a missing value as a new thread. Among loaded threads it skips ephemeral ones and never guesses the newest by cwd. The 60 s unload does not matter: the TUI keeps the thread subscribed. |
| D4 | Approvals | **The bridge is passive.** It never answers `requestApproval`, the blocking `requestUserInput`, or any other server request. It only reads `serverRequest/resolved` to update its view. Any answer would win the race (§3). |
| D5 | Session id and resume | The same-pane launch makes Herdr's hook report to the right pane (B3). Herdr's native resume cannot express `--remote` and calls Codex by absolute path (B4). Shared-mode Codex workers are therefore **resumed by herdr-3d**: the wake fallback (`floorops.go`) becomes the launcher, server first, then `codex resume ID --remote unix://$SOCK -C $CWD <model args>`, in place of `codex resume ID`. The model args **leave out `--dangerously-bypass-approvals-and-sandbox`**, which a remote resume refuses; the thread keeps its permissions (B9). Herdr's own resume must not run first for such a pane. **Unverified:** whether `herdr pane release-agent`, or leaving the session unreported at sleep, stops it while the bridge keeps the id. Verify that first in phase 2. If neither does, the fallback is to stop the worker's server before sleep. Herdr's resume would then still attach the CODEX_HOME daemon (B2), so the bridge must exit that TUI and relaunch. |
| D6 | Rollouts | Worker servers run with the user's normal `CODEX_HOME`, so rollouts stay under `~/.codex/sessions` and the readers need no change (§4). |
| D7 | Orchestrator-created workers | Orchestrators start workers through the Herdr CLI and bypass the bridge, so the launch must be Herdr CLI calls too. It is: `pane run <pane> '<server start>'`, then `agent start … --kind codex -- --remote unix://SOCK -C CWD` ([R] `MixedHarness`). herdr-3d's hire and the write-code skill's Codex start step use the same two calls, best through one shared script on PATH that picks the socket and checks direnv. Until the skill adopts it, orchestrator-created Codex workers stay embedded: the right environment, but no transcript answers. |
| D8 | Opt-in | The epic's opt-in switch stays. The terminal stays the default. Changes apply to new or restarted workers only. |

## 7. A terminal-free mode (A8, documentation only)

A worker could run with only an app-server and the transcript view. That would be a **separate, explicit, persisted
Settings opt-in**, never implied by "shared server" or transcript access. Switching back means relaunching the worker
with the terminal launch (D1) and `codex resume ID --remote`. Feature gaps this investigation found:

- Herdr has no pane agent, so `agent prompt`, `read`, `wait`, `send-keys` and working/blocked detection all need an
  adapter on app-server events. Orchestrator skills that use them (write-code) would need changes.
- Slash commands and the TUI's own UI (`/status`, pickers, approval modals, the question editor) have no counterpart.
  Skills work through `$name` in the input text [S].
- Approvals must then be answered by the bridge: it stops being passive (D4).
- The environment must come from a launcher that runs the shell and direnv first, with the same failure checks (D1).
  `direnv exec DIR codex app-server …` covers `.envrc` but not fish functions [S].

## 8. The fixture

`internal/codexshare` (`make codex-shared-tui`, build tag `integration`; `go test ./internal/codexshare` runs the unit
tests only, so CI is unaffected):

- `home.go`: an isolated `CODEX_HOME` with a config for the mock provider (`requires_openai_auth=false`, no
  websockets), a one-model catalog advertising `request_user_input_async` (`catalog.json`, rust-v0.160.1's
  `gpt-6-astra` entry as `mock`), trust for the workspaces, update checks, analytics, feedback and OTEL off, and the
  managed daemon's updater off (`app-server-daemon/settings.json`). `CleanEnv` drops `CODEX_*`, `OPENAI_*`,
  `HERDR_*`, `CLAUDE*` and `PARALLEL_API_KEY`.
- `mock.go`: a Responses-API SSE server on `127.0.0.1:0`, driven by directives in the user message (`MOCK:say`,
  `ask-options`, `ask-free`, `ask-both`, `shell`, `approve`, `hold`). It holds a response open until `Release` (active
  turns), `HoldNext(kind)` holds the next reply, it adds model-like latency (Herdr only reports a turn it saw working),
  and it records and classifies every request (turn, tool, reply, title side request).
- `rpc.go`: the second client, JSON-RPC over the WebSocket that `--listen unix://` serves (`ws://localhost/rpc`).
- `reply.go`: `ReplyEnvelope`, the native answer format (byte-for-byte test).
- `envdump.go`: the env-dumping MCP server (the test binary in that role).
- `herdr.go`: a throwaway `h3d-it-154-<rand>` Herdr session. Every call names it, and the session is stopped and
  deleted at the end. Its server gets the fixture's `CODEX_HOME` too, because Herdr restores panes without their
  `--env`; in one development run a restored pane reached `~/.codex` that way (§10).
- `procs.go`: process ownership. Each test gets a random `H3D_CODEXSHARE_OWNER` marker, set in its Herdr session
  server's environment (so its panes, TUIs, app-servers, daemons and tools inherit it) and passed to its MCP children.
  Cleanup signals only this user's processes whose environment carries that exact marker; naming the temp root does not
  make a process the test's (`TestOwnedPIDsNeedTheMarker`, `TestKillOwnedSparesStrangers`).
- `*_integration_test.go`: the suites cited above. Each test kills the processes it left (those with its marker) and
  stops temp-home daemons.

Launch and attach procedure used throughout:

```fish
# in the worker's pane, at an initialized prompt
setsid -f fish -c 'codex app-server --listen unix:///run/…/w.sock' </dev/null >…/w.log 2>&1
herdr agent start <name> --kind codex --pane <pane> -- --remote unix:///run/…/w.sock -C <cwd> [model args]
# resume
codex resume <thread-id> --remote unix:///run/…/w.sock -C <cwd>
```

## 9. Real-model smoke test

[R-real], evidence in [`codex-shared-tui-evidence/RealModelSmoke/`](codex-shared-tui-evidence/RealModelSmoke/). Five
short turns; the TUI's exit summary reported `total=31,038` tokens (`16-tui-exit`).

**Setup.** A throwaway Herdr session `h3d-it-154-smoke-44a259`, its server started with every `HERDR_*`, `CODEX_*`,
`OPENAI_*` and `CLAUDE*` variable removed. One workspace in a fresh temp dir, not a git repository. The user's real
`~/.codex` (auth, config, hooks); no `CODEX_HOME` set. The server was started as D1 proposes, typed into the test pane
with `herdr pane run`: `setsid -f fish <script>`, where the script holds `codex app-server -c
'projects={"<cwd>"={trust_level="trusted"}}' --listen unix://<tmp>/w.sock` (`00-start-server.fish`). A script instead
of `fish -c '…'` only to keep the TOML quoting simple; fish loads its config and functions either way. The server's
environment had the test pane's `HERDR_PANE_ID`, `HERDR_SESSION` and `HERDR_SOCKET_PATH`, so Herdr's SessionStart
hook could only report into the test session. The TUI was started with hire's args: `herdr agent start smoke --kind
codex --pane w1:p1 -- --remote unix://<tmp>/w.sock -C <cwd> -m gpt-6.1-sol -c model_reasoning_effort=low
--dangerously-bypass-approvals-and-sandbox`.

Every Herdr state below comes from `agent get` polled every ~0.27 s (`*-status-poll.txt`). Turn start and end times come
from the thread's rollout (`32-rollout-events`).

| Step | Result |
|---|---|
| First start, no trust override | `agent start` failed after 3.65 s with `agent_not_ready` on the "Trust this folder?" dialog (B10). The dialog was not answered; Ctrl+C twice quit, through the Agent command center (`00-first-attempt-trust-dialog`). The server was restarted with the override |
| `agent start` | 3.75 s, `interactive_ready:true`, `idle`; the TUI shows `permissions: YOLO mode`, `GPT-6.1-Sol low` (`01-*`, `02-tui-started`) |
| Turn 1, "Reply with the single word OK." | `agent prompt --wait` returned `idle` after 4.23 s. Herdr went `working` 0.48 s after the turn started and `idle` within 0.81 s of its end. `agent read` shows `• OK` (`03-*`, `04-turn1-agent-read`). Herdr then had the session id, `agent_session.source:"herdr:codex"`, in the test pane (`05-*`) |
| Turn 2, run `echo h3d-smoke-$PWD` | The model ran the command (`• Ran echo h3d-smoke-$PWD └ h3d-smoke-/tmp/…/ws`) and replied with the output. 7.93 s, `working` without a gap across the tool call, `idle` 0.26 s after the end (`06-*`, `07-turn2`) |
| Turn 3, "Run `sleep 20` … then reply", Ctrl+C after 3.4 s | The Ctrl+C reached the model phase, before the command started. `■ Conversation interrupted`, rollout `turn_aborted reason:"interrupted"`, Herdr `idle` 0.32 s after the Ctrl+C (`08-*` to `11-*`) |
| Turn 4, "Run `sleep 25; echo h3d-slept` …" | Herdr stayed `working` for the whole 32 s turn, the 25 s command included, and the reply was `h3d-slept`. The Ctrl+C meant for this turn arrived as it completed (`task_complete` and the key within 1 ms) (`12-*` to `15-*`) |
| One Ctrl+C on the idle remote TUI | **Exits at once**, with no second press: "Disconnected from this task. Any running work continues. To reconnect, run: codex --remote unix://… resume ID. Stop the current turn: run codex --remote unix://… agents, select this task, and press x." Herdr then has no agent on the pane and no `agent_session` (`15-*`, `16-tui-exit`, `17-pane-get-after-exit`). Seen twice (also `29-*`). The fixture's two presses were more than needed |
| `agent start … -- resume ID --remote … <hire args>` | Refused: "Permission overrides are not supported when resuming a remote task." `agent start` returned `timeout` only after its 60 s (B9; `18-*`, `19-*`) |
| The same without the bypass flag | 3.85 s, `idle`, `interactive_ready`. The history is there: all four turns, the interruption, "Worked for 32s" (`20-*`, `21-tui-resumed`). No `agent_session` until a turn ran (`22-*`) |
| Turn 5 on the resumed TUI, "Run `sleep 30; …`", Ctrl+C after 2.5 s | The screen showed `• Working (2s • esc to interrupt)`, still the model phase. Interrupted, `idle` 0.22 s after the Ctrl+C. Herdr had the same session id again (`23-*` to `28-*`) |
| Exit, archive, stop | One Ctrl+C exited (`29-*`). `codex archive ID --remote unix://<tmp>/w.sock`, run in the test pane while the server was up, printed "Archived session …" and moved the rollout to `~/.codex/archived_sessions/` (`30-archive`). The server was stopped by pid; no process was left in the temp dir |
| Shared daemon | Before and after: the same pid 2255710, the same start ticks (83085313) in the pid file and in `/proc`, `daemon version` `running`/0.160.1. `~/.codex/config.toml` and `hooks.json` have the same md5 (`00-baseline-before`, `31-shared-daemon-after`). Every `codex` call named `--remote` with the test socket, so `daemon_auto_start` never applied |

Left behind on purpose: Codex's own `~/.codex/tui-thread-reference-capabilities/<test thread id>`, the archived
rollout, and whatever Codex logs to its state database. The test Herdr session was stopped and deleted and the temp
dir removed.

## 10. Not verified

- **Interrupting a model-run command while it executes, with the real model.** Both attempts landed in the model phase
  (turns 3 and 5), and turn 4's Ctrl+C came as the turn ended; the five-turn budget was used up. The mock-model fixture
  covers interrupting a held model response (`Lifecycle/ctrlc*`), not a running command either.
- Herdr reported `idle`, never `done`, at the end of each real turn. The pane was focused, and the fixture's runs saw
  `done`. Whether focus decides this is unverified; orchestrators wait with both `--until idle --until done`.
- **No real-model run on the shared managed daemon.** The live daemon carries a live pane's `HERDR_PANE_ID`, and
  `~/.codex` has Herdr's SessionStart hook (§0). A new thread there would report its session id into that pane and
  could change that worker's identity and resume. The smoke test therefore used the phase-2 launch only.
- **Side effect in development:** before the fixture pinned `CODEX_HOME` on its Herdr server, one Herdr session
  restart restored a pane without its `--env` and ran `codex resume <fixture id>` against `~/.codex`. It failed ("No
  saved session found"). No thread was created, `~/.codex/config.toml` was not changed, and the daemon was not
  restarted (its pid file is unchanged). Codex may have written to its log/state SQLite in `~/.codex`.
- Ctrl+C, slash commands and approvals were checked on the worker-owned server only. On the managed daemon, the TUI
  uses the same remote client [S].
- D5's suppression of Herdr's native resume (`pane release-agent`) is unverified. **Resolved by #155**: `release-agent` does not keep Herdr from resuming the pane; the TUI's own exit does (`TestCodexShareResumeSuppression`, decisions.md #155 row 1).
- Real Claude worker in the reverse mixed-harness direction (needs inference).
- Images in the composer and terminal/transcript switching in the game (phase 5). **Partly resolved by #158**: an
  image marker reaches a shared worker as its path in the text, typed or steered, as for any Codex worker, and the
  transcript of a shared worker is its thread (§12.2). Not verified: Codex's own image input, and the game's toggle
  against a real TUI (§12.6).
- Whether a steered input survives its turn ending before the next model request. **Resolved by #156**: it is
  dropped (§11).
- Whether the terminal's question editor accepts free text on a question that has options (#156 is strict: one of the
  options). Still open after #158.
- **#158** resolved: a reply from either view reaching the model once through the bridge, retries and reconnects, the
  bridge restarted, resume and the server killed and recovered, all through herdr-world itself (§12). Its own open
  points are in §12.6.

## 11. Phase 3: the bridge's answers (#156)

`TestCodexShareAsyncAnswers` [R], mock model, real TUI in a Herdr pane, the production `codexapp.Watcher` (its
`Steer` and `StartTurn`) and `codexapp.Questions` (the reconciler the hub runs). Evidence in
[`codex-shared-tui-evidence/TestCodexShareAsyncAnswers/`](codex-shared-tui-evidence/TestCodexShareAsyncAnswers/),
cited as `AsyncAnswers/<label>`.

- **A steered input is an item only once delivered.** Right after `turn/steer` returned (with the asking turn's id,
  `AsyncAnswers/a-steer-result`) the join had no user message for it (`a-user-items-before-delivery`: none), and the
  terminal still showed its badge (`a-after-steer`). With the next model request came `item/started` and
  `item/completed` of a `userMessage` in the asking turn, carrying the envelope and **the bridge's
  `clientUserMessageId` as `clientId`** (`a-user-items-after-delivery`). The reconciler then read the question as
  answered by the bridge (`a-question-state`).
- **Refusals deliver nothing.** `turn/steer` on an idle thread: `-32600 no active turn to steer`; with a stale id while
  another turn runs: `-32600 expected active turn id … but found …`, naming both ids (`b-steer-idle-error`, `b-steer-stale-error`).
  Neither made a model request.
- **`turn/start` while a turn runs joins that turn.** It was accepted and returned the running turn's id; the input
  became a user message of that turn and the model got it with the turn's next request, no second turn
  (`b-start-while-active`, `b-user-items`, `b-requests`).
- **The race: a steer accepted, then the turn ends before the next model request.** The asking turn's model request
  held, the bridge steered its answer (accepted), and the turn was interrupted (`turn/interrupt`; `c-turn-completed`:
  `interrupted`). The steered input was **dropped**: no user message on the join or in `thread/read` history, no model
  request after the interrupt (`c-user-items-after-turn-end`, `c-history-after-turn-end`,
  `c-requests-after-turn-end`), and the next turn did not carry it (`c-next-turn`, `c-requests-next-turn`). The
  terminal showed "Conversation interrupted" and no badge (`c-after-turn-end`). The reconciler kept the question `sent`
  and marked it `undelivered` (`c-question-state`); sending it again (`turn/start`, the thread idle) answered it
  (`c-resent-question-state`, `c-resent-answer`).
- **A new join recovers every batch's state from the history** (`d-hydrated`): the batch the bridge answered is
  `answered` by `bridge` from the history alone (the `clientId` is persisted), the same as the live view.

## 12. Phase 5: full-stack validation (#158)

Every suite before this one drove a protocol client (`rpc.go`) or, at most, `codexapp.Watcher` in-process. #158's
suites drive **herdr-world itself**: `app.Serve` (the hub, its `herdr.Control`, its `CodexHost`, the store) aimed at
the fixture's throwaway Herdr session, driven over its own WebSocket with `proto`'s client exactly as the game drives
it (`codex_server.set`, `worker.hire`, `transcript.watch`, `worker.answer_async`, `worker.dismiss_async`,
`worker.prompt`, `worker.keys`, `floor.sleep` / `floor.wake`, `worker.fire`), against the real Codex TUI (codex-cli
0.160.1, Herdr 0.9.0) and the mock model. The assertions are the bridge's acks, events and `worker.codex` view, the
TUI's screen (its queued-question badge, the rendered answer) and the mock's classified requests. "One model-visible
answer" is counted in the **model's whole input** (a model request carries the conversation so far), not in acks.

`make codex-shared-bridge` (or `make codex-shared-tui`, which includes it), `EVIDENCE=<dir>` as before:
`internal/codexshare/bridge*_integration_test.go`. Evidence in
[`TestCodexShareBridgeQuestions/`](codex-shared-tui-evidence/TestCodexShareBridgeQuestions/),
[`TestCodexShareBridgeRegression/`](codex-shared-tui-evidence/TestCodexShareBridgeRegression/),
[`TestCodexShareBridgeWorkers/`](codex-shared-tui-evidence/TestCodexShareBridgeWorkers/),
[`TestCodexShareBridgeRollout/`](codex-shared-tui-evidence/TestCodexShareBridgeRollout/) and
[`TestCodexShareBridgeRealModelSmoke/`](codex-shared-tui-evidence/TestCodexShareBridgeRealModelSmoke/), cited as
`BridgeQuestions/<label>` and so on. **[R]** below is this full stack with the mock model.

**Where the fixture differs from production**, and why:

- The package rule holds: `internal/codexshare` stays imported by nothing. Its full-stack suites import `internal/app`
  and `internal/proto` only in `integration`-tagged test files, which are in no package's import graph, so every
  `layer_test.go` tripwire (`go list -deps`) is unchanged and CI is unaffected.
- Workspaces are `bare-*`: no `.envrc`. The bridge's preflight runs `direnv status` in **its own** environment, whose
  allow list is the user's, not the fixture's (the blocked-`.envrc` fallback is #155's unit-tested path).
- herdr-world's own processes (the preflight's `codex --version`, the command catalog's stdio `codex app-server`,
  which #138's prompt translation runs for a text with a `/`) get the fixture's `CODEX_HOME`, never `~/.codex`.
- A floor wake starts the session through `systemd-run` with a login environment in production. The suite's
  `herdr.Control` runs every command as production does except that one, which starts the fixture's own session
  server instead (the same herdr, the same session name, the fixture's pinned `CODEX_HOME` and owner marker), so a
  woken pane can never reach `~/.codex`.
- Panes run the user's real fish configuration (hire creates its workspaces without `--env`); the fixture's session
  server carries the throwaway `CODEX_HOME`.
- Codex's "Hooks need review" dialog (B8) shows on each fixture's first hire (a fresh CODEX_HOME with Herdr's hook).
  The bridge leaves it, as designed; the suite answers it as the player would (`*-startup`, `*-after-trust`).

### 12.1 Async questions through the bridge [R]

`TestCodexShareBridgeQuestions`: one shared worker the bridge hired; the asking turn held by the mock where a step
needs it active.

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | Active turn, answer from the transcript side | `worker.answer_async` acked `sent` `via: turn/steer`; the badge stays at 2 until delivery, then shows 1 while the turn is still running (the reply request held): only the answered question cleared. The view goes `sent` → `answered`, `answered_by: bridge`; the other question stays `pending`. The mock got **one** reply request carrying one envelope | `BridgeQuestions/1-batch`, `1-answer-ack`, `1-sent`, `1-tui-after-send-not-yet-delivered`, `1-tui-delivered-turn-active`, `1-answered`, `1-mock-requests` |
| 3 | Idle turn | The asking turn's end cleared the TUI's badge; the bridge still had the other question `pending` (`turn: ""`, `async_blocked` false). `shift+←` from the game's seated terminal opened nothing. The bridge's answer went `via: turn/start`, the terminal rendered it as an answer (`› > Any context for the fixture?` / the text, then `MOCK_REPLY_SEEN …`), `answered` by `bridge`, one reply request | `3-idle-view`, `3-tui-idle`, `3-tui-idle-shift-left`, `3-answer-ack`, `3-tui-answer-rendered`, `3-answered` |
| 2 | Active turn, answer from the terminal | `shift+←`, the text and Enter through `worker.keys`: Codex's editor queued it; the bridge kept the question `pending` until delivery, then `answered`, **`answered_by: other`**, answer `typed-in-terminal`. The bridge sent nothing (no `answer_async`; the user message is not the bridge's `clientId`) | `2-terminal-editor`, `2-terminal-submitted`, `2-tui-delivered-turn-active`, `2-answered`, `2-mock-requests` |
| 4 | Suggested-answer and free-text questions, several batches | `ask-both` (options + free text in one batch), `ask-options`, `ask-free`: seven batches, seven distinct ids (the call ids), each answered or kept on its own | `1-batch`, `2-batch`, `4-batches`, `final-view` |
| 5 | Two clients answer at once | Two WebSocket clients sent `worker.answer_async` for the same question in the same instant: one `sent`, the other **`stale`** ("question 0 of call_15 is sent"); a third while it was on its way `stale`, one after it was answered `stale` ("… is answered"). The mock got **one** reply request | `5-concurrent-replies`, `5-third-answer-while-sent`, `5-answer-after-answered`, `5-mock-requests` |
| 5b | Terminal **and** transcript answer one question in the asking turn | Both are delivered with the turn's next model request: the model's input holds **two** answers to that question (findings §2: the server does not deduplicate, and the bridge cannot see the terminal's queued answer before it is delivered). The bridge reports the question `answered` with the one delivered **last**: `answered_by: other`, `from-the-terminal` (its own ack had said `sent`). A known limit, below | `5b-bridge-answer-ack`, `5b-terminal-submitted`, `5b-tui-delivered-turn-active`, `5b-answered`, `5b-both-answers` |
| 6 | The `undelivered` race and its retry | Steered (`sent`, `turn/steer`), then Ctrl+C from the game's terminal before the next model request: the turn was interrupted and the view says `sent` + **`undelivered`**; the mock got no reply. The player's second send went `via: turn/start` and was `answered`; a third was `stale` ("… is answered"). **One** reply request in all, one answer in the model's input | `6-answer-ack`, `6-undelivered`, `6-tui-interrupted`, `6-retry-ack`, `6-answered`, `6-answer-after-answered`, `6-mock-requests` |
| — | Dismiss | `worker.dismiss_async`: `dismissed` in the bridge only, nothing sent; an answer to it afterwards `stale` ("… is dismissed") | `d-dismissed`, `d-answer-after-dismiss` |
| 7 | herdr-world goes away and comes back with a question pending | The game's connection dropped, then herdr-world stopped. The worker's server kept running (its token's process and files: `7-server-while-bridge-gone`), the badge stayed, the turn finished and a prompt typed into the terminal ran, all without the bridge. Restarted on the same store, the new join rebuilt the **same seven batches in the same order**, no duplicate: the answered ones `answered` with the same `answered_by` (bridge or other, from the history), the pending one `pending`. The dismissal came back `pending` (dismissals are the bridge's only, #156 row 5). The pending question was then answered (`turn/start`), one reply | `7-view-before`, `7-tui-bridge-gone`, `7-tui-terminal-turn-bridge-gone`, `7-view-after`, `7-batches`, `7-answer-after-restart-ack`, `7-answered` |
| 8 | The native composer and badge | Read off the TUI at every step above: the badge counts the questions Codex still holds, clears each one at its delivery (not when the bridge's send is accepted, not at the turn's end while active), and goes when the asking turn ends | the `*-tui*` screens |
| — | One reply, one model-visible answer | In the model's last input: one answer to each question answered once (from either view, retried, after a restart), two to the question both views answered | `4-model-visible-answers` |

### 12.2 A shared worker's regressions [R]

`TestCodexShareBridgeRegression` (one worker), `TestCodexShareBridgeWorkers` (two).

| # | Check | Result | Evidence |
|---|---|---|---|
| 9 | A typed prompt (`worker.prompt`) | Typed by herdr (`via` absent); the join, which came after the first turn, made no model request; the next model request had the same model, the same instructions (hash) and the cwd | `BridgeRegression/9-typed-prompt-ack`, `9-settings` |
| 9 | A prompt while an async question shows the worker `blocked` (#156 row 10) | Bridge status `blocked`, `async_blocked: true`; the prompt acked `queued: true, via: "app_server"`, and the turn's next model request was it | `9b-blocked-view`, `9b-steered-prompt-ack`, `9b-mock-requests` |
| 9 | `/status` | Acked `terminal: true` (#140); the terminal shows the worker's own server (`unix://…/<marker>.sock (v0.160.1)`), the session and the model; no model request | `9c-status-prompt-ack`, `9c-tui-status` |
| 9 | A skill (`$h3d-fixture`) | Its SKILL.md reached the model | `9c-tui-skill` |
| 9 | Ctrl+C (`worker.keys`) | "Conversation interrupted", the worker back to idle | `9d-tui-interrupted` |
| 9 | An approval | **Never asked on a hired worker**: hire starts Codex with `--dangerously-bypass-approvals-and-sandbox` (approval policy never), so an escalation is refused by Codex itself ("approval policy is Never; reject command") and no approval reaches the terminal or the bridge. The bridge's passivity with approvals on is #155's adapter-level check (`TestCodexShareSharedApprovals`) | `9e-tui` |
| 9 | An image (`[Image #1: <path>]` in `worker.prompt`, #64) | Not rewritten (`sent` absent). Typed by herdr and steered through the app-server alike, the model gets the **path in the text**, no `input_image`: the same as any Codex worker today. The transcript shows the marker as an input image on both (`unavailable` here: the fixture's file is outside the transcript's image roots, which hold Drop Zone's directory) | `9f-image`, `9g-transcript` |
| 9 | The transcript subscription | `transcript.watch` names the worker's thread (`harness: codex`, `session` = the thread) and holds the turns typed in the terminal and steered through the bridge; opening it made no model request and left the join as it was | `9g-transcript`, `9g-after-watch` |
| 10 | Sleep, then wake | Sleep: the TUI quit, the server stopped (no marked process, no files), `server: "stopped"`, herdr's `session.json` without the thread. Wake: `resume: "fallback"`, the pane runs `codex resume <thread> --remote unix://… -C … -m mock -c model_reasoning_effort=low` (no bypass flag), the same thread, attached, and the question left pending before the sleep is still `pending` and was answered after the wake | `10-asleep`, `10-wake-ack`, `10-resumed-argv`, `10-tui-resumed`, `10-answered` |
| 11 | The server killed | `server: "down"` within the 3 s tick while herdr still said `working` and the TUI showed "Reconnecting to server…" (B6). Recovery by sleep and wake: the sleep quit the terminal with Ctrl-C (**the fix in §12.4**), the wake started a new server and resumed the thread attached; the next turn ran | `11-down-view`, `11-herdr-status`, `11-tui-server-down`, `11-audit`, `11-tui-recovered` |
| 12 | Send home | The worker removed; no marked process, no launcher, socket, pid file or log; the `codex_launch` record gone | `12-fire-ack`, `12-after-send-home` |
| 13 | Two shared workers | Two servers (two pids, two sockets), two threads. One worker's batch named on the other is `stale` ("no such question batch"), the other's thread `stale` too; each answer reached only its own worker's model input | `BridgeWorkers/servers-and-threads`, `crossed-answers`, `mock-replies` |

### 12.3 Unchanged paths, rollout and rollback [R]

`TestCodexShareBridgeRollout`.

| # | Check | Result | Evidence |
|---|---|---|---|
| 14 | The switch on a fresh store | `enabled: false`, `available: true` | `BridgeRollout/14-switch-default` |
| 14 | A Codex hire with the switch off | No `codex` in the ack or on the worker, no `codex_launch` record, argv exactly `codex -m mock -c model_reasoning_effort=low --dangerously-bypass-approvals-and-sandbox` | `14-l1-record`, `14-l1-argv` |
| 14 | A Claude hire with the switch on | No `codex`, no record, argv `claude --model … --effort low --permission-mode bypassPermissions --name …` (no prompt, so no inference) | `14-claude-hire-ack`, `14-claude-argv` |
| 14 | Claude's and the legacy blocking question paths | Unchanged code; their bridge-level tests pass (`internal/server/ask_test.go`: `TestAskFromTheTranscript`, `TestAnswerAskCodex`, …; `TestAskTrackerIgnoresCodexAsyncQuestions`), and `make integration` hires real Claude and Codex workers | — |
| 16 | Rollback | Switched off with a shared worker running: it stayed `shared`, `server: running`, attached, its token's process alive, and its pending question was answered afterwards. The next Codex hire was legacy (no record, the legacy argv). Switched on again: the shared worker kept its launch (same token), the legacy one stayed legacy, and the next hire was shared | `16-switch-off`, `16-s1-after-rollback`, `16-s1-server-after-rollback`, `16-s1-answered`, `16-l2-record`, `16-l2-argv`, `16-switch-on-again`, `16-l2-after-on-argv`, `16-s2-hire-ack` |
| 15 | An unsupported Codex | herdr-world restarted with a `codex` that prints `codex-cli 0.161.0` (the pane keeps the real one, so the fallback can run): the switch survived the restart; the hire acked `mode: legacy` with `shared Codex server: unsupported Codex version: "codex-cli 0.161.0" (supported: codex-cli 0.160.x); started the usual way`, the same note on the worker (the seat bar), the legacy argv, and a turn ran. The note names the version found, the supported line and what happened: left as it is | `15-note`, `15-u-view`, `15-u-argv`, `15-u-tui` |

### 12.4 Found and fixed: a terminal whose server died could not be put to sleep

Scenario 11 first failed [R]. A TUI whose own server died **ignores `/quit`**: it only waits to reconnect, and its
footer says "ctrl+c quit" (`BridgeRegression/11-tui-server-down`). So the floor's sleep could not quit it and noted
"its terminal did not quit"; herdr then kept the pane's session and, on wake, ran **its own** resume: it typed `codex
resume <thread>` into the restored pane before fish was ready, the bridge saw the pane at its shell and typed its
launcher line, which fish appended to herdr's unexecuted line (the screen showed ` codex resume <thread>setsid -f fish
<launcher> …`, exit status 2). The server never started, and the embedded fallback was refused with `agent_name_taken`
(herdr had restored the pane's agent). The wake's audit: `resume: "failed"`, "the app-server … did not answer … ;
starting it without its own server failed too: … agent_name_taken". In production that herdr resume is a plain
`codex resume`, which starts the user's CODEX_HOME daemon (B2).

One Ctrl-C exits such a TUI at once ("Disconnected from this task…"), and with its server gone there is no turn to
interrupt. **Fix** (`internal/server/codexfloor.go`, `hire.go`): the sleep presses Ctrl-C **once**, after `/quit` and
the Enters failed, and **only** when the worker's recorded server is gone (pid gone, or another process under it);
send home treats such a worker like a legacy one (its Ctrl-Cs). A TUI whose server runs still never gets Ctrl-C (#155
R1). Unit tests: `TestSharedCodexSleepQuitsATerminalWhoseServerDied` (dead and alive), `TestSharedCodexSendHomeWhenItsServerDied`.
With the fix the sleep notes "its codex server was gone: its terminal quit on Ctrl-C" and the wake resumes attached
(`11-audit`).

What remains: the wake's **safety net** for a pane herdr resumed its own way (#155 decisions row 1, "quit, then
relaunched") did not hold in this run. The bridge read the pane as at its shell while herdr's resume line was still
unexecuted, and herdr's restored agent kept the name. It is only reached now when a shared terminal does not quit at
sleep while its server runs (a dialog left open, for instance); the sleep's note says so. Recorded as a limitation.

### 12.5 The real-model run [R-real]

`TestCodexShareBridgeRealModelSmoke` (`H3D_CODEXSHARE_REAL=1`), once, `gpt-6.1-sol` at low effort. herdr-world
(`app.Serve`) aimed at a throwaway Herdr session on the user's real `~/.codex`, the switch on, a hire into a fresh
directory: `mode: shared`, its own server from the pane (`BridgeRealModelSmoke/hire-ack`, `launch`); no trust or
hooks dialog. Turn 1 asked the model to queue one async question: it called `request_user_input_async` ("Pick a color",
Red / Blue) and replied `ASKED` (`turn1-ask`). The bridge saw the batch, `call_1c19…`, and answered `Red` (`turn/start`,
the thread idle); the view went `answered`, `answered_by: bridge` (`answer-ack`, `answered`). The thread's rollout has
**one** user message carrying that envelope (`model-visible`). Tokens: **34,218** in all (the asking turn's
`token_count`; the answer's turn recorded none). Then the thread was archived through the worker's own socket and the
worker sent home: no marked process, no files left. The CODEX_HOME daemon's pid file and start ticks and the
checksums of `config.toml` and `hooks.json` were the same before and after (`baseline-before`, `baseline-after`).

**Not shown with the real model: the model's reply to the answer.** The test's wait for the answer's turn returned on
herdr's `idle` before that turn had begun, so the archive ran 0.26 s into it and interrupted it (`turn_aborted`,
`18-rollout-read-after-the-run`, read from the archived rollout afterwards). The answer was in the thread's input when
the turn started; the run does not show the model acting on it. The suite now waits for the turn's end in the join's
view; the one allowed run was not repeated. Two turns were used of the five allowed.

### 12.6 Limitations after #158

- **Both views answering one question before delivery reach the model twice**, and the bridge then shows the one
  delivered last (§12.1 5b). The bridge cannot see an answer queued in the terminal until Codex delivers it.
- **Approvals never occur on a hired worker** (hire's bypass flag); the bridge's passivity towards approvals is shown
  at the adapter level only (#155).
- **Images** reach a shared worker as their path in the text, as for every Codex worker; Codex's own image input
  (`input_image`) is not used on either path. Drop Zone's upload was not part of the suite (the marker was built
  directly; the bridge never reads it).
- **The wake's safety net** for a pane herdr resumed its own way failed in development (§12.4); after the fix it is
  reached only when a live-server terminal does not quit at sleep.
- **The game's own views were not driven against the real TUI**: the suites use the game's protocol, not its
  browser. The cards and the terminal/transcript toggle are #157's vitest and e2e against the fixture server.
- **The real-model run did not show the model's reply to the bridge's answer** (§12.5).
- Codex releases other than 0.160.x, and orchestrator-created (write-code) workers, which stay embedded (D7).
- Whether the terminal's editor takes free text on a question with options (the terminal answers here were free-text
  questions; the bridge stays strict).

### 12.7 Epic requirement ledger

Every product requirement of #153 and every acceptance item of #158, verified (with evidence) or a limitation.
The default stays **off**: the switch is opt-in (#158's decision).

| Requirement | Status | Evidence / reason |
|---|---|---|
| #153: the terminal remains Codex's own UI: typing | verified [R] | `BridgeRegression/9-typed-prompt-ack`, `9-tui-typed` |
| … slash commands | verified [R] | `9c-status-prompt-ack`, `9c-tui-status` |
| … skills | verified [R] | `9c-tui-skill` |
| … interrupts | verified [R] | `9d-tui-interrupted`, `BridgeQuestions/6-tui-interrupted` |
| … approvals | limitation | never asked with hire's arguments (`9e-tui`); approvals reach the terminal and the bridge stays passive: #155 [R] `TestCodexShareSharedApprovals` (adapter level) |
| … images | verified as today [R], with limits | path in the text on both paths, the transcript shows it as an image (`9f-image`, `9g-transcript`); no `input_image`; upload not exercised |
| … terminal/transcript switching | partly | the transcript of a shared worker is its thread and opening it changes nothing (`9g-transcript`); the game's toggle itself: #157's e2e, not against a real TUI |
| #153: both views refer to the same worker and conversation; opening the transcript starts no turn and overrides no setting | verified [R] | `9-settings`, `9g-transcript`, `9g-after-watch`; #155 [R-real] (the join started no turn) |
| #153: async questions can be answered while the worker still works; they do not disable the composer or make it a blocking ask | verified [R] | `BridgeQuestions/1-*` (answered during the turn); `BridgeRegression/9b-*` (a prompt while `blocked` is steered); #157 counts such a worker as working |
| #153: suggested answers and free text | verified [R] | `BridgeQuestions/1-*` (option), `3-*`, `2-*` (free text) |
| #153: multiple pending questions | verified [R] | `1-batch` (two in one batch), `4-batches` (seven batches), `BridgeWorkers/*` |
| #153: retries | verified [R] | `6-*` (undelivered, resent once, then `stale`) |
| #153: reconnects | verified [R] | `7-*` (game disconnect and bridge restart, no duplicate batch); `10-*` (sleep and wake) |
| #153: answers submitted from the terminal | verified [R], with a limit | `2-*` (`answered_by: other`); both views on one question reach the model twice (`5b-*`) |
| #153: "Sent" means accepted; "Answered" needs a verified association | verified [R] | `1-sent` then `1-answered`, `6-undelivered`; architecture.md "Delivered input vs verified native question resolution" |
| #153: preserve the Claude and blocking-question flows | verified [R] | `BridgeRollout/14-claude-*`; `ask_test.go`, `TestAskTrackerIgnoresCodexAsyncQuestions`; `make integration` |
| #153: the Codex connection change behind an opt-in switch | verified [R] | `14-switch-default`, `14-l1-*` |
| #158: real-TUI evidence: answers from both views, active and idle turns, native question-state reconciliation | verified [R]; [R-real] for one bridge answer | §12.1 rows 1, 2, 3, 8; §12.5 |
| #158: normal terminal and transcript workflows, bridge disconnect and worker resume | verified [R], approvals a limitation | §12.2; §12.1 row 7 |
| #158: one reply, one model-visible answer with retries and reconnects; a handled card cannot submit again | verified [R], with the 5b limit | `4-model-visible-answers`, `5-*`, `6-*`, `7-*` (`stale` for sending, sent, answered, dismissed) |
| #158: opt-in rollout, actionable unsupported-version behaviour, rollback: documented and verified | verified [R] | §12.3; architecture.md "Shared Codex workers" |
| #158: repo docs explain the architecture and distinguish delivered input from verified resolution | done | architecture.md "Shared Codex workers"; protocol.md "Codex async questions" |
| #158: all epic requirements verified or recorded as limitations | done | this table; §12.6 |
