# Server model follow-up: SSH-tunnel auth, Mac shell, Ghostty, attach targeting

Researcher: GROUND|server · Date: 2026-09-28 · Follows [server-model.md](server-model.md) (unchanged), answers
[decisions.md](../decisions.md) items 1, 2 and the HIGH finding in [server-model.verify.md](server-model.verify.md).
Versions: herdr 0.9.0 (both hosts), Mac OpenSSH_10.3p1 / LibreSSL 3.3.6, server tailscale 1.98.10, Ghostty 1.3.1 (build 15212),
Chrome 153.0.8010.53, Safari 26.6.2, server Go 1.27.0.

## TL;DR

1. **The Mac uses the OpenSSH client, and the server side is Tailscale SSH** (`tailscaled be-child ssh … --remote-user=dev@example.com`).
   Verified on this path: **TCP `-L`, unix-to-unix `-L`, and TCP-to-unix `-L` forwarding all work**. The tunnel adds **~0 ms**:
   the echo RTT median was 22.4–23.6 ms against a 23.2 ms ICMP average. A fresh SSH connect takes ~340 ms. An exec over an
   existing ControlMaster takes ~190 ms (dominated by the fish login shell). New design: the bridge listens on
   **`/run/user/1000/herdr-world/bridge.sock` (dir 0700, socket 0600)**, and clients forward to it. Nothing is exposed on the
   tailnet. This also removes the verifier's `After=tailscaled.service` problem.
2. **ControlMaster reuse:** `ssh -O forward` onto a running master works (tested on my own master). Herdr's per-attach masters
   (`$TMPDIR/herdr-ssh-<pid>-0/ctl`, `ControlPersist=yes`) *could* carry the forward, but they are private, pid-named,
   and live only as long as some `herdr --remote` attach. **Don't piggyback.** The Mac helper should own one long-lived
   `ssh -N` with its own ControlPath and supervise it.
3. **Game shell recommendation: a small Go helper on the Mac (launchd user agent) plus a Chrome `--app` window.** The helper keeps the
   tunnel up, serves the game at `http://127.0.0.1:7777` (localhost is a secure context, so WebGPU works), reverse-proxies
   `/ws` and `/api` to the bridge socket, and exposes `/local/open-terminal`, which drives Ghostty. It is Go like the bridge, so they
   share protocol types. It is **cross-compiled on the server** (`GOOS=darwin GOARCH=arm64`), so no Xcode is needed. It
   keeps the engine plan's Chrome + Playwright test loop unchanged. Tauri 2 is the "polish later" option.
4. **Ghostty 1.3.1: use AppleScript** (`new window with configuration {command: …}`). The scripting dictionary ships in the
   app (`Ghostty.sdef`; `macos-applescript` defaults to true) and compiled cleanly with `osacompile`. `ghostty +new-window` prints
   "+new-window is not supported on this platform". `open -na Ghostty.app --args -e …` works but starts a **second Ghostty
   process** (`open -n`).
5. **Verifier HIGH finding:** there is **no flag, config key or env var** for landing a fresh `herdr --remote` attach on a given
   workspace or pane in 0.9.0. However, **a fresh attach lands on the server's focused workspace**. I verified this 5/5 times (3 local, 2 via
   `herdr --remote` from the Mac), and an attached client **did not follow** a later API focus (verified). Least-bad
   approach: bridge calls `agent.focus <pane>` (or `workspace.focus`) → immediately launches a **new** Ghostty window with
   `herdr --remote … --session <s>`. Side effects (verified): it marks `done` as seen, and it changes where the next fresh attach lands.
   For exact-pane viewing there is also **direct attach**: `ssh -t dev@devbox herdr --session <s> terminal attach <term_id>`
   showed the target pane's content after 0.64 s.

## 1. Auth = SSH access: tunnel path verified

### Which SSH is it?

The Mac side is OpenSSH (`ssh -V` → OpenSSH_10.3p1, LibreSSL 3.3.6). Two properties matter to the bridge:

- A typical `~/.ssh/config` enables `ControlMaster auto` / `ControlPersist` for all hosts, so `ssh -G <host>` reports a
  `controlpath` under `~/.ssh/sockets/` and a `serveraliveinterval`. The bridge must not assume a host block exists.
- The server's MagicDNS name resolves to its tailnet address (`devbox.example.net`, 203.0.113.10).

The server side is Tailscale SSH. While the Mac ran `ssh -o ControlPath=none dev@devbox 'sleep 12; …'`, the server showed
a `tailscaled be-child ssh` process wrapping the command (login identity shown as the placeholder `dev@example.com`):

```
355238 13476 /usr/sbin/tailscaled be-child ssh --login-shell=/bin/fish --uid=1000 ... --remote-user=dev@example.com
       --remote-ip=203.0.113.20 --has-tty=false ... --cmd=sleep 12; echo h3d-probe-done
355248 355238 /bin/fish -c sleep 12; echo h3d-probe-done
```

With Tailscale SSH enabled (`RunSSH: true`), traffic to the tailnet IP is intercepted by tailscaled even if a regular
`sshd` is also listening. **"Anyone with SSH access" therefore means:** (a) whoever the tailnet policy's `ssh` rules map to
the local user, plus (b) on a host that also runs `sshd`, whoever has an authorized key for that user and can reach it on a
non-tailnet interface. The bridge socket is `0600 dev`, so
only sessions that land as `dev` can use it. Any root user can too, which is unavoidable.

### Forwarding tests (Mac → server; own ControlMaster, existing masters untouched)

Throwaway echo server on the server: TCP `127.0.0.1:47777` + unix `/tmp/h3d-probe-server/echo.sock` (0600, dir 0700).
It was removed afterwards.

```
ssh -F /dev/null -o ControlMaster=yes -o ControlPath=$D/ctl -o ControlPersist=60 -fN dev@devbox   → master-up
ssh -S $D/ctl -O forward -L 17777:127.0.0.1:47777 …                          → tcpfwd-ok
ssh -S $D/ctl -O forward -L $D/echo.sock:/tmp/h3d-probe-server/echo.sock …    → unixfwd-ok
ssh -S $D/ctl -O forward -L 17778:/tmp/h3d-probe-server/echo.sock …           → tcp2unix-ok
```

| path (64-byte echo × 50, then a 256 KB echo) | median | p90 | min | 256 KB |
|---|---|---|---|---|
| `-L` TCP → TCP | 23.6 ms | 28.2 ms | 19.1 ms | 132 ms |
| `-L` unix → unix | 22.6 ms | 27.5 ms | 19.5 ms | 70 ms |
| `-L` TCP → unix | 22.4 ms | 28.0 ms | 19.7 ms | 73 ms |
| ICMP `ping -c 20 203.0.113.10` | 23.2 ms avg (18.7–27.3) | | | |

**The tunnel overhead is within noise.** Setup costs:

| action | time |
|---|---|
| fresh `ssh … true` | 330–343 ms |
| fresh `ssh -L … true` | 340 ms |
| `ssh -S <master> … true` | 180–217 ms |

Exec timings include spawning the fish login shell on the server. A `-N` tunnel runs no remote command.
Reconnect after a network drop is therefore well under 1 s once the network is back.

### ControlMaster reuse

- Mechanism works: `ssh -S <ctl> -O forward -L …` adds forwards to a live master (above). `-O cancel` removes them.
- Herdr's own masters: `ssh -F $TMPDIR/herdr-ssh-<pid>-0/config -S $TMPDIR/herdr-ssh-<pid>-0/ctl -o ControlMaster=auto
  -o ControlPersist=yes`. Four were live (`ssh -O check` → `Master running`), and ~15 stale dirs had dead sockets. The generated
  config file is not left on disk. These masters are an implementation detail tied to one attach (docs: "a private per-attach control
  socket"), so **I did not attach forwards to them**. Adding a forward to one is technically possible, but it would break when that attach
  ends and it is not a supported interface.
- A typical global `ControlPath ~/.ssh/sockets/%r@%h:%p` + `ControlPersist 10m` means any plain `ssh devbox` could
  become or reuse a master. That is fine, but the helper should use an explicit ControlPath of its own (or `ControlPath=none` for
  the tunnel process) so its lifetime is independent. Recommended tunnel command:

  ```
  ssh -N -o ControlMaster=no -o ControlPath=none -o ExitOnForwardFailure=yes \
      -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o StreamLocalBindUnlink=yes \
      -L "$HOME/Library/Caches/herdr-3d/bridge.sock:/run/user/1000/herdr-world/bridge.sock" \
      dev@devbox
  ```

  The helper supervises it and restarts it with backoff. `StreamLocalBindUnlink` removes a stale local socket on restart. The system `ssh`
  is used, not a Go SSH library, so the operator's ssh config, key agent, known_hosts and Tailscale SSH all behave as they do today.

### Bridge side changes vs server-model.md

- Listen on `unix:/run/user/1000/herdr-world/bridge.sock`, speaking HTTP + WebSocket. Go's `net.Listen("unix", …)` works with
  `net/http` and a WebSocket lib unchanged. Create the dir with 0700 and the socket with 0600, and `chmod` after bind. `/run/user/1000` exists
  and `Linger=yes` for dev (`loginctl show-user dev`), so a `systemd --user` unit survives logout and has no Tailscale dependency.
  That resolves the verifier's `After=tailscaled.service` finding.
- Drop the WhoIs / tailnet-IP bind / Serve design. Auth is filesystem permission on the socket; identity is "unix user dev".
  Keep the audit log. It can record the client-announced device name from `hello` (informational only, not trusted).
- Optional for server-side agents and tools: nothing changes. They can already use the herdr sockets directly.

## 2. Game shell: Tauri 2 vs Mac helper + browser vs Go helper

The engine decision is three.js in a browser (docs/research/engine.md), with performance to be proven. A browser tab
can't spawn `ssh` or launch Ghostty, so something native is needed on the Mac.

| | **A. Tauri 2 app** | **B. Tiny helper (script/launchd) + browser** | **C. Go helper (launchd) + Chrome `--app` window** ✅ |
|---|---|---|---|
| Renderer | system WKWebView (WebKit). WebGPU seen in a raw WKWebView probe on this Mac, **not yet in a real Tauri app** (verifier: UNVERIFIABLE) | Chrome or Safari | Chrome (Dawn → Metal; engine probe got `apple / metal-3`), Safari also possible |
| Tunnel | Rust spawns system `ssh` (std::process or `tauri-plugin-shell`, which needs capability allow-list) | `ssh -N` under launchd `KeepAlive` | Go supervises `ssh -N` |
| Ghostty launch | Rust runs `osascript` (needs `NSAppleEventsUsageDescription` + Automation TCC prompt) | needs *something* listening for the page's request, so it isn't really "tiny" anymore (a URL scheme needs an .app) | helper `/local/open-terminal` → `osascript` (Automation TCC prompt on first use) |
| Loading the game | bundled assets, or remote URL through the tunnel. For IPC from a non-bundled origin, Tauri needs a `remote.urls` capability (docs: only fully trusted domains) | page from forwarded port | helper serves `127.0.0.1:7777`: static build or proxy to Vite dev server, plus `/ws` → bridge socket |
| Build | Rust + Tauri CLI on the **Mac** (Xcode license not accepted yet; CLT present; rustc 1.98.1 present). Agents on the server can't produce a signed .app without the Mac | none | `GOOS=darwin GOARCH=arm64 go build` **on the server**, then `scp`. No Xcode. Same repo/module as the bridge |
| Test loop | WKWebView can't be driven by Playwright. Debug via Safari Web Inspector | Playwright/Chrome as in the engine plan | same as B: headless Chrome or Playwright hits `127.0.0.1:7777` on the Mac |
| Feels like an app | yes (Dock icon, own window) | tab | near-app: `open -na "Google Chrome" --args --app=http://127.0.0.1:7777 --user-data-dir=…` gives a chromeless window with its own Dock entry. The helper can be wrapped in a hand-made `.app` bundle later (Info.plist + binary, no Xcode) for a Dock icon or URL scheme |
| Effort | highest | lowest, but it runs out of road at Ghostty launch | low–medium (~300–500 LOC Go) |

**Recommend C.** Reasons:
- It is the only option that keeps the engine researcher's Chrome/Playwright verification loop unchanged.
- It can be built and updated entirely by agents on the server.
- It reuses Go and protocol types from the bridge, and keeps all privileged local actions in one small, auditable process.
- If a native app is wanted later, wrap the same page in Tauri 2. The helper's tunnel and Ghostty logic stays, and Tauri just
  loads `http://127.0.0.1:7777`. First verify WebGPU inside an actual Tauri window, as the verifier asked.

### Helper design sketch

- **launchd user agent** `~/Library/LaunchAgents/dev.herdr3d.helper.plist` with `KeepAlive`, running
  `~/h3d-tools/herdr3d-helper`. Config: SSH target (`dev@devbox`), remote socket path, local port.
- **Supervises** the `ssh -N -L <local unix sock>:<remote bridge.sock>` process shown above. It reports the tunnel state to the page
  (`/local/status`) so the game can show "city offline / reconnecting" (the power cut in the town).
- **Serves `127.0.0.1:7777` only.** Routes:
  - `/ws` and `/api/*` → reverse proxy to the local forwarded unix socket
  - `/local/*` → helper actions
  - everything else → game assets. Prod: served by the bridge through the same tunnel. Dev: a second forward to Vite on the server.
- **Browser-facing security.** A localhost port is reachable by *any* web page Chrome loads, and WebSockets are not
  CORS-protected. The helper must:
  - reject requests whose `Host` isn't `127.0.0.1:7777`/`localhost:7777` (DNS rebinding)
  - reject WebSocket upgrades and `/local` POSTs whose `Origin` isn't exactly the helper origin
  - require a per-launch random token. The helper opens the window with `#t=<token>`; the page sends it as a header or first WS message.

  Behind the helper sits a bridge that can start bypass-permission agents, so all three checks matter. Other local processes on the Mac run as
  the same user and are trusted.
- **Open terminal:** `POST /local/open-terminal {session, workspace_id?, pane_id?}`. Steps:
  1. The helper asks the bridge to `prepare_open` (focus, see §4).
  2. The helper runs the Ghostty AppleScript (§3).
  3. Validate `session` against `^[A-Za-z0-9._-]{1,64}$` before building the command string. Ghostty runs `command` through a shell.

## 3. Ghostty "open in real terminal"

Mac inventory (read-only):

```
/Applications/Ghostty.app  CFBundleShortVersionString 1.3.1  CFBundleVersion 15212  (channel stable, Zig 0.15.2)
Info.plist: OSAScriptingDefinition = Ghostty.sdef; NSAppleEventsUsageDescription present
Resources: Ghostty.sdef, Metadata.appintents (NewTerminalIntent[location, command, workingDirectory, env, parent], ...)
~/.config/ghostty: only themes/ (no macos-applescript override → default true)
```

| method | result |
|---|---|
| `ghostty +new-window` | `+new-window is not supported on this platform.` (tested) |
| `ghostty -e cmd` from CLI | help text: "On macOS, launching the terminal emulator from the CLI is not supported … Use `open -na Ghostty.app`" |
| `open -na Ghostty.app --args -e <cmd>` | works per Ghostty help, but `-n` = "open a new instance even if one is already running". That gives a **second Ghostty process** with its own Dock icon and no shared tabs. Acceptable fallback only |
| **AppleScript** `new window with configuration` | ✅ Ghostty.sdef: `surface configuration` has `command` ("Command to execute instead of the configured shell"), `initial working directory`, `initial input`, `wait after command`, `environment variables`. Commands: `new window`, `new tab [in window]`, `split`, `focus`, `activate window`, `input text`, `send key` … ([docs](https://ghostty.org/docs/features/applescript)) |
| Shortcuts / App Intents (`NewTerminalIntent`) | present, gated by `macos-shortcuts` (ask/allow/deny, since 1.2.0). Usable from `shortcuts run` only after the user builds a Shortcut, which is more setup than AppleScript |

Script used by the helper (compiled OK with `osacompile`. **Not executed**, so no window was opened in a real session):

```applescript
on run argv
  set sess to item 1 of argv
  tell application "Ghostty"
    set cfg to new surface configuration
    set command of cfg to "/opt/homebrew/bin/herdr --remote dev@devbox --session " & quoted form of sess
    set wait after command of cfg to false
    set win to new window with configuration cfg
    activate
  end tell
end run
```

The helper invokes it as `osascript open.scpt <session>`.
- First use triggers the macOS Automation (TCC) prompt: "herdr3d-helper wants to control Ghostty". Which process TCC attributes the request to
  (launchd-spawned binary vs `osascript`) needs a one-time check on the Mac.
- `new tab in front window` is an alternative if tabs are preferred.
- Use the absolute path `/opt/homebrew/bin/herdr`, since a Ghostty `command` may not get the fish PATH.

## 4. Verifier HIGH finding: landing a fresh attach on a specific workspace or pane

### Is there a direct mechanism? No (0.9.0)

- `herdr --help`: only `--session`, `--remote`, `--remote-keybindings`, `--handoff`. There is no workspace, tab or pane option for the TUI attach.
- Binary strings: the long options are `--remote --handoff --takeov[er] --worksp[ace] --plugin …`. `--workspace` belongs to
  subcommands (`tab create`, `worktree`, `plugin pane open`). `parse_attach_target` serves `agent attach` / `terminal attach` only.
  Env vars in the binary and docs (`HERDR_SESSION`, `HERDR_SOCKET_PATH`, `HERDR_CLIENT_SOCKET_PATH`, `HERDR_WORKSPACE_ID`, …) are
  pane-context and plugin variables, not attach targets.
- Docs (0.9.1): "Multiple Herdr clients can also view different tabs on the same server independently". Session restore
  brings back "workspaces, tabs, panes, cwd, layout, and focus". There is no documented initial-view flag.

### What a fresh client does (verified in throwaway session `h3d-probe-server`, since stopped and deleted)

Setup: 3 workspaces. Each root pane printed a unique marker (`ZZ_ALPHA_ZZ` / `ZZ_BRAVO_ZZ` / `ZZ_CHARLIE_ZZ`). The client ran in a
160×40 pty, and I checked which marker appeared in the rendered output.

| step | result |
|---|---|
| `workspace.focus w2` → fresh local client | shows **BRAVO** |
| (same client still attached) `workspace.focus w3`, then `w1` | client output 532 / 524 bytes, **no new markers**. The attached client stays put ✔ (confirms verifier) |
| `workspace.focus w3` → fresh local client | **CHARLIE** |
| `workspace.focus w1` → fresh local client | **ALPHA** |
| `workspace.focus w3` → fresh **`herdr --remote dev@devbox --session h3d-probe-server` from the Mac** | **CHARLIE**, first content after 1.43 s |
| `workspace.focus w2` → fresh remote attach from Mac | **BRAVO**, 1.39 s |
| `ssh -t dev@devbox herdr --session … terminal attach <term_id of w3:p1>` from Mac | **CHARLIE** (exact pane), 0.64 s |

Seen-state side effect, faked with `pane report-agent --state working → idle` on an unfocused pane:

```
before:                    focused w3  [('w2','done'), ...]
after workspace.focus w2:  focused w2  [('w2','idle'), ...]   ← done marked seen
after agent.focus w3:p1:   focused w3  [('w3','idle')]        ← same for agent.focus (documented)
```

A workspace that is already focused never shows `done`: a finish there counts as seen right away.

### Least-bad approach (recommended)

1. The game's "open in terminal" on a worker → helper → bridge `prepare_open {session, pane_id}`.
2. The bridge calls **`agent.focus <pane>`** if the worker has an agent pane. This picks the workspace, its tab and the pane.
   Otherwise it calls `workspace.focus <ws>`.
3. The helper **immediately** opens a **new** Ghostty window with `herdr --remote … --session <s>`. The new client adopts the server
   focus at handshake (~1.4 s).

Accepted side effects, to document in UI and code:
- `done` → seen for that worker. This is semantically right, since the user is about to look at it. The game should update its
  "finished!" bubble.
- The server's focus changes, so the *next* plain `herdr --remote` lands there. Existing attached windows don't move.
- Small race: if another client changes server focus in the ~1 s before the handshake, the new window lands elsewhere. Rare with
  one human. No fix exists short of a herdr feature.
- Every click opens a new window. Reusing an existing Ghostty window attached to that session wouldn't navigate it, because the client
  keeps its own view. So "reuse" only makes sense as "bring that window to front" via AppleScript `activate window`, with the
  caveat that it may show a different workspace.

Complementary **"look over the worker's shoulder"** mode: `ssh -t dev@devbox herdr --session <s> terminal attach <term_id>`
in Ghostty. It shows exactly one pane full-screen without the herdr UI. Open question: does it resize or steal input from an attached TUI when used
without `--takeover` while a TUI is attached? I tested it only with no other client. The in-game observer
(`terminal session observe`, server-model.md) remains the non-intrusive viewer.

Upstream ask worth filing: `herdr --remote … --session S --workspace <id>|--pane <id>` (initial client view), or a
client-targeted `client.navigate` API.

### Side finding: starting stopped sessions (verifier item)

A probe server launched as plain `herdr --session S server` under `nohup` made the remote attach refuse:
"the remote server was started by a herdr build that may not survive SSH connection loss. restart it … [y/N]". Answering
`y` restarted it (pane processes lost). The restarted server was a proper daemon:
- PPID 1, cmdline `/home/dev/.local/bin/herdr server`, env `HERDR_SESSION=<s>`, `HERDR_STARTUP_CWD=/home/dev`
- same as all other running servers

So **don't start sessions with a bare `herdr server` from the bridge.** A "wake the sleeping floor" action should use herdr's own
detached-daemon launch path. The practical way today is to let the first `herdr --remote … --session <s>` (the open-terminal flow)
start it. Or confirm with the herdr researcher which non-interactive command performs the detached launch.

## Recommendation (delta to server-model.md)

- **Bridge:** Go, `systemd --user`, listens only on `/run/user/1000/herdr-world/bridge.sock` (0600). No tailnet listener, no
  WhoIs, no Serve. Auth = can SSH in as dev.
- **Transport:** system OpenSSH `ssh -N -L <local.sock>:<bridge.sock>` supervised by the Mac helper. Unix-to-unix forwarding verified
  over Tailscale SSH, with no measurable latency cost. Don't reuse herdr's private ControlMasters.
- **Mac shell:** Go helper (launchd agent, cross-compiled on the server) + Chrome `--app` window at `http://127.0.0.1:7777`,
  with Host, Origin and token checks. Tauri 2 later if a native app is wanted, after an in-Tauri WebGPU check.
- **Open in terminal:** bridge `agent.focus`/`workspace.focus`, then Ghostty AppleScript `new window with configuration`
  running `/opt/homebrew/bin/herdr --remote dev@devbox --session <s>`. Optional direct `terminal attach` mode for a single pane.

## Open questions

1. OK that "open in terminal" always opens a **new Ghostty window**, which also clears that worker's "done" badge? New tab in
   the front window instead?
2. Chrome `--app` window acceptable as the game window for now, with Tauri later? It needs a one-time Automation permission
   click for Ghostty.
3. Want the single-pane "look over the shoulder" terminal mode (direct attach, no herdr UI) in addition to the full herdr attach?
4. OK for the helper to live in `~/h3d-tools/` with a LaunchAgent plist, and be deployed via `scp` from the server?

## Probe hygiene

- The server echo listener (pid 351802, `/tmp/h3d-probe-server/`) was killed and removed. Port 47777 is free.
- Session `h3d-probe-server` was stopped and deleted.
- Mac: temp dirs `/tmp/h3dp.*`, `/tmp/h3dg.*` and `/tmp/h3d-macpty.py` were removed, and my ControlMasters were exited (`-O exit`).
- No existing herdr session, workspace, pane or SSH master was modified. No config changes on either host.
