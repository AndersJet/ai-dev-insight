# Shared by POSIX packaging and Bash deployment; never evaluates .env as code.
manual_die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
manual_compose() (
  if [ -f "$script_dir/.env" ]; then
    while IFS='=' read -r key ignored; do
      case "$key" in ADI_*|TRAE_OPENAPI_*|COMPOSE_PROJECT_NAME) unset "$key" ;; esac
    done < "$script_dir/.env"
  fi
  unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES
  if [ "${MANUAL_COMPOSE_BIN:-}" = docker ]; then docker compose "$@";
  elif [ -n "${MANUAL_COMPOSE_BIN:-}" ]; then "$MANUAL_COMPOSE_BIN" "$@";
  elif [ -x "$script_dir/docker-compose" ]; then "$script_dir/docker-compose" "$@";
  else docker compose "$@"; fi
)
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sum=$(sha256sum "$1") || manual_die 'Cannot hash file.';
  elif command -v shasum >/dev/null 2>&1; then sum=$(shasum -a 256 "$1") || manual_die 'Cannot hash file.';
  else manual_die 'Install sha256sum or shasum.'; fi
  printf '%s\n' "${sum%% *}"
}
verify_checksums() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum -c SHA256SUMS;
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 -c SHA256SUMS;
  else manual_die 'Install sha256sum or shasum.'; fi
}
image_id() { docker image inspect "$1" --format '{{.Id}}'; }
image_platform() { docker image inspect "$1" --format '{{.Os}}/{{.Architecture}}'; }
image_revision() { docker image inspect "$1" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'; }
manual_postgres_parent() { printf '%s\n' 'postgres:18.6@sha256:86c951e05bf56c93d95d397747fb8820ac76cc3bedb78f43abd83eedbe3666ae'; }
# Children of the immutable parent above; the exact OCI index is retained in
# scripts/test/fixtures/postgres-18.6-index.json and checked against its SHA256.
# Keep parent, children and evidence together when deliberately updating PostgreSQL.
postgres_platform_ref() (
  case "$1" in
    linux/amd64) pg_child=sha256:0377e72c5289ed2f98cf61b1a9c2db9eb9d300317fe14244492fbc94343b3d04 ;;
    linux/arm64) pg_child=sha256:f4fcd2b983483177b15d72d94fb3614736211554f7cac5c2cc54a05c75110b90 ;;
    *) manual_die 'Unsupported PostgreSQL platform.' ;;
  esac
  pg_parent=$(manual_postgres_parent)
  printf '%s@%s\n' "${pg_parent%@*}" "$pg_child"
)
