# The Codex terminal beside a second app-server client (#154, phase 1)

Date 2026-10-06. Installed and verified: **codex-cli 0.160.1**, **herdr 0.9.0**, fish 4.2.0, direnv 2.37.1. The Codex source cited is
tag `rust-v0.160.1`. Parent epic: #153.

**Labels.** **[R]** marks a runtime-verified claim. The fixture test that shows it is named, and its captured screens and
messages are in [`codex-shared-tui-evidence/`](codex-shared-tui-evidence/), one directory per test, with files numbered
in capture order. The text cites a file by test and label, for example `Questions/active-after-steer-not-yet-delivered`.
**[S]** marks a claim that rests on reading the source only. **[R-live]** marks a read-only observation of the user's real
machine.

All tests use mock inference. The one real-model smoke test against the user's shared daemon was **skipped for safety**
(§9).

## 0. The answer: does the terminal still work with a shared app server?

**Yes.** Codex's own TUI keeps working, for a person and for Herdr orchestration, when it is attached with `--remote`
to an app-server that a second protocol client also uses. This holds on (a) a worker-owned `codex app-server --listen
unix://…` and (b) the managed daemon mechanism (`codex app-server daemon start`, CODEX_HOME-scoped, run from a
throwaway home). It holds **provided that the server is started from the worker's own initialized pane**. The shared
daemon breaks the worker's environment and its Herdr identity. Phase 2 must also own lifecycle and resume, because
Herdr's resume does not keep `--remote`.

What works [R], mock model, real TUI in a Herdr pane:

| Capability | Evidence |
|---|---|
| `herdr agent start … -- --remote unix://SOCK -C DIR`: Codex is detected and `interactive_ready`; typing a prompt runs a model turn | every test, e.g. `Lifecycle/*` |
| `agent prompt --wait` sees working → idle/done during a model turn; `agent wait`, `agent read`, `pane send-keys` | `Lifecycle`, `MixedHarness/agent-read` |
| Turns typed in the terminal appear in the bridge client, and bridge `turn/start` turns appear in the terminal | `Lifecycle/bridge-turn-in-terminal` |
| Ctrl+C interrupts a running turn (`turn/completed status:"interrupted"`); Herdr goes back to done | `Lifecycle/ctrlc*` |
| Slash commands (`/status` names the shared server and the thread, makes no model request) and skills (`$h3d-fixture` injects its SKILL.md) | `Lifecycle/slash-status`, `Lifecycle/skill-turn` |
| Approvals reach the TUI and every subscribed client; the TUI answers; Herdr shows blocked meanwhile | `Approvals/*` |
| Exiting the TUI (idle Ctrl+C ×2) and `codex resume ID --remote … -C …` reopen the thread with its history | `Lifecycle/tui-resumed` |
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
| D1 | Server ownership | **One app-server per Codex worker**, started from the worker's pane after its shell and direnv are initialized, immediately before the TUI and in the same pane: `setsid -f fish -c 'codex app-server --listen unix://$SOCK' </dev/null >$LOG 2>&1`, then `herdr agent start … -- --remote unix://$SOCK -C $CWD <model args>`. The `fish -c` keeps wrapper functions; `setsid -f` keeps the server off the pane's foreground job. A server typed with `&` left the pane `agent_pane_busy` in the ground probe. Socket: a short per-worker path under `$XDG_RUNTIME_DIR` (the 108-byte limit). Before starting, the launcher checks `direnv status` for the cwd and refuses or reports a blocked `.envrc`. Never use the CODEX_HOME daemon (B1, B2). |
| D2 | Server lifetime | The bridge records each worker's socket and server pid. It stops the server when the worker is sent home or fired and before a floor sleeps, because a detached server survives its pane and `herdr session stop` (B5). On wake it starts the server again from the pane (D5). The bridge reports a dead server; Herdr would show "working" (B6). |
| D3 | Subscription lifetime | The bridge joins with `thread/resume {threadId}`, never with overrides, while it has a reason to watch (transcript open, question pending), and leaves with `thread/unsubscribe`. Reconnecting uses Herdr's `agent_session.value` as the thread id. Among loaded threads it skips ephemeral ones and never guesses the newest by cwd. The 60 s unload does not matter: the TUI keeps the thread subscribed. |
| D4 | Approvals | **The bridge is passive.** It never answers `requestApproval`, the blocking `requestUserInput`, or any other server request. It only reads `serverRequest/resolved` to update its view. Any answer would win the race (§3). |
| D5 | Session id and resume | The same-pane launch makes Herdr's hook report to the right pane (B3). Herdr's native resume cannot express `--remote` and calls Codex by absolute path (B4). Shared-mode Codex workers are therefore **resumed by herdr-3d**: the wake fallback (`floorops.go`) becomes the launcher, server first, then `codex resume ID --remote unix://$SOCK -C $CWD`, in place of `codex resume ID`. Herdr's own resume must not run first for such a pane. **Unverified:** whether `herdr pane release-agent`, or leaving the session unreported at sleep, stops it while the bridge keeps the id. Verify that first in phase 2. If neither does, the fallback is to stop the worker's server before sleep. Herdr's resume would then still attach the CODEX_HOME daemon (B2), so the bridge must exit that TUI and relaunch. |
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
  `--env`; in one development run a restored pane reached `~/.codex` that way (§9).
- `*_integration_test.go`: the suites cited above. Each test kills the processes it left (anything naming its temp
  root) and stops temp-home daemons.

Launch and attach procedure used throughout:

```fish
# in the worker's pane, at an initialized prompt
setsid -f fish -c 'codex app-server --listen unix:///run/…/w.sock' </dev/null >…/w.log 2>&1
herdr agent start <name> --kind codex --pane <pane> -- --remote unix:///run/…/w.sock -C <cwd> [model args]
# resume
codex resume <thread-id> --remote unix:///run/…/w.sock -C <cwd>
```

## 9. Not verified, and the skipped smoke test

- **The real-model smoke test against the user's daemon was not run.** The live daemon carries a live pane's
  `HERDR_PANE_ID`, and `~/.codex` has Herdr's SessionStart hook (§0). A new thread there would report its session id
  into that pane and could change that worker's identity and resume. The brief forbids affecting live workers. Every
  terminal and Herdr check above ran on mock inference. The TUI and Herdr side does not depend on the model, but
  real-model turn timing is not covered.
- **Side effect in development:** before the fixture pinned `CODEX_HOME` on its Herdr server, one Herdr session
  restart restored a pane without its `--env` and ran `codex resume <fixture id>` against `~/.codex`. It failed ("No
  saved session found"). No thread was created, `~/.codex/config.toml` was not changed, and the daemon was not
  restarted (its pid file is unchanged). Codex may have written to its log/state SQLite in `~/.codex`.
- Ctrl+C, slash commands and approvals were checked on the worker-owned server only. On the managed daemon, the TUI
  uses the same remote client [S].
- D5's suppression of Herdr's native resume (`pane release-agent`) is unverified.
- Real Claude worker in the reverse mixed-harness direction (needs inference).
- Images in the composer and terminal/transcript switching in the game (phase 5).
