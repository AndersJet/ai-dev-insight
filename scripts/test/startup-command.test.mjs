import { URL } from 'node:url';
import process from 'node:process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {runStartup} from '../lib/startup-command.mjs';

test('cancelling startup kills an uncooperative command group and never runs the next stage', { timeout: 5000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adi-start-')); t.after(() => rm(dir, { recursive: true, force: true })); const marker = join(dir, 'child.pid');
  const command = `require('node:fs').writeFileSync(process.env.MARKER,String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  const code = `import {runStartup} from ${JSON.stringify(new URL('../lib/startup-command.mjs', import.meta.url).href)};try {await runStartup(process.execPath,['-e',${JSON.stringify(command)}],{MARKER:${JSON.stringify(marker)}},100);process.stdout.write('SHOULD_NOT_RUN');}catch{process.exitCode=1;}`;
  const parent = spawn(process.execPath, ['--input-type=module','-e',code], { env: {}, stdio: ['ignore','pipe','pipe'] });
  let output = ''; parent.stdout.on('data', value => { output += String(value); }); const exited = once(parent, 'exit');
  t.after(async () => { if (parent.exitCode === null && parent.signalCode === null) { parent.kill('SIGTERM'); await exited; } });
  let pid = 0; for (let n = 0; n < 100 && !pid; n++) { try { pid = Number(await readFile(marker, 'utf8')); } catch { await delay(10); } }
  assert.ok(pid); await delay(20); parent.kill('SIGINT'); const [result] = await exited;
  assert.equal(result, 1); assert.doesNotMatch(output, /SHOULD_NOT_RUN/); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('failed startup commands retain exit status and missing executable code without argv',async()=>{
 await assert.rejects(runStartup(process.execPath,['-e','process.exit(7)'],{}),error=>{
  assert.equal(error.message,'startup_command_failed');assert.equal(error.exitCode,7);assert.equal(error.cancelled,false);
  assert.doesNotMatch(JSON.stringify(error),/process.exit/);return true;
 });
 await assert.rejects(runStartup('/nonexistent-adi-startup-command',['synthetic-private-argument'],{}),error=>{
  assert.equal(error.systemCode,'ENOENT');assert.doesNotMatch(JSON.stringify(error),/synthetic-private-argument/);return true;
 });
});
