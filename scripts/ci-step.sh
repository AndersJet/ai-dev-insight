#!/bin/sh
# Works in both Node and Docker jobs. Never echo the command arguments or env.
set -u
if [ "$#" -lt 2 ]; then
  echo 'Usage: sh scripts/ci-step.sh phase command [args...]' >&2
  exit 2
fi
ci_phase=$1
shift
case "$ci_phase" in
  ''|*[!a-zA-Z0-9_.-]*) echo 'Invalid CI phase name' >&2; exit 2 ;;
esac
mkdir -p .run || exit 1
ci_started=$(date +%s)
printf 'CI phase=%s started\n' "$ci_phase"
"$@"
ci_status=$?
ci_finished=$(date +%s)
ci_elapsed=$((ci_finished - ci_started))
printf 'CI phase=%s elapsed_seconds=%s exit_code=%s\n' "$ci_phase" "$ci_elapsed" "$ci_status"
printf '%s\t%s\t%s\n' "$ci_phase" "$ci_elapsed" "$ci_status" >> .run/ci-step-timings.tsv
exit "$ci_status"
