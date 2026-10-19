#!/bin/sh
# Keep both browser reports in one required job, without masking cancellation.
set -eu
if [ "$#" -ne 0 ]; then
  echo 'Usage: sh deploy/product/ci-browser-tests.sh' >&2
  exit 2
fi
# Reused workspaces must not upload successful JUnit from an earlier attempt.
rm -f .run/e2e-junit.xml .run/ui-junit.xml
exec node --input-type=module <<'NODE'
import process from 'node:process';
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:os';
import { setTimeout, clearTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';

const timings = '.run/ci-step-timings.tsv';
let ownedPid, cancelled, forceTimer;
const signalCode = signal => 128 + (constants.signals[signal] ?? 1);
function signalOwned(signal) {
  if (!ownedPid) return;
  try { process.kill(-ownedPid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function groupAlive() {
  if (!ownedPid) return false;
  try { process.kill(-ownedPid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  if (process.platform !== 'linux') return true;
  // A container PID 1 may leave exited grandchildren as zombies. They cannot
  // run or receive signals; only live members of this owned group need waiting.
  for (const pid of await readdir('/proc')) {
    if (!/^[0-9]+$/.test(pid)) continue;
    let stat;
    try { stat = await readFile(`/proc/${pid}/stat`, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
    const [state, , group] = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (Number(group) === ownedPid && state !== 'Z' && state !== 'X') return true;
  }
  return false;
}
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    cancelled ??= signal;
    signalOwned(signal);
    // Arm before waiting for the shell: it may defer/ignore the first signal.
    if (ownedPid && !forceTimer) forceTimer = setTimeout(() => signalOwned('SIGKILL'), 5000);
  });
}
async function stopOwned() {
  // The group was created by this process; never signal a discovered/shared PID.
  signalOwned(cancelled ?? 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (await groupAlive() && Date.now() < deadline) await delay(25);
  if (await groupAlive()) signalOwned('SIGKILL');
  clearTimeout(forceTimer);
  forceTimer = undefined;
  ownedPid = undefined;
}
async function recordedTimings() {
  try { return await readFile(timings, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
async function run(phase, command) {
  const before = await recordedTimings();
  if (cancelled) return { code: signalCode(cancelled), stop: true };
  const child = spawn('sh', ['scripts/ci-step.sh', phase, 'pnpm', command], {
    detached: true, stdio: 'inherit'
  });
  ownedPid = child.pid;
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    await stopOwned();
  }
  if (cancelled) return { code: signalCode(cancelled), stop: true };
  if (result.signal) return { code: signalCode(result.signal), stop: true };
  // Shell/command startup failures and signal-style exits are not test verdicts.
  if (result.code === null || result.code >= 126) return { code: result.code ?? 1, stop: true };
  const after = await recordedTimings();
  const row = after.trimEnd().split('\n').at(-1);
  if (!after.startsWith(before) || after.length <= before.length ||
      !new RegExp(`^${phase}\\t[0-9]+\\t${result.code}$`).test(row)) {
    throw new Error('missing_ci_step_result');
  }
  return { code: result.code, stop: false };
}
try {
  let failure = 0;
  for (const [phase, command] of [['browser-tests', 'test:e2e'], ['ui-tests', 'test:ui']]) {
    const result = await run(phase, command);
    failure ||= result.code;
    if (result.stop) { failure = result.code; break; }
  }
  process.exitCode = cancelled ? signalCode(cancelled) : failure;
} catch {
  // Do not print command arguments, environment, or arbitrary exception text.
  console.error('CI browser verification stopped before completion');
  process.exitCode = cancelled ? signalCode(cancelled) : 1;
}
NODE
