#!/bin/sh
# A synthetic sudo -A: the expected marker is read from a fixture file.
[ "$1" = "-A" ] || exit 2
shift
attempt=0
while [ "$attempt" -lt 3 ]; do
  attempt=$((attempt + 1))
  value=$("$SUDO_ASKPASS" '[sudo] password for x: ') || exit 1
  if [ "$value" = "$(cat "$FAKE_EXPECT")" ]; then
    unset value
    exec "$@"
  fi
  unset value
  printf '%s\n' 'Sorry, try again.' >&2
done
exit 1
