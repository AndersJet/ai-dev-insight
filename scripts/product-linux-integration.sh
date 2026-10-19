#!/bin/sh
# Reproduce CI integration in local Docker; fixed synthetic targets only.
set -eu
suffix=$(node -e "process.stdout.write(require('node:crypto').randomUUID().slice(0,8))")
network="adi-ci-${suffix}"
postgres="adi-ci-postgres-${suffix}"
runner="adi-ci-tests-${suffix}"
cleanup() {
  docker rm -f "$runner" "$postgres" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT HUP INT TERM
docker image inspect adi-product-integration:local >/dev/null
docker network create "$network" >/dev/null
docker run -d --name "$postgres" --network "$network" --network-alias postgres-test \
  --cpus 1 --memory 1536m --tmpfs /var/lib/postgresql:rw,size=1024m \
  -e POSTGRES_USER=adi_test -e POSTGRES_PASSWORD=adi_test_local_only -e POSTGRES_DB=adi_test \
  postgres:18.6@sha256:86c951e05bf56c93d95d397747fb8820ac76cc3bedb78f43abd83eedbe3666ae \
  postgres -c max_wal_size=128MB -c min_wal_size=32MB -c checkpoint_timeout=30s >/dev/null
attempt=0
until docker exec "$postgres" pg_isready -U adi_test -d adi_test >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 80 ] || { echo 'Synthetic PostgreSQL did not start' >&2; exit 1; }
  sleep 0.25
done
docker run --rm --name "$runner" --network "$network" --cpus 2 --memory 2048m \
  -e ADI_TEST_DATABASE_URL=postgres://adi_test:adi_test_local_only@postgres-test:5432/adi_test \
  adi-product-integration:local
