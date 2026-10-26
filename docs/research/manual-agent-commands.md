# Agent-requested manual commands: feasibility and spike

Investigated 2026-10-26 at `f0b78531e0b2524ddc51f42fc4651c30f39f1442`, with installed Herdr 0.9.1. Scope: source investigation and an isolated executable probe, not a shipped feature. The supplied screenshot shows `sudo tailscale serve --bg --https=8443 http://127.0.0.1:39525` failing because the agent's command runner has no terminal.

Follow-up: [GitHub #207 — Spike: run agent-requested commands with remote sudo input and workspace-owned cleanup](https://github.com/JeffreyVdb/herdr-3d/issues/207), created at the user's request. The issue includes the findings, implementation seams and acceptance criteria independently of these local files. The earlier Kaneo task is H3D-11.

## Conclusion

**Viable, with a bounded cleanup contract.** Offer an explicit Run action for a command requested by the agent, execute it on that worker's bridge host in a labelled sibling Herdr tab, and expose those runs in a Manual processes view. Herdr already supplies the PTY and a stdin-based input transport. Its existing terminal transport needs extending to target an owned command run independently of the agent's primary pane.

The password dialog should use an explicit, run-bound credential request (for supported sudo launches, an askpass helper), with an interactive terminal fallback for other programs. Merely recognizing the word “password” in output is insufficient. The classifier proposes commands; it never authorizes execution or handles credential bytes.

Closing a tab is useful cleanup for ordinary foreground work, but **does not remove every effect of a command**. Our probe found detached processes survive both tab and workspace closure. Tailscale `--bg` is an additional case: it leaves state in the existing daemon. Use foreground Serve for a temporary share, with the change clearly shown before Run; otherwise require a scoped cleanup adapter. See the [primary-source lifecycle investigation](manual-command-process-lifecycle.md).

## Executable evidence

Run from the repository root:

```sh
python3 docs/research/manual-command-spike/probe.py --out docs/research/manual-command-spike/results.json
```

The [probe](manual-command-spike/probe.py) uses a fresh named Herdr session, isolated XDG directories and a synthetic terminal program. It reuses the [earlier terminal spike's stream reader](terminal-experience-spike/herdr-probe.py). It never invokes sudo, changes Tailscale, uses a real password or attaches to a user session. Two runs produced the same [results](manual-command-spike/results.json):

| Question | Observation |
| --- | --- |
| Can a manual process have a separate, labelled, unfocused tab in the same workspace? | Yes, through `tab create --workspace … --label … --no-focus`. |
| Can hidden input reach its PTY without argv transport? | Yes, `terminal.input` JSON over the controller's stdin reached a fixture with terminal echo disabled. The synthetic value was absent from captured screen frames and the inspected process command lines. |
| Does detaching the controller stop the command? | No; all fixture processes remained alive. Closing the UI and stopping the run must be distinct actions. |
| Does closing the manual tab affect the owner pane? | The owner remained alive; the command fixture and its ordinary child stopped. |
| Does workspace closure stop ordinary processes? | The owner, command fixture and ordinary child stopped. |
| Does either close stop a detached, HUP-ignoring child? | No. It survived both operations. |
| Was the probe cleaned up? | Both sessions were stopped/deleted, servers reaped and all recorded processes stopped. |

This establishes local Herdr mechanics, not a complete browser/SSH/bridge path. Real sudo/PAM retries and cancellation, root-owned descendants, native Mac input, classifier quality, bridge restart and a real Tailscale endpoint still require the integrated spike. The fake input result is not a blanket claim about arbitrary programs: a program can echo or log what it receives.

## Existing integration seams

| Area | Existing behavior and required extension |
| --- | --- |
| Suggestion detection | [AI interfaces](../../internal/ai/ai.go) expose `ClassifyMany` and `LLM`. [Schedule suggestions](../../internal/server/schedsuggest.go) already share the settled final-message pipeline with follow-up questions, perform gated extraction and persist deduplication. Add a separate command-request gate to that pipeline. |
| Exact command extraction | Follow the exact-source validation pattern used by [packup](../../internal/packup/packup.go): return source spans or exact substrings and reject fabricated/altered commands. Preserve quoting, shell syntax and ordering. No executable suggestion when the command is incomplete or extraction fails. |
| Creation/control | [Control](../../internal/herdr/control.go) is an explicit command allowlist. It currently has workspace creation/close and agent launch operations, but no general manual-tab lifecycle. Add narrow typed methods; do not reuse an agent's input buffer to run a shell command. |
| Terminal transport | [Herdr controller](../../internal/herdr/termcontrol.go) already owns a duplex stdin/stdout process, but its exported interface exposes resize/scroll/live/release, not arbitrary input. Underlying Herdr supports input, as the probe demonstrates. Extend it for command-run input. |
| Routing | [Terminal watches](../../internal/server/term.go) resolve a worker to its primary pane; [world derivation](../../internal/world/derive.go) chooses one pane per workspace. Add run-scoped pane ownership and validation, rather than changing which pane represents the worker when a manual tab opens. |
| Existing browser terminal | [SeatTerm](../../game/src/laptop/seatTerm.ts) provides a real terminal widget. [Seat tabs](../../game/src/laptop/seatTabs.ts) are conversation/images navigation, not a Herdr tab browser. A process list and run-terminal selection are new UI; the widget can be reused. |
| Password boundary | [SendText](../../internal/herdr/control.go) passes text as a CLI argument. [Input audit](../../internal/server/input.go) redacts text bodies, but that does not remove argv exposure. Passwords need controller stdin or a private askpass channel, never `worker.prompt`, `pane send-text`, shell command arguments, environment variables, persisted drafts or model input. |
| Privilege boundary | [Bridge service](../../deploy/herdr-world.service) sets `NoNewPrivileges=yes`. A PTY spawned directly by the bridge cannot make sudo elevation work. Existing Herdr panes execute in their server's context. Verify that context; retain the bridge's restriction. A separate systemd service is another candidate, but scope mode inherits the caller's restriction. |
| Send home | [runFire](../../internal/server/hire.go) exits the agent and then closes/removes its workspace. Insert owned-run cleanup before workspace/worktree removal, retaining a visible outcome if cleanup fails. Also observe external workspace closure, floor sleep and missing workers. |

## Proposed vertical slice

1. **Track one user-started run.** Store a run ID, source turn/revision, bridge/session/worker identity, workspace and pane IDs, cwd, reviewed command, launch identity, timestamps, exit result and cleanup state. Show machine and cwd beside Run. Start in the worker's checkout with the configured shell policy. Keep an idempotency key across duplicate clicks and uncertain launch replies. Never rerun merely because the bridge reconnects.
2. **Show Manual processes.** A worker badge opens its list: command/title, host, status, start time, exit code and cleanup result. Offer Open terminal, Stop and Dismiss completed. Each launch has a visibly labelled Herdr tab. Retain running/cleanup-needed entries outside the worker if it disappears, so send-home cannot hide leftovers. Closing the view or switching bridges detaches; Stop ends the run. This tracks runs started through this feature, not every process on the host.
3. **Prove input without another login.** Initially use the separate terminal's input over a pipe. For a supported top-level sudo command, add a private askpass helper: it requests a masked dialog for a specific run and nonce, writes the response only to sudo's expected pipe, and expires/cancels the request when the process exits. Show host, target account and reviewed command. Wrong password, retry, cancel and stale replies must be exercised. Nested sudo, MFA and other prompts use the terminal until explicitly supported. Do not rewrite arbitrary shell programs to inject askpass.
4. **Tie supported processes to the owner.** Stop and verify completion before successful send-home/worktree deletion. Treat UI disconnect separately from owner lifetime. Reconcile after bridge restart, external tab/workspace close and floor sleep, preserving unknown or cleanup-needed state instead of assuming success. Use launch markers/process start identity, not reusable PIDs alone. Do not automatically restart manual runs on wake.
5. **Add the suggestion gate.** Classify whether the final assistant reply explicitly asks the user to run a command. Extract only commands present in that reply. Bind Run to the reviewed command and live owner revision. Include manual entry as a fallback when models are unavailable. Distinguish actual requests from documentation examples, already-executed commands, error quotations, hypothetical alternatives and remote-host instructions. A suggestion must not silently run on the bridge if the requested host is different or unknown.

The classifier's first release can consume completed replies, matching current infrastructure. Detecting a request halfway through an active tool call would be an additional event source and is not established by this investigation.

## Cleanup contract and Tailscale case

Separate process termination from external resource cleanup in both state and UI:

- **Foreground processes:** Herdr tab closure worked for the probe's ordinary process family. Test real privileged processes before promising the same for sudo. Consider a per-run cgroup/transient service when stronger descendant ownership is needed; a process group alone cannot contain `setsid`. That alternative must preserve the interactive PTY and be tested with systemd and sudo together.
- **Persistent services/configuration:** `tailscale serve --bg`, `systemctl start`, container starts and cloud resources are effects in another manager. Tab closure cannot roll them back. Neither a cgroup nor a remembered PID solves that.
- **Temporary Tailscale share:** offer the foreground form `sudo tailscale serve --https=8443 http://127.0.0.1:39525` as an explicitly reviewed alternative. Confirm endpoint ownership/conflicts and shutdown on the supported version. Never silently remove `--bg` from an extracted command.
- **Existing/background Serve:** an adapter can record the endpoint it created and remove only that endpoint, using the original flags and `off` (for the screenshot: `sudo tailscale serve --bg --https=8443 off`). Refuse collisions and preserve unrelated/pre-existing configuration. Concurrent edits must produce a visible conflict, not blind rollback. Do not call global `serve reset` or stop tailscaled. Cleanup that needs authentication must remain visibly pending; a cached sudo credential cannot be assumed to last until send-home.

The first spike should support a foreground server and the temporary Tailscale case, plus an adversarial detached-child fixture. Unsupported persistent effects must remain explicitly unmanaged/cleanup-needed; do not market arbitrary command execution as automatic rollback.

## Exit criteria

- An agent requests a command; the user reviews the exact command, host and cwd and launches exactly one separately tracked run.
- The browser handles a real remote sudo password/retry/cancel without a manual SSH login; injected marker bytes do not appear in model requests, transcripts, audit/error logs, argv, environment, persisted state or reconnect replay.
- The agent's terminal and prompt remain usable while a manual command waits for input. Multiple runs and switching between their output are distinguishable.
- Stop, send-home, external workspace close and bridge reconnect produce accurate process/cleanup states; normal foreground work stops, detached/external effects are either owned and cleaned or visibly unsupported. Verify root-owned child behavior and timeout paths.
- A temporary Serve endpoint goes away after owner cleanup while an unrelated pre-existing endpoint remains. No global reset, daemon stop or sudoers change is needed.
- Classifier fixtures cover request/non-request examples, exact multiline quoting, stale suggestions, missing cwd/host and duplicate messages. A classifier error starts no process.

## Validation

The isolated Herdr probe passed twice, with the detached-child survival recorded as a finding. Python syntax and local research links were checked.

Repository validation used `mise exec go@1.27.0 node@26.12.0 pnpm@11.7.0 -- make lint test`: Go vet (including integration-tagged code), formatting, TypeScript checks, all Go tests and 4,829 Vitest tests passed. The final shell-check step initially stopped because the shellcheck shim had no selected version. Rerunning that step with the installed tool, `mise exec shellcheck@0.11.0 -- make sh-test`, passed shellcheck and the deployment script's fake-environment tests. No browser test was needed for these research-only additions.

No product code or live configuration was changed. Existing untracked research files were preserved.
