#!/bin/bash
export PATH=/opt/homebrew/bin:$PATH
label=$1; shift
"$@" >/tmp/h3d-soak-$label.log 2>&1 & pid=$!
sleep 12
top -l 6 -s 4 -stats pid,command,cpu,power > /tmp/h3d-top-$label.txt 2>/dev/null
wait $pid
