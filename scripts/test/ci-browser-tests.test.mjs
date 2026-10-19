import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const runner = fileURLToPath(new URL('../../deploy/product/ci-browser-tests.sh', import.meta.url));
const timer = fileURLToPath(new URL('../ci-step.sh', import.meta.url));
const posix = { skip: process.platform === 'win32', timeout: 15000 };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'adi-ci-browser-')), bin = join(root, 'bin');
  await mkdir(bin); await mkdir(join(root, 'scripts'));
  await copyFile(timer, join(root, 'scripts/ci-step.sh'));
  for (const [name, path] of [['node', process.execPath], ['sh', '/bin/sh'], ['date', '/bin/date'], ['mkdir', '/bin/mkdir'], ['rm', '/bin/rm']]) {
    await symlink(path, join(bin, name));
  }
  await writeFile(join(bin, 'pnpm'), `#!${process.execPath}
import process from 'node:process';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const command = process.argv[2];
appendFileSync('calls.txt', command + '\\n');
mkdirSync('.run', { recursive: true });
if (command === 'test:e2e' && process.env.FIXTURE_SIGNAL) process.kill(process.pid, process.env.FIXTURE_SIGNAL);
else if (command === 'test:e2e' && process.env.FIXTURE_WAIT === 'true') {
  const worker = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{if(process.env.FIXTURE_STUBBORN!=='true')process.exit(0)});process.on('SIGINT',()=>{if(process.env.FIXTURE_STUBBORN!=='true')process.exit(0)});process.send('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  worker.on('message', () => writeFileSync('owned.json', JSON.stringify([process.pid, worker.pid])));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    if (process.env.FIXTURE_STUBBORN !== 'true') worker.once('exit', () => process.exit(0));
  });
  setInterval(() => {}, 1000);
} else {
  const status = Number(process.env[command === 'test:e2e' ? 'FIXTURE_E2E_EXIT' : 'FIXTURE_UI_EXIT'] ?? 0);
  writeFileSync('.run/' + (command === 'test:e2e' ? 'e2e' : 'ui') + '-junit.xml', '<testsuite name="' + command + '" failures="' + (status ? 1 : 0) + '"><testcase name="fixture">' + (status ? '<failure message="fixture_exit_' + status + '"/>' : '') + '</testcase></testsuite>');
  process.exit(status);
}
`, { mode: 0o755 });
  t.after(async () => {
    try {
      for (const pid of JSON.parse(await readFile(join(root, 'owned.json'), 'utf8'))) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(root, { recursive: true, force: true });
  });
  return { root, bin };
}
function launch(t, f, env = {}, args = []) {
  const child = spawn('sh', [runner, ...args], { cwd: f.root,
    env: { ...process.env, PATH: f.bin, SYNTHETIC_SECRET: 'synthetic-private-value', ...env } });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal, output }));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return { child, exited };
}
async function calls(f) {
  try { return (await readFile(join(f.root, 'calls.txt'), 'utf8')).trim().split('\n'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function report(f, kind) { return readFile(join(f.root, `.run/${kind}-junit.xml`), 'utf8'); }
async function staleReports(f) {
  await mkdir(join(f.root, '.run'), { recursive: true });
  for (const kind of ['e2e', 'ui']) await writeFile(join(f.root, `.run/${kind}-junit.xml`), '<testsuite name="old_success"/>');
}
async function noReports(f) {
  for (const kind of ['e2e', 'ui']) await assert.rejects(report(f, kind), { code: 'ENOENT' });
}
for (const [name, e2e, ui, code] of [['success', 0, 0, 0], ['E2E failure', 7, 0, 7], ['UI failure', 0, 9, 9], ['both failures', 7, 9, 7]]) {
  test(`browser verification keeps both reports and real exit codes after ${name}`, posix, async t => {
    const f = await fixture(t), result = await launch(t, f, { FIXTURE_E2E_EXIT: String(e2e), FIXTURE_UI_EXIT: String(ui) }).exited;
    assert.equal(result.code, code, result.output); assert.equal(result.signal, null);
    assert.deepEqual(await calls(f), ['test:e2e', 'test:ui']);
    const rows = (await readFile(join(f.root, '.run/ci-step-timings.tsv'), 'utf8')).trim().split('\n').map(row => row.split('\t'));
    assert.deepEqual(rows.map(([phase, , status]) => [phase, Number(status)]), [['browser-tests', e2e], ['ui-tests', ui]]);
    assert.ok(rows.every(([, seconds]) => /^\d+$/.test(seconds)));
    for (const [kind, status] of [['e2e', e2e], ['ui', ui]]) {
      const xml = await report(f, kind);
      assert.ok(xml.includes(`failures="${status ? 1 : 0}"`));
      assert.equal(xml.includes('<failure '), status !== 0);
      if (status) assert.ok(xml.includes(`fixture_exit_${status}`));
    }
    assert.ok(!result.output.includes('synthetic-private-value'));
  });
}
test('retry reruns both test groups and replaces failed results with the current successful reports', posix, async t => {
  const f = await fixture(t);
  const first = await launch(t, f, { FIXTURE_E2E_EXIT: '7' }).exited;
  assert.equal(first.code, 7, first.output); assert.match(await report(f, 'e2e'), /fixture_exit_7/);
  const second = await launch(t, f).exited;
  assert.equal(second.code, 0, second.output);
  assert.deepEqual(await calls(f), ['test:e2e', 'test:ui', 'test:e2e', 'test:ui']);
  const rows = (await readFile(join(f.root, '.run/ci-step-timings.tsv'), 'utf8')).trim().split('\n').map(row => row.split('\t'));
  assert.deepEqual(rows.map(([phase, , status]) => [phase, Number(status)]), [['browser-tests', 7], ['ui-tests', 0], ['browser-tests', 0], ['ui-tests', 0]]);
  for (const kind of ['e2e', 'ui']) {
    assert.match(await report(f, kind), /failures="0"/);
    assert.doesNotMatch(await report(f, kind), /fixture_exit_7|old_success|<failure /);
  }
});
test('unexpected arguments are rejected without logging their values or running tests', posix, async t => {
  const f = await fixture(t), secret = 'synthetic-argument-value';
  const result = await launch(t, f, {}, [secret]).exited;
  assert.equal(result.code, 2); assert.deepEqual(await calls(f), []);
  assert.ok(!result.output.includes(secret)); assert.ok(!result.output.includes('synthetic-private-value'));
});
test('a missing pnpm runtime stops before starting the next test group', posix, async t => {
  const f = await fixture(t); await staleReports(f); await rm(join(f.bin, 'pnpm'));
  const result = await launch(t, f).exited;
  assert.equal(result.code, 127, result.output); assert.deepEqual(await calls(f), []);
  assert.match(await readFile(join(f.root, '.run/ci-step-timings.tsv'), 'utf8'), /^browser-tests\t\d+\t127\n$/);
  await noReports(f);
});
test('a missing Node runtime leaves no JUnit from a previous attempt', posix, async t => {
  const f = await fixture(t); await staleReports(f); await rm(join(f.bin, 'node'));
  const result = await launch(t, f).exited;
  assert.equal(result.code, 127, result.output); assert.deepEqual(await calls(f), []);
  await noReports(f);
});
test('an unexpected ci-step shell failure is not treated as an ordinary E2E result', posix, async t => {
  const f = await fixture(t); await staleReports(f); await writeFile(join(f.root, 'scripts/ci-step.sh'), 'if then\n');
  const result = await launch(t, f).exited;
  assert.equal(result.code, 1, result.output); assert.deepEqual(await calls(f), []);
  assert.match(result.output, /CI browser verification stopped before completion/);
  await noReports(f);
});
test('a signal exit from E2E is preserved and does not start UI', posix, async t => {
  const f = await fixture(t), result = await launch(t, f, { FIXTURE_SIGNAL: 'SIGTERM' }).exited;
  assert.equal(result.code, 143, result.output); assert.deepEqual(await calls(f), ['test:e2e']);
});
async function ownedPids(f) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    try { return JSON.parse(await readFile(join(f.root, 'owned.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(20);
  }
  throw new Error('fixture_start_timeout');
}
async function processState(pid) {
  if (process.platform !== 'linux') {
    try { process.kill(pid, 0); return 'running'; }
    catch (error) { if (error.code === 'ESRCH') return 'gone'; throw error; }
  }
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    assert.match(state, /^[A-Z]$/);
    return state;
  } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return 'gone'; throw error; }
}
const exitedState = state => state === 'gone' || state === 'Z' || state === 'X';
async function assertNotRunning(pid) {
  const deadline = Date.now() + 1000;
  let state = await processState(pid);
  while (!exitedState(state) && Date.now() < deadline) {
    await delay(20); state = await processState(pid);
  }
  assert.ok(exitedState(state), `Owned PID ${pid} is still running (state ${state})`);
}
for (const [signal, code, stubborn] of [['SIGTERM', 143, false], ['SIGINT', 130, false], ['SIGTERM', 143, true], ['SIGINT', 130, true]]) {
  test(`${signal} cancellation kills owned descendants${stubborn ? ' after a bounded grace period' : ''} and preserves unrelated processes`, posix, async t => {
    const f = await fixture(t); await staleReports(f);
    const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const foreignExit = once(foreign, 'exit');
    t.after(async () => { foreign.kill('SIGKILL'); await foreignExit; });
    if (stubborn) await writeFile(join(f.root, 'scripts/ci-step.sh'), "trap '' TERM INT\n" + await readFile(timer, 'utf8'));
    const running = launch(t, f, { FIXTURE_WAIT: 'true', FIXTURE_STUBBORN: String(stubborn) }), pids = await ownedPids(f);
    for (const pid of pids) assert.ok(!exitedState(await processState(pid)), 'The owned process must be running before cancellation');
    running.child.kill(signal);
    const result = await running.exited;
    assert.equal(result.code, code, result.output); assert.deepEqual(await calls(f), ['test:e2e']);
    await noReports(f);
    for (const pid of pids) await assertNotRunning(pid);
    assert.ok(!exitedState(await processState(foreign.pid)), 'The unrelated process must still be running');
  });
}
