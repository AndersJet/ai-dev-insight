# Contributing

Use GitHub Issues to describe reproducible bugs or discuss a feature before making a large change. Include expected behavior, actual behavior, minimal reproduction steps, and relevant platform/version details. Use synthetic data.

## Development checks

```sh
pnpm install --frozen-lockfile
make test
make test-db-up
pnpm test:integration
pnpm test:e2e
pnpm test:ui
make test-db-down
```

Database tests only accept the dedicated synthetic database on local port 55438 (or the explicit CI test service) and create isolated schemas. The database is temporary; stopping it discards test data. Real native IDE tests are opt-in and have separate setup.

Keep changes focused. Add behavior-level regression coverage when changing authentication, collection, data handling, or packaging. Report skipped and untested paths explicitly. Do not weaken assertions or remove working functionality merely to make a check pass.

When dependencies change, update the frozen lockfile, run `pnpm notices:generate`, and review the generated third-party materials. Preserve existing copyright and attribution. Commit source and required generated contracts/notices together; do not commit build caches or test secrets.

## Pull requests

Explain the problem, resulting behavior, compatibility impact, and validation performed. Separate engineering, database, browser, image, and real-device evidence. Screenshots should contain synthetic data only.

## License

Contributions are provided under the project's [Apache-2.0 license](LICENSE), unless a contribution explicitly identifies independently licensed third-party material. Preserve that material's terms and notices.
