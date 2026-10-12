#!/usr/bin/env bash
# Runs deploy/h3d-update against fake gh, systemctl, curl, ssh, scp and
# launchctl: install, update, no-op, rollback, a bridge that does not come up,
# a bad checksum, the private update.env (no built-in Mac, --server-only), and
# that the Mac's helper configuration is never probed or written. Touches
# nothing outside a temp dir.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/state" "$T/host/bin" "$T/host/state" "$T/machome/.local/bin" "$T/release"

# --- fakes -------------------------------------------------------------------
cat >"$T/bin/gh" <<'F'
#!/usr/bin/env bash
case "$2" in
  view) echo "$(cat "$T/state/latest")" ;;
  download)
    tag=$3; dir=
    while [ $# -gt 0 ]; do [ "$1" = --dir ] && dir=$2; shift; done
    [ -d "$T/release/$tag" ] || { echo "no release $tag" >&2; exit 1; }
    cp "$T/release/$tag"/* "$dir"/ ;;
esac
F
cat >"$T/bin/systemctl" <<'F'
#!/usr/bin/env bash
# systemctl --user restart UNIT: the bridge now reports what the installed binary says.
out=$("$H3D_BIN/herdr-world" --version)
case "$out" in
  *BROKEN*) rm -f "$T/state/bridge_ver" ;;
  *) echo "${out#herdr-world }" >"$T/state/bridge_ver" ;;
esac
F
cat >"$T/bin/launchctl" <<'F'
#!/usr/bin/env bash
out=$("$HOME/.local/bin/h3d-helper" --version)
case "$out" in
  *BROKEN*) rm -f "$T/state/mac_ver" ;;
  *) echo "${out#h3d-helper }" >"$T/state/mac_ver" ;;
esac
F
cat >"$T/bin/curl" <<'F'
#!/usr/bin/env bash
args="$*"
case "$args" in
  *--unix-socket*)
    [ -f "$T/state/bridge_ver" ] || exit 7
    case "$args" in *"-D -"*) printf 'HTTP/1.1 200 OK\r\nX-H3D-Version: %s\r\n\r\n' "$(cat "$T/state/bridge_ver")" ;; esac ;;
  *127.0.0.1:7777/healthz*)
    [ -f "$T/state/mac_ver" ] || exit 7
    printf '{"version":"%s","tunnel":{}}' "$(cat "$T/state/mac_ver")" ;;
  *) exit 2 ;;
esac
F
cat >"$T/bin/ssh" <<'F'
#!/usr/bin/env bash
while [ "$1" = -o ]; do shift 2; done
echo "$1" >>"$T/state/ssh_hosts"
shift # host
# Like a real ssh: the command goes through the remote login shell, which is
# fish on the MacBook. Use fish here when it is installed so POSIX-only
# commands that only work under bash are caught.
sh=bash; command -v fish >/dev/null && sh=fish
# Every command, and every script piped to `sh -s`, is logged for the assertions.
printf '%s\n' "$*" >>"$T/state/mac_cmds"
if [ "$*" = "sh -s" ]; then
  tee -a "$T/state/mac_cmds" | (cd "$T/machome" && HOME="$T/machome" "$sh" -c "$*")
else
  cd "$T/machome" && HOME="$T/machome" "$sh" -c "$*"
fi
F
cat >"$T/bin/scp" <<'F'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in -o) shift 2 ;; -q) shift ;; *) break ;; esac; done
cp "$1" "$T/machome/${2#*:}"
F
cat >"$T/bin/rsync" <<'F'
#!/usr/bin/env bash
# rsync -a --delete -e SSH SRC/ HOST:DEST/  ->  make DEST match SRC.
src=${*: -2:1}; dst="$T/machome/${*: -1}"; dst=${dst#*:}
dst="$T/machome/${dst#"$T/machome/"}"
rm -rf "${dst:?}"/* ; mkdir -p "$dst"; cp -a "$src". "$dst"
F
chmod +x "$T"/bin/*
export T PATH="$T/bin:$PATH"
export H3D_BIN="$T/host/bin" H3D_DB="$T/host/state/world.db" H3D_SOCK="$T/sock" H3D_WAIT=2 H3D_MAC=fake-mac
# The private config lives in a temp dir: never the real ~/.config/h3d/update.env.
export XDG_CONFIG_HOME="$T/xdg"
CONF="$XDG_CONFIG_HOME/h3d/update.env"
mkdir -p "$XDG_CONFIG_HOME/h3d"
# No H3D_MAC in it: the Mac comes from the environment unless a test says otherwise.
NO_MAC_CONF='# the update config of the bridge host'
printf '%s\n' "$NO_MAC_CONF" >"$CONF"
sqlite3 "$H3D_DB" 'create table t(x); insert into t values (1);'

# release TAG [broken-bridge|bad-sums]
release() {
  local kind=${2:-ok} d="$T/release/$1" bv=$1
  mkdir -p "$d"
  [ "$kind" = broken-bridge ] && bv="$1-BROKEN"
  printf '#!/bin/sh\necho "herdr-world %s"\n' "$bv" >"$d/herdr-world-linux-amd64"
  printf '#!/bin/sh\necho "h3d-helper %s"\n' "$1" >"$d/h3d-helper-darwin-arm64"
  (cd "$d" && sha256sum herdr-world-linux-amd64 h3d-helper-darwin-arm64 >SHA256SUMS)
  [ "$kind" = bad-sums ] && echo tampered >>"$d/herdr-world-linux-amd64"
  return 0
}
release v0.1.0; release v0.2.0; release v0.3.0-rc.1 broken-bridge; release v0.4.0 bad-sums; release v0.5.0; release v0.6.0

fails=0
expect() { # expect DESCRIPTION WANT GOT
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: want '$2', got '$3'"; sed 's/^/     | /' "$T/out"; fails=$((fails + 1)); fi
}
versions() { echo "$(cat "$T/state/bridge_ver" 2>/dev/null || echo -)/$(cat "$T/state/mac_ver" 2>/dev/null || echo -)"; }
rc=0
run() { if "$here/h3d-update" "$@" >"$T/out" 2>&1; then rc=0; else rc=$?; fi; }

echo v0.2.0 >"$T/state/latest"
run v0.1.0;        expect "fresh install of v0.1.0" "v0.1.0/v0.1.0" "$(versions)"
expect "no .prev on a fresh install" "no" "$([ -e "$H3D_BIN/herdr-world.prev" ] && echo yes || echo no)"
run;               expect "update to latest (v0.2.0)" "v0.2.0/v0.2.0" "$(versions)"
expect "the Mac side runs under sh, not the login shell (fish)" "0" "$(grep -c -e 'requires an argument' -e 'Standard input' "$T/out" || true)"
expect "previous bridge kept" "yes" "$([ -e "$H3D_BIN/herdr-world.prev" ] && echo yes || echo no)"
expect "previous helper kept" "yes" "$([ -e "$T/machome/.local/bin/h3d-helper.prev" ] && echo yes || echo no)"
expect "database backed up" "1" "$(sqlite3 "$H3D_DB.bak" 'select count(*) from t')"
run;               expect "same version is a no-op: no download, no restart note" "0/1" "$(grep -c -e '->\|downloading\|restarted' "$T/out" || true)/$(grep -c 'nothing to do' "$T/out" || true)"
run --check;       expect "--check changes nothing" "v0.2.0/v0.2.0" "$(versions)"
run --rollback;    expect "rollback" "v0.1.0/v0.1.0" "$(versions)"
run v0.3.0-rc.1
expect "a bridge that does not come up fails the update" "1" "$rc"
expect "and leaves the old bridge and helper" "v0.1.0/v0.1.0" "$(versions)"
run v0.4.0
expect "a bad checksum installs nothing" "1/v0.1.0/v0.1.0" "$rc/$(versions)"
run --no-mac v0.2.0; expect "--no-mac leaves the helper, exits 0" "0/v0.2.0/v0.1.0" "$rc/$(versions)"

# --- the Mac is named by the environment or the private config, never by the script ---
yes_no() { if "$@"; then echo yes; else echo no; fi; }
echo v0.5.0 >"$T/state/latest"
rm -f "$T/state/ssh_hosts"
H3D_MAC='' run
expect "no Mac anywhere: fails early" "1" "$rc"
expect "and says what to set" "1" "$(grep -c 'no Mac to update.*H3D_MAC.*update.env.*--server-only' "$T/out")"
expect "and touches nothing: no download, no ssh, no install" "0/no/v0.2.0/v0.1.0" "$(grep -c downloading "$T/out" || true)/$(yes_no test -e "$T/state/ssh_hosts")/$(versions)"
H3D_MAC='' run --check
expect "--check needs the Mac too" "1" "$rc"
H3D_MAC='' run --music "$T/music"
expect "--music needs the Mac too" "1" "$rc"
H3D_MAC='' run --rollback
expect "--rollback needs the Mac too" "1/v0.2.0/v0.1.0" "$rc/$(versions)"

rm -rf "$T/machome/Library"
H3D_MAC='' run --server-only
expect "--server-only updates the bridge without any Mac" "0/v0.5.0/v0.1.0" "$rc/$(versions)"
expect "--server-only never reaches the Mac" "no" "$(yes_no test -e "$T/state/ssh_hosts")"

# The private config file: KEY=VALUE read as data (not sourced), env wins.
mkdir -p "$T/pwn"
cat >"$CONF" <<F
# the bridge host's update config
export H3D_MAC = "conf-mac"   
UNKNOWN_KEY=$(printf '%s' ignored)
H3D_REPO=somebody/else
EVIL=\$(touch $T/pwn/ran)
\$(touch $T/pwn/ran2)=x
H3D_HELPER_HOST='dev@devbox' # the server
F
H3D_MAC='' run --check
expect "the Mac comes from update.env (quotes, export and comments handled)" "0/conf-mac" "$rc/$(tail -n1 "$T/state/ssh_hosts")"
expect "update.env is read as data: nothing in it runs" "no/no" "$(yes_no test -e "$T/pwn/ran")/$(yes_no test -e "$T/pwn/ran2")"
expect "update.env sets only its known keys (H3D_REPO is not one)" "0" "$(grep -c somebody "$T/out" || true)"
H3D_MAC=env-mac run --check
expect "the environment wins over update.env" "env-mac" "$(tail -n1 "$T/state/ssh_hosts")"
printf 'not a setting\n' >"$CONF"
H3D_MAC='' run --check
expect "a malformed update.env is an error naming the file" "1/1" "$rc/$(grep -c "update.env: want KEY=VALUE" "$T/out")"
printf '%s\n' "$NO_MAC_CONF" >"$CONF"

# --- the Mac's helper configuration is its own (its LaunchAgent plist) --------
# Both hosts update on a Mac with no plist and no other config, and an update.env
# that still carries the helper's old keys: they are ignored, nothing on the Mac
# is probed for a bridge host or written besides the helper binary.
rm -rf "$T/machome/Library" "$T/state/mac_cmds"
printf 'H3D_HELPER_HOST=dev@devbox\nH3D_HELPER_REMOTE_SOCKET=/run/user/1000/herdr-world/bridge.sock\n' >"$CONF"
echo v0.6.0 >"$T/state/latest"
before=$(versions)
run
expect "both hosts update without touching the helper's configuration" "0/v0.6.0/v0.6.0" "$rc/$(versions)"
expect "no guard step: the Mac is never asked about, or given, a helper config" "0/no/no" \
  "$(grep -c -i -e 'H3D_HELPER' -e 'helper.env' -e 'LaunchAgents' "$T/state/mac_cmds" || true)/$(yes_no test -e "$T/machome/Library/Application Support")/$(yes_no test -e "$T/machome/Library/LaunchAgents")"
expect "and says nothing about one" "0" "$(grep -c -i -e 'helper config' -e 'bridge host' -e guard "$T/out" || true)"
printf '%s\n' "$NO_MAC_CONF" >"$CONF"
run --rollback
expect "rollback of both hosts puts back what was there" "0/$before" "$rc/$(versions)"
run --force v0.6.0

before_music=$(versions)
mkdir -p "$T/music/house" && echo a >"$T/music/house/a.ogg" && echo b >"$T/music/house/b.ogg"
run --music "$T/music"; expect "--music copies the tracks" "0/2" "$rc/$(find "$T/machome/Library/Caches/h3d-helper/music" -name '*.ogg' | wc -l)"
expect "--music leaves the release alone" "$before_music" "$(versions)"
rm "$T/music/house/b.ogg"; run --music "$T/music"
expect "--music removes tracks that are gone" "1" "$(find "$T/machome/Library/Caches/h3d-helper/music" -name '*.ogg' | wc -l)"
mkdir -p "$T/empty"; run --music "$T/empty"
expect "--music refuses a folder with no tracks" "1/1" "$rc/$(find "$T/machome/Library/Caches/h3d-helper/music" -name '*.ogg' | wc -l)"

if [ "$fails" = 0 ]; then echo "all passed"; else echo "$fails failed"; cat "$T/out"; exit 1; fi
