# Manual processes

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
