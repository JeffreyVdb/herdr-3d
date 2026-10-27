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
## Command requests

A settled final agent reply may ask the user to run a shell command. The classifier gates an extraction that returns exact spans of the reply; the bridge validates those spans before showing a card. A card is a proposal for review, and never executes a command by itself. The host must be the bridge for a suggested command to run. A named absolute working directory is used; otherwise the worker's working directory is used. A reply is identified by worker and text hash, persisted across restarts, and closes when the transcript moves on, it is dismissed, or a run consumes it. `HERDR_WORLD_COMMAND_REQUESTS_ENABLED` can switch the feature off.

## Tailscale Serve

A supported simple `tailscale serve --bg` command offers an explicit foreground variant for review; it never silently changes the command. The adapter identifies the endpoint and prepares scoped cleanup by replacing its target with `off`, preserving the original flags. Conflict detection reads ServeConfig TCP, Web and foreground session entries. Background Serve persists beyond its launcher and needs explicit cleanup; global reset and stopping the daemon are outside this adapter. Other command effects are not automatically reversible.

## 2026-10-27 — #213: input attention, askpass eligibility and the command request gate

### Attention

A run that asks for the user carries `attention {id, kind, confidence, reason, since, expires_at?}` on its
`manual_process.upsert`, and `input_detection` says what the bridge can observe of it (`full`, `hints`, `none`).
Attention is live state: the store has no field for it, a run waiting only on input is stored as `running`, and a
bridge restart starts from no observation. Each run has its own episode; the snapshot carries it, so a reconnecting
client sees the same id.

- **Credential** (`credential` / `authenticated` / `askpass`) exists exactly while the run-bound askpass request does:
  its id is the request id, `since` is when the broker opened it, `expires_at` its expiry. It wins over input
  attention, which comes back when the request ends. The `credential` field stays the only way to submit a secret.
- **Input** comes only from observing the run tty's foreground group (`internal/manual/inputwatch`), never from
  terminal text, a quiet period or the echo mode, and is never called a password request. `confirmed` / `tty_read`: a
  foreground task is blocked in `read(2)` or `readv(2)` on the run's own tty, its pts (descriptor `rdev` equal to the
  launcher's `tty_nr`) or `/dev/tty` (5,0) while the run's tty is that task's controlling tty; this needs
  `/proc/<pid>/task/<tid>/syscall`. `uncertain` / `tty_wait`: the syscall file is unreadable and the task sleeps in the
  tty line discipline's wait (`wchan` `wait_woken` or `n_tty_read`) with a descriptor on the run's tty. `uncertain` /
  `sudo_terminal`: a childless sleeping foreground `sudo` (its terminal prompt; `sudo -A` has the askpass helper as a
  child, and a sudo running its command has that command).
- The group is found from the launcher: PID and start ticks verified, then `tty_nr`, `tpgid` and session from its
  `/proc/<pid>/stat`. The session is walked from its leader through the `children` files (every task of every
  member, not only the launcher); when the leader's children cannot be listed the whole process table is scanned.
- An episode opens after two consecutive positive samples and closes after two negatives. Input sent to the run's
  terminal (`terminal.input`) closes it at once; only two new positives open another, with a new id. Stop, exit,
  failure, tab loss (all through `stopping` or a terminal state) and `unknown` clear it. `state` is `waiting` while a
  credential or a `confirmed` episode is open and `running` otherwise; `uncertain` never changes the state.
- Full-screen programs never raise attention: a wait is dropped when the run's tty is out of canonical mode (raw mode:
  editors, pagers, TUIs) or the foreground program is a known pager, editor, monitor or terminal client (`less`,
  `vim`, `nano`, `top`, `tmux`, `ssh`, …). The mode is read with `TCGETS` on the launcher's own pts descriptor, opened
  `O_RDONLY|O_NOCTTY|O_NONBLOCK` and never read from (a `/dev/tty` descriptor would open the bridge's terminal). Line
  prompts (`read -p`, `input()`, `getpass`, `[Y/n]`) are canonical.
- Each running or waiting run is sampled every 500 ms, off the hub goroutine, one sample at a time, by a ticker that
  exists only while such a run does. Measured on this host (`BenchmarkObserveSystem`, i7-10750H, 529 processes): 0.33
  ms and 63 KB for one sample of three runs, about 0.1 ms per run, so about 0.02 % of a core per run; the full-table
  fallback costs about 7.4 ms a sample.

Detection limits. On this host Yama `ptrace_scope=1` denies `/proc/<pid>/syscall` of herdr's processes (the bridge
is not their ancestor), so real runs report `hints` and their input attention is at most `uncertain`; `confirmed` is
covered by tests with a fake proc reader and a parent-owned pty. A `tty_wait` hint can be wrong: `wait_woken` also
serves socket waits, so a process with a tty descriptor waiting on the network looks the same. Not detected: prompts
answered within about a second, reads through `poll`/`select`/`epoll` or `splice`, background jobs, programs that leave
the session leader's tree, nested terminals (`tmux`, `screen`, `script`, a remote shell over `ssh`), GUI prompts, and
questions asked in raw mode. Nothing here works off Linux (`input_detection: none`). In every unsupported case the
run's terminal is the fallback: its process row opens it, and its input is the answer.

In the game an episode is a chip in the top bar (every run, from any floor, laptop open or closed; several runs are one
count that opens the list of all manual processes) and, while seated, a line under the seat's header (this worker's
run first, its process control marked, then the other workers'). The words follow kind and certainty: "Password
requested" (Respond: the run's request-bound dialog, from anywhere), "Waiting for input" and "May be waiting for input"
(Open terminal: that run's terminal); an unknown reason code is shown as its kind alone. A new episode id is announced
once per browser tab: a desktop notification while the game is in the background (the inbox's permission and
setting), else a toast with the action; a reconnect's snapshot, or a reload of the tab (the announced ids are in its
`sessionStorage`, bounded), announces nothing again. An episode that ends takes its toast and notification with it, and
a dropped connection takes them all with the chips. The texts name the worker, the host and the
first line of the user's own reviewed command, never terminal output or the credential prompt. With `hints` or `none`
the run's row and its terminal view say that other prompts may not be detected and the terminal is the way to answer.

### Askpass eligibility

The manual form's command ends in a newline, so the user's `sudo -k python3 tools/hello_world_server.py 80` launches
were never rewritten and fell back to sudo's terminal prompt. Trailing spaces, tabs and newlines are now ignored for
eligibility and kept in the launched form, which differs from the reviewed command only by the inserted ` -A`.
`internal/manual/askpass/testdata/eligibility.json` is generated from `Rewrite` (`go test ./internal/manual/askpass
-run TestEligibilityVectors -update-eligibility`); the game's eligibility must agree with every case.

### Command request gate

The missed suggestion was Pinecone's settled reply asking to launch `sudo -k python3 tools/hello_world_server.py 80`
from a `sh` fence; the classifier scored it 0.52 against the 0.7 threshold, so extraction never ran. A deterministic
shell-candidate rule (`cmdrequest.Candidate`) now admits a lower band to extraction: a fenced block tagged as shell
or untagged, or a `$ ` command line, whose preceding paragraph asks to run, launch, execute, paste, type or start
something and is not a report of the agent's own run, an example, an alternative or output. A candidate reply
scoring at least 0.35 (`cmdrequest.Band`) reaches extraction; the extraction prompt's exclusions and the exact-span,
host and source validation are unchanged, so the rule never makes a command by itself. Inline commands in prose
(`run \`make test\``) are not candidates: they are too common in replies that ask for nothing.

The numbers. Over the final replies in this machine's Claude and Codex transcripts from 13 to 27 October (2,391
replies in 1,391 transcripts, counted with the bridge's own turn tracker, no model calls) the rule matches 42 (1.8 %),
about 36 of them genuine requests to run something by inspection. That is the upper bound of extra extraction calls,
about 3 a day; replies already over 0.7 went to extraction before. A bounded replay with the configured models (18
calls) on 15 labelled candidate replies from these projects: the genuine requests below 0.7 scored 0.54 (the missed
reply, 0.52 originally), 0.59 and 0.68, the non-requests 0.05, 0.09 and 0.09. Extraction was reached by 9 of the 15
before and by 12 after; extraction still returned nothing for the 0.59 reply (a proposal), and returned the missed
reply's command. 0.35 sits well under the lowest genuine request seen and well over every non-request.

Each settled turn gets one `command request turn` log line: worker, turn id, hash prefix, then either the skip
reason or the attempt, score, threshold and band, gate (`threshold`, `candidate`, `below`) and rule, extraction
(`skipped`, `ok`, `error` with its stage and kind), command count, rejection reasons with counts, and whether the
result was persisted, published or stale; a close logs `command request closed` with its outcome. No reply text,
command or working directory is logged. A transient classifier or extraction failure (timeout, unreachable, rate
limit, provider failure, a bad, truncated, empty or malformed answer) is retried twice, after 30 s and 60 s, for the
command request alone; a reply still failing is recorded as `failed`, so a restart does not ask again. An
authentication failure or a role that is not ready is not recorded, and a restart looks again.
