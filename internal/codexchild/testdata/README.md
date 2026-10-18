# Codex subagent rollouts (#25)

Real Codex rollouts, made for #25's research (`docs/research/codex-subagents.md`). Each case directory holds the
root session's rollout and each child's, under their own names (`rollout-<start>-<thread id>.jsonl`; the tests put
them in a `YYYY/MM/DD` tree as Codex does). Model `gpt-6-luna` at `low` effort (multi-agent v2 by its model
metadata) unless noted; `codex exec` in a scratch directory.

Scrubbed: `base_instructions`, `creator_user_id`, `creator_account_id`, `git`, `runtime_workspace_roots` dropped from
`session_meta`; `user_instructions`/`developer_instructions` dropped wherever they occur; home and user names are
`/home/user` and `user`, a case's scratch directory is `/home/user/work/<dir>`; encrypted payloads (Fernet tokens)
keep their first 32 characters (`gAAAAA…`); text longer than 240 characters is cut (`…<clipped>`); image data is
`data:image/png;base64,(clipped)`. Every id, type, ordinal, timestamp, status and field the source and the transcript
parser read is kept as recorded (JSON strings such as call arguments are re-encoded compactly).

The `corpus-*` cases come from real work sessions (`~/.codex/sessions`, read-only): only the records the source and
the transcript read are kept (`session_meta`, turn starts and ends, `SubAgentActivity` / `CollabAgentToolCall` items,
collaboration calls and their outputs, messages), and all free text in them is `(clipped)`. Ordinals are as recorded,
so the gaps are the records dropped.

| case | root session | cli | what it shows |
|---|---|---|---|
| `a` | `01a14e28-bd2c-7e73-93d2-81ecf2153526` | 0.163.0 | one child, `fork_turns` `all`: line 2 of the child is the root's `session_meta`, history start 9; `spawn_agent`, `wait_agent` (cwd `probe`) |
| `b` | `01a14e2b-473a-7321-8c9d-23f2c7973264` | 0.163.0 | two concurrent children (`fork_turns` `none`), two waits; `count_a` started 177 ms before its file's first line |
| `c2` | `01a14e2b-d7d0-7c01-8a79-2cb6ba62938e` | 0.163.0 | nested: `count_outer` (not forked) spawns `count_inner` (forked, depth 2); the root's file never names depth 2 |
| `d` | `01a14e2c-443a-7ed2-8ddc-fa7e07c5e551` | 0.163.0 | follow-up: `followup_task` (`interacted`), a second own turn of the same thread |
| `e` | `01a14e30-98b9-7882-9fc9-2b6576e76199` | 0.163.0 | SIGINT of `codex exec` while the child runs: the child's own `turn_aborted` only |
| `f-run` | `01a14e31-1989-78d3-b7cd-f0ec0cf8be00` | 0.163.0 | `interrupt_agent` on a running child: `SubAgentActivity` `interrupted`, then the child's `turn_aborted` |
| `f-run2` | `01a14e31-77cf-7562-89a6-3966c43a2627` | 0.163.0 | a timed-out wait while the child runs; the root's exec ends first and the child gets `turn_aborted` at exit |
| `f-run-v1b` | `01a14e34-22ec-7022-aca1-c45b73f53039` | 0.163.0 | v1 (`gpt-5.6-luna`): `close_agent` on a running child, `CollabAgentToolCall` items with receiver ids |
| `f-idle-v1b` | `01a14e34-4bdf-7ff1-ac99-4bd71728f015` | 0.163.0 | v1: spawn, wait (its item names the child, `agents_states` completed), `close_agent` on the idle child |
| `g-a0160-v` | `01a14e34-cd56-7403-bbbd-9fcbb638138f` | **0.160.1** | case `a` on 0.160.1 (`npx @openai/codex@0.160.1`): same shapes, no `turn_attribution`, no `model` on activities |
| `corpus-trap` | `01a1411d-60ee-7ca0-91a1-88ef70dddaae` | 0.162.1 | the inherited-prefix trap (TUI): the child's history start is 16; its copied history has the parent's completed turn and an open one |
| `corpus-guardian` | `01a13fba-4edf-7880-a324-1d3b25197386` | 0.162.1 | a guardian reviewer (`thread_source` `guardian_review`, `source.subagent.other`): no child |
