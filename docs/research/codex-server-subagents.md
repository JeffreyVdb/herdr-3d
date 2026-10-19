# Codex subagents through the shared app-server (#27)

Date 2026-10-19. Research for #27 (phase 6 of #20: a shared-server Codex worker's children, live from its own
app-server), condensed from two reports and the fixture runs that verified the implementation:

- a reading of the upstream app-server, core and thread store at `openai/codex` tags `rust-v0.160.1`, `rust-v0.162.1`
  and `rust-v0.163.0`, with the generated JSON schemas (`codex app-server generate-json-schema [--experimental]`) of all
  three and a no-model probe of the refusals (isolated `CODEX_HOME`);
- a live probe with a real model (`gpt-6-luna`, effort `low`, own `codex app-server --listen unix://…` per version, never
  the user's daemon) on **0.163.0** (spawn, follow-up, interrupt, reconnect, SIGTERM, SIGKILL and restart) and
  **0.162.1** (spawn, reads, the list filters), observed from bridge-like connections that logged every frame;
- the #27 fixture suites (`internal/codexshare/children_integration_test.go`, `bridgechildren_integration_test.go`):
  mock inference spawning and steering real Codex children, on **0.160.1, 0.162.1 and 0.163.0** (§10).

The bridge's design is `decisions.md` "#27" and `protocol.md` "Codex subagents through the shared app-server (#27)";
#25's rollout research is `codex-subagents.md`, the shared server itself `codex-shared-tui.md`.

**Labels.** **[S]** upstream source at the three tags (read, not run; 0.163.0 unless a version is named); **[G]** the
generated schemas; **[R]** the live real-model probe; **[F]** the #27 fixture (mock model, real Codex, the versions in
§10); **[U]** unverified. Where the source reading and a live trace disagree, **the live trace wins**, and the item says
so. Wire names are the app-server's (camelCase), except inside `source`, which is snake_case as in the rollouts.

## 1. A child thread's metadata

- `Thread` is identical in the three schemas [G]: `id` (the child's identity), `parentThreadId` (its immediate parent;
  set only for a subagent), `ephemeral`, `status`, `source`, `threadSource`, `agentNickname`, `agentRole`, `createdAt`
  (unix seconds), `cwd`, `path`, `model`, `reasoningEffort`, … `forkedFromId` is a history fork, not the parent [S].
- `source` of a spawned child: `{"subAgent": {"thread_spawn": {"parent_thread_id", "depth", "agent_path",
  "agent_nickname", "agent_role"}}}`. Other `subAgent` sources: `"review"`, `"compact"`, `"memory_consolidation"`,
  `{"other": …}` (a guardian); a root's is `"cli"`, `"vscode"`, `"exec"`, `"appServer"`, `{"custom": …}` [S][G]. Only
  `thread_spawn` is a child (#25's rule). `agentPath` is not a top-level field: it is in `source` and on
  `subAgentActivity` items [S][R].
- **`sessionId` is not the root's** [R, live trace wins]: on 0.163.0 a child's `thread/read` and `thread/list` rows
  carry its **own** id as `sessionId` (the source reading said "shared by a session tree"). Nothing may filter children
  by `sessionId`; the bridge follows `parentThreadId` chains.
- `threadSource` is `"subagent"` in `thread/read` but **`null` in `thread/list` rows** [R]: never gate on it.

## 2. What a connection receives

- **No `thread/started` for a spawned child**, on any connection [S][R]: only thread start, fork and review emit it.
  A child is named by its parent's items.
- Per-thread events (`turn/*`, `item/*`, `thread/tokenUsage/updated`) go to that thread's subscribers only;
  `thread/status/changed`, `thread/closed` and `thread/started` are **broadcast** to every initialized connection,
  for threads it never joined too [S][R].
- **Auto-subscription at creation**: when a child is spawned (or reloaded, or resumed), every connection initialized
  at that moment is subscribed to it [S]. So the bridge's join of the parent, made before the spawn, already gets the
  child's own `turn/*` and `item/*` [R][F]; a connection joined to the parent **after** the spawn gets only the child's
  broadcast status and the parent's items naming it, never the child's turns [F] (`TestCodexShareChildren`, the
  `early` and `late` connections). A reconnect is such a later connection.
- The probe also saw a child's `turn/started`/`turn/completed` reach connections that had unsubscribed or never joined
  it (§6 of its report); which connections get which lifecycle events beyond the rule above is [U]. Silence is never
  evidence of no child.

## 3. The items that name a child

- `subAgentActivity` (v2), on the **spawner's** stream (the root's, or a child's for a nested spawn), as `item/started`
  and `item/completed` [S][R]: `{"type": "subAgentActivity", "id", "kind", "agentThreadId", "agentPath", "model"?,
  "reasoningEffort"?}` (`model`/`reasoningEffort` since 0.162.1 [G]). `kind`: `started` (its `id` is the spawn call's
  `call_id`), `interacted` (a message or a follow-up), `interrupted` (`interrupt_agent`), `completed` (one per child
  turn; `id` `subagent-completed-<child turn id>`). `started` arrives as `item/completed` with `completedAtMs` (and
  `item/started` with `startedAtMs`) [R].
- `collabAgentToolCall`: `tool` (`spawnAgent`, `sendInput`, `resumeAgent`, `wait`, `closeAgent`, `sendMessage`,
  `followupTask`, `interruptAgent`, `listAgents`), `status` (`inProgress`, `completed`, `failed`, `interrupted`),
  `senderThreadId`, `receiverThreadIds`, `agentsStates` [G]. **On v2 only `wait` appears, with no receivers** (14 of 14
  in the probe): spawn, interact and interrupt are `subAgentActivity` only [R]. v1's spawn and close carry receivers [S].
- **A tool call's status is never the child's state**: a timed-out `wait_agent` completes (`"Wait timed out."`) while
  the child runs [R][F]; the parent's turn may end with its child still running [R][F].
- None of these is experimental [S]; a connection without `experimentalApi` gets the same items [R].

## 4. Lifecycle as the server shows it

- A fresh child's **first status is `idle`** (its pending init), before the parent's `started` and its `active` [R][F].
- Order at the end of a child's turn [R][F]: the child's `thread/status/changed idle`, its own `turn/completed`
  (`status` `completed`/`interrupted`/`failed`), then the parent's `subAgentActivity completed`.
- A follow-up: the parent's `interacted`, then the child's new turn (`active`, `turn/started`), then `completed` again
  [R][F]. `interrupt_agent`: the parent's `interrupted` and the child's `turn/completed` `interrupted` [R][F].
  `send_message` to an idle child names it (`interacted`) [F]; whether it starts a turn was not asserted [U].
- Status values: `notLoaded`, `idle`, `systemError`, `active` (with `activeFlags`) [G]. A loaded spawned child maps
  core `Running` → `active`; `PendingInit`/`Interrupted`/`Completed` → `idle`; `Errored` → `systemError`;
  `Shutdown`/`NotFound` → `notLoaded` [S]. So `idle` alone does not say how the last turn ended.
- A `turn/start` sent while a turn runs is merged into it [R] (the driver's concern, not the observer's).

## 5. Finding children: lists and reads

- `thread/list` with no `sourceKinds` lists interactive sources only: **subagents are excluded** [S][R].
- `thread/list {sourceKinds: ["subAgentThreadSpawn"]}` **missed the live child** on 0.163.0 and 0.162.1 while it ran
  [R]; the mechanism is [U].
- `parentThreadId` (direct children) and `ancestorThreadId` (all descendants) are **experimental**: without
  `capabilities.experimentalApi` the whole request fails with `-32600 "thread/list.ancestorThreadId requires
  experimentalApi capability"` [S][R][F, all three versions]. With it they found the live child with its live status
  [R]; they read the state DB only (`"state DB unavailable for filtered thread listing"` without it) [S]; a loaded thread
  with no store row (ephemeral) is never listed [S][F].
- `thread/loaded/list` returns the ids in memory: the parent and its live children [R].
- After a reconnect, **the parent's `thread/resume` returns no children** and replays nothing [R]: recover with the
  list and `thread/loaded/list`.
- `thread/read {threadId}` without `includeTurns` **never subscribes, loads, resumes or starts a turn** [S][R]: running,
  completed and unloaded children read fine. With `includeTurns` it hydrates the whole history (a deprecation notice on
  paginated threads) [R]. `thread/turns/list` needs a legacy thread loaded and refuses an ephemeral one [S][F];
  `itemsView: "notLoaded"` returns turns without items [G].

## 6. Joining, leaving, unloading

- Joining a child is `thread/resume {threadId, excludeTurns: true}` with nothing else; it starts no turn and keeps its
  model and effort [R]. Two side effects: **every subscriber of the child, the terminal included, gets
  `thread/goal/cleared`** [R]; and a resume carrying an override field that differs can shut an idle, unsubscribed child
  down and reload it [S].
- An unloaded v2 child refuses a resume until its parent is loaded: `"cannot resume an unloaded multi-agent v2
  sub-agent through its parent; resume the parent first, or use thread/read to inspect it"` [R].
- `thread/unsubscribe` removes the caller's subscription only [S][R]. Closing a connection drops every subscription it
  held, the auto-given ones included (`connection_closed`) [S]. A **running** child is never unloaded or stopped by it
  [S][R][F: three bridges left while a child ran, which then completed for the terminal]. An idle child with no
  subscriber is unloaded after `thread_unload_delay` (60 s on 0.160.1/0.162.1, 1800 s on 0.163.0), with `thread/closed`;
  0.163.0 also evicts idle v2 children (rollout kept, reloadable) [S].

## 7. Server or process loss

- SIGTERM drains: resumes are refused (`"serverShuttingDown"`), reads work, connections stay open, the process lingered
  [R]. SIGKILL: every connection ends with an EOF, no close frame [R][F].
- **The killed child's rollout has no end record** (no `turn_aborted`, no `task_complete`): a rollout reader sees it
  running forever [R][F].
- After a restart nothing is loaded; every child is `notLoaded` (the killed one too) [R][F], and the parent's resume
  does not load them [R].
- The store reconstructs the killed child's last turn as `interrupted` in `thread/read {includeTurns: true}` [R]. The
  bridge does **not** read turns at recovery: one hydrating read per historical child, on every join, to learn what is
  only "not running" for the board; it shows `unknown` (or the rollout's end, when it has one) instead (`decisions.md`
  "#27").

## 8. Ephemeral children

- A spawned child's config is built from its spawner's, so it is **ephemeral exactly when its spawner is** [S][F]: a
  persistent root's child is persistent; an ephemeral root's child (a driver's `thread/start {ephemeral: true}`) is
  ephemeral [F, all three versions]. A shared worker's root is never ephemeral (the bridge's join refuses one), so its
  children are not.
- An ephemeral child: no rollout, no spawn edge, never listed, `thread/turns/list` refused (`"ephemeral threads do not
  support thread/turns/list"`), `thread/resume` from another connection refused (`"no rollout found for thread id …"`),
  `thread/read` without turns answers while it is loaded [S][F]. Live only: gone after its last subscriber plus the
  unload delay.

## 9. Version differences that matter here

| | 0.160.1 | 0.162.1 | 0.163.0 |
|---|---|---|---|
| list filters experimental, same refusal | yes | yes | yes [S][R][F] |
| auto-subscription of initialized connections | yes | yes | yes [S][F] |
| `subAgentActivity.model`/`reasoningEffort` | absent | present | present [G] |
| `thread_unload_delay` | 60 s | 60 s | 1800 s [S] |
| idle eviction of v2 children | no | no | yes [S] |
| `thread/list.excludedThreadIds` | absent | absent | present [G] (unused) |
| routing (`thread_status.rs`, `transport.rs`) | identical | identical | identical [S] |

## 10. The fixture

- The mock (`internal/codexshare/mock.go`) offers `MOCK:spawn <task> <msg>`, `MOCK:followup <task> <msg>`,
  `MOCK:message <task> <msg>`, `MOCK:interrupt <task>`, `MOCK:wait <ms>`. Codex offers the v2 tools inside a
  `namespace` tool named `collaboration` (the catalog's `multi_agent_version: v2`); a call must name that namespace
  [F]. Arguments: `spawn_agent {task_name, fork_turns: "none", message}`, `followup_task`/`send_message {target,
  message}`, `interrupt_agent {target}`, `wait_agent {timeout_ms}` [S][F].
- A child's turn reaches the mock as a request whose last input is an **`agent_message`** (`author` `/root`, `recipient`
  `/root/<task>`) with a header text part (`Message Type: NEW_TASK\nTask name: …\nSender: …\nPayload:\n`) and the
  payload as an `encrypted_content` part, which is the plain text when the model sent it plain [F]. So the spawn's
  `message` carries the child's own directive (`MOCK:hold a1` keeps it running until the test releases it).
- The headless suites run a worker-style app-server (the launcher's `features.instant_interrupt=false`, the fixture's
  `CODEX_HOME`) with a driver client in the terminal's place; `TestCodexShareBridgeChildren` runs herdr-world with the
  real TUI. **Verified on codex-cli 0.160.1 and 0.163.0** (in `VerifiedCodex`) **and 0.162.1** (run once with a local,
  uncommitted `VerifiedCodex` entry: the list names 0.162.0, which is not installed here). `VerifiedCodex` and
  `codexapp.SupportedLines` are unchanged: verifying a release for the fixture is the full `make codex-shared-tui`.

## 11. Open items

- [U] Which connections get a child's lifecycle beyond the subscription rule (§2); why a `sourceKinds`-only list misses
  a live child (§5); whether `send_message` to an idle child starts a turn; a direct `turn/interrupt` of a child; a
  child resumed after a restart keeping a live turn; v1 (`multi_agent_version: v1`) children on a shared server (the
  catalog's model is v2; v1's items are decoded from the schema only).
