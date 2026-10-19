#!/bin/sh
# Offline startup gate: a prepared image must not install anything in a CI job.
set -eu
for ci_tool in node pnpm ps git openssl pg_dump pg_restore; do
  command -v "$ci_tool" >/dev/null 2>&1 || { echo "Missing CI tool: $ci_tool" >&2; exit 1; }
done
[ "$(node --version)" = v24.14.1 ] || { echo 'Pinned Node 24.14.1 CI runtime required' >&2; exit 1; }
[ "$(pnpm --version)" = 10.33.0 ] || { echo 'Pinned pnpm 10.33.0 required' >&2; exit 1; }
case "$(pg_dump --version)" in 'pg_dump (PostgreSQL) 18.'*) ;; *) echo 'PostgreSQL 18 pg_dump required' >&2; exit 1 ;; esac
case "$(pg_restore --version)" in 'pg_restore (PostgreSQL) 18.'*) ;; *) echo 'PostgreSQL 18 pg_restore required' >&2; exit 1 ;; esac
[ -s /etc/ssl/certs/ca-certificates.crt ] || { echo 'Public CA certificate store required' >&2; exit 1; }
ps --version
git --version
openssl version
node --version
pnpm --version
pg_dump --version
pg_restore --version
