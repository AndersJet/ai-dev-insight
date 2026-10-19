#!/bin/sh
# Disposable Debian CI job only. Not a host/production provisioning command.
# Primary source: https://www.postgresql.org/download/linux/debian/
set -eu
[ "${CI:-}" = true ] && [ "$(id -u)" = 0 ] || { echo 'Disposable root CI container required' >&2; exit 1; }
. /etc/os-release
case "$VERSION_CODENAME" in bookworm|trixie) ;; *) echo 'Unsupported CI distribution' >&2; exit 1 ;; esac
. "$(dirname "$0")/prepare-ci-apt.sh"
export DEBIAN_FRONTEND=noninteractive
apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o "Acquire::https::CAInfo=$ADI_CI_APT_CA_FILE" -o Acquire::https::Verify-Peer=true -o Acquire::https::Verify-Host=true update -qq
apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o "Acquire::https::CAInfo=$ADI_CI_APT_CA_FILE" -o Acquire::https::Verify-Peer=true -o Acquire::https::Verify-Host=true install -y --no-install-recommends ca-certificates curl
install -d /usr/share/postgresql-common/pgdg
curl --fail --silent --show-error --location --connect-timeout 15 --max-time 60 https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
cat > /etc/apt/sources.list.d/adi-pgdg.sources <<SOURCES
Types: deb
URIs: https://apt.postgresql.org/pub/repos/apt
Suites: ${VERSION_CODENAME}-pgdg
Components: main
Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
SOURCES
apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o "Acquire::https::CAInfo=$ADI_CI_APT_CA_FILE" -o Acquire::https::Verify-Peer=true -o Acquire::https::Verify-Host=true update -qq
apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o "Acquire::https::CAInfo=$ADI_CI_APT_CA_FILE" -o Acquire::https::Verify-Peer=true -o Acquire::https::Verify-Host=true install -y --no-install-recommends postgresql-client-18
pg_dump --version
pg_restore --version
