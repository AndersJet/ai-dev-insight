import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import process from 'node:process';
import { unitTestFiles } from '../ci-check.mjs';

const timer = fileURLToPath(new URL('../ci-step.sh', import.meta.url));
const runner = fileURLToPath(new URL('../ci-check.mjs', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'adi-ci-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('phase timing preserves arguments and child failures without logging arguments or environment', async t => {
  const root = await fixture(t), secret = 'synthetic secret with spaces';
  const options = { cwd: root, encoding: 'utf8', env: { ...process.env, CI_TEST_SECRET: secret } };
  const success = spawnSync('sh', [timer, 'install', process.execPath, '-e',
    "require('node:fs').writeFileSync('argument.txt',process.argv[1])", secret], options);
  assert.equal(success.status, 0);
  assert.equal(await readFile(join(root, 'argument.txt'), 'utf8'), secret);
  const failure = spawnSync('sh', [timer, 'unit', process.execPath, '-e', 'process.exit(37)', secret], options);
  assert.equal(failure.status, 37);
  for (const result of [success, failure]) {
    assert.ok(result.stdout.includes('elapsed_seconds='));
    assert.ok(!result.stdout.includes(secret));
    assert.ok(!result.stderr.includes(secret));
    assert.ok(!result.stdout.includes('CI_TEST_SECRET'));
  }
  const rows = (await readFile(join(root, '.run/ci-step-timings.tsv'), 'utf8')).trim().split('\n');
  assert.match(rows[0], /^install\t\d+\t0$/);
  assert.match(rows[1], /^unit\t\d+\t37$/);
});

test('invalid phase names are refused before executing the command', async t => {
  const root = await fixture(t);
  const result = spawnSync('sh', [timer, 'unit\ninjected', process.execPath, '-e',
    "require('node:fs').writeFileSync('should-not-run','')"], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 2);
  await assert.rejects(readFile(join(root, 'should-not-run')), { code: 'ENOENT' });
  assert.ok(!result.stdout.includes('injected'));
});

test('engineering checks stop on the first failed gate after one workspace build', async t => {
  const root = await fixture(t), bin = join(root, 'bin'), calls = join(root, 'calls.jsonl');
  await mkdir(bin);
  await mkdir(join(root, '.run'));
  await writeFile(join(root, '.run/engineering-junit.xml'), '<testsuites tests="99" failures="0"/>');
  const pnpm = join(bin, 'pnpm');
  await writeFile(pnpm, `#!${process.execPath}\n` +
    "const fs=require('node:fs'),args=process.argv.slice(2);fs.appendFileSync(process.env.CI_TEST_CALLS,JSON.stringify(args)+'\\n');if(args[0]===process.env.CI_TEST_FAIL){process.stderr.write('synthetic-private-error-body');process.exit(37);}\n");
  await chmod(pnpm, 0o755);
  const result = spawnSync(process.execPath, [runner], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: bin + ':' + process.env.PATH,
      CI_TEST_CALLS: calls, CI_TEST_FAIL: 'typecheck:prepared' },
  });
  assert.equal(result.status, 37, result.stderr);
  const executed = (await readFile(calls, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  assert.equal(executed.filter(args => args[0] === 'build').length, 1);
  assert.ok(executed.some(args => args[0] === 'typecheck:prepared'));
  assert.ok(!executed.some(args => args[0] === 'contracts:check:prepared' || args[0] === 'test:unit:prepared'));
  const timings = await readFile(join(root, '.run/ci-step-timings.tsv'), 'utf8');
  assert.match(timings, /typecheck\t\d+\t37/);
  const report = await readFile(join(root, '.run/engineering-junit.xml'), 'utf8');
  assert.match(report, /testcase name="typecheck"/);
  assert.match(report, /failed with exit code 37/);
  assert.ok(!report.includes('tests="99"'), 'a stale success report must not survive the new run');
  assert.ok(!report.includes('synthetic-private-error-body'), 'the failure report must not copy command output');
});

test('the shared unit runner selects every legacy suite and refuses empty suites', async t => {
  const root = await fixture(t);
  const directories = ['apps/api/test', 'apps/collector/test', 'apps/worker/test', 'apps/hook-client/test',
    'packages/domain/test', 'apps/web/test', 'scripts/test', 'trae-plugin/test'];
  for (const directory of directories) {
    await mkdir(join(root, directory, 'integration'), { recursive: true });
    const filename = directory === 'scripts/test' ? 'sample.test.mjs' : 'sample.test.ts';
    await writeFile(join(root, directory, filename), '');
    await writeFile(join(root, directory, 'ignore.txt'), '');
    await writeFile(join(root, directory, 'integration', filename), '');
  }
  const selected = unitTestFiles(root);
  assert.equal(selected.length, directories.length);
  for (const directory of directories) assert.ok(selected.some(file => file.startsWith(directory + '/')));
  assert.ok(selected.every(file => !file.includes('/integration/')));
  await rm(join(root, 'apps/worker/test/sample.test.ts'));
  assert.throws(() => unitTestFiles(root), /No unit tests found/);
});


test('a failing unit command keeps its real JUnit report instead of replacing it with a gate record', async t => {
  const root = await fixture(t), bin = join(root, 'bin');
  await mkdir(bin);
  const report = '<testsuites tests="2" failures="1"><testsuite><testcase name="real unit failure"/></testsuite></testsuites>';
  const pnpm = join(bin, 'pnpm');
  await writeFile(pnpm, `#!${process.execPath}\n` +
    `if(process.argv[2]==='test:unit:prepared'){require('node:fs').writeFileSync('.run/engineering-junit.xml',${JSON.stringify(report)});process.exit(9);}`);
  await chmod(pnpm, 0o755);
  const result = spawnSync(process.execPath, [runner], { cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: bin + ':' + process.env.PATH } });
  assert.equal(result.status, 9, result.stderr);
  assert.equal(await readFile(join(root, '.run/engineering-junit.xml'), 'utf8'), report);
});


test('prepared unit execution stays serial and includes plugin failures in the same JUnit report', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(root, 'node_modules'));
  const directories = ['apps/api/test', 'apps/collector/test', 'apps/worker/test', 'apps/hook-client/test',
    'packages/domain/test', 'apps/web/test', 'scripts/test', 'trae-plugin/test'];
  for (const directory of directories) {
    await mkdir(join(root, directory), { recursive: true });
    const filename = directory === 'scripts/test' ? 'sample.test.mjs' : 'sample.test.ts';
    const plugin = directory === 'trae-plugin/test';
    await writeFile(join(root, directory, filename), `
import { test } from 'node:test';
import { open, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
test(${JSON.stringify(plugin ? 'synthetic plugin failure' : directory)}, async () => {
  const guard = await open('.run/serial.lock', 'wx');
  try { await delay(100); ${plugin ? "assert.fail('synthetic plugin failure');" : ''} }
  finally { await guard.close(); await unlink('.run/serial.lock'); }
});
`);
  }
  const environment = { ...process.env, ADI_UNIT_JUNIT: 'true' };
  // This is a fresh CLI run, not a child already owned by node:test.
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [runner, '--unit'], { cwd: root, encoding: 'utf8', env: environment });
  assert.equal(result.status, 1, result.stderr);
  const report = await readFile(join(root, '.run/engineering-junit.xml'), 'utf8');
  assert.equal((report.match(/<testcase /g) ?? []).length, directories.length);
  assert.equal((report.match(/<failure /g) ?? []).length, 1, 'only the intentional plugin failure is allowed');
  assert.match(report, /synthetic plugin failure/);
  assert.ok(!report.includes('EEXIST'), 'unit files must not run concurrently');
});
