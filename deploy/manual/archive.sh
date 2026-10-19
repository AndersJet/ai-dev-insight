#!/usr/bin/env bash
# Receives only the private, reference-checked plan created by deploy.sh.
set -euo pipefail
umask 077
root=$1; plan=$2; mode=$3
[[ -d "$root" && -f "$plan" && ! -L "$root/archive" ]] || { echo '归档路径或清单不合法。' >&2; exit 1; }
case "$mode" in preview|archive|purge) ;; *) exit 1 ;; esac
destination=''; count=0
while IFS=$'\t' read -r operation name; do
  [[ -n "$name" ]] || continue
  case "$operation" in
    archive)
      [[ "$name" =~ ^[a-zA-Z0-9_.-]+$ && "$name" != . && "$name" != .. ]] || exit 1
      printf '归档候选：%s\n' "$root/$name"
      if [[ "$mode" == archive ]]; then
        if [[ -z "$destination" ]]; then
          destination="$root/archive/$(date -u +%Y%m%dT%H%M%SZ)-$$"
          mkdir -p "$destination"
          date +%s > "$destination/.adi-managed-archive"
          printf '本次归档：%s\n' "$destination"
        fi
        mv -- "$root/$name" "$destination/$name"
        printf '%s\n' "$name" >> "$destination/contents.txt"
      fi ;;
    purge)
      [[ "$name" =~ ^archive/[0-9]{8}T[0-9]{6}Z-[0-9]+$ && ! -L "$root/$name" && -f "$root/$name/.adi-managed-archive" ]] || exit 1
      printf '满 14 天的受管归档：%s\n' "$root/$name"
      if [[ "$mode" == purge ]]; then rm -rf -- "$root/$name"; fi ;;
    *) exit 1 ;;
  esac
  count=$((count+1))
done < "$plan"
if (( count == 0 )); then printf '没有已确认类型的整理候选；未知文件、数据和备份保留。\n'; fi
if [[ "$mode" == preview ]]; then printf '本次仅预览。确认无外部脚本依赖后加 --apply 归档；满 14 天后用 --purge 显式清理受管归档。\n'; fi
