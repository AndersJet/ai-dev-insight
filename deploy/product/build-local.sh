#!/bin/sh
# Build and verify a clean local release; retain images for offline packaging.
set -eu
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
platform=linux/amd64
prefix=local/ai-dev-insight
registry=https://registry.npmjs.org/
while [ "$#" -gt 0 ]; do
  case "$1" in
    --platform|--image-prefix|--registry)
      [ "$#" -ge 2 ] || { echo 'Missing option value' >&2; exit 2; }
      case "$1" in --platform) platform=$2 ;; --image-prefix) prefix=$2 ;; --registry) registry=$2 ;; esac
      shift 2 ;;
    -h|--help) echo 'Usage: sh deploy/product/build-local.sh [--platform linux/amd64|linux/arm64] [--image-prefix local/ai-dev-insight] [--registry PUBLIC_NPM_URL]'; exit 0 ;;
    *) echo 'Unknown build option' >&2; exit 2 ;;
  esac
done
mkdir -p .run
report=.run/local-product-images.txt
rm -f "$report"
case "$platform" in linux/amd64|linux/arm64) ;; *) echo 'Unsupported platform' >&2; exit 2 ;; esac
printf '%s\n' "$prefix" | LC_ALL=C grep -Eq '^[a-z0-9.-]+(:[0-9]+)?/[a-z0-9._/-]+$' || { echo 'Invalid image prefix' >&2; exit 2; }
case "$registry" in http://*|https://*) ;; *) echo 'HTTP(S) npm registry required' >&2; exit 2 ;; esac
case "$registry" in *@*|*\?*|*\#*|*[[:space:]]*) echo 'Registry must not contain credentials, query, fragment or whitespace' >&2; exit 2 ;; esac
revision=$(git rev-parse --verify HEAD 2>/dev/null) || { echo 'Commit the reviewed source before building release images' >&2; exit 1; }
printf '%s\n' "$revision" | LC_ALL=C grep -Eq '^[a-f0-9]{40}$' || { echo 'Full commit identity required' >&2; exit 1; }
[ -z "$(git status --porcelain --untracked-files=normal)" ] || { echo 'A clean working tree is required for release images' >&2; exit 1; }
docker info >/dev/null
temporary=$(mktemp .run/local-product-images.XXXXXX)
cleanup() { status=$?; trap - EXIT INT TERM; rm -f "$temporary"; exit "$status"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
architecture=${platform#linux/}
printf 'commit %s architecture %s\n' "$revision" "$architecture" > "$temporary"
for target in api collector worker web; do
  image="$prefix-$target:$revision"
  docker build --platform "$platform" --target "$target" --tag "$image" \
    --label "org.opencontainers.image.revision=$revision" \
    --label "org.opencontainers.image.version=$revision" \
    --build-arg "ADI_CI_NPM_REGISTRY=$registry" --file deploy/product/Dockerfile .
  [ "$(docker image inspect "$image" --format '{{.Architecture}}')" = "$architecture" ] || { echo 'Image architecture mismatch' >&2; exit 1; }
  [ "$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$revision" ] || { echo 'Image revision mismatch' >&2; exit 1; }
  if [ "$target" = web ]; then
    docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --platform "$platform" "$image" -v
  else
    node_arch=$(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --platform "$platform" "$image" node -p process.arch)
    case "$architecture:$node_arch" in amd64:x64|arm64:arm64) ;; *) echo 'Node architecture mismatch' >&2; exit 1 ;; esac
  fi
  identity=$(docker image inspect "$image" --format '{{.Id}}')
  printf '%s\n' "$identity" | LC_ALL=C grep -Eq '^sha256:[a-f0-9]{64}$' || { echo 'Image identity required' >&2; exit 1; }
  printf '%s %s %s\n' "$image" "$identity" "$architecture" >> "$temporary"
done
[ "$(git rev-parse HEAD)" = "$revision" ] && [ -z "$(git status --porcelain --untracked-files=normal)" ] || { echo 'Source changed during build' >&2; exit 1; }
mv "$temporary" "$report"
cat "$report"
