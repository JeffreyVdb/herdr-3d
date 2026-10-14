// Package handoffllm reduces a worker's main-session transcript (Claude Code
// or Codex JSONL) into bounded, scrubbed source data for a handoff the
// configured LLM writes (#9), and owns the outgoing-text policy (Scrub) for
// anything sent to that model. The reducer half (reduce*.go, scrub*.go,
// budget*.go) reads transcripts only: the standard library, internal/jsonl
// and internal/transcript (TestReducerIsALeaf); the prompt and the call live
// in the rest of the package.
//
// # Snapshot
//
// Reduce reads Input.Path from its start up to Input.Through (a line start:
// transcript.Candidate.Through), never past it. The file must be the one
// Input.File describes (os.SameFile) and at least Through bytes long, and the
// read must end exactly at Through; otherwise ErrChanged (also for a nil
// File and a missing file). Reduce does not re-hash the snapshot's region:
// the caller checks the candidate is still the latest (transcript.StillLatest)
// first. Lines over jsonl.MaxLine and lines that are not JSON are skipped and
// counted (Coverage.Skipped, plus a gap); the read and the fitting stop on
// context cancellation. A Claude file under a subagents/ directory and a
// Codex subagent rollout are ErrUnsupported, as are unknown harnesses and a
// snapshot with no conversation.
//
// # Main thread
//
// Claude: the active branch is the uuid/parentUuid ancestry of the snapshot's
// last conversation row (user, assistant, summary or compact boundary; a
// trailing turn_duration or attachment row descends from it), crossing a
// compact_boundary by its logicalParentUuid. Claude Code's last-prompt
// leafUuid is only a hint (it is stale in real files): when its ancestry
// meets the branch below the tip, the gap "branch tip uncertain" is added and
// the latest row's branch is used. Off-branch rows are Abandoned, except a
// streamed block of a message on the branch (same message.id) and a result
// of a call kept. isSidechain rows are counted (Sidechains) and never read.
// Rows of one message.id merge into one message (Deduplicated counts the
// extra rows; an identical copy of a block is dropped); a row written twice
// (same uuid) is dropped and counted. Lines without ids (older files) follow
// the line before them.
//
// Codex: response_item messages are the conversation; an event_msg
// user_message or agent_message is read only when its turn has no
// response_item with the same text (else Deduplicated). Developer messages,
// injected user context (AGENTS.md, environment, skill text), reasoning
// (encrypted or not), token counts, turn context, world state and
// item_completed events are never text; another agent's messages and
// sub_agent_activity count as Sidechains. Calls (function_call,
// custom_tool_call, local_shell_call) and their outputs are tool evidence. A
// turn's final reply is its final_answer message (legacy rollouts without a
// phase: its last assistant message; with no message at all,
// task_complete's last_agent_message). A forked rollout (forked_from_id)
// keeps its own rows (ordinal >= subagent_history_start_ordinal) with a gap;
// when the inherited rows cannot be told apart, everything is read once with
// a gap.
//
// # Compaction
//
// Claude: when the latest compact_boundary on the branch is followed by a
// readable isCompactSummary row (text that is not the "Conversation
// compacted" display note), the summary seeds the payload
// (Compaction="claude_summary") and the rows before the boundary are covered
// by it; the person's prompts from before it (the first goal, later
// corrections) are kept too, unless a later prompt says the same, as
// "user (before compaction)" messages that are dropped before the summary
// is. Without a readable summary: "missing", a gap, and the earlier rows the
// file still holds are reduced like any history.
//
// Codex (a deviation from the orchestrator's D5, accepted on evidence:
// rollouts are append-only, and 190 of 193 local compacted rollouts still
// hold readable assistant replies before the compaction row): the rows
// before a compacted row are kept; compacted.message (always empty in
// practice) is never a summary; replacement_history's user messages are
// added where the compaction happened ("user (kept across compaction)")
// unless an identical user message was read earlier (Deduplicated); its
// developer items and its encrypted compaction item are never text.
// Compaction is "codex_retained" when replacement_history has a readable
// user message, "opaque" when the row carries history it cannot show, else
// "missing"; opaque and missing add a gap, and "pre-compaction assistant
// replies unavailable (Codex)" is added only when no assistant reply was read
// before the compaction row. Every compaction leaves a note line in Text.
//
// # What is kept
//
// Every user message (typed, queued while the agent worked, or kept across a
// compaction) with reminders and paste wrappers removed, assistant text,
// compaction summaries, and for each tool call its name and a one-line
// summary of its input (command, path, patch files; at most 300 bytes) with
// the result's status ("ok", "error", "exit N") and at most 8 evidence lines
// of at most 200 bytes from the result's first and last 64 KiB: exit status,
// test outcomes and failure lines, error headers, apply_patch's file list,
// git commit lines and pull request / issue URLs. Never a full log, thinking
// or redacted thinking, encrypted content, JSONL bookkeeping or image data:
// an image becomes "[N images omitted]".
//
// Artifacts are the references observed: files an edit or patch call names,
// commits from git commit output, pull request and issue URLs, and test
// commands. Verified is true only when a result shows success (the edit or
// patch applied, the commit line printed, the URL in a result, the test
// command's latest run passed); a call alone, or a URL in prose, is false.
//
// # Budget
//
// Text is at most Input.Budget bytes. When everything does not fit,
// reductions are tried in this order, oldest first within each step, until
// it does: tool evidence of assistant messages; the text of assistant
// messages that are not a turn's final reply, excerpted to 400 bytes (tool
// calls reduced to a count); the same for turns' final replies; the
// compaction summary excerpted (head and tail); then whole messages of the
// middle history are omitted (intermediate assistant messages before final
// replies); then Claude's prompts from before the summary (corrections
// newest first, the first goal last); then the summary. A last pass gives
// left-over room back to the messages dropped last. User messages and the
// snapshot's final reply are pinned whole: when they do not fit, ErrTooLarge
// (there is no newest-only truncation). Cuts are only at message boundaries,
// and excerpts at rune boundaries with their markers counted. Every
// reduction is a Range in Coverage.Omitted (adjacent ones with the same
// reason merged): "tool evidence", "older assistant detail", "middle
// history", "compaction summary excerpted", "prompt before compaction",
// "compaction summary". The output is deterministic.
//
// Coverage.Messages counts the main thread's messages after branch
// selection, compaction seeding and deduplication; Kept those in Text
// (whole or excerpted). Complete is true only when nothing was omitted or
// excerpted, there is no gap and no line was skipped.
//
// # Text layout
//
// Blocks separated by a blank line:
//
//	=== #3 user 2026-10-12T09:00:46Z ===
//	<text>
//	=== #4 assistant 2026-10-12T09:00:47Z ===
//	<text>
//	[tool] Bash: go test ./... -> exit 1
//	  | --- FAIL: TestParse (0.00s)
//	=== #9 assistant (final reply) 2026-10-12T09:00:52Z ===
//	=== omitted #5-#8 (4 messages): middle history ===
//	=== note: conversation compacted here ===
//
// A header names the message's ordinal (1..Coverage.Messages, the numbering
// Range uses), its role ("user", "user (before compaction)", "user (kept
// across compaction)", "assistant", "assistant (final reply)", "compaction
// summary") and its UTC timestamp when the line has one. An excerpt ends
// "… [N bytes omitted]"; a call whose evidence was dropped ends
// "[output omitted]"; an excerpted message's calls become "[tools] Bash x3,
// Edit x1 (detail omitted)". Text is valid UTF-8 with no control characters
// but newline and tab (no carriage returns, escape sequences or bidi
// overrides), and a transcript line that starts with "===" gets a leading
// space, so no line of the source can pass for a header. The caller wraps
// Text in its own delimiters as untrusted data.
//
// # Scrub
//
// Scrub is the outgoing policy for everything sent to the configured LLM; it
// is not ai.Scrub (whose catch-all for long runs would erase the commit SHAs,
// UUIDs and session ids a handoff needs: those survive Scrub). Each secret
// becomes "[redacted:<category>]", and Scrub returns counts by category,
// never the text. In order: the caller's literal secrets
// (configured_secret), data URIs (data_uri), PEM private-key blocks and
// blocks cut before their END line (private_key), URL userinfo passwords
// (url_credentials), Slack webhooks (slack_webhook), AWS key ids
// (aws_access_key) and keyed AWS secret keys (aws_secret_key), GitHub tokens
// ghp_/gho_/ghu_/ghs_/ghr_/github_pat_ (github_token), Anthropic sk-ant-
// (anthropic_key), OpenAI sk-/sk-proj- (openai_key), Stripe sk_/rk_
// (stripe_key), Slack xox?- (slack_token), Google AIza (google_api_key),
// JWTs (jwt), Authorization headers and bearer tokens (auth_header), and
// values assigned to secret-named keys — password, secret, token, api key,
// access key, private key, credential(s), auth token, passphrase — in code,
// JSON, YAML and .env lines (secret_assignment; placeholders such as $VAR,
// <name>, numbers and type names are left alone). Every pattern is RE2
// (linear time) and runs only when the text holds its literal hint, so no
// input makes it hang. Reduce scrubs every kept string whole, again after
// each clip or excerpt, and every artifact ref; Payload.Redactions sums the
// counts of the pieces in Text and the artifacts (an excerpt still counts
// the redactions of its whole message, so a count can exceed the markers
// left in Text).
//
// EstimateTokens is ceil(ASCII bytes / 3) + one per non-ASCII rune: an
// estimate meant to err high, not a tokenizer count.
package handoffllm
