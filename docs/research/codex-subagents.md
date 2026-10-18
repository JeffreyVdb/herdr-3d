# Codex subagents: evidence in rollout files (#25)

Date 2026-10-18. Research for #25 (phase 4 of #20, the Codex terminal path), condensed from two reports: a corpus study
(a snapshot of `~/.codex/sessions`, 243 rollouts: 167 roots, 72 spawned children, 4 guardian reviewers; children under
codex-cli 0.162.1 (37) and 0.163.0 (35), all `history_mode: paginated`, all multi-agent v2) with a reading of the
upstream types at `openai/codex` tags `rust-v0.160.1`, `rust-v0.162.1` and `rust-v0.163.0`, and controlled runs
(`codex exec`, a 200 ms poller of the session files) on **0.163.0** and one on **0.160.1** (`npx @openai/codex@0.160.1`).
The recordings used by the tests are `internal/codexchild/testdata` (its README); the bridge's design is `decisions.md`
"#25" and `protocol.md` "Codex subagents (#25)".

**Supported versions: 0.160.1 (one real run), 0.162.1, 0.163.0.** The persisted types the source reads are identical in
the three tags (§7); a version that writes other records shows fewer children or fewer states, never wrong ones.

**Labels.** **[R]** observed in the corpus or a run (0.162.1 / 0.163.0); **[R-0.160]** observed in the 0.160.1 run;
**[R-real]** observed in the real-terminal smoke check (§8); **[D]** upstream source at the tags above (read, not run);
**[U]** unverified. Field names are the persisted ones (snake_case); the app-server's camelCase is #27's. None of this is
a versioned schema.

## 1. Where the evidence is

- A rollout is `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local start>-<thread id>.jsonl` (default `~/.codex/sessions`).
  Each line is `{"timestamp", "ordinal", "type", "payload"}`; `ordinal` is on every line and rises within a file [R,
  R-0.160].
- **Children are flat siblings** of their root in the date tree, nested ones included [R]; a child starts after its
  root, so its date directory is the root's or a later one.
- **The child's first line is its identity**: `session_meta` with `id` (its own thread id), `session_id` (the **root's**,
  at every depth), `parent_thread_id` (the immediate parent), `forked_from_id` (forked children only),
  `thread_source: "subagent"`, `source: {"subagent": {"thread_spawn": {parent_thread_id, depth, agent_path,
  agent_nickname, agent_role}}}`, top-level `agent_path`/`agent_nickname` repeating the spawn's,
  `multi_agent_version`, and (forked only) `subagent_history_start_ordinal` [R, R-0.160]. Invariants over all 72 corpus
  children: `session_id` is the root's 72/72; the top-level and nested parent agree 72/72; `depth` is the number of
  parent hops 72/72; `forked_from_id` is the immediate parent whenever present 65/65 [R].
- **A forked child copies its parent's history** (`fork_turns` omitted or `"all"`, the common case: 65 of 72): its
  **line 2 is the parent's `session_meta`, verbatim** (another `id`), and every record with `ordinal <
  subagent_history_start_ordinal` is the parent's copied history: `task_started` copies (an open one among them),
  `task_complete` copies, messages [R, R-0.160; D: `thread_history_materialization.rs`]. `fork_turns: "none"` writes
  no copy and no start ordinal [R]. A reader that takes "any `session_meta`" or "the last one" takes the parent's id;
  one that reads the copied turns sees a child that is already done, or one with an open turn (the corpus's
  `correction_prompt`, start ordinal 16) [R].
- **The spawn and its lifecycle are in the spawner's rollout**: the root's, or for a depth-2 child the depth-1 child's
  (the root's file never names depth 2) [R].
- **Guardian reviewers** are no children: `thread_source: "guardian_review"`, `source.subagent.other: "guardian"`,
  `multi_agent_version: "disabled"`, a top-level `parent_thread_id`; nothing references them in a `SubAgentActivity` [R].

## 2. The records

| record (file) | carries | meaning |
|---|---|---|
| `response_item/function_call` `spawn_agent`, namespace `collaboration` (spawner) | `call_id`, `arguments` `{task_name, fork_turns?, message, model?, reasoning_effort?}`; `message` encrypted (`gAAAAA…`) | the dispatch [R]; 0.160.1 omits `status` [R-0.160] |
| `response_item/function_call_output` (spawner) | `{"task_name": "/root/<name>"}` | **no thread id** (the nickname is hidden, `SpawnAgentResult::HiddenMetadata`) [R, D] |
| `event_msg/item_completed`, item `SubAgentActivity` `kind: "started"` (spawner) | `id` = **the spawn call's `call_id`**, `agent_thread_id`, `agent_path`, `model`, `reasoning_effort` | **the only explicit link** from a dispatch to a thread: 72/72 [R]; also 0.160.1 [R-0.160] |
| same, `kind: "completed"` | `id` = `subagent-completed-<child turn id>`, `agent_thread_id` | one per child **turn**, 0–18 ms after its `task_complete` [R] |
| same, `kind: "interacted"` | `id` = the `send_message` / `followup_task` call's | written by the caller at call time; no state [R] |
| same, `kind: "interrupted"` | `id` = the `interrupt_agent` call's | written by the caller after the interrupt; **not** written for SIGINT [R] |
| `event_msg/item_completed`, item `CollabAgentToolCall` `tool: "wait"` (v2) | `status: "completed"`, `receiver_thread_ids: []`, `agents_states: {}` | a wait names **no** child; a timed-out wait is `completed` too; an aborted wait writes none [R] |
| `function_call_output` of `wait_agent` | `{"message": "Wait completed." \| "Wait timed out.", "timed_out"}` | a tool result: a wait returned while its child still ran (woken by a message) [R] |
| child: `event_msg/task_started` | `turn_id`, `turn_attribution {turn_trigger, parent_turn_id, initiating_agent_path, root_turn_id}` (0.162.1+) | a turn start; own only at `ordinal ≥ start` [R]; 0.160.1 has **no `turn_attribution`** [R-0.160] |
| child: `event_msg/task_complete` | `turn_id`, `last_agent_message` | the end of an own turn [R] |
| child: `event_msg/turn_aborted` | `turn_id`, `reason` (`interrupted`, `replaced`, `review_ended`, `budget_limited`) | the only child-side end of an abort (SIGINT, `interrupt_agent`, v1 close, the process ending) [R, D] |
| `event_msg/sub_agent_activity` (legacy history only) | `event_id`, `occurred_at_ms`, `agent_thread_id`, `agent_path`, `kind` | a legacy rollout's non-completed activity; no sample [D: `rollout/src/policy.rs`; U] |

**v1** (`gpt-5.6-*`-class model metadata, `multi_agent_version: "v1"`) [R]: the collaboration calls run inside the `exec`
custom tool (`tools.multi_agent_v1__spawn_agent`); the spawner writes **no `SubAgentActivity`**, one
`CollabAgentToolCall` per completed call: `spawn_agent` (`id: "exec-<uuid>"`, `receiver_thread_ids: [child]`,
`receiver_agents: [{thread_id, agent_nickname}]`, `agents_states: {child: "pending_init"}`), `wait` (it names the child,
`agents_states: {child: {"completed": "<last message>"}}`), `close_agent` (`receiver_thread_ids: [child]`). The exec
output's JSON text carries `{"agent_id", "nickname"}`; the `CollabAgentToolCall` ↔ exec call link is by time only. A v1
child has no `agent_path` (null) [R].

**Close.** v2 has **no `close_agent`** (its tool spec is v1-only, `multi_agents_spec.rs:336`; v2 adds `interrupt_agent`
and `list_agents`) [D, R: asked to close, the v2 model called `interrupt_agent` or claimed "closed" with no call]. v1
`close_agent` on a running child: the child's `turn_aborted` (9 ms), then the completed `close_agent` item; on an idle
child: nothing in the child's file [R].

## 3. Timing (ms after the spawn call's record; corpus and runs)

| step | min | median | p90 | max |
|---|---|---|---|---|
| spawn call → child file's first line | 5 | 15 | 34 | 212 |
| spawn call → spawner's `started` | 17 | 28 | 42 | 178 |
| child's first line → spawner's `started` | −177 | 13 | 21 | 99 |
| child's `task_complete` → spawner's `completed` (84 turns) | 0 | 1 | — | 18 |

Seven `started` records came before the child's first line (up to 177 ms): the child's file can be absent or empty
when the spawn is first visible [R]. SIGINT of `codex exec` while a child ran: parent `turn_aborted` +10 ms, child
`turn_aborted` +20 ms, exit +364 ms; the spawner wrote no end for the child [R]. A root `exec` that ends while its
child runs: the child's `turn_aborted` 14 ms later; the spawner keeps it at `started` forever [R].

## 4. Pairing and parentage

- **Dispatch ↔ thread**: v2's `started` (`id` = the spawn `call_id`, `agent_thread_id`), 72/72 [R]; concurrent spawns
  (two calls in one response, `count_a`/`count_b`) pair exactly; each `wait_agent` returned at the **next** completion,
  not a named child [R]. v1: the completed `spawn_agent` `CollabAgentToolCall`'s single receiver [R]. Never by time,
  order, task name or `forked_from_id`.
- **Child ↔ parent**: line 1's `thread_spawn.parent_thread_id` (= the top-level one, 72/72): the root session or another
  child. A depth-2 spawn and its `started`/`completed` are in the depth-1 child's file [R].
- `followup_task` and `send_message` name their target by task name; the caller's `interacted` carries the resolved
  thread id [R].

## 5. Lifecycle

| evidence | state |
|---|---|
| spawner's `started` (v2), completed v1 `spawn_agent` item | `running` |
| own `task_started` (ordinal ≥ start) | `running` (a follow-up's too: the same thread, no new file) |
| own `task_complete`; spawner's `completed` (`subagent-completed-<turn>`) | `completed` (per turn) |
| own `turn_aborted`; spawner's `interrupted` (v2 `interrupt_agent`) | `interrupted` |
| v1 `close_agent` item | `shut_down` |
| `interacted`, a `wait` item or output, a spawn call's status, `agents_states` | nothing: tool-call status, never the child's |

Completion is per turn: a follow-up makes the same child `running` again (`followup_task` → `interacted` in the caller,
a new own `task_started` in the child within 5 s, 12/12) [R]. Own turns in the corpus are exactly 72 spawns + 12
follow-ups, so nothing else starts one [R]. `idle` is never read from rollouts (nothing shows a thread still loaded);
it is #27's. Quiet files end nothing: the child's `sleep` wrote nothing for seconds [R]. What files cannot show:
a child whose process was killed hard (SIGKILL: no record expected [U]) stays as its files left it; an idle v2 child is
never "closed"; whether a `turn_aborted` came from SIGINT or process teardown (both `interrupted`) [U].

## 6. History modes and upstream type diff (0.160.1 → 0.163.0) [D]

Identical in all three tags: `SessionSource`, `ThreadSource`, `SubAgentSource`, `SessionMeta`, `SessionMetaLine`,
`MultiAgentVersion`, `ThreadHistoryMode`, `SubAgentActivityKind`, `CollabAgentToolCallItem`, `CollabAgentTool`,
`CollabAgentRef`, `CollabAgentToolCallStatus`, `AgentStatus`, the `RolloutItemWire` variants, and the app-server v2
`CollabAgentToolCall`/`SubAgentActivity` shapes. The differences:

1. 0.162.1 adds `model` and `reasoning_effort` to `SubAgentActivity` (null on every kind but `started`); 0.160.1 writes
   neither [R-0.160].
2. 0.162.1 adds `turn_attribution` to `task_started` and `root_turn_id` to `task_complete`/`turn_aborted`; 0.160.1 has
   no own-turn attribution [R-0.160], so the own-turn test is the ordinal against the history start, never
   `turn_attribution` (a v1 child's own turn also has `initiating_agent_path: null` [R]).
3. 0.162.1 drops `stdout`/`stderr`/`formatted_output` from `CommandExecution` items and some `TurnContextItem` fields
   (not sub-agent fields).
4. 0.162.1 → 0.163.0: no change to any type above.
5. **History mode** (`session_meta.history_mode`, `legacy` when absent): paginated persists every `item_completed`;
   legacy persists only the `completed` `SubAgentActivity` as an item, the other kinds as `event_msg/sub_agent_activity`,
   and no `CollabAgentToolCall`. All 243 corpus rollouts and every run are paginated, the 0.160.1 one included
   (#20's "0.160.1 persists `CollabAgentToolCall`" holds for paginated history) [R, R-0.160].

## 7. What the existing code covered

`internal/codex` already skipped subagent rollouts in root recovery (`thread_source: "subagent"` or a parent thread)
and read only line 1 [R: code]; `internal/transcript` parsed a child's file from line 1, so a forked child's copied
history showed as its conversation, and `sub_agent_activity` fell to an unknown item; `codexcollab.go` read the
`SubAgentActivity`/`CollabAgentToolCall` items for the view only. #25 adds the rest (`decisions.md` "#25").

## 8. Real-terminal smoke check (2026-10-18)

A private bridge (`herdr-world serve` built from the branch, its own socket and database under
`$XDG_RUNTIME_DIR/h3d-xsmoke`, `-sessions '^h3d-xsmoke$'`, `-codex-run -` so Codex hires take the terminal path; a unix
socket only, no TCP port) created a private herdr session `h3d-xsmoke` (`session.create`) and hired one Codex worker
(`worker.hire`: `gpt-6-luna`, effort `low`, multi-agent v2 by its model metadata) in a throwaway directory; herdr's
Codex integration reported its session. Prompts went through `worker.prompt`; `herdr-world dump` recorded the events.

| step | what the bridge showed |
|---|---|
| spawn (`sleeper`, a child running `sleep 30`) | a row ~4 s after the prompt (`running`, transcript `available`, parent `root`, name = the nickname, description = the task name), **31 s before the child reported back**; then `completed`: one row [R-real] |
| two concurrent (`conc_a`, `conc_b`, sleeps of 15 and 25 s) | two rows, each with its own thread id, both `running`; `conc_a` `completed` while `conc_b` still ran, then `conc_b` [R-real] |
| nested (`outer` → `inner`) | `inner` first from the `started` record in `outer`'s rollout (`parent: child`, `parent_id` = outer's row, transcript `pending`), then `available` from its own file; both `completed` [R-real] |
| follow-up (`followup_task` to `sleeper`) | the same row `running` again (`ended_at` cleared), then `completed` with the new end [R-real] |
| `interrupt_agent` (`stopme`, a child running `sleep 60`) | `running`, then `interrupted` [R-real] |
| bridge restart (stopped and started on the same database) | the same six children from the files alone: native ids, names, parents and nesting, states, start and end times, transcript identical. Row ids were new: the worker's `/new` (below) had raised its `child_generation` to 2, and a fresh registry binds the session at 1 (row ids hash the generation, `protocol.md` "Restart"). A second restart (generation 1 both times): **identical rows and ids** [R-real] |

Before the runs above, the TUI model ran the shell command itself three times instead of spawning (the session's
multi-agent mode is `explicitRequestOnly`; the tools were offered); after `/new` (a new root session: the worker's
generation rose) the research's wording ("Use only the collaboration tools; do not run shell commands yourself. Step 1:
call spawn_agent …") worked every time. The session was then stopped and deleted, the bridge stopped, and the eight
throwaway rollouts moved out of `~/.codex/sessions`.

## 9. Open items

- [U] SIGKILL of the Codex process mid-child; a timed-out v1 wait; `send_message` to a running child; ephemeral
  children (no rollout at all [D]); a legacy-history rollout (no sample: `sub_agent_activity` is read tolerantly).
- [U] Whether a forked **root** (`codex fork`) copies another session's `started` records: none in the corpus (no root
  has `forked_from_id`).
