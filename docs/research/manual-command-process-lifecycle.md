# Manual command sessions: authentication and process lifetime

Investigated 2026-10-26 against repository revision `f0b78531e0b2524ddc51f42fc4651c30f39f1442`. This note covers external command semantics and implementation constraints for an agent-requested command that a human runs on the bridge host; the [main investigation](manual-agent-commands.md) connects these findings to the product architecture. Sources are upstream documentation/source read on that date; upstream `main` links can change. No live sudo credentials, Tailscale configuration, or user sessions were used or changed for this research.

## Conclusion

The feature is viable: create a human-controlled command session on the remote machine, associate it with the requesting worker and workspace, and present it in a separately named terminal tab plus a visible process list. A real remote PTY can handle ordinary interactive sudo. A dedicated askpass helper is a stronger option for a predictable password dialog. Classification should propose commands for review; it should neither execute them automatically nor handle credentials.

The screenshot's exact command needs a different lifetime policy. `sudo tailscale serve --bg --https=8443 http://127.0.0.1:39525` writes persistent Serve configuration. Its launcher can exit while sharing continues, even across reboot. Closing a tab cannot undo that configuration. Prefer a visibly reviewed foreground variant for a temporary agent-owned preview, or register an explicit, narrowly scoped cleanup operation. [Tailscale Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)

## Authentication has an existing protocol

Sudo ordinarily reads a password from its terminal; the upstream troubleshooting guide identifies the screenshot's error as absence of a terminal in which to disable echo. Allocating a remote PTY addresses that specific failure. It does not make passwords a model input. [Sudo troubleshooting](https://github.com/sudo-project/sudo/blob/main/docs/TROUBLESHOOTING.md)

There are three candidate transports:

| Path | Fit for this feature | Constraint |
| --- | --- | --- |
| Ordinary sudo in a remote PTY | Best initial terminal-based flow; also supports other interactive commands. | The user can type into the terminal, but there is no universal structured “needs password” event. |
| `sudo -A` with a Herdr askpass helper | Best candidate for a dedicated masked dialog. Sudo calls the helper, which can request input from the authenticated browser through the bridge. | Requires helper lifecycle and secure local IPC, plus policy/PAM compatibility validation. |
| `sudo -S` with stdin | Technically possible. | Password and command stdin share a channel, which complicates ownership and interactive commands; not the default recommendation. |

Upstream documents `-A`/`SUDO_ASKPASS` as a helper path whose stdout supplies the password, and `-S` as reading the password from stdin with the prompt on stderr. Sudo's prompt is configurable, and credential caching may suppress authentication entirely. Consequently matching an English `[sudo] password` string cannot be a reliable authentication protocol. [Sudo manual source](https://github.com/sudo-project/sudo/blob/main/docs/sudo.man.in)

Sudo's implementation opens `/dev/tty`, changes terminal echo behavior, and restores it around input. For askpass it uses a private pipe from the helper's stdout. These are useful implementation patterns, but disabled terminal echo is a display behavior, not proof of a prompt's identity. A program can print a password-looking prompt; many TUIs also disable echo. [Sudo password input source](https://github.com/sudo-project/sudo/blob/main/src/tgetpass.c)

**Design inference:** the classification model should extract “the assistant asks the user to run this command” from the assistant message. It should not inspect password input or decide where a password goes. For a masked dialog, bind each request to the exact run, process generation, helper invocation and authenticated client. Expire it on command exit/cancellation; reject late responses instead of typing them into whichever shell subsequently occupies the pane. Verify wrong-password retry and cancellation explicitly. Unsupported authentication methods can fall back to the interactive tab.

### The existing text path is unsuitable for secrets

[Control.SendText](../../internal/herdr/term.go) delegates to `opSendText`, whose [argv template](../../internal/herdr/control.go) embeds text in `herdr ... pane send-text <pane> <input>`. A password sent that way appears transiently in process arguments. A new secret input path should use a pipe/private socket or the terminal controller's input stream, not this CLI argument path. Its input must bypass command audit payloads, browser persistence, transcripts, model requests, analytics and debug logging. A masked HTML field alone does not establish that contract.

No-echo output and no-input-logging are separate properties: sudoers' I/O logging documentation explicitly discusses passwords remaining in input recordings despite disabled echo, and `log_passwords` filtering. The feature must exclude secret payloads from Herdr-controlled recording paths and identify deployment-specific terminal recording as a validation requirement. It cannot guarantee that a privileged host administrator has no independent recording. [Sudoers logging documentation](https://github.com/sudo-project/sudo/blob/main/docs/sudoers.man.in)

The existing prompt-secret feature writes protected files for agent consumption; it should not be reused for sudo authentication. A sudo password is one-time interactive input, not a reference the agent should be given. This is a proposed product boundary, not an OS isolation guarantee against other processes running under the same account.

## The bridge cannot simply spawn sudo itself

[The deployed bridge unit](../../deploy/herdr-world.service) sets `NoNewPrivileges=yes`. Linux inherits this flag across fork/clone/exec and does not allow a child to clear it; executing a setuid binary cannot then raise its UID. A PTY does not change that. Thus direct bridge-child sudo is not a viable launch architecture under the committed service configuration. [Kernel no-new-privileges documentation](https://docs.kernel.org/userspace-api/no_new_privs.html)

Systemd explicitly distinguishes direct descendants from processes launched on a service's request through IPC, including `systemd-run`. Its `NoNewPrivileges` setting only restricts the former. Preserve the bridge restriction and execute through the independently running Herdr server, or evaluate a separately managed command service. Validate the actual launcher environment rather than assuming every Herdr installation has the same privileges. [systemd.exec](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#NoNewPrivileges=)

`systemd-run` service mode starts the command through the service manager; scope mode starts it as a child of `systemd-run` and inherits the caller's execution environment. Therefore adding `--scope` around a bridge-child command does not address the inherited restriction. A transient service can offer a PTY and a unique unit identity, but its environment, working directory, input ownership and sudo/PAM behavior need explicit testing. [systemd-run](https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html)

## A tab is a useful owner, not a universal cleanup guarantee

The existing Herdr server launch in [control.go](../../internal/herdr/control.go) uses `KillMode=process`. Stopping that unit is not evidence that every descendant is stopped. Systemd's documentation says `KillMode=control-group` stops remaining processes in the unit's cgroup, with a termination timeout and subsequent kill; `process` targets only the main process. A separately scoped unit per managed command is a candidate for stronger descendant cleanup. Do not change the shared Herdr server unit's policy as part of this spike. [systemd.kill](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html)

**Design inference:** ordinary foreground jobs, detached descendants, root-owned descendants, and changes made to an external daemon are four distinct lifetime cases. Test each independently. Process groups are a useful first stop target but can be escaped through daemonization/new sessions. A cgroup can cover processes remaining in it; it cannot undo configuration sent to a daemon outside it. Privileged commands and PAM/session changes need their own proof before claiming a cgroup covers them. Arbitrary command side effects cannot be generically reversed.

Recommended ownership data is a durable run ID, bridge/host, worker identity, workspace, tab/pane, reviewed command, cwd, start/end time, execution status and cleanup status. Mark the origin as “Run by you” and retain stopped/failed records. Track resource ownership separately when the launcher exits but its effect persists. Store stable process/unit identities and avoid cleanup based on a reused PID or a command-name match.

The Stop action, managed-tab close, Send home, and explicit workspace removal should converge on one idempotent cleanup path. A browser disconnect or standing up from the desk is different from closing the workspace. Bridge restart must reconcile tracked runs and cleanup failures, not lose them. If cleanup fails or needs fresh authentication, retain a visible actionable record; do not report success simply because the workspace disappeared.

## Tailscale is the first lifetime fixture

Tailscale documents foreground Serve as ending when Ctrl+C is pressed or the terminal session ends, while `--bg` deliberately persists beyond the session. For this user's temporary share, propose the following command visibly before execution:

```sh
sudo tailscale serve --https=8443 http://127.0.0.1:39525
```

Removing `--bg` changes the user's proposed command and must be visible in the run preview. No silent command rewriting is needed. [Tailscale Serve examples](https://tailscale.com/docs/reference/examples/serve)

Upstream source implements foreground mode through an IPN bus session and nested Serve configuration. The daemon deletes the foreground configuration by session ID and rejects a new foreground listener if the port is already occupied. This supports a session-owned design; it is not a substitute for testing abrupt termination against the installed Tailscale version. [Serve CLI implementation](https://github.com/tailscale/tailscale/blob/main/cmd/tailscale/cli/serve_v2.go), [daemon configuration lifecycle](https://github.com/tailscale/tailscale/blob/main/ipn/ipnlocal/serve.go)

If background mode is retained, use endpoint-scoped disable semantics, for example `sudo tailscale serve --bg --https=8443 off`, after verifying the endpoint still belongs to this run. Original flags are required by the documented disable interface; the target may be omitted. Never call `tailscale serve reset`, stop `tailscaled`, or overwrite the entire configuration to clean up one worker's preview. A concurrent user change to the same endpoint should become a cleanup conflict, not be deleted. Cleanup may require fresh sudo authentication after the timestamp expires. [Tailscale Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)

Configuring an operator is a separate optional administration choice: Tailscale documents `sudo tailscale set --operator=<USERNAME>` as allowing that user to manage the daemon without root. It does not solve ownership or cleanup, and this feature need not require it. [Tailscale Linux operator permissions](https://tailscale.com/docs/reference/troubleshooting/linux/linux-operator-permission)

## Spike exit criteria

The [isolated Herdr 0.9.1 probe](manual-command-spike/probe.py) already establishes the underlying tab/controller feasibility; its [recorded results](manual-command-spike/results.json) show a labelled sibling tab accepting synthetic no-echo input through controller stdin, absent from screen frames and observed process argv. Releasing the controller preserved the running fixture. Closing either the tab or workspace stopped the main process and ordinary child, **but a detached child survived both**. Tab close preserved the owner pane; workspace close ended it. The probe explicitly stopped all remaining test processes and deleted its isolated session. It did not exercise the browser/bridge path or actual sudo.

The first implementation should therefore support supervised foreground commands, with explicit unsupported/cleanup-required treatment of detached jobs and external side effects. A promise that “closing the workspace removes everything” is disproved for the current backend.

1. A real remote Herdr tab receives synthetic no-echo input through a pipe/socket path; inspect output, logs, audit payloads, transcripts and argv for a synthetic secret sentinel.
2. In a controlled environment, exercise actual sudo success, bad password/retry, cached authorization, cancel, unsupported auth and late input after process exit. Confirm the deployed `NoNewPrivileges` boundary is preserved.
3. Verify Stop, tab close, workspace close and Send home against foreground parent/child jobs, a detached descendant and a privileged child. Record where cleanup is guaranteed and where it fails; do not hide unsupported cases.
4. Run a temporary foreground Tailscale share on a reserved endpoint and verify it disappears on both graceful stop and forced launcher death while an unrelated endpoint remains intact. Use an isolated test environment or explicitly approved endpoint; the research did not run this against the user's live daemon.
5. Reconnect/restart the bridge and ensure run ownership and cleanup errors remain visible. Duplicate Run submissions start one process. A stale classification cannot run against a different worker/workspace generation.

These are implementation-spike acceptance criteria. This note establishes the upstream semantics and architecture constraints; it does not claim that an integrated password modal, universal cleanup, or real privileged/Tailscale execution has already been demonstrated.
