# Issue #58: Q2 status reliability and Q4 indicator mapping

Research date: 2026-09-30. Repository read-only, commit `b43999c34b41f35562a550c611d6854edb571031`. Read issue #58 with `gh issue view 58 --repo JeffreyVdb/herdr-3d` before testing. Herdr client/server 0.9.0, protocol 22.

## Method and limits

Started real Claude Code (`claude-sonnet-5-5`, high effort, bypassPermissions) and Codex (`gpt-6.1-sol`, high reasoning effort, dangerously-bypass-approvals-and-sandbox) using `herdr agent start`. Used scratch cwd, no repository edits. Polled `herdr agent get` nominally every 200 ms using independent threads; logged wall time before/after each call and full JSON, prompt submission start/ack, status-transition screen snapshots, and final screen. Captured session JSONL to correlate real completion with screen status. Polling can miss flicker shorter than a sample interval; this is a small observational sample, not proof for all agent versions/screens.

First workspace w8J disappeared externally before prompt submission (later confirmed by user); its attempts do not count. Retried with panes w8G:p2 (Codex) and w8G:p3 (Claude) in the caller workspace. An interrupted old probe briefly submitted a Codex tool task; cancelled it, archived interrupted logs, then started the clean measured trials. The first Claude prompts produced `reasoning_extraction` safeguard errors, not valid sustained-work tests. Retried plain mathematical answer prompts without asking for private reasoning. Claude retry tool task used three independent `sleep 4` calls with prime facts between calls; Codex used three calls with comparisons of prime proofs between them. Each received a follow-up approximately 3 seconds into the tool turn. Claude acknowledged it and returned QUEUE_DONE; Codex's disposition is recorded below. Claude queued messages may be incorporated into the same turn, so do not assume a new turn boundary per queued submission.

Elapsed start measurements distinguish time from command invocation and time from successful prompt ack. The CLI prompt itself took roughly 300 ms; a successful ack means submitted, not necessarily already working. Completion uses Codex `event_msg/task_complete` or Claude `system/turn_duration`; these records are practical proxies for real end, not a timestamp of the final terminal paint.

## Measured transitions

### ground-codex

| Case | UTC observation | Since submit start | Status/event |
|---|---|---:|---|
| thinking | 2026-09-30T20:10:26.236+00:00 | 0 | Submit starts |
| thinking | 2026-09-30T20:10:26.545+00:00 | 0.308 s | Prompt ack |
| thinking | 2026-09-30T20:10:26.553+00:00 | 0.317 s | done |
| thinking | 2026-09-30T20:10:26.965+00:00 | 0.729 s | working |
| thinking | 2026-09-30T20:12:39.291+00:00 | 133.054 s | done |

thinking: 683 samples; maximum interval 0.221 s; first working 0.420 s after ack.

| tools | 2026-09-30T20:12:43.499+00:00 | 0 | Submit starts |
| tools | 2026-09-30T20:12:43.806+00:00 | 0.307 s | Prompt ack |
| tools | 2026-09-30T20:12:43.811+00:00 | 0.311 s | done |
| tools | 2026-09-30T20:12:44.212+00:00 | 0.712 s | working |
| tools | 2026-09-30T20:15:12.367+00:00 | 148.867 s | done |
| tools | 2026-09-30T20:12:47.126+00:00 | 3.627 s | Queued follow-up submitted successfully |

tools: 760 samples; maximum interval 0.564 s; first working 0.406 s after ack.

### ground-claude-retry

| Case | UTC observation | Since submit start | Status/event |
|---|---|---:|---|
| thinking | 2026-09-30T20:11:54.898+00:00 | 0 | Submit starts |
| thinking | 2026-09-30T20:11:55.211+00:00 | 0.314 s | Prompt ack |
| thinking | 2026-09-30T20:11:55.218+00:00 | 0.320 s | done |
| thinking | 2026-09-30T20:11:55.521+00:00 | 0.624 s | working |
| thinking | 2026-09-30T20:12:30.758+00:00 | 35.861 s | done |

thinking: 198 samples; maximum interval 0.219 s; first working 0.310 s after ack.

| tools | 2026-09-30T20:12:34.778+00:00 | 0 | Submit starts |
| tools | 2026-09-30T20:12:35.084+00:00 | 0.306 s | Prompt ack |
| tools | 2026-09-30T20:12:35.089+00:00 | 0.311 s | done |
| tools | 2026-09-30T20:12:35.289+00:00 | 0.512 s | working |
| tools | 2026-09-30T20:13:01.423+00:00 | 26.645 s | done |
| tools | 2026-09-30T20:12:38.523+00:00 | 3.745 s | Queued follow-up submitted successfully |

tools: 152 samples; maximum interval 0.432 s; first working 0.205 s after ack.

## Q2 findings

Both successful pure-thinking trials and both successful tool/queued trials retained `working` across the observed active interval. No sampled idle/unknown flicker occurred during reasoning or between tool calls. `done` was the final settled state because these background panes were not focused; this is the unseen-completion variant of idle. The unsuccessful Claude safeguard trials did transition to done and back to working around the follow-up, which corresponds to actual refused/finished turns rather than demonstrated mid-turn misclassification.

Pure thinking: Claude stayed working for about 35 seconds, Codex for about 132 seconds. First working was observed about 0.5–0.75 seconds after submit invocation (about 0.2–0.42 seconds after ack). Completion delays and tool boundaries are included in the generated correlation section below. Treat these as sample-resolution measurements, not exact detector internals.

Recommendation: use `worker.status` as the initial live activity signal, with transcript rows selecting the label and explaining tools. The measured trials do not justify adding a new bridge turn field yet. Preserve uncertainty for unknown status; do not call it idle or completion. Keep #57's counterexample and this limited sample in mind: if deployment evidence shows systematic missed working intervals, use explicit turn lifecycle records as a later authoritative supplement. Status alone cannot distinguish reasoning from generation; “Thinking…” is a useful inferred label.

## Herdr → bridge → game latency trace

| Stage | Evidence | Timing implication |
|---|---|---|
| Subscribe to pane status events | `internal/herdr/types.go:208–215`, `internal/herdr/client.go:155–184` | Unix socket `events.subscribe`, line-by-line reads; no periodic status poll |
| Establish snapshot and live stream safely | `internal/watch/session.go:68–139` | Lifecycle subscribe, snapshot, pane status subscribe, second snapshot prevents lost change in startup gap |
| Read stream | `internal/watch/session.go:239–257` | Dedicated pump, bounded 64-event channel; scheduling/backpressure, no timer |
| Apply known-pane status and publish | `internal/watch/session.go:161–177`; `internal/world/derive.go:110–128`; `internal/watch/session.go:82–92` | Immediate update/publish; no debounce in normal known-pane path |
| Exceptional lifecycle/new-pane resnapshot | `internal/watch/session.go:16–17,152–171` | 50 ms debounce for lifecycle events or unknown pane |
| Discovery and fallback | `internal/watch/watch.go:38–55,85–95`; `internal/watch/session.go:139,179` | 2 s session discovery and 30 s safety resnapshot are not normal status latency |
| Consume world observation | `internal/server/hub.go:490–498,872–882` | Hub applies floor then emits worker events; processing/storage/layout work may add delay |
| Stamp status_since | `internal/server/hub.go:1211–1223` | Bridge observation clock, not original turn start; timestamp changes only when status changes |
| Build worker.status | `internal/server/hub.go:1144–1155` | Status/title-only changes emit worker.status; other changes may emit worker.upsert carrying status |
| Queue all clients | `internal/server/hub.go:1544–1565` | Immediate sequence/replay/queue; slow clients are dropped instead of waiting indefinitely |
| WebSocket write | `internal/server/ws.go:150–164` | Write as soon as send channel yields; no batched status flush |
| Client dispatch/store | `game/src/net/client.ts:265–268,345–359`; `game/src/app.ts:514`; `game/src/world/store.ts:233–249` | Immediate event callback and status/status_since update |
| Seated laptop frame | `game/src/app.ts:433,1795`; `game/src/laptop/index.ts:835–850` | Next rendered frame. Currently only blocked question is passed to transcript mode (`transcriptMode.ts:598–606`); activity indicator does not exist yet |

Expected normal latency **after Herdr changes its state**: socket delivery + watcher/hub work + WebSocket/network + client callback + at most one visible frame. On an unloaded local connection, expect milliseconds to tens of milliseconds plus 0–16.7 ms at 60 Hz. This is a code-derived expectation, not an instrumented end-to-end benchmark or guaranteed upper bound. Under load, slow network, hidden-tab throttling, storage delays, reconnects or startup, there is no hard bound. Add 50 ms in the unknown-pane/lifecycle branch; recovery may depend on discovery/reconnect/safety resnapshot. Screen detection delay is separate and was measured above. The game already receives status into its store; the current transcript does not show an activity label at all.

Do not add the usage tick or transcript flush to status latency. Those are a separate content path: this checkout already has `WatchedUsageInterval = 1 s` (`internal/server/usage.go:39–40,119–136`), default unwatched 2 s, and transcript flush 250 ms (`internal/server/transcript.go:31–36`). Thus the issue's 2 s watched-poll description is stale for this checkout. `kickUsage` is defined at `internal/server/transcript.go:245–253` and called on a new watch at line 286; there is no kick in `input.go` or `hub.go` after prompt/on working. `status_since` measures duration of the observed uninterrupted working state; queued work may keep the same timestamp and therefore it is not elapsed time of the queued prompt.

## Q4: recommended indicator policy

Types: `internal/proto/transcript.go:34–71,171–176`; documented shapes/statuses: `docs/protocol.md:1565–1570`. Tool results replace existing call rows (`internal/transcript/item.go:118–142`), so select activity from canonical items ordered by seq, not the last received push or updated row. Ignore hidden metadata notices when finding the last meaningful conversation item. Do not limit the search for running calls to the last item: concurrent calls can remain live earlier in the current turn.

Global precedence: disconnected/stale data → no definitive live claim; blocked/active ask → waiting-for-user UI; idle/done → no bottom activity; unknown → no Thinking/Working claim (optional neutral unavailable-state note). Then, for working, a relevant live foreground tool or synchronous subagent row can explain the activity; otherwise use the current-turn last meaningful item.

| Last meaningful item/state | working | idle/done | blocked | unknown |
|---|---|---|---|---|
| user, including accepted local pending prompt for this turn | Thinking… | none | none; waiting banner/card | none |
| thinking, including empty/redacted reasoning | Thinking… | none | none; waiting banner/card | none |
| tool running, belongs to current turn | tool row speaks; no duplicate bottom cue | no bottom cue; stale tool row is history, not proof of live work | none; waiting UI wins | no bottom cue; row state may be stale |
| tool ok/error/interrupted | Thinking… | none | none; waiting UI | none |
| assistant from current turn | Working… | none | none; waiting UI | none |
| subagent running, synchronous foreground call | subagent row speaks; no duplicate bottom cue | none; do not infer parent work | none; waiting UI | none |
| subagent completed/error/interrupted | Thinking… | none | none; waiting UI | none |
| subagent async_launched | fallback Thinking… unless newer current-turn assistant → Working…; launch ack is not continuing foreground work | none; child may still run separately | none; waiting UI | none |
| compaction/notice/unknown or no items | walk back to meaningful current-turn item; default Thinking… if none | none | none; waiting UI | none |
| old finished assistant from previous turn, user echo has not arrived | Thinking… immediately; do not classify stale text as active generation | none | none; waiting UI | none |

**Running subagent recommendation:** make its collapsed header itself visibly live (status plus elapsed time, with the same 1 Hz clock) and optionally show “Subagent running…” in its body. Suppress the bottom Thinking cue only while a synchronous current-turn call explains parent activity. Today the header only prints status (`game/src/laptop/transcriptRender.ts:1014–1042`) and lacks the tool row's ticking duration (`:935–942,1110–1122`), so suppressing the bottom label without strengthening the header can still leave an apparently static view. If retaining today's header unchanged, use a generic Working… bottom cue instead of incorrectly implying parent reasoning. For asynchronous launch, the result `async_launched` does not mean child completion; do not keep the parent spinner forever based on it. No child liveness field exists here.

**Stale assistant recommendation:** capture the transcript seq/id watermark on entry into working (and on accepted local sends), use Thinking until new-turn user/content appears, and then apply the table. A watermark is more reliable than comparing item.ts to status_since because the bridge stamps status_since after the agent may already have logged its first item. Timestamp comparison is only a fallback on initial seating/reconnect; historical items can arrive late and metadata updates need not be new turn content. For already-working initial attach without known boundaries, choose a generic Thinking/Working fallback rather than asserting old assistant generation. This heuristic has unavoidable ambiguity for remote prompts/initial attach without turn IDs; if that ambiguity matters, add explicit transcript turn identity rather than pretending timestamps solve it.

Queued pending prompts should remain distinct: show their queued state immediately, but do not let them override an active current-turn tool row or restart the current status elapsed clock. A running item from an old completed turn should not suppress a new turn's cue. Error/interrupt rows do not themselves prove the whole worker stopped; worker status has precedence. AskUserQuestion uses the question UI, not a tool-running spinner.

Implementation constraints for the later feature: pass status/status_since adjacent to blocked(), remove the bottom activity when not working, opacity-only CSS pulse, separate 1 Hz elapsed span, pause/remove animation when hidden, reduced-motion static label, polite announcements only on state changes. No implementation or GPU performance claim is made by this read-only spike.

## Correlation evidence


Session `rollout-2026-09-30T22-09-16-01a0f3ef-890e-7f91-9d67-3d70b5fae03c.jsonl`:

- 2026-09-30T20:10:26.610Z: task_started
- 2026-09-30T20:12:38.795Z: task_complete
- 2026-09-30T20:12:43.832Z: task_started
- 2026-09-30T20:12:50.535Z: custom_tool_call exec
- 2026-09-30T20:12:56.847Z: custom_tool_call_output 
- 2026-09-30T20:13:21.441Z: custom_tool_call exec
- 2026-09-30T20:13:27.294Z: custom_tool_call_output 
- 2026-09-30T20:14:16.255Z: custom_tool_call exec
- 2026-09-30T20:14:22.169Z: custom_tool_call_output 
- 2026-09-30T20:15:11.841Z: task_complete

Session `d76acc12-92aa-4f87-ac44-64c0ce363740.jsonl`:

- 2026-09-30T20:12:30.412Z: turn_duration
- 2026-09-30T20:12:37.277Z: Bash sleep 4 tool_use
- 2026-09-30T20:12:45.750Z: tool_result
- 2026-09-30T20:12:48.914Z: Bash sleep 4 tool_use
- 2026-09-30T20:12:53.095Z: tool_result
- 2026-09-30T20:12:54.873Z: Bash sleep 4 tool_use
- 2026-09-30T20:12:59.069Z: tool_result
- 2026-09-30T20:13:00.982Z: turn_duration

Raw polling artifacts: `ground-herdr-scratch/ground-codex.jsonl`, `ground-herdr-scratch/ground-claude-retry.jsonl`; unsuccessful first Claude attempt: `ground-claude.jsonl`; interrupted workspace/probe attempts: `interrupted-*.jsonl`. `probe.py`, `claude-retry.py`, and `tailprobe.py` preserve procedure. `observed-lines.jsonl` holds append-observation timestamps (initial lines were backfilled when tail observer started; use embedded record timestamps for those). Raw agent logs can contain opaque reasoning payloads; findings above use only lifecycle/time/type data.

### End-to-settled sampled delay

| Agent/case | Real-end record UTC | Last sampled working minus end | First sampled done minus end |
|---|---|---:|---:|
| ground-codex/thinking | 2026-09-30T20:12:38.795Z | 0.296 s | 0.496 s |
| ground-codex/tools | 2026-09-30T20:15:11.841Z | 0.220 s | 0.526 s |
| ground-claude-retry/thinking | 2026-09-30T20:12:30.412Z | 0.150 s | 0.347 s |
| ground-claude-retry/tools | 2026-09-30T20:13:00.982Z | 0.234 s | 0.441 s |

The last working samples fell roughly 0.15–0.30 s after these transcript-end records, then done was observed roughly 0.35–0.53 s after end. The transition lies between the surrounding polls (with additional uncertainty from RPC snapshot timing and log record time). Both queued follow-ups produced QUEUE_DONE within the ongoing tool trial, without a sampled done/working boundary; do not assume queued submissions always start a separate lifecycle interval.

## Cleanup and final scope

Closed only the created sibling panes w8G:p3 and w8G:p2 after both agents settled. The externally removed w8J workspace and its panes no longer existed. Stopped the scratch log observer. Final `git status --short` was empty. No repository changes, issue comments, or implementation work were made. End-to-end game latency is traced and estimated from code, not measured in a live browser.
