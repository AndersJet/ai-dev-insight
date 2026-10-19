#!/usr/bin/env bash
# Prepended to a checksum-bound tar.gz by export-images.sh.
set -euo pipefail
umask 077
case "${1:-}" in
  -h|--help|'')
    printf '%s\n' '用法：bash 本文件.run install|upgrade|recover|status|cleanup --env test|prod [--root 绝对目录]' \
      '首次安装使用 install 包；日常升级使用 upgrade 包。必须明确选择环境。'
    exit 0 ;;
esac
[[ -f "$0" ]] || { echo '请先下载完整 .run 文件，再用 bash 执行。' >&2; exit 1; }
bundle=$(cd -- "$(dirname -- "$0")" && pwd)/$(basename -- "$0")
line=$(awk '/^__ADI_PAYLOAD_BELOW__$/ {print NR + 1; exit}' "$bundle")
[[ "$line" =~ ^[0-9]+$ ]] || { echo '安装包不完整，请重新下载。' >&2; exit 1; }
work=$(mktemp -d "${TMPDIR:-$(dirname -- "$bundle")}/.adi-deploy.XXXXXXXX")
trap 'rm -rf -- "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(tail -n +"$line" "$bundle" | sha256sum | awk '{print $1}')
else
  actual=$(tail -n +"$line" "$bundle" | shasum -a 256 | awk '{print $1}')
fi
[[ "$actual" == '@PAYLOAD_SHA256@' ]] || { echo '安装包校验失败，请重新下载；尚未修改服务。' >&2; exit 1; }
available=$(df -Pk "$work" | awk 'END {print $4}')
(( available >= @PAYLOAD_KB@ + 262144 )) || { echo '临时目录空间不足；可用 TMPDIR 指定空间充足的目录。' >&2; exit 1; }
tail -n +"$line" "$bundle" | tar --no-same-owner -xzf - -C "$work"
export ADI_RUN_FILE="$bundle"
bash "$work/deploy.sh" "$@"
exit $?
__ADI_PAYLOAD_BELOW__
