import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import process from 'node:process';

const prepare = fileURLToPath(new URL('../../deploy/product/prepare-ci-apt.sh', import.meta.url));
const original = 'Types: deb\nURIs: http://deb.debian.org/debian\nSuites: bookworm bookworm-updates\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n\nTypes: deb\nURIs: http://deb.debian.org/debian-security\nSuites: bookworm-security\nComponents: main\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n';
async function fixture(t, source = original) {
  const directory = await mkdtemp(join(tmpdir(), 'adi-ci-apt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, 'debian.sources'), program = join(directory, 'prepare.mjs'), loader = join(directory, 'redirect.mjs'), ca = join(directory, 'public-ca.pem');
  await writeFile(input, source);
  // Run the real embedded transformation, redirecting only its fixed system path
  // into a fixture. The shell's host/container guards are verified separately.
  const script = (await readFile(prepare, 'utf8')).match(/<<'NODE'\n([\s\S]+)\nNODE\n?$/);
  assert.ok(script, 'APT preparation must expose its embedded Node transformation');
  await writeFile(program, script[1]);
  await writeFile(loader, `import fs from 'node:fs';\nimport {syncBuiltinESMExports} from 'node:module';\nconst input=${JSON.stringify(input)},read=fs.readFileSync,write=fs.writeFileSync;\nconst redirect=path=>path==='/etc/apt/sources.list.d/debian.sources'?input:path;\nfs.readFileSync=(path,...args)=>read(redirect(path),...args);\nfs.writeFileSync=(path,...args)=>write(redirect(path),...args);\nsyncBuiltinESMExports();\n`);
  return { input, ca, run(selection = '') {
    return spawnSync(process.execPath, ['--import', loader, program, ca], { encoding: 'utf8', env: { ...process.env, ADI_CI_APT_SOURCE: selection } });
  } };
}

test('APT preparation defaults to TUNA HTTPS and preserves signed archive configuration', async t => {
  const subject = await fixture(t), result = subject.run();
  assert.equal(result.status, 0, result.stderr);
  const updated = await readFile(subject.input, 'utf8');
  assert.match(updated, /URIs: https:\/\/mirrors\.tuna\.tsinghua\.edu\.cn\/debian\n/);
  assert.match(updated, /URIs: https:\/\/mirrors\.tuna\.tsinghua\.edu\.cn\/debian-security\n/);
  assert.deepEqual(updated.match(/^Signed-By:.+$/gm), original.match(/^Signed-By:.+$/gm));
  assert.match(await readFile(subject.ca, 'utf8'), /BEGIN CERTIFICATE/);
});

test('APT preparation explicitly selects official HTTPS sources and is idempotent', async t => {
  const subject = await fixture(t), first = subject.run('official');
  assert.equal(first.status, 0, first.stderr);
  const once = await readFile(subject.input, 'utf8');
  assert.match(once, /URIs: https:\/\/deb\.debian\.org\/debian\n/);
  assert.match(once, /URIs: https:\/\/security\.debian\.org\/debian-security\n/);
  assert.equal(subject.run('official').status, 0);
  assert.equal(await readFile(subject.input, 'utf8'), once);
  assert.equal(subject.run().status, 0);
  assert.match(await readFile(subject.input, 'utf8'), /mirrors\.tuna\.tsinghua\.edu\.cn/);
});

test('APT preparation rejects an unknown selection before rewriting sources', async t => {
  const subject = await fixture(t), result = subject.run('https://arbitrary.example.invalid/');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported CI APT source/);
  assert.equal(await readFile(subject.input, 'utf8'), original);
});

for (const [name, uri] of [
  ['unknown mirror', 'https://arbitrary.example.invalid/debian'],
  ['multiple URIs', 'http://deb.debian.org/debian https://arbitrary.example.invalid/debian'],
  ['URI continuation', 'http://deb.debian.org/debian\n https://arbitrary.example.invalid/debian'],
]) {
  test(`APT preparation rejects ${name} without rewriting its input`, async t => {
    const source = original.replace('http://deb.debian.org/debian\n', uri + '\n'), subject = await fixture(t, source), result = subject.run('official');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Expected one supported Debian/);
    assert.equal(await readFile(subject.input, 'utf8'), source);
  });
}

test('APT preparation refuses invocation outside an explicitly marked CI environment', () => {
  const result = spawnSync('/bin/sh', [prepare], { encoding: 'utf8', env: { ...process.env, CI: 'false' } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Disposable root Docker CI container required/);
});
