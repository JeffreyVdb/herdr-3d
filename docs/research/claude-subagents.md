# Claude Code subagents: evidence on disk and hooks (#23)

Date 2026-10-17. **Claude Code 2.1.302** (`claude --version`; child lines in the corpus also carry 2.1.301), herdr 0.9.1.
Research for #23 (phase 2 of #20), condensed from two reports: a survey of the local transcripts plus a timing experiment
(`claude --model claude-haiku-5-5 -p`, a 200 ms poller of the session's files), and a hooks study (docs, changelog,
runs with a `--settings` file). The recordings used by the tests are `internal/claudechild/testdata` (its README); the
bridge's design is `decisions.md` "#23" and `protocol.md` "Claude Code subagents (#23)".

**Labels.** **[R]** observed on 2.1.302 (a run or the corpus); **[R-real]** observed in the real-terminal smoke check
(§6, an interactive worker hired by a private bridge); **[D]** documentation only; **[U]** unverified. None of the
transcript layout is a versioned schema: these are observations.

Sources: the Claude Code docs pages `hooks` (https://code.claude.com/docs/en/hooks), `settings`
(https://code.claude.com/docs/en/settings), `settings-reference`, `env-vars` (https://code.claude.com/docs/en/env-vars),
`claude-directory` (https://code.claude.com/docs/en/claude-directory), `sub-agents`
(https://code.claude.com/docs/en/sub-agents) and `agent-teams` (https://code.claude.com/docs/en/agent-teams), fetched
2026-10-17; the `anthropics/claude-code` `CHANGELOG.md` (sections 2.1.250–2.1.302).

## 1. Where the evidence is

- `<projects>/<project>/<rootSession>.jsonl` is the root's (main) transcript; `<projects>` is `$CLAUDE_CONFIG_DIR/projects`,
  else `~/.claude/projects` [D: env-vars `CLAUDE_CONFIG_DIR`; R for the default].
- Every child of the session, **at any depth**, is `<rootSession>/subagents/agent-<agentId>.jsonl` with
  `agent-<agentId>.meta.json` beside it: one **flat** directory, nested children included [R].
- The meta file is replaced whole (a `.meta.json.tmp.<hex>` renamed over it; the inode changes on every state write);
  the JSONL is appended on one inode [R]. A reader sees the old meta or the new one; a missing meta is "not written yet".
- `cleanupPeriodDays` (default 30) removes `<session>.jsonl` and `<session>/subagents/` together: a child's transcript
  lives as long as its parent's [D: claude-directory "cleaned up automatically"]. `CLAUDE_CODE_SKIP_PROMPT_HISTORY` or
  `-p --no-session-persistence` write no transcript at all [D].

## 2. The records (corpus: 106 main transcripts, 11 children; plus the runs)

- **The call.** An `assistant` record with a `tool_use` block, `name: "Agent"` (legacy `Task`), `id` = the dispatch id
  (`toolu_…`), `input.subagent_type`, `input.description`, `input.prompt`, optional `input.name`, optional
  `input.run_in_background` [R]. It is a boolean in `-p` runs and **the string `"true"`/`"false"`** from an interactive
  Haiku session [R-real]. Omitted means **background** on 2.1.302; only a boolean `false` gave a foreground child [R];
  the string `"false"` gave a background one [R-real].
- **The result** (`user` record, `tool_result` block, `tool_use_id`, plus the record's `toolUseResult`):
  `status: "async_launched"` with `agentId` about 30 ms after the call for a background child; `status: "completed"`
  with `agentId` at the end of a foreground child (its text starts `[Subagent hand-back]`); an interrupt is `is_error`
  with `toolUseResult` the **string** `"User rejected tool use"` [R]. A fork's result is `completed`, not the `forked`
  #20 mentions [R].
- **Background completion.** A `queue-operation` `enqueue` record and a `user` record whose text is a
  `<task-notification>` with `<task-id>` (the `agentId`), `<tool-use-id>` (the call), `<status>` [R]. Statuses seen:
  `completed`, `killed` (TaskStop) [R-real], `failed` [R: corpus]. A background shell's notification has the same shape
  with a shell's task id.
- **The child's file.** Its first line already has `agentId` and the **root** `sessionId` (also at depth 2), `isSidechain:
  true`, `parentUuid: null` [R]: no line of a child names its parent. `promptId` is the parent turn's, shared by
  concurrent siblings: not an identity [R]. `api-request*` records and `prompt_snapshot` attachments repeat other records
  and are no events [R].
- **The meta.** `agentType`, `description`, `toolUseId` (the call), `spawnDepth`, `requestShape`
  (`foreground`/`background`), `requestNonInteractive`, `launchedWithDefaults`; `parentAgentId` **only** on depth ≥ 2
  (the depth-1 parent's `agentId`); `finished: true` only once the child's work is done, **absent** while it runs and
  after an interrupt [R].
- **Nested.** The depth-2 call is in the depth-1 child's own file (and its result too); the depth-2 meta has
  `parentAgentId` = that child and `toolUseId` = that call, from its first write (≈1.6 s after the call) [R].
- **Fork** (`subagent_type: "fork"`). The file starts with `{type: "fork-context-ref", agentId, parentSessionId,
  parentLastUuid, contextLength}` (no timestamp), then **copies** of the parent's spawning `assistant` `tool_use` (same
  `id`) and a synthesized `tool_result` for it [R]. Indexing that copy as a call, or its result as an end, would be wrong.
- **Interrupt.** SIGINT to the parent: within ~30 ms a rejected result for the call, the same rejection for the child's
  in-flight tool (its file's last records, then `[Request interrupted by user for tool use]`), and no `finished` [R].
- **Resume.** A message to a finished child (`SendMessage`) runs **the same `agentId`** again: a `user` record in its file
  with `isMeta: true`, `origin: {kind: "coordinator"}` ("The coordinator sent a message while you were working: …"),
  then its work, then a new `finished` meta and (background) a new notification [R][R-real]. A child whose own
  background shell ends is woken the same way (`origin.kind: "task-notification"`, `[SYSTEM NOTIFICATION …]`) after it
  had finished [R-real]. A Stop hook's feedback is a plain `user` prompt ("Stop hook feedback: …") while it still works [R].

### Identity timing (ms after the call's record)

| case | child file, 1st line | meta 1st write (has `toolUseId`) | parent result | `finished` |
|---|---|---|---|---|
| foreground | +17 | ≤ +200 | +21,731 `completed` | +21.6 s |
| background | +18 | +92 | +31 `async_launched` | +22.1 s (notification the same ms) |
| two concurrent (2nd) | +8 after its own call | +78 after it | +17 after it | +22.2 s |
| nested, depth 2 | +1,767 | +1.6 s, with `parentAgentId` | (in the depth-1 file) | +14.0 s |
| interrupted | +19 | +79 | +8,210 rejected | never |
| fork | header, copy at +0 | +77 (`isFork: true`) | +22,505 `completed` | +22.5 s |

So the call id ↔ `agentId` pairing is on disk well under a second after the call, before any result, for foreground and
background children alike: by the file (+20 ms, `agentId` only) and the meta's `toolUseId` (+0.1–0.4 s; +1.6 s at depth
2). `stream-json` stdout shows the call 0.15–0.7 s before its JSONL line [R].

## 3. Hooks (2.1.302)

| event | input (observed) | notes |
|---|---|---|
| `PreToolUse` (matcher `Agent`) | `tool_use_id`, `tool_input`; `agent_id` when a child makes the call | before `SubagentStart`; the dispatch id before the child exists [R] |
| `PostToolUse` (`Agent`) | `tool_use_id` **and** `tool_response.agentId`, `status` | at once for a background child (`async_launched`), at the end for a foreground one; inside a child, `agent_id` = the caller: the nested parent link [R] |
| `SubagentStart` | `session_id` (root), `agent_id`, `agent_type`, `prompt_id`; **no** `tool_use_id`, no parent | fires again on resume (same `agent_id`) [R][R-real]; for in-process teammates per message [D] |
| `SubagentStop` | `agent_id`, `agent_type`, `agent_transcript_path`, `stop_hook_active`, `last_assistant_message` (large), `background_tasks` | a blocking Stop hook keeps the child working and its next stop has `stop_hook_active: true` [R]; fires for internal helpers with `agent_type: ""` [D][R-real]; none on a TaskStop kill [R-real] |
| `Stop` (root) | `background_tasks` lists running children | fires while a background child runs [R] |

- Hook input has **no timestamp**. Each event's stdin is one compact JSON line plus `\n` (574 B Start, 1006 B Stop) [R].
- **Merging.** `--settings <file>` hooks run **alongside** the user's and the project's (the user's own `SessionStart`
  hook still ran) [R; D: hooks "hook locations"]. Pass **one** `--settings`: with two, only the last one's hooks ran
  [R, one run]. `disableAllHooks` in the flag file silenced every hook [R]; one in the user's settings presumably
  silences the flag's too [U, by documented precedence]. Whether managed policy (`allowManagedHooksOnly`) blocks
  `--settings` hooks [U: no managed settings here]. Interactive trust gating of `--settings` hooks [U]; bridge-hired
  workers ran them [R-real].
- **Sync vs async.** Hooks block by default: a 5 s `SubagentStart` hook delayed the child's first model call by 5 s [R].
  `async: true` hooks ran in `-p` [R]. Exit codes other than 0/2 are non-blocking errors [D]; `onFailure: "block"`
  (2.1.295) and prompt/agent hook types on `SubagentStart` are of no use here [D].
- **Appending.** 8 concurrent writers: `jq -c . >> F` tore 186 of 2,400 lines (≥ 4 KB), `cat >> F` 136 of 800
  (5–20 KB lines); `flock F cat >> F` tore none of 800 [R]. A full disk tore one line [R]: readers must skip lines that
  do not parse.
- Changelog 2.1.250–2.1.302: no entry adds a parent id or a spawn `tool_use_id` to `SubagentStart`/`SubagentStop`/
  `PreToolUse(Agent)`. 2.1.275: `SubagentStop` matchers no longer fire for empty `agent_type`s; 2.1.290: teammate
  `agent_id` in Agent results is the agent id, the `name@team` address moved to `teammate_id`.

## 4. Helpers and teammates

- **Internal helpers** (prompt suggestions, `/btw`, compaction): `SubagentStop` with `agent_type: ""` [D]. In the smoke
  session, 15 such stops after the worker's turns, with **no** `SubagentStart`, no call and no file under
  `subagents/` [R-real]; the corpus has no file of a helper either [R]. Whether `SubagentStart` ever fires for them [U].
- **Agent-team teammates** are not disposable subagents: an Agent call with `team_name` (and `name`), results with
  `teammate_id` [D]; `SubagentStart` per message [D]; their transcript and meta layout and their hooks' `agent_type`
  [U: teammates need an interactive team, not run here].

## 5. What this means for the bridge

Pair by explicit ids only (call id ↔ `agentId` by the meta's `toolUseId`, the result's `agentId`, a notification
naming both, a `PostToolUse`); never by launch order, mtime or `promptId`. Immediate parent: the transcript holding the
call (main: the root; a child's: that child), else the meta's `parentAgentId`, else `spawnDepth: 1` (the root);
otherwise unknown. Ends: a completed or rejected result, a notification, `finished` (at the meta's write); a later
prompt (a meta one with an origin included) resumes. Hooks add the call before its line is read, the pairing and the
nested parent; they carry no time, so they cannot order an end against a resume, and a `SubagentStop` is never an end.

## 6. Real-terminal smoke check (2026-10-17)

A private bridge (`herdr-world serve` with its own socket and database under `$XDG_RUNTIME_DIR/h3d-csmoke`, `-sessions
'^h3d-csmoke$'`, `-claude-hooks` there) created a private herdr session `h3d-csmoke` (`session.create`) and hired one
Claude worker (`claude-haiku-5-5`, effort low) in a throwaway directory; `herdr pane process-info` showed it started as
`claude --model claude-haiku-5-5 --effort low --permission-mode bypassPermissions --name Smoke --settings
<bridge>/hooks/settings.json`. Prompts went through `worker.prompt`; `herdr-world dump` recorded the events.

| step | what the bridge showed |
|---|---|
| spawn (`smoke-fg`) | a row from the hooks (`source: hook`, `transcript: pending`, its `agentId` from `PostToolUse`) about 100 ms after the call, before any result; the transcript's evidence then (`available`); `completed` at its `finished`; woken by its own background shell and completed again: one row |
| concurrent spawn (`conc-A`, `conc-B` in one message) | two rows from the hooks, each with its own `agentId` (as the metas' `toolUseId` say), both `running` while the root sat idle, both `completed` by their notifications |
| nested spawn (`outer` → `inner`) | `inner` under `outer` (`parent: child`, `parent_id` = outer's row), from the call in outer's file and `parentAgentId` |
| interrupt (`interrupt-me`, stopped by the root's TaskStop) | `interrupted` from the `killed` notification, same row |
| bridge restart | stopped and started on the same database: the snapshot had the same six rows (same ids, the nested parent), from the files alone |
| resume (SendMessage to `conc-B` after the restart) | the same row `running`, then `completed` |

The first run of the resume step found a bug: the coordinator's message is an `isMeta` record, which the bridge then
read as no prompt; fixed (`origin`, §2) and run again after the restart. The session was then stopped and deleted, the
bridge stopped, and its directory and the throwaway project's transcripts removed.
