#!/bin/bash
set -eu
umask 077
if [ "$(/usr/bin/uname -s)" != Darwin ]; then
  printf '%s\n' '{"error":"macos_required"}' >&2
  exit 1
fi
package_dir="$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)"
exec /usr/bin/osascript -l JavaScript "$package_dir/native-macos.js" "$package_dir" "$@" 2>/dev/null
