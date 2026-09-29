#!/usr/bin/env bash
# Runs deploy/h3d-update against fake gh, systemctl, curl, ssh, scp and
# launchctl: install, update, no-op, rollback, a bridge that does not come up,
# and a bad checksum. Touches nothing outside a temp dir.
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
shift # host
cd "$T/machome" && HOME="$T/machome" bash -c "$1"
F
cat >"$T/bin/scp" <<'F'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in -o) shift 2 ;; -q) shift ;; *) break ;; esac; done
cp "$1" "$T/machome/${2#*:}"
F
chmod +x "$T"/bin/*
export T PATH="$T/bin:$PATH"
export H3D_BIN="$T/host/bin" H3D_DB="$T/host/state/world.db" H3D_SOCK="$T/sock" H3D_WAIT=2 H3D_MAC=fake-mac
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
release v0.1.0; release v0.2.0; release v0.3.0-rc.1 broken-bridge; release v0.4.0 bad-sums

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
expect "previous bridge kept" "yes" "$([ -e "$H3D_BIN/herdr-world.prev" ] && echo yes || echo no)"
expect "previous helper kept" "yes" "$([ -e "$T/machome/.local/bin/h3d-helper.prev" ] && echo yes || echo no)"
expect "database backed up" "1" "$(sqlite3 "$H3D_DB.bak" 'select count(*) from t')"
run;               expect "same version is a no-op" "0" "$(grep -c -e '->' "$T/out" || true)"
run --check;       expect "--check changes nothing" "v0.2.0/v0.2.0" "$(versions)"
run --rollback;    expect "rollback" "v0.1.0/v0.1.0" "$(versions)"
run v0.3.0-rc.1
expect "a bridge that does not come up fails the update" "1" "$rc"
expect "and leaves the old bridge and helper" "v0.1.0/v0.1.0" "$(versions)"
run v0.4.0
expect "a bad checksum installs nothing" "1/v0.1.0/v0.1.0" "$rc/$(versions)"
run --no-mac v0.2.0; expect "--no-mac leaves the helper, exits 0" "0/v0.2.0/v0.1.0" "$rc/$(versions)"

if [ "$fails" = 0 ]; then echo "all passed"; else echo "$fails failed"; cat "$T/out"; exit 1; fi
