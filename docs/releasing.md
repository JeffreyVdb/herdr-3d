# Releasing and updating

One tag builds everything both machines run; one command on the server installs it.

```
git tag v0.2.0 && git push origin v0.2.0        # release.yml builds and publishes
h3d-update                                       # on the bridge server: bridge first, then the Mac helper
```

## Which machines? Discover them, never guess

The repository names no machine, and neither do the scripts. This page is written for agents too: **do not write real
hostnames, users or IPs into the repository, a commit message, a PR or an issue**; find them where they live.

| What | Where it comes from |
|---|---|
| The Mac `h3d-update` updates (`H3D_MAC`) | the environment, else `${XDG_CONFIG_HOME:-~/.config}/h3d/update.env` on the bridge server |
| The bridge host the Mac's helper tunnels to (`H3D_HELPER_HOST`, `user@host`) | on the Mac only: the LaunchAgent's `EnvironmentVariables` in `~/Library/LaunchAgents/com.jeffreyvdb.h3d-helper.plist` (or `-host`). Nothing else is read |
| The bridge socket (`H3D_HELPER_REMOTE_SOCKET`) | the same plist (or `-remote-socket`); if unset the helper asks the host for `$XDG_RUNTIME_DIR` and uses `$XDG_RUNTIME_DIR/herdr-world/bridge.sock` |

So: `cat ~/.config/h3d/update.env` (you are on the bridge server; it is private, mode 600, not in git) and read the Mac
from `H3D_MAC`; do not ask for or invent one. If the file is missing, `h3d-update` says so and stops. For the bridge host,
read the installed plist on the Mac. `deploy/update.env.example` and the plist's header show the shape with fictional
values (`dev@devbox`, `devmac`).
`game/tools/mac-perf.ts` (`pnpm perf:mac`) reads the same `H3D_MAC`, from the environment or that file, and exits 2
without one. A private wrapper that runs these steps for you may sit next to the config, outside the repository.

`update.env` is a `KEY=VALUE` file read as data (never sourced; `#` comments; optional quotes; only `H3D_MAC` is used,
other keys are ignored); a variable set in the environment wins. `.gitignore` keeps it out of the repository.

### Failure messages you may meet

| Message (start) | Meaning and fix |
|---|---|
| `h3d-update: no Mac to update: set H3D_MAC=…` | no `H3D_MAC` in the environment or `update.env`. Nothing was downloaded or touched. Set it, or pass `--server-only` to update the bridge alone |
| `h3d-update: …/update.env: want KEY=VALUE` | a line of the config that is neither a comment nor `KEY=VALUE` |
| `h3d-helper: no bridge host: pass -host [user@]host or set $H3D_HELPER_HOST (on the Mac: in the LaunchAgent's EnvironmentVariables)` | the helper started with no host (flag and environment empty, or the plist still has its `@H3D_HELPER_HOST@` placeholder). Fill in the plist ("Changing the Mac's bridge host" below) |
| `h3d-helper: … reported no usable $XDG_RUNTIME_DIR …` / `asking <host> for its runtime dir over ssh: …` | no socket was named and the host's answer was empty, relative or ssh failed. Name it: `-remote-socket` / `H3D_HELPER_REMOTE_SOCKET` |

## What a release contains

`release.yml` (on a `v*` tag pushed from `main`) runs `make lint test`, then `make release-assets VERSION=<tag>`:

| Asset | Runs on | Notes |
|---|---|---|
| `herdr-world-linux-amd64` | `devbox` | the bridge |
| `h3d-helper-darwin-arm64` | the MacBook | the helper, **with the game embedded** (`internal/webdist`), so the game and helper can never drift |
| `SHA256SUMS` | | checked by `h3d-update` before anything is installed |

Tags are `vMAJOR.MINOR.PATCH`, or with a suffix (`v0.3.0-rc.1`) for a prerelease. The binaries are stamped with the tag
(`-X internal/version.Version`), and the workflow fails if the built bridge does not report it. Release notes are
generated from the merged PRs.

## First install (once)

From the server, with `gh` logged in and ssh to the Mac working (`ControlMaster=no`, see `docs/architecture.md` §2).
Create the private config first: copy `deploy/update.env.example` to `~/.config/h3d/update.env`, `chmod 600`, and put your
own `H3D_MAC` in it.

```sh
install -Dm755 deploy/h3d-update ~/.local/bin/h3d-update
install -Dm644 deploy/herdr-world.service ~/.config/systemd/user/herdr-world.service
systemctl --user daemon-reload && systemctl --user enable herdr-world

# ssh runs commands through the Mac's login shell (fish here), so scripts go to `sh -s`.
mac=<the H3D_MAC value>; ssh="ssh -o ControlMaster=no -o ControlPath=none"
host=<user@host of this bridge server>; sock=<its bridge socket, or empty: the helper asks the host>
$ssh $mac sh -s <<'EOF'
mkdir -p "$HOME/.local/bin" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
EOF
# The plist carries the bridge host in its EnvironmentVariables (launchd does not see shell exports).
mac_home=$($ssh $mac 'printf %s "$HOME"')
sed -e "s|@HOME@|$mac_home|g" -e "s|@H3D_HELPER_HOST@|$host|g" -e "s|@H3D_HELPER_REMOTE_SOCKET@|$sock|g" \
    deploy/com.jeffreyvdb.h3d-helper.plist |
  $ssh $mac 'cat > Library/LaunchAgents/com.jeffreyvdb.h3d-helper.plist'
$ssh $mac sh -s <<'EOF'
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.jeffreyvdb.h3d-helper.plist"
EOF

h3d-update [vX.Y.Z]   # installs both and starts them (name the tag while only -rc releases exist)
```

## Updating

`h3d-update [vX.Y.Z]` (the newest full release by default; GitHub's "latest" skips prereleases, so name an `-rc` tag):

0. reads the Mac from `H3D_MAC` / `update.env` and **stops before anything else** if there is none (`--server-only`
   is the explicit way to update the bridge alone);
1. downloads the release with `gh` and verifies `SHA256SUMS`;
2. bridge: backs up `world.db` to `world.db.bak` (`sqlite3 .backup`), keeps the old binary as `herdr-world.prev`,
   installs the new one, restarts `herdr-world.service`, and waits for `/healthz` to report the new version. If it does
   not, it puts the old bridge and database back and stops; the Mac is untouched;
3. Mac: copies the helper over ssh, keeps the old one as `h3d-helper.prev`, runs `launchctl kickstart -k`, and waits
   for the helper's `/healthz` to report the new version (otherwise it restores `.prev`).

`h3d-update` never configures the helper: the Mac's LaunchAgent plist is the helper's only configuration, and an update
replaces the binary only.

Agents keep running through a bridge restart: herdr sessions are started with `systemd-run` in their own units. Update
between hires and send-homes; an in-flight one rolls back.

`h3d-update --check` prints the latest release and what is installed. `--server-only` (alias `--no-mac`) updates the
bridge and never talks to the Mac, so it needs no `H3D_MAC`; `--no-bridge` does the other half; `--force` reinstalls the
same version; `--music DIR` syncs the radio's tracks and nothing else; `--no-backup` skips the database copy. Settings
are `H3D_*` variables at the top of the script (`H3D_MAC` also from `update.env`).

### Changing the Mac's bridge host

The helper reads `H3D_HELPER_HOST` and `H3D_HELPER_REMOTE_SOCKET` from its LaunchAgent's `EnvironmentVariables` only
(launchd does not see shell exports). To set or change them, reinstall the plist from
`deploy/com.jeffreyvdb.h3d-helper.plist` with the `sed` in its header (or the `sed` under "First install" from the
server), then reload it:

```sh
launchctl bootout gui/$(id -u)/com.jeffreyvdb.h3d-helper
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.jeffreyvdb.h3d-helper.plist
```

Check: `curl -s http://127.0.0.1:7777/healthz` on the Mac (tunnel `up`), `tail ~/Library/Logs/h3d-helper.log` (no
`no bridge host`), and `h3d-update --check` on the server (shows both versions).

## The radio's music

The tracks are about 100 MB and not committed, so a release does not carry them (the manifest and credits are in the
game; the audio is not). The helper serves `~/Library/Caches/h3d-helper/music/` under `/music/`, and a file there wins over
anything embedded. Without it the radio is silent and nothing else changes.

Fetch the tracks once where the repo is checked out (`pnpm -C game music`, see CONTRIBUTING "Audio"), then copy them to the
Mac:

```sh
h3d-update --music <repo checkout>/game/public/music   # rsync --delete over ssh; the helper serves it live
```

`H3D_MUSIC_SRC` sets the folder once. The copy is a cache: it needs redoing only when tracks are added or replaced, not
on every release, and no helper restart.

## Rolling back

`h3d-update --rollback` swaps the `.prev` binaries back on both machines. If the old bridge refuses to start because
the database is on a newer schema (migrations only go forward), it restores `world.db.bak`, which drops whatever the
bridge wrote since the update.

## Versions and compatibility

- The game, helper and bridge of one release are meant to run together. The helper logs a warning when the bridge is
  another version, and the game shows `game … · helper … · bridge …` above the backend line (amber when they differ).
- Update the bridge first. An old game on a new bridge works while protocol changes are additive; a breaking one bumps
  `proto.Version`, and the handshake refuses the mismatch (`unsupported_proto`).
- Migrations only append. A release that adds one has no free downgrade (see above).
- The bridge reports its version in `X-H3D-Version` on `/healthz`; the body stays `ok` so an older helper still reads it
  as healthy.

## The game as a Mac app

The game is a web app (`manifest.webmanifest`), so Chrome can install it as a real app: its own icon in the Dock and
Cmd-Tab, no browser chrome, WebGPU as before.

1. On the Mac: `~/.local/bin/h3d-helper -print-url` (it needs no host), and open that URL in a normal Chrome window.
2. Chrome menu, **Cast, save and share**, **Install page as app**, name it `herdr-3d`.
3. Launch **herdr-3d** from the Dock or `~/Applications/Chrome Apps.localized`.

The helper keeps its token in a file that survives restarts, and the app keeps it in its own storage, so the app starts
without the `#token=` URL and reconnects by itself after every `h3d-update`. Once `herdr-3d.app` exists the helper no
longer opens its own `--app` window. To rotate the token, delete `~/Library/Application Support/h3d-helper/token`,
restart the helper, and open the `-print-url` URL in the app once.

## Testing the release machinery

- `make sh-test`: shellcheck and `deploy/test-h3d-update.sh`, which runs `h3d-update` against fake `gh`, `systemctl`,
  `curl`, `ssh`, `scp` and `launchctl`, with its config in a temp dir: install, update, no-op, rollback, a bridge that does
  not come up, a bad checksum, no Mac configured (fails early), `--server-only`, the `update.env` parsing and
  precedence, and that an update of both hosts never probes or writes the Mac's helper configuration.
- `make release-assets VERSION=v0.0.0-test` builds exactly what CI publishes into `bin/release/`.
- A prerelease tag (`v0.0.1-rc.1`) exercises the real workflow and `h3d-update` end to end without touching "latest".
