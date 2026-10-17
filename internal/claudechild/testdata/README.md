# Claude Code 2.1.302 subagent recordings (#23)

Real recordings of throwaway `claude --model claude-haiku-5-5 -p` sessions, made for #23's research
(`docs/research/claude-subagents.md`, section "Evidence on disk"). Each case directory holds:

- `parent-<case>.jsonl`: the root session's records that concern the spawn, in order: the `assistant` record with
  the `Agent` `tool_use`, the `user` record with its `tool_result`, and the `queue-operation` (`enqueue`) and `user`
  records of a background child's `<task-notification>`.
- `agent-<agentId>.jsonl`: the child's transcript, its `user`, `assistant`, `attachment`, `queue-operation`,
  `fork-context-ref` and `system` records in order (the `api-request*` records are dropped).
- `agent-<agentId>.meta.json`: the child's final meta file, verbatim.

Scrubbed: thinking and signature text is `<redacted>`; long text, tool results and prompts are cut (`…<clipped>`);
attachment payloads are dropped (`{"type": …, "_fixture_note": "payload dropped"}`); user, organisation and home
path names are `USER`/`ORG`. Everything the parser reads (ids, types, timestamps, statuses, notifications) is kept as
recorded, in Claude Code's compact JSON.

| case | root session | what it shows |
|---|---|---|
| `a` | `f41bf49f-1bb1-4510-8e0a-338094e2a6ba` | foreground child (`run_in_background: false`), synchronous `completed` result |
| `b` | `bc8c5901-8ee0-4a6d-b05d-834ae9dfc88f` | background child: `async_launched`, then its task notification |
| `c` | `a9bfd339-1eba-4ab4-8fb6-00193e2e3915` | two background children of one API message |
| `d` | `9a1ba95d-8c02-49f5-a68d-a5d85dd6c47b` | nested: a depth-2 child spawned inside a depth-1 child (`parentAgentId`) |
| `e` | `ef90ce79-0e17-4ce3-9cb6-8083169e2635` | the parent interrupted (SIGINT) while a foreground child runs: a rejected result, no `finished` |
| `f` | `7697b132-4098-4729-9d47-e377057cf505` | `subagent_type: "fork"`: the file starts with `fork-context-ref` and copies the spawning call |
| `g2` | `8a46bd85-bdda-4454-92f6-c16067c96d28` | `run_in_background` omitted: background by default |
