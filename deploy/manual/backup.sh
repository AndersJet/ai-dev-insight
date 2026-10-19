#!/usr/bin/env bash
# Cold application backup; PostgreSQL remains running. No restore or deletion.
set -euo pipefail
umask 077
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./lib.sh
source "$script_dir/lib.sh"
destination=''; snapshot=''
while (( $# )); do
  (( $# >= 2 )) || manual_die "Missing value: $1"
  case "$1" in --root) script_dir=$2 ;; --destination) destination=$2 ;; --snapshot) snapshot=$2 ;; --compose-bin) MANUAL_COMPOSE_BIN=$2 ;; *) manual_die "Unknown backup option: $1" ;; esac
  shift 2
done
cd "$script_dir"
[[ -f .env ]] || manual_die '.env is missing.'
manual_compose config --quiet
running=$(manual_compose ps --status running -q web api collector worker initialize prepare-storage)
[[ -z "$running" ]] || manual_die 'Stop web/api/collector/worker and wait for initialization to finish before backing up.'
[[ -n "$(manual_compose ps --status running -q postgres)" ]] || manual_die 'PostgreSQL must be running.'
destination=${destination:-"$script_dir/backups/$(date -u +%Y%m%dT%H%M%SZ)"}
[[ ! -e "$destination" ]] || manual_die 'Backup path already exists.'
mkdir -p "$destination"
printf 'Creating private backup in %s\n' "$destination"
manual_compose exec -T postgres pg_dump -U adi_bootstrap -d adi -Fc > "$destination/database.dump"
manual_compose run --rm --no-deps -T --user 0:0 --entrypoint tar prepare-storage -C /var/lib -cf - adi-cleanup adi-credentials > "$destination/private-volumes.tar"
cp .env "$destination/.env"
cp docker-compose.yml "$destination/docker-compose.yml"
if [[ -n "$snapshot" ]]; then
  cp docker-compose.yml "$destination/source-compose.yml"
  cp "$snapshot" "$destination/docker-compose.yml"
fi
for file in postgres-init.sql .deployment-success; do
  if [[ -f "$file" ]]; then cp "$file" "$destination/$file"; fi
done
if [[ -f images.manifest ]]; then cp images.manifest "$destination/images.manifest"; fi
for file in "$destination"/* "$destination/.env" "$destination/.deployment-success"; do
  [[ -f "$file" ]] || continue
  printf '%s  %s\n' "$(sha256_file "$file")" "$(basename "$file")" >> "$destination/SHA256SUMS.tmp"
done
mv "$destination/SHA256SUMS.tmp" "$destination/SHA256SUMS"
touch "$destination/.complete"
printf 'Backup complete. Keep .env and private-volumes.tar protected; copy to separate storage. Restore has NOT been verified.\n'
