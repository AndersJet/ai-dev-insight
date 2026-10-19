# Changelog

## [Unreleased]

### Added

- Provide a standalone community source tree with public dependency installation, four-service container builds, and offline installation/upgrade packaging
- Include Apache-2.0 project licensing and third-party attribution in source, Web, VSIX, service images, offline packages, and native Hook materials

### Changed

- Allow valid email domains by default, with an optional deployment-managed allowlist
- Generalize organization-facing names and use the community plugin namespace while preserving role and data-access boundaries
- Configure native acceptance environments explicitly instead of relying on a maintainer's VM, paths, or relay addresses
- Pin reviewed dependency fixes and replace the obsolete ExcelJS decompression dependency chain

### Removed

- Remove private deployment defaults, internal publishing configuration, teaching materials, interview/specification intermediates, and operational history from the community source tree
