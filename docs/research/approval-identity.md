# Permission prompts: their native identity, and Telegram's limits (#106)

Date 2026-10-18. **Claude Code 2.1.302** (`claude --version`), **codex-cli 0.163.0**. Research for GitHub issue #106
("Telegram permission cards flood every 2s and lose approval buttons"), condensed from two read-only reports: a hooks
study (throwaway `--settings` hooks that only logged their stdin, interactive `claude` in tmux and `claude -p`, in
scratch directories; two runs whose hook answered `PermissionRequest`) and a reading of the Telegram Bot API. No bridge,
setting or bot was touched. The bridge's design is `decisions.md` "#106 (GitHub)"; the code `internal/server/approval.go`,
`internal/transcript/calls.go`, `internal/notify/{buttons,limits}.go`, `internal/approval`.

**Labels.** **[R]** observed locally on the versions above; **[B]** text in the 2.1.302 binary (`strings`), not
exercised; **[D]** documentation only; **[C]** a community source, not the official docs; **[U]** unverified.

Sources: the Claude Code docs pages `hooks` (https://code.claude.com/docs/en/hooks.md) and `permission-modes`
(https://code.claude.com/docs/en/permission-modes.md), the `anthropics/claude-code` `CHANGELOG.md` (2.0.45, 2.1.268,
the rm-guard entries 2.1.126–2.1.296), all fetched 2026-10-18; `codex app-server generate-json-schema` of 0.163.0; the
Telegram Bot API FAQ (https://core.telegram.org/bots/faq) and reference (https://core.telegram.org/bots/api).

## 1. What identifies a pending permission prompt (Claude Code)

| source | carries | when | for which workers |
|---|---|---|---|
| `PreToolUse` hook | `tool_name`, whole `tool_input` (a compound Bash command whole), **`tool_use_id`**, `cwd`, `session_id`, `prompt_id` | before every tool call, before the permission check [D][R] | the Claude workers the bridge starts (its `--settings`) |
| `PermissionRequest` hook | `tool_name`, whole `tool_input`, `cwd`, `session_id`, `prompt_id`, `permission_mode`, `permission_suggestions`; **no `tool_use_id`** [D][R] | as the dialog is about to show; the dialog appears in parallel [R]. 0.03–0.10 s after the call's `PreToolUse`, same `prompt_id` and `tool_input` [R] | the same |
| `Notification` (`permission_prompt`) | the text "Claude needs your permission" only [R] | about 6 s after the dialog opens [R][D] | the same; no identity |
| the transcript's assistant `tool_use` line | `id` (the `tool_use_id`), `name`, whole `input`, and the line's `cwd` [R] | about **0.1 s after** the dialog opens (absent at `PermissionRequest`, present 0.13 s later, dialog still open) [R] | every Claude worker whose transcript the bridge reads, started by it or not |
| the transcript's `{"type":"permission-mode","permissionMode":…}` line | the session's mode (`bypassPermissions`, …) [R: a local 2.1.302 session's transcript] | when it is set | the same |

**No event says a prompt was answered** [R]. Yes runs the tool: `PostToolUse` with the same `tool_use_id`; No and Esc
leave no hook event (no `PostToolUse`, no `Stop` within 30 s); the transcript records `toolUseResult: "User rejected
tool use"`, `toolDenialKind: "user-rejected"`. An accepted call's result line carries `permissionDecision: {decision:
"accept", source: "user_temporary"}` (the record the issue quotes) [R]. So "answered in the game" is never known from
these; only "no longer waiting".

**The dialog on the screen** is drawn under a rule at the left edge, its head ("Bash command", "Create file"), the
command's lines indented, the call's description, then the question right above the choices [R: the captured
`testdata/screens`]. Codex's starts with its question ("Would you like to run the following command?"), then
`Environment:`, `Reason:` and `$ <command>`; its trust dialog with "Folder access" [R].

## 2. Bypass mode

Plain commands and variable-target ones (`D=$PWD/scratch; touch $D/x`) do not prompt in `bypassPermissions` [R]; a
project `ask` rule still prompts and fires `PermissionRequest` [R]. An `rm`/`rmdir` on a critical path (including a
`"$VAR"/*` target whose variable may be empty) **still prompts in bypass mode, with a two-minute countdown, denied on
timeout; after three unanswered such prompts in a session further ones are denied at once** [D: permission-modes
"Critical-path removals"]. The binary has the denial's text "Only a person may approve such a removal, and no person did
(the permission prompt timed out, or this session cannot prompt)" [B]. **Not reproduced** locally: the research
session's own safety check refused to run the removal [U for whether a hook can answer it].

## 3. What a hook could decide

`PermissionRequest` may answer `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":
"allow"|"deny",…}}}`; both were verified [R]; an allow ran the call with no dialog, also over an `ask` rule in bypass
mode [R]. A hook that times out, exits non-zero or answers invalid JSON leaves the human prompt [R][D]; any deny wins
[D]. A `PreToolUse` allow does not approve a critical-path removal [D]; whether `PermissionRequest` reaches one is
**open** [D says it can in modes that ask; U]. The bridge's hooks only observe (#23): a deciding hook would change
what the bridge is trusted with.

## 4. Codex

Hired Codex workers run with approvals bypassed: they never prompt [repo, D4 of `codex-shared-tui.md`]. Shared
(app-server) workers' approval requests carry `itemId`, `turnId`, `command`, `cwd`, `reason` on the wire
(`CommandExecutionRequestApprovalParams`) [B-schema]; `internal/server/codexserver.go` keeps only the request id. Codex
has `PermissionRequest` hooks without a call id [D]. Codex prompts stay screen-only in #106.

## 5. Telegram's limits

- **About one message a second in a private chat**; bursts may pass, then 429 [official FAQ]. 20 a minute in a group,
  ~30 a second across chats [official]. No per-bot figure, nothing about which methods count [official: silent].
- **Silent messages count**: `disable_notification` changes nothing documented [official: silent].
- A 429's `parameters.retry_after` is the seconds to wait before repeating the request [official]; no maximum is
  documented. Pausing the whole destination for it is our choice.
- Edits, `deleteMessage` and `answerCallbackQuery` have **no documented rate limit** [official: silent]; assume edits may
  count. `answerCallbackQuery` must be called for every tap [official]; it expires about **15 s** after the tap
  [C: Stack Overflow 58661909, python-telegram-bot #2254].
- A bot's own messages in a private chat can be edited after 48 h (the 48-hour rule is about business messages)
  [official]; `400 message is not modified` is a no-op [C].

## 6. What #106 takes from this

- The native identity of a Claude prompt is the **transcript's pending `tool_use`**: it covers every Claude worker the
  bridge reads (the incident's was not started by the bridge), has the `tool_use_id` the hook lacks, and is on disk
  0.1 s after the dialog opens; the bridge reads transcripts every 2 s, so the card may start from the screen and learn
  the call a read later. The `PermissionRequest` hook would add nothing for workers the bridge does not start and would
  need pairing to `PreToolUse` (every tool call logged) for its id.
- That 2 s lag is why the call must be **bound, not trusted**: the dialog is matched to a call word for word (a line
  break one of the command's spaces, or none where the wrap cut a word), the call's id (with its directory) goes into
  the hash every answer is checked against, the game's as a tap's, and a card's keyboard is renewed whenever that hash
  changes. A screen that draws two commands alike (a word cut by the wrap exactly where the other has a space) is
  told apart only by the call and the blocked spell; the screen alone cannot.
- Cards say "replaced" or "no longer waiting", never "answered in the game": nothing tells the bridge how it ended.
- In bypass mode the card says a removal is denied after about two minutes unanswered ([D] only).
- The send budget paces every provider call (about one a second, a burst of five) and counts silent cards. Since a
  429's `retry_after` has no documented maximum, a message counts from when it is sent, not when it was let in: a
  long pause must not let a second minute's worth in over the first.
- An AI pre-approval would be a deciding `PermissionRequest` hook (bridge-started workers only, a new trust) or the
  answer lane a tap takes; neither may approve a critical-path removal. #106 ships neither (`internal/approval` is
  unwired).
