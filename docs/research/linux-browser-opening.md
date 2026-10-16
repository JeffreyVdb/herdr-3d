# Open provider links from a Linux helper

Investigated 2026-10-16 against repository source, an installed v1.46.0 Linux helper, and primary desktop documentation. Investigation only; no implementation change.

Tracked in [#81: Linux: make “Open in GitHub” open the default desktop browser](https://github.com/JeffreyVdb/herdr-3d/issues/81).

## Confirmed cause and reproduction

[`SystemOpen`](../../internal/helper/open.go) rejects every OS except Darwin with `opening a browser needs macOS`. A valid authenticated `POST /api/open` on the installed Linux helper returns **HTTP 502**, with `the helper could not open a browser: opening a browser needs macOS`. This is an explicit platform restriction, before any browser command runs.

The frontend already routes provider links through [`openExternal`](../../game/src/ui/boards/external.ts). With a helper token it accepts only HTTP 204 as success and deliberately does not fall back to `window.open`; [`App.external`](../../game/src/app.ts) then displays its generic link-failure toast. Fixing the shared helper opener covers issue links, PR links, and other trusted provider links without a new frontend transport.

On the tested desktop, `xdg-mime query default x-scheme-handler/https` reports `google-chrome.desktop`. Running `/usr/bin/xdg-open https://github.com/JeffreyVdb/herdr-3d` through `systemd-run --user --wait --pipe --collect` succeeds in **284 ms**, exits 0, and reports `Opening in existing browser session.` This confirms that the installed desktop's user-manager environment can open the normal browser; it does not establish behavior with a closed browser or after logout/login.

## Linux behavior and service environment

Use `xdg-open <url>` for Linux. It delegates to the preferred browser and is intended for an active desktop session, running as the desktop user. Its documented exit codes distinguish syntax errors (1), missing files (2), missing tools (3), and action failures (4). [Upstream xdg-open manual](https://portland.freedesktop.org/doc/xdg-open.html).

A helper started as a user service needs the desktop session's environment. Inspect relevant variables in the actual helper process as well as the user manager: `PATH`, `WAYLAND_DISPLAY`/`DISPLAY`, `XDG_RUNTIME_DIR`, `XDG_CURRENT_DESKTOP`, and `DBUS_SESSION_BUS_ADDRESS`. Go commands inherit their parent's environment unless `Cmd.Env` is set. [Go os/exec](https://pkg.go.dev/os/exec#Cmd).

Upstream Omarchy startup imports the compositor environment into systemd and D-Bus before starting session services. D-Bus documents that `dbus-update-activation-environment --systemd` updates the environment for subsequently activated user services. A previously started helper may therefore need restarting after the session import; that is a deployment consideration, not the cause of the confirmed macOS guard failure. Avoid embedding a fixed display name, runtime path, browser executable, or a copy of the SSH login environment. [Omarchy startup source](https://github.com/omacom/omarchy/blob/master/default/hypr/autostart.lua), [D-Bus environment documentation](https://dbus.freedesktop.org/doc/dbus-update-activation-environment.1.html).

## Proposed fix and verification

- Dispatch Darwin to the existing `open` command, Linux to `xdg-open`, and return a clear unsupported-platform error elsewhere. Pass the validated URL as one argument through `os/exec`, without a shell.
- Preserve all existing origin, Host, token, HTTPS, credential/port/control-character, size, and trusted-host checks, including bridge-advertised provider hosts. Existing [`open_test.go`](../../internal/helper/open_test.go) covers these boundaries and opener-failure HTTP 502 behavior.
- Add a small test seam for command dispatch/execution. Verify Linux/Darwin arguments, unsupported OS, missing executable, nonzero exit with useful diagnostics, and bounded cancellation; include a URL containing query parameters/fragments to confirm argument preservation. Do not launch a real browser in automated tests.
- Decide launch-completion semantics deliberately. Arch's packaged upstream manual warns that a successful `.desktop` application may remain in the foreground for a long time. Blindly reusing Darwin's 15-second `CommandContext(...).CombinedOutput()` can falsely report a successful Linux launch as failure. Captured output can also keep Go waiting when descendants retain its pipes; bound that wait or avoid inherited capture pipes. `WaitDelay` addresses pipe/cancellation waits, but does not itself decide whether a long-lived opener means success. [Packaged xdg-open manual](https://man.archlinux.org/man/xdg-open.1.en), [Go cancellation and WaitDelay](https://pkg.go.dev/os/exec#Cmd).
- Validate issue and PR buttons from the installed Linux app using its actual service, with the default browser running and closed; check logout/login startup and a missing/unavailable desktop session. Retain the macOS behavior and authenticated refusal tests. Update nearby Mac-only comments/documentation touched by the change.

The live endpoint and user-service opener probes above were performed during investigation. No implementation tests were added or run for this documentation-only change.

## Implementation outcome (#81)

Implemented as proposed in [`open.go`](../../internal/helper/open.go): Darwin `open`, Linux `xdg-open`, an error naming any other OS, the URL as one argv element, the helper's environment inherited. Launch completion: a 3 s grace window; exit 0 is success, a failure (missing executable, non-zero exit) is an error with the exit code and capped output, a still-running opener counts as launched and is neither killed nor left unreaped, and the request context ending leaves the launch alone (decisions log, 2026-10-16). `Cmd.WaitDelay` bounds descendants that hold the output pipe. The claims above are unchanged; one deployment consequence is added to CONTRIBUTING.md ("Linux user service"): a browser started cold by the helper lives in the helper service's cgroup. Automated tests use fake `xdg-open`/`open` scripts on `PATH`; no real browser was opened.
