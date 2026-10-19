# Development

Use the Node version in [.node-version](.node-version) and the pnpm version in [package.json](package.json). The workspace uses Node.js/TypeScript, PostgreSQL 18, Vue 3, and a separate Trae extension.

## Workspace

| Directory | Responsibility |
| --- | --- |
| `apps/web` | Web UI, role-specific operating manuals, browser tests |
| `apps/api` | Authenticated HTTP API, administration, maintenance CLI |
| `apps/collector` | Bounded Hook HTTP intake and persistence consumer |
| `apps/worker` | Derivation, import, usage, cleanup and maintenance jobs |
| `apps/hook-client` | Standalone native Hook package |
| `packages/contracts` | Runtime schemas, shared types and generated OpenAPI |
| `packages/domain` | Business rules, identity and access boundaries |
| `packages/storage` | PostgreSQL access, migrations, partitions and recovery |
| `trae-plugin` | Local UI, authenticated platform access and SSH helper |
| `deploy` | Product images, deployment configuration and offline tools |

Web/contracts must not depend on backend runtime implementations. Keep published SQL migrations immutable. Internal identifiers such as `anc_admin` and `nt_email` remain wire/storage compatibility identifiers; user-facing organization wording is generic.

## Install and compile

```sh
pnpm install --frozen-lockfile
make test
pnpm build
```

No database, provider credential or `.env` is required for compilation. `make test` runs Lint, build, typechecking, generated-contract checks and engineering unit tests. It does not run PostgreSQL or browser suites.

After contract changes, run `pnpm contracts:generate` and include the resulting OpenAPI changes. After dependency changes, update the lockfile and run `pnpm notices:generate`.

## Local application database

Use an existing PostgreSQL 18 instance or the optional [database Compose file](deploy/product/compose.database.yml). A deployment-managed administrator and application database/schema are required. The application role needs access to `public.btree_gist` and `public.pg_trgm`; the supplied first-start SQL creates them for a fresh Compose database.

For the supplied database Compose setup:

1. Copy `.env.example` to a private `.env`.
2. Add `ADI_PG_ADMIN_PASSWORD`, `ADI_APP_DB_PASSWORD`, and an absolute `ADI_PG_DATA_DIR` pointing to a newly created dedicated directory. Use separate random passwords; hex passwords avoid URI escaping mistakes.
3. Set `ADI_DATABASE_URL` to the matching `adi_app` connection on local port 55432, database `adi`. Fill `ADI_ADMIN_EMAIL` and `ADI_ADMIN_PASSWORD`.
4. Create the external Docker network named `adi` if it does not already exist, then start the database:

```sh
docker compose --env-file .env -p ai-dev-insight-dev-db -f deploy/product/compose.database.yml up -d --wait
make dev
```

`make dev` initializes/migrates the configured application schema, synchronizes the configured administrator and starts the local applications. It does not create the database instance. Use an empty application schema for first startup; do not point experiments at real organizational data.

`make stop` stops this project's owned application processes and preserves the database. Development logs are under `.run/`. Keep real `.env`, credential keys, journals and backups out of Git.

## Automated validation

```sh
make test-db-up
pnpm test:integration
pnpm test:e2e
pnpm test:ui
make test-db-down
```

Integration/E2E helpers only accept the dedicated synthetic `adi_test` database on local port 55438, or the explicit CI service. PostgreSQL tests use isolated schemas. Run real database suites sequentially; do not share their database with manual experiments. Stopping the test database discards its temporary data.

Browser tests use Playwright. If the required browser is unavailable, install it with `pnpm exec playwright install chromium`; local macOS configuration can use the standard Chrome application. E2E exercises real application services; UI suites use synthetic HTTP fixtures. Keep their results distinct.

Native macOS/Windows and real IDE tests have additional platform/fixture requirements. Passing a simulated process or browser test is not a claim of Trae device acceptance.

## Opt-in native environments

No maintainer VM or personal home directory is configured by default. Real Parallels checks require `ADI_TEST_PARALLELS_WINDOWS=1`, an isolated ordinary-user VM, and explicit settings:

| Variable | Meaning |
| --- | --- |
| `ADI_TEST_PARALLELS_VM` | Plain UUID of the isolated VM |
| `ADI_TEST_PARALLELS_HOST_IP` | Private IPv4 address on which the host relay binds |
| `ADI_TEST_PARALLELS_GUEST_IP` | Exact allowed guest private IPv4 address |
| `ADI_TEST_WINDOWS_GIT_DIR` | Optional guest directory containing git.exe; otherwise resolved in the guest |
| `ADI_PLUGIN_TEST_SERVER` | Isolated HTTP origin for the native acceptance host; set in that host's environment |
| `ADI_WINDOWS_FIXTURE_ROOT` | Exact isolated Windows fixture root expected by the host-side verifier |

Relay helpers accept HTTP loopback/private-address origins and retain owned-fixture and ordinary-user checks. Production platform URLs retain HTTP/HTTPS support. Do not reuse an employee's real profile for fixture tests.

## Dependencies and legal materials

The reviewed overrides pin `source-map-js@1.2.2`, `exceljs>uuid@11.1.1`, and `exceljs>unzipper@0.12.3`. They address the [source-map advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), [uuid advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq), and the obsolete decompression chain whose package archives lacked clear license material. ExcelJS usage is validated through real workbook/import tests.

`pnpm notices:generate` reads installed locked packages rather than optional pnpm global-store indexes. It preserves original texts, author metadata, and the provenance of supplements under `third_party/`. The `lodash-unified` supplement explicitly records its published MIT declaration and author and labels the supplied standard terms.

Web, both VSIX components, service runtimes, offline packages and native Hook ZIPs carry their appropriate licensing materials. When changing archive contents, update every producer/consumer allowlist and verify real packaged artifacts.

## Images and deployment

See [docs/build.md](docs/build.md). Release-image tooling requires a clean committed source tree and writes a success manifest only after four-image checks complete. Local uncommitted Dockerfile experiments are candidate checks and must not be presented as a verified commit release.

Public CI hosting and binary publication are not implicitly enabled by the local build commands.
