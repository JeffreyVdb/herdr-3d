# Releasing and updating

One tag builds everything both machines run; one command on the server installs it.

```
git tag v0.2.0 && git push origin v0.2.0        # release.yml builds and publishes
h3d-update                                       # on devbox: bridge first, then the Mac helper
```

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

From the server, with `gh` logged in and ssh to the Mac working (`ControlMaster=no`, see `docs/architecture.md` §2):

```sh
install -Dm755 deploy/h3d-update ~/.local/bin/h3d-update
install -Dm644 deploy/herdr-world.service ~/.config/systemd/user/herdr-world.service
systemctl --user daemon-reload && systemctl --user enable herdr-world

# ssh runs commands through the Mac's login shell (fish here), so scripts go to `sh -s`.
mac=devmac; ssh="ssh -o ControlMaster=no -o ControlPath=none"
$ssh $mac sh -s <<'EOF'
mkdir -p "$HOME/.local/bin" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
EOF
sed "s|@HOME@|/Users/dev|g" deploy/com.jeffreyvdb.h3d-helper.plist |
  $ssh $mac 'cat > Library/LaunchAgents/com.jeffreyvdb.h3d-helper.plist'
$ssh $mac sh -s <<'EOF'
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.jeffreyvdb.h3d-helper.plist"
EOF

h3d-update [vX.Y.Z]   # installs both and starts them (name the tag while only -rc releases exist)
```

## Updating

`h3d-update [vX.Y.Z]` (the newest full release by default; GitHub's "latest" skips prereleases, so name an `-rc` tag):

1. downloads the release with `gh` and verifies `SHA256SUMS`;
2. bridge: backs up `world.db` to `world.db.bak` (`sqlite3 .backup`), keeps the old binary as `herdr-world.prev`,
   installs the new one, restarts `herdr-world.service`, and waits for `/healthz` to report the new version. If it does
   not, it puts the old bridge and database back and stops; the Mac is untouched;
3. Mac: copies the helper over ssh, keeps the old one as `h3d-helper.prev`, runs `launchctl kickstart -k`, and waits
   for the helper's `/healthz` to report the new version (otherwise it restores `.prev`).

Agents keep running through a bridge restart: herdr sessions are started with `systemd-run` in their own units. Update
between hires and send-homes; an in-flight one rolls back.

`h3d-update --check` prints the latest release and what is installed. `--no-mac` / `--no-bridge` do half;
`--force` reinstalls the same version; `--music DIR` syncs the radio's tracks and nothing else; `--no-backup` skips the database copy. Settings are `H3D_*` variables at the top
of the script.

## The radio's music

The tracks are about 100 MB and not committed, so a release does not carry them (the manifest and credits are in the
game; the audio is not). The helper serves `~/Library/Caches/h3d-helper/music/` under `/music/`, and a file there wins over
anything embedded. Without it the radio is silent and nothing else changes.

Fetch the tracks once where the repo is checked out (`pnpm -C game music`, see CONTRIBUTING "Audio"), then copy them to the
Mac:

```sh
h3d-update --music ~/devel/herdr-3d/game/public/music   # rsync --delete over ssh; the helper serves it live
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

1. On the Mac: `~/.local/bin/h3d-helper -print-url`, and open that URL in a normal Chrome window.
2. Chrome menu, **Cast, save and share**, **Install page as app**, name it `herdr-3d`.
3. Launch **herdr-3d** from the Dock or `~/Applications/Chrome Apps.localized`.

The helper keeps its token in a file that survives restarts, and the app keeps it in its own storage, so the app starts
without the `#token=` URL and reconnects by itself after every `h3d-update`. Once `herdr-3d.app` exists the helper no
longer opens its own `--app` window. To rotate the token, delete `~/Library/Application Support/h3d-helper/token`,
restart the helper, and open the `-print-url` URL in the app once.

## Testing the release machinery

- `make sh-test`: shellcheck and `deploy/test-h3d-update.sh`, which runs `h3d-update` against fake `gh`, `systemctl`,
  `curl`, `ssh`, `scp` and `launchctl`: install, update, no-op, rollback, a bridge that does not come up, a bad checksum.
- `make release-assets VERSION=v0.0.0-test` builds exactly what CI publishes into `bin/release/`.
- A prerelease tag (`v0.0.1-rc.1`) exercises the real workflow and `h3d-update` end to end without touching "latest".
