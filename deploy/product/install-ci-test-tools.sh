#!/bin/sh
# Only prepare the disposable Linux CI container, never a host or production.
set -eu
[ "${CI:-}" = true ] && [ "$(id -u)" = 0 ] || { echo 'Disposable root CI container required' >&2; exit 1; }
. /etc/os-release
case "$VERSION_CODENAME" in bookworm|trixie) ;; *) echo 'Unsupported CI distribution' >&2; exit 1 ;; esac
. "$(dirname "$0")/prepare-ci-apt.sh"
export DEBIAN_FRONTEND=noninteractive
timeout 150 apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o "Acquire::https::CAInfo=$ADI_CI_APT_CA_FILE" -o Acquire::https::Verify-Peer=true -o Acquire::https::Verify-Host=true update -qq
timeout 150 apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o "Acquire::https::CAInfo=$ADI_CI_APT_CA_FILE" -o Acquire::https::Verify-Peer=true -o Acquire::https::Verify-Host=true install -y --no-install-recommends procps git openssl ca-certificates
ps --version
git --version
openssl version
