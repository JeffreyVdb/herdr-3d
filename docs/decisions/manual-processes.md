# Manual process decisions

A manual process belongs to a worker's workspace and runs in a separate, unfocused tab. The user's command is stored as a file, not placed in Herdr's arguments. The fixed pane command invokes the bridge's `manual-launch` subcommand with only the private process directory; that subcommand reads the reviewed command, executes it with the configured bridge shell policy, and keeps the terminal foreground process group.

Process directories live under `$XDG_STATE_HOME/herdr-world/manual/`, not the runtime directory. The state survives bridge restarts, including the atomic status file. The status records the launcher's PID and Linux `/proc/<pid>/stat` start ticks, its process group, and its exit code. The bridge checks both identity fields before signaling; PID reuse never establishes ownership.

The Herdr server's privilege context is checked on the session socket: `SO_PEERCRED` identifies the server process, then `/proc/<pid>/status` supplies `NoNewPrivs`. An unreadable or restricted context refuses the launch. The bridge service's `NoNewPrivileges` setting is unchanged.

All stop triggers converge on the same cleanup operation. For a verified live identity it signals the foreground group with SIGINT, SIGTERM, and SIGKILL, waiting between signals; it closes the tab and searches readable process environments for the process marker. Detached survivors and visible surviving process-group members remain visible as cleanup needed, even when their environments cannot be read. A member that cannot be positively matched to the process marker is reported but is not killed by a retry. The bridge records their PID and start-tick pairs and confirmed tab closure in the process state directory, so a later retry can work while the floor is asleep. On a later explicit Stop it may signal only those recorded identities after verifying them again; newly discovered survivors are reported for another retry. It does not claim to reverse arbitrary external effects.

Send-home stops manual processes before asking the agent to exit and refuses to close anything when a process cannot be verified stopped. Persistent effects do not block send-home; their records remain reachable. Sleep stops processes before stopping the session. On wake the bridge closes restored `⚙ ` tabs in workspaces with manual records; it never starts them again. On bridge restart status and tab observations reconcile existing records without relaunch.

For a recognized background Tailscale Serve effect, the adapter checks read-only status before launch, reserves its endpoint against other tracked manual processes, and records a scoped cleanup command. An explicit Stop runs that command as a new manual process, using the password-dialog path when available. If the owner has gone, a temporary `manual cleanup` workspace on the same session hosts it. The effect remains cleanup needed until that command exits zero. No global Serve reset, daemon stop, or sudoers change is performed.
## Credentials

For a supported top-level simple sudo invocation, the bridge inserts `-A` and shows the launched form alongside the
reviewed command. Shell composition and substitutions are outside the dialog path. A 0700 per-process helper executes
`herdr-world manual-askpass` with the process directory; a random per-process nonce is stored there with mode 0600. The
helper connects to `$XDG_RUNTIME_DIR/herdr-world/askpass.sock` (0600). The broker checks `SO_PEERCRED`, the nonce,
and the current process state before opening an unpredictable request id.

At most one request is open per process. A new invocation replaces the old one and increments the attempt. Answers,
cancellation, helper disconnect, process exit, and a 120-second timeout expire the request; late or replayed answers
are stale. The bridge passes secret bytes only to the waiting helper and clears its byte slice after writing. Audit
records keep the byte count, not the secret. Nested sudo, MFA, and non-sudo prompts use the interactive terminal.

## Run terminal

A run terminal is a watch of `mp:<process id>` on the manual tab's pane, independent of the worker pane. The same
connection can control both, subject to the normal watch and observer limits. Input uses the terminal controller's
JSON stdin, never a command-line `send-text`; messages contain either UTF-8 text or base64 bytes and are capped at
16 KiB decoded. Controller input is ordered and is not superseded by scroll or resize; queue pressure returns an
error. Closing the view releases the controller and leaves the process running. The target application controls
whether its terminal echoes input.
