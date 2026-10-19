# Build and deployment

## Source build

Use Node.js 24 and pnpm 10.33.0:

```sh
pnpm install --frozen-lockfile
make test
pnpm build
```

The default npm source is public. The lockfile is frozen during installation. Required generated contracts and legal materials are part of the source tree; regenerate them when changing contracts/dependencies.

The build creates the Web frontend, service packages, native Hook template and the main/Remote SSH helper VSIX files. Install `trae-plugin/dist/adi-project-tracker-1.0.6.vsix` through Trae's VSIX installation flow, then configure your deployment's root URL.

## Four service images

Use a clean, reviewed commit so each image has an unambiguous source identity:

```sh
make images IMAGE_PLATFORM=linux/amd64
# For an arm64 deployment:
make images IMAGE_PLATFORM=linux/arm64
```

Default tags are `local/ai-dev-insight-{api,collector,worker,web}:FULL_COMMIT_SHA`. All four retain the same revision/version labels. The command checks image architecture, revision, content ID and basic execution in network-disabled read-only containers.

Only a complete run writes `.run/local-product-images.txt`. A failed/partial run cannot produce a complete success manifest. Images remain local for offline export; the command performs no registry login, push or deployment.

Set `IMAGE_PREFIX` to change local names. The script also accepts `--registry` for a public or operator-controlled npm proxy; do not include credentials in its URL.

## Offline installation and upgrade packages

Use the same platform and prefix as the image build:

```sh
revision=$(git rev-parse HEAD)
sh deploy/manual/export-images.sh --local --tag "$revision" --platform linux/amd64 --kind install
sh deploy/manual/export-images.sh --local --tag "$revision" --platform linux/amd64 --kind upgrade
```

The output directory is `deploy/manual/offline/`. An install package includes the four application images and the pinned PostgreSQL platform image; the build machine needs access to the public database image. Upgrade packages contain the application images only.

Export verifies matching revision, architecture and image identity. Packages include file checksums, empty configuration templates and legal materials. They do not include the build machine's private `.env`.

For your own registry, explicitly supply `--image-prefix` and a verified tag. No maintainer registry address or account is preconfigured.

## First deployment

The target is Linux amd64/arm64 with Docker, Bash and Docker Compose 2.20 or newer, plus the tools listed in [deployment operations](../deploy/manual/README.md). Transfer the install package, follow that document, and use a fresh environment directory.

Configure a deployment-managed administrator, random database/application passwords, Web origin and collection URL. `ADI_EMAIL_DOMAINS` is empty by default; a comma-separated list restricts account admission. A domain allowlist does not verify mailbox ownership.

Verify initialization, service readiness, login/roles, plugin connection, synthetic event persistence and derivation separately. Readiness alone does not establish end-to-end collection.

## Local offline-package acceptance on macOS

A macOS machine can exercise these packages through its Linux Docker engine. On Apple Silicon, build and export `linux/arm64`; the services still run as Linux containers. Use Docker Compose 2.20 or newer, including current 5.x releases.

Use a private configuration based on `deploy/manual/.env.example`. Set a unique `COMPOSE_PROJECT_NAME`, unused Web/Collector ports, loopback Web binding and matching public URLs. Keep the filled configuration outside the source tree. Use a new absolute deployment directory visible to Docker:

```sh
bash /path/to/install.run install --env test --root /absolute/offline-test --config /absolute/private/test.env
bash /path/to/upgrade.run upgrade --env test --root /absolute/offline-test
bash /path/to/upgrade.run status --env test --root /absolute/offline-test
```

Use the actual generated package filenames. The root must be a separate directory without spaces. If the default temporary directory is not shared with Docker, set `TMPDIR` to a private writable directory that is shared. The deployment entry point uses the packaged images without registry access; package creation itself needs the source dependencies and pinned base/database images.

For a version-transition check, install an earlier reviewed community commit, create synthetic accounts and Hook sessions, then upgrade to the target commit. Verify browser login, old and new sessions, unchanged data-volume identities and credentials, plus the complete pre-upgrade backup. Also test the target install package in a separate fresh environment. Do not use real employee data or a live deployment for this exercise. macOS Docker acceptance does not establish production Linux or real Trae IDE compatibility.

## Upgrades and recovery

Preserve the actual Compose project name, database volume, credential-key volume and cleanup journal. Back up before upgrading. Do not use `down -v` as an upgrade step, modify applied migration checksums, or reopen a restored dataset without its recovery checks.

See [advanced operations](../deploy/manual/REFERENCE.md) for dataset isolation and recovery boundaries. Container builds, offline-package checks and target-device acceptance are separate results.
