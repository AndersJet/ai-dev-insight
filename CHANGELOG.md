# Changelog

## [1.0.0] - 2026-10-20

### Added

- Provide a standalone community source tree with public dependency installation, four-service container builds, and offline installation/upgrade packaging
- Include Apache-2.0 project licensing and third-party attribution in source, Web, VSIX, service images, offline packages, and native Hook materials

### Changed

- Identify unreadable or malformed offline-deployment inputs without logging their contents; preserve host-side input fingerprints in private failure logs

- Start the independent community release line at 1.0.0 for the platform, workspace packages, native Hook client, and Trae plugin
- Support Docker Compose 2.20 and newer, including current major versions and vendor version suffixes

- Allow valid email domains by default, with an optional deployment-managed allowlist
- Generalize organization-facing names and use the community plugin namespace while preserving role and data-access boundaries
- Configure native acceptance environments explicitly instead of relying on a maintainer's VM, paths, or relay addresses
- Pin reviewed dependency fixes and replace the obsolete ExcelJS decompression dependency chain

### Removed

- Remove private deployment defaults, internal publishing configuration, teaching materials, interview/specification intermediates, and operational history from the community source tree
