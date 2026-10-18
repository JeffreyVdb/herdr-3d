#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
CHECKOUT=${1:-$(cd -- "$HERE/../../../.." && pwd)}
python3 -I "$HERE/evaluate.py" "$CHECKOUT"
