#!/usr/bin/env bash
# Run inside an extracted bundle on the offline server.
set -euo pipefail
umask 077
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./lib.sh
source "$script_dir/lib.sh"
cd "$script_dir"
[[ -f images.manifest && -f images.tar && -f SHA256SUMS ]] || manual_die 'Run this script inside the extracted offline bundle.'
verify_checksums
# tar extraction may apply the receiving user's restrictive umask. Restore the
# public bootstrap SQL's mode so the PostgreSQL UID can read the bind mount.
if [[ -f postgres-init.sql ]]; then chmod 0644 postgres-init.sql; fi
docker info >/dev/null
arch=$(docker info --format '{{.Architecture}}')
case "$arch" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) manual_die "Unsupported Docker architecture: $arch" ;; esac
count=0
seen=' '
bundle_prefix=''
release=$(awk '$1 == "#" && $2 == "release" {print $3}' images.manifest)
kind=$(awk '$1 == "#" && $2 == "kind" {print $3}' images.manifest)
[[ -z "$kind" || "$kind" == install || "$kind" == upgrade ]] || manual_die 'Invalid package kind.'
[[ -z "$kind" || "$release" =~ ^[a-f0-9]{40}$ ]] || manual_die 'Invalid package revision.'
missing=false
while IFS=$'\t' read -r role _source_ref local_ref expected expected_platform extra; do
  [[ "$role" == \#* || -z "$role" ]] && continue
  [[ "$expected_platform" == "linux/$arch" ]] || manual_die 'Bundle architecture does not match this server; obtain a matching bundle.'
  case "$role" in api|collector|worker|web) tag=${release:-latest}; [[ -n "$kind" ]] || tag=latest ;; postgres) tag=18.6 ;; *) manual_die 'Unexpected manifest role.' ;; esac
  # Legacy names are accepted only for a complete, checksum-verified old bundle.
  case "$local_ref" in
    ai-dev-insight-offline-*) prefix=ai-dev-insight-offline ;;
    trae-hooks-offline-*) prefix=trae-hooks-offline ;;
    *) manual_die 'Unexpected manifest image.' ;;
  esac
  [[ "$local_ref" == "$prefix-$role:$tag" ]] || manual_die 'Unexpected manifest image.'
  [[ -z "$bundle_prefix" || "$bundle_prefix" == "$prefix" ]] || manual_die 'Mixed manifest image namespaces.'
  bundle_prefix=$prefix
  [[ "$seen" != *" $role "* ]] || manual_die 'Duplicate manifest role.'
  seen+="$role "
  [[ "$expected" =~ ^sha256:[a-f0-9]{64}$ && -z "${extra:-}" ]] || manual_die 'Invalid manifest identity.'
  count=$((count + 1))
  if actual=$(image_id "$local_ref" 2>/dev/null); then
    if [[ -n "$kind" && "$actual" != "$expected" ]]; then manual_die "镜像版本名已存在但内容不同：$role；请核对版本，不覆盖现有镜像。"; fi
    [[ "$actual" == "$expected" ]] || missing=true
  else missing=true; fi
done < images.manifest
expected_count=5
if [[ "$kind" == upgrade ]]; then expected_count=4; [[ "$seen" != *' postgres '* ]] || manual_die 'Upgrade package must not replace PostgreSQL.'; fi
[[ "$count" == "$expected_count" ]] || manual_die 'The manifest has an incomplete image set.'
if [[ "$missing" == true ]]; then docker image load -i images.tar;
else printf '本机已有本版本镜像，跳过重复导入。\n'; fi
while IFS=$'\t' read -r role _source_ref local_ref expected expected_platform extra; do
  [[ "$role" == \#* || -z "$role" ]] && continue
  [[ "$(image_id "$local_ref")" == "$expected" ]] || manual_die "Loaded identity mismatch: $role"
  [[ "$(image_platform "$local_ref")" == "$expected_platform" ]] || manual_die "Loaded architecture mismatch: $role"
  if [[ -n "$kind" && "$role" != postgres ]]; then
    [[ "$(image_revision "$local_ref")" == "$release" ]] || manual_die "Loaded revision mismatch: $role"
  fi
done < images.manifest
printf '\n%s images loaded and verified.\n' "$expected_count"
