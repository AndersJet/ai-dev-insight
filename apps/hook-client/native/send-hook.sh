#!/bin/bash
# Two bounded, isolated process groups; no daemon, spool file or runtime download.
exec 2>/dev/null
set -m
umask 077
package_dir="$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)" || exit 0
sender_pid=''
timer_pid=''
finish() {
  [ -z "$sender_pid" ] || kill -TERM -- "-$sender_pid" 2>/dev/null || :
  [ -z "$sender_pid" ] || kill -KILL -- "-$sender_pid" 2>/dev/null || :
  [ -z "$timer_pid" ] || kill -TERM -- "-$timer_pid" 2>/dev/null || :
  [ -z "$timer_pid" ] || kill -KILL -- "-$timer_pid" 2>/dev/null || :
}
trap 'finish; exit 0' HUP INT TERM EXIT
exec 3<&0
(
  set +m
  /usr/bin/osascript -l JavaScript "$package_dir/native-macos.js" "$package_dir" --send "${1:-}" <&3 2>/dev/null |
    (
      # Keep ordinary collection's transport startup parallel with JXA.
      # Only an active verification marker needs the diagnostic response reader.
      if [ ! -f "${HOME}/.trae-cn/adi-plugin-control/verification.json" ]; then
        exec /usr/bin/curl --config - >/dev/null 2>&1
      fi
      IFS= read -r first || exit 0
      diagnostic_port=''; diagnostic_id=''; diagnostic_operation=''
      if [[ "$first" =~ ^\#\ adi-diagnostic\ ([0-9]{4,5})\ ([a-f0-9-]{36})\ ([a-f0-9-]{36})$ ]]; then
        diagnostic_port="${BASH_REMATCH[1]}"; diagnostic_id="${BASH_REMATCH[2]}"; diagnostic_operation="${BASH_REMATCH[3]}"
      fi
      if [ -z "$diagnostic_port" ]; then
        exec /usr/bin/curl --silent --config - >/dev/null 2>&1
      fi
      status="$(/usr/bin/curl --silent --config - --output /dev/null --write-out '%{http_code}' 2>/dev/null)"
      code=$?
      if [ -n "$diagnostic_port" ] && [[ "$status" =~ ^[0-9]{3}$ ]]; then
        phase='success'; reason=''; [ "$code" -eq 0 ] && [ "$status" -ge 200 ] && [ "$status" -lt 300 ] || phase='failed'
        [ "$code" -eq 0 ] || reason=',"code":"transport_failed"'
        printf '{"verification":"%s","operation":"%s","stage":"hook.response","phase":"%s","http_status":%s,"exit_code":%s%s}' "$diagnostic_id" "$diagnostic_operation" "$phase" "$((10#$status))" "$code" "$reason" >/dev/udp/127.0.0.1/"$diagnostic_port" 2>/dev/null || :
      fi
    ) >/dev/null 2>&1
) >/dev/null 2>&1 &
sender_pid=$!
( /bin/sleep 0.75; kill -TERM -- "-$sender_pid" 2>/dev/null || : ) >/dev/null 2>&1 &
timer_pid=$!
wait "$sender_pid" 2>/dev/null || :
finish
sender_pid=''
finish
wait "$timer_pid" 2>/dev/null || :
timer_pid=''
exit 0
