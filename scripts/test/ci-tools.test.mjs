import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import process from 'node:process';

const check = fileURLToPath(new URL('../../deploy/product/check-ci-tools.sh', import.meta.url));
const build = fileURLToPath(new URL('../../deploy/product/build-ci-tools.sh', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
async function tools(t, overrides = {}, missing = '') {
  const directory = await mkdtemp(join(tmpdir(), 'adi-ci-tools-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const versions = { node: 'v24.14.1', pnpm: '10.33.0', ps: 'ps from procps-ng', git: 'git version',
    openssl: 'OpenSSL', pg_dump: 'pg_dump (PostgreSQL) 18.6', pg_restore: 'pg_restore (PostgreSQL) 18.6', ...overrides };
  for (const [tool, output] of Object.entries(versions)) {
    if (tool === missing) continue;
    await writeFile(join(directory, tool), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o755 });
  }
  return directory;
}
function verify(path) {
  return spawnSync('/bin/sh', [check], { encoding: 'utf8', env: { PATH: path } });
}

test('prepared CI tools fail closed when a required executable is missing', async t => {
  const result = verify(await tools(t, {}, 'pg_restore'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing CI tool: pg_restore/);
});

for (const [tool, output, error] of [
  ['node', 'v24.14.2', /Pinned Node 24\.14\.1/],
  ['pnpm', '10.34.0', /Pinned pnpm 10\.33\.0/],
  ['pg_dump', 'pg_dump (PostgreSQL) 17.7', /PostgreSQL 18 pg_dump/],
  ['pg_restore', 'pg_restore (PostgreSQL) 17.7', /PostgreSQL 18 pg_restore/],
]) {
  test(`prepared CI tools reject incompatible ${tool}`, async t => {
    const result = verify(await tools(t, { [tool]: output }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
  });
}

test('maintenance build uses the isolated Dockerfile and amd64 target without publishing', async t => {
  const directory = await tools(t), bin = join(directory, 'bin'), record = join(directory, 'docker-args');
  await mkdir(bin);
  await writeFile(join(bin, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" > "$ADI_BUILD_RECORD"\n', { mode: 0o755 });
  const result = spawnSync('/bin/sh', [build, 'adi-ci-tools:fixture'], { encoding: 'utf8', cwd: tmpdir(),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ADI_BUILD_RECORD: record, ADI_CI_NPM_REGISTRY: 'https://registry.npmjs.org/', ADI_CI_BUILD_PROXY: '' } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readFile(record, 'utf8')).trim().split('\n'), [root, 'build', '--platform', 'linux/amd64',
    '--file', 'deploy/product/Dockerfile.ci-tools', '--build-arg', 'ADI_CI_NPM_REGISTRY=https://registry.npmjs.org/',
    '--tag', 'adi-ci-tools:fixture', '.']);
});

test('maintenance build rejects credentials or tokens in registry arguments', () => {
  for (const registry of ['https://user:secret@example.invalid/', 'https://example.invalid/?token=secret', 'https://example.invalid/#secret', 'file:///tmp/registry']) {
    const result = spawnSync('/bin/sh', [build], { encoding: 'utf8', env: { ...process.env, ADI_CI_NPM_REGISTRY: registry } });
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stdout + result.stderr, /secret/);
  }
});

test('maintenance build keeps an optional proxy in Docker predefined build arguments', async t => {
  const directory = await tools(t), bin = join(directory, 'bin'), record = join(directory, 'docker-args');
  await mkdir(bin);
  await writeFile(join(bin, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$ADI_BUILD_RECORD"\n', { mode: 0o755 });
  const result = spawnSync('/bin/sh', [build], { encoding: 'utf8', env: { ...process.env,
    PATH: `${bin}:${process.env.PATH}`, ADI_BUILD_RECORD: record, ADI_CI_NPM_REGISTRY: 'https://registry.npmjs.org/',
    ADI_CI_BUILD_PROXY: 'http://host.docker.internal:7897' } });
  assert.equal(result.status, 0, result.stderr);
  const args = (await readFile(record, 'utf8')).trim().split('\n');
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
    assert.ok(args.includes(`${name}=http://host.docker.internal:7897`));
  }
  assert.doesNotMatch(result.stdout + result.stderr, /host\.docker\.internal/);
});

test('maintenance build rejects credentials or tokens in proxy arguments', () => {
  for (const proxy of ['http://user:secret@example.invalid/', 'http://example.invalid/?token=secret', 'http://example.invalid/#secret', 'file:///tmp/proxy']) {
    const result = spawnSync('/bin/sh', [build], { encoding: 'utf8', env: { ...process.env,
      ADI_CI_NPM_REGISTRY: 'https://registry.npmjs.org/', ADI_CI_BUILD_PROXY: proxy } });
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stdout + result.stderr, /secret/);
  }
});
