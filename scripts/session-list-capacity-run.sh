#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
mkdir -p .run/session-list-capacity/logs
task_log=".run/session-list-capacity/logs/run-$(date +%s)-$$.log"
printf 'Capacity stdout/stderr log: %s\n' "$task_log"
node scripts/session-list-capacity.mjs "$@" 2>&1 | tee "$task_log"
