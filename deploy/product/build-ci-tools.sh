#!/bin/sh
# Explicit maintenance command: build locally, never publish or deploy.
set -eu
ci_tools_image=${1:-adi-ci-tools:node24.14.1-pnpm10.33.0-local}
[ "$#" -le 1 ] || { echo 'Usage: sh deploy/product/build-ci-tools.sh [local-image-tag]' >&2; exit 2; }
ci_tools_registry=${ADI_CI_NPM_REGISTRY:-https://registry.npmjs.org/}
case "$ci_tools_registry" in
  http://*|https://*) ;;
  *) echo 'HTTP(S) npm registry required' >&2; exit 2 ;;
esac
case "$ci_tools_registry" in
  *@*|*\?*|*\#*) echo 'CI tooling build registry must not contain credentials, query or fragment' >&2; exit 2 ;;
esac
ci_tools_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ci_tools_root"
set -- docker build --platform linux/amd64 \
  --file deploy/product/Dockerfile.ci-tools \
  --build-arg "ADI_CI_NPM_REGISTRY=$ci_tools_registry" \
  --tag "$ci_tools_image"
if [ -n "${ADI_CI_BUILD_PROXY:-}" ]; then
  case "$ADI_CI_BUILD_PROXY" in http://*|https://*) ;; *) echo 'HTTP(S) build proxy required' >&2; exit 2 ;; esac
  case "$ADI_CI_BUILD_PROXY" in *@*|*\?*|*\#*) echo 'CI tooling build proxy must not contain credentials, query or fragment' >&2; exit 2 ;; esac
  # Docker's predefined proxy args are excluded from image configuration/history.
  set -- "$@" --build-arg "HTTP_PROXY=$ADI_CI_BUILD_PROXY" --build-arg "HTTPS_PROXY=$ADI_CI_BUILD_PROXY" \
    --build-arg "http_proxy=$ADI_CI_BUILD_PROXY" --build-arg "https_proxy=$ADI_CI_BUILD_PROXY"
fi
exec "$@" .
