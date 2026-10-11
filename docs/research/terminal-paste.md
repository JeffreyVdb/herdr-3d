# Terminal paste without submission

Investigated 2026-10-11 at `8951f0ff6c1704dc3d448b7dbd5cb7cb73b0421a`. The user's clarified requirement is to paste text into the terminal, review or edit it, and press Enter themselves. This includes Claude's normal prompt and editable text in question or approval dialogs. No application changes were made.

Filed as [issue #243: Terminal: paste text without submitting, including question and approval inputs](https://github.com/JeffreyVdb/herdr-3d/issues/243).

## Findings

Command+V is already recognized on Mac in [keys.ts](../../game/src/laptop/keys.ts). [SeatBar](../../game/src/ui/seat.ts) reads `text/plain` and files from the paste event on its hidden textarea. The bug is what happens next: [InputQueue.paste](../../game/src/laptop/keys.ts) routes an agent's clipboard text to `worker.prompt`, which is a complete prompt submission. For Claude, [TypePrompt](../../internal/herdr/typed.go) types the text and presses Enter; for Codex, [SubmitPrompt](../../internal/herdr/term.go) uses Herdr's prompt submission. This explains the user's observation that the regular Claude prompt immediately sends pasted text.

The same submission route cannot insert text into an active question. [startPrompt](../../internal/server/input.go) rejects a worker with `Ask != nil`; blocked states can reject submissions too. The existing [TestAskFromTheTranscript](../../internal/server/ask_test.go) explicitly verifies that guard. The guard is appropriate for a new prompt; terminal clipboard insertion needs a different operation. Native approval dialogs were not independently reproduced, so the ticket calls for explicit coverage there.

Plain shells use `textItems`, which translates pasted newlines into Enter keys. Reusing that path unchanged would execute multiline clipboard content and fail the review-before-Enter requirement. Single-line input can use the existing literal key transport, but multiline insertion needs verified terminal/Herdr semantics that preserve lines without submitting or executing. Do not simply remove question guards from `worker.prompt`.

There is a separate focus weakness: a real browser paste aimed at a top-bar button while still seated never reaches the textarea listener. Keyboard mapping recognizes paste but the controller does not restore focus or route that event. This is verified additional coverage, not the explanation for the clarified immediate-submission report.

## Browser reproduction

[terminal-paste-probe.mjs](terminal-paste-probe.mjs) drives the actual game in its `demo-m4` simulator using an isolated agent-browser session. It copies a harmless marker using a real browser shortcut, then pastes using native Ctrl+V. It records `isTrusted: true`; it does not dispatch a synthetic `ClipboardEvent`. Run `make dev`, then:

```sh
node docs/research/terminal-paste-probe.mjs http://127.0.0.1:<leased-dev-port>
```

On Linux Chromium, the investigation returned exit 1:

| Scenario | Observed result |
| --- | --- |
| Claude terminal, hidden input focused | `REVIEW_BEFORE_ENTER` becomes `worker.prompt`; `insertsWithoutSubmitting: false`. |
| Same worker with a pending structured question | `worker.prompt` fails with `invalid_state`: the worker waits on its question. |
| Still seated, focus moved to the Menu button | Trusted paste targets `.btn--menu`; no terminal input command is sent. |

This is a browser/fixture reproduction plus real bridge guard validation, not a live Claude TUI or native Mac Command+V reproduction. The terminal recording in the simulator does not render an actual question editor. Verify the final fix in the Mac Chrome app window and real Claude/Codex dialogs.

Existing checks passed: 30 tests in `src/laptop/keys.test.ts` and `src/ui/seat.test.ts`, and `go test ./internal/server -run '^TestAskFromTheTranscript$' -count=1`. The existing tests encode prompt-on-paste behavior; [m5-screen.spec.ts](../../game/e2e/m5-screen.spec.ts) dispatches paste directly onto the textarea and does not verify native clipboard targeting.

## Documentation and renderer feasibility

Alterlab MCP found the [W3C Clipboard API working draft](https://www.w3.org/TR/clipboard-apis/). Its scrape failed, so the specification was read directly as a fallback. A paste event targets the editable selection or focused node/body and bubbles; a textarea-only listener misses other targets. A synthetic paste event supplies script-provided data rather than exercising OS clipboard access. Event-based clipboard capture can remain the primary path; changing terminal engines does not fix input routing.

[libghostty-terminal-feasibility.md](libghostty-terminal-feasibility.md) records the requested Alterlab investigation. libghostty-vt has browser WASM support but an unstable API and no drawing/windowing implementation. A parser adapter is feasible; performance benefits require separate benchmarks of parsing, canvas painting, texture upload and input-to-display latency. Clipboard insertion should ship independently.
