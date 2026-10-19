#!/bin/sh
# Build a single offline delivery file. Registry credentials stay with Docker.
set -eu
umask 077
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$script_dir/lib.sh"
prefix=''
tag=latest; platform=linux/amd64; kind=upgrade; output="$script_dir/offline"; local_mode=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --local) local_mode=true; shift ;;
    --tag|--platform|--output|--image-prefix|--kind)
      [ "$#" -ge 2 ] || manual_die "Missing value for $1"
      case "$1" in --tag) tag=$2 ;; --platform) platform=$2 ;; --output) output=$2 ;; --image-prefix) prefix=$2 ;; --kind) kind=$2 ;; esac
      shift 2 ;;
    -h|--help) printf '%s\n' 'Usage: sh export-images.sh [--kind upgrade|install] [--local --tag FULL_SHA | --tag latest|FULL_SHA] [--platform linux/amd64|linux/arm64] [--output DIR] [--image-prefix REGISTRY/PROJECT/PREFIX]' 'upgrade: four application images; install: also pinned PostgreSQL. Produces one .run file, no private .env.'; exit 0 ;;
    *) manual_die "Unknown option: $1" ;;
  esac
done
is_sha() { printf '%s\n' "$1" | LC_ALL=C grep -Eq '^[a-f0-9]{40}$'; }
is_id() { printf '%s\n' "$1" | LC_ALL=C grep -Eq '^sha256:[a-f0-9]{64}$'; }
[ "$tag" = latest ] || is_sha "$tag" || manual_die 'Use latest or a full lowercase commit SHA.'
[ "$local_mode" = false ] || is_sha "$tag" || manual_die 'Local export requires a full lowercase commit SHA.'
case "$platform" in linux/amd64|linux/arm64) ;; *) manual_die 'Unsupported platform.' ;; esac
case "$kind" in install|upgrade) ;; *) manual_die 'Use --kind install or upgrade.' ;; esac
[ -n "$prefix" ] || { [ "$local_mode" = true ] && prefix=local/ai-dev-insight || manual_die 'Registry export requires --image-prefix; use --local for local release images.'; }
printf '%s\n' "$prefix" | LC_ALL=C grep -Eq '^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+$' || manual_die 'Invalid image prefix.'
command -v docker >/dev/null || manual_die 'Docker is required.'
docker info >/dev/null
mkdir -p -- "$output"
output=$(CDPATH='' cd -- "$output" && pwd)
lock="$script_dir/.export-lock"
mkdir "$lock" 2>/dev/null || manual_die "Another export is running; inspect $lock before retrying."
staging=''; payload=''
cleanup() {
  status=$?; trap - EXIT INT TERM
  [ -z "$staging" ] || rm -rf -- "$staging"
  [ -z "$payload" ] || rm -f -- "$payload"
  rm -f -- "$lock/identities"
  rmdir "$lock" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
revision=''
for role in api collector worker web; do
  ref="$prefix-$role:$tag"
  if [ "$local_mode" = false ]; then docker pull --platform "$platform" "$ref"; fi
  [ "$(image_platform "$ref")" = "$platform" ] || manual_die "Architecture mismatch: $role"
  id=$(image_id "$ref"); is_id "$id" || manual_die "Invalid image identity: $role"
  found=$(image_revision "$ref")
  if [ "$tag" = latest ]; then
    is_sha "$found" || manual_die 'latest has no complete revision label.'
    [ -n "$revision" ] || revision=$found
  else revision=$tag; fi
  [ "$found" = "$revision" ] || manual_die 'Four images must have the same complete revision label.'
  printf '%s\t%s\n' "$role" "$id" >> "$lock/identities"
done
while IFS="$(printf '\t')" read -r role id; do
  ref="$prefix-$role:$revision"
  if [ "$local_mode" = false ] && [ "$tag" = latest ]; then docker pull --platform "$platform" "$ref"; fi
  [ "$(image_id "$ref")" = "$id" ] && [ "$(image_platform "$ref")" = "$platform" ] && [ "$(image_revision "$ref")" = "$revision" ] || manual_die "Commit identity changed: $role"
done < "$lock/identities"
if [ "$kind" = install ]; then
  postgres=$(postgres_platform_ref "$platform")
  docker pull --platform "$platform" "$postgres"
  [ "$(image_platform "$postgres")" = "$platform" ] || manual_die 'PostgreSQL architecture mismatch.'
  pg_id=$(image_id "$postgres"); is_id "$pg_id" || manual_die 'Invalid PostgreSQL identity.'
fi
staging=$(mktemp -d "$output/.export-XXXXXX")
printf '# release %s platform %s\n# kind %s\n# role\tsource\tlocal_tag\timage_id\tplatform\n' "$revision" "$platform" "$kind" > "$staging/images.manifest"
set --
while IFS="$(printf '\t')" read -r role id; do
  local_ref="ai-dev-insight-offline-$role:latest"; version_ref="ai-dev-insight-offline-$role:$revision"
  docker tag "$id" "$local_ref"; docker tag "$id" "$version_ref"
  printf '%s\t%s\t%s\t%s\t%s\n' "$role" "$prefix-$role:$revision" "$version_ref" "$id" "$platform" >> "$staging/images.manifest"
  set -- "$@" "$local_ref" "$version_ref"
done < "$lock/identities"
if [ "$kind" = install ]; then
  docker tag "$pg_id" ai-dev-insight-offline-postgres:18.6
  printf '# postgres_parent %s\n' "$(manual_postgres_parent)" >> "$staging/images.manifest"
  printf 'postgres\t%s\t%s\t%s\t%s\n' "$postgres" ai-dev-insight-offline-postgres:18.6 "$pg_id" "$platform" >> "$staging/images.manifest"
  set -- "$@" ai-dev-insight-offline-postgres:18.6
fi
docker image save -o "$staging/images.tar" "$@"
for file in docker-compose.yml postgres-init.sql .env.example lib.sh load-images.sh backup.sh deploy.sh archive.sh site-config.mjs README.md REFERENCE.md LICENSE NOTICE THIRD_PARTY_NOTICES.md THIRD_PARTY_LICENSES.txt; do cp "$script_dir/$file" "$staging/$file"; done
chmod 0644 "$staging/postgres-init.sql"
for file in images.tar images.manifest docker-compose.yml postgres-init.sql .env.example lib.sh load-images.sh backup.sh deploy.sh archive.sh site-config.mjs README.md REFERENCE.md LICENSE NOTICE THIRD_PARTY_NOTICES.md THIRD_PARTY_LICENSES.txt; do
  printf '%s  %s\n' "$(sha256_file "$staging/$file")" "$file" >> "$staging/SHA256SUMS"
done
short=$(printf '%s' "$revision" | cut -c1-12)
name="ai-dev-insight-$short-${platform#linux/}-$kind.run"; destination="$output/$name"
[ ! -e "$destination" ] || manual_die 'Output already exists; use another output directory.'
payload=$(mktemp "$output/.payload-XXXXXX")
tar -czf "$payload" -C "$staging" .
digest=$(sha256_file "$payload"); size=$(du -sk "$staging" | awk '{print $1}')
sed -e "s/@PAYLOAD_SHA256@/$digest/g" -e "s/@PAYLOAD_KB@/$size/g" "$script_dir/run-header.sh" > "$staging/package.run"
cat "$payload" >> "$staging/package.run"
mv "$staging/package.run" "$destination"
printf '\nReady: %s\nRelease: %s (%s), kind: %s. Upload only this .run file.\n' "$destination" "$revision" "$platform" "$kind"
