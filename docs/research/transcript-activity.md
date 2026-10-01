# Transcript activity: spike for #58 (thinking indicator, prompt echo)

Researchers: GROUND|jsonl-think and GROUND|herdr-work · 2026-09-30 · Claude Code 2.1.286 (claude-sonnet-5-5, high), Codex CLI 0.159.2 (gpt-6.1-sol, high), herdr 0.9.0.
Full reports with timelines: [transcript-activity-jsonl.md](transcript-activity-jsonl.md) (Q1, Q3, queued prompts) and
[transcript-activity-status.md](transcript-activity-status.md) (Q2, Q4, status latency trace). Their links into
`ground-*-scratch/` point at raw captures kept outside the repo.

## TL;DR

1. **Q1, is anything written while the model reasons?** Yes, but nothing usable as a live signal. Claude wrote only
   metadata during a 33 s thinking wait and the complete thinking block together with the final text (the block's
   embedded timestamp was 5.8 s older than its append). Codex appended a complete, encrypted `reasoning` item about every
   31 s during a long turn, with empty summaries. A `thinking` item is history, never proof that reasoning is going on now.
2. **Q2, is herdr's `working` reliable?** In every valid trial (pure thinking 35 s Claude / 132 s Codex; three tool
   calls with reasoning between them; a prompt sent mid-turn) the status stayed `working` for the whole turn with no
   idle/unknown flicker at ~200 ms sampling. `working` appeared 0.5–0.75 s after the send; `done` 0.35–0.53 s after
   the turn's closing record. herdr → game is event-driven (`events.subscribe`, no poll or debounce on the normal
   path): milliseconds plus one frame.
3. **Q3, should the bridge report the turn?** No, not now. Codex has explicit `task_started` / `task_complete` /
   `turn_aborted` with a turn id, but a SIGTERM left a start with no close. Claude has no explicit start,
   `turn_duration` is written interactively but not under `-p`, and prompts are absorbed mid-turn. The indicator is
   **client-derived from `status` + the last items**; a bridge field (with an `unknown` state) stays the fallback if
   #57-style misdetection shows up in practice.
4. **Q4, what is the agent doing?** Table below. Pick the last *meaningful* item by `seq` (skip notices/metadata),
   and look for running tools/subagents in the current turn, not only in the last item.

## Q4 mapping (only while `status === "working"`)

| Current-turn last meaningful item | Indicator |
|---|---|
| none yet / `user` (incl. a pending sent row) | Thinking… |
| `thinking` | Thinking… |
| `tool` running | the tool row speaks ("Still running…"), no bottom cue |
| `tool` ok / error / interrupted | Thinking… |
| `assistant` | Working… |
| `subagent` running (synchronous) | the subagent row speaks: its header gets the same live elapsed time as a tool row; no bottom cue |
| `subagent` finished / `async_launched` | Thinking… (Working… if a newer assistant item follows) |
| assistant from a **previous** turn (the new `user` item has not arrived yet) | Thinking… |

`idle` / `done` → nothing. `blocked` → nothing (the "Waiting for you" banner owns it). `unknown` → nothing.
"Current turn" = items after a watermark (the highest `seq` seen when the status last became `working`, or when you
sent a prompt), so stale assistant text from the previous turn never reads as "Working…". On first seat into a worker
that is already working there is no watermark; the table is then applied to the last item as is.
Elapsed time comes from `status_since` (bridge observation time of the status change); a queued prompt does not
restart it.

## Prompt echo

- **Queued prompts are absorbed mid-turn** by both CLIs, not only after the turn. Claude writes
  `queue-operation` enqueue/remove (`reason: absorbed_mid_turn`) and an `attachment/queued_command` with the prompt,
  which `internal/transcript/claude.go` already turns into an `ItemUser`; its embedded timestamp is the *enqueue* time.
  Codex writes a `response_item` user message in the running turn. So a queued pending row can be replaced before the
  turn ends, and the copy "takes it after the current turn" should become "takes it when it can".
- **Matching:** both CLIs trim leading/trailing whitespace and keep the interior verbatim. Normalise by trimming and
  CR/CRLF → LF; compare with the text of the first new `user` item after the send watermark; identical sends match
  FIFO. Never match tool results or injected context items (the parser already keeps those out of `ItemUser`).
- **Latency:** watched transcripts are already polled every 1 s (`WatchedUsageInterval`, `internal/server/usage.go:40`),
  not 2 s; the 250 ms watch flush comes on top. `kickUsage()` (`internal/server/transcript.go:246`) is only called on a
  new watch. Kicking it after a successful `worker.prompt` and when a watched worker turns `working` is the planned cut.
