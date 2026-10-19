import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supervise,type ProcessEvent } from '../src/supervisor.js';

test('supervisor bounds repeated process failure and exits unsuccessfully', { timeout: 10000 }, async () => {
  let starts = 0;
  const supervisor = supervise([{ name: 'failing', command: process.execPath, args: ['-e', 'process.exit(3)'], env: {} }], { restart: true, onEvent: event => { if (event.event === 'process_started') starts++; } });
  assert.equal(await supervisor.finished, 1); assert.equal(starts, 5);
});

test('supervisor identifies failed components, exit status and spawn error without leaking argv or environment',async()=>{
 const events:ProcessEvent[]=[];
 const failed=supervise([{name:'api',command:process.execPath,args:['-e','process.exit(7)'],env:{PRIVATE_VALUE:'synthetic-private-env'}}],{onEvent:event=>events.push(event)});
 assert.equal(await failed.finished,1);
 const failure=events.find(event=>event.event==='process_failed');assert.equal(failure?.name,'api');assert.equal(failure?.exit_code,7);assert.equal(failure?.level,'error');assert.ok((failure?.duration_ms??-1)>=0);
 const missing=supervise([{name:'missing',command:'/nonexistent-adi-supervised-command',args:['synthetic-private-argv'],env:{}}],{onEvent:event=>events.push(event)});
 assert.equal(await missing.finished,1);assert.equal(events.find(event=>event.event==='process_start_failed')?.system_code,'ENOENT');
 assert.doesNotMatch(JSON.stringify(events),/synthetic-private|process.exit/);
});
test('closing supervisor stops every owned process and does not restart it', { timeout: 4000 }, async () => {
  const pids: number[] = []; let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
  const supervisor = supervise(['a', 'b'].map(name => ({ name, command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], env: {} })), { shutdownMs: 500, restart: true, onEvent: event => { if (event.event === 'process_started' && event.pid) { pids.push(event.pid); if (pids.length === 2) ready(); } } });
  await started; assert.equal(await supervisor.close(), 0); assert.equal(pids.length, 2);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('outer supervisor allows nested shutdown to kill a child that ignores SIGTERM', { timeout: 6000 }, async t => {
  const { mkdtemp, rm, readFile } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'adi-nested-')); t.after(() => rm(dir, { recursive: true, force: true })); const marker = join(dir, 'child.pid');
  const inner = `import {supervise} from ${JSON.stringify(new URL('../src/supervisor.ts', import.meta.url).href)}; const childCode=${JSON.stringify("require('node:fs').writeFileSync(process.env.MARKER,String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)")}; const supervisor=supervise([{name:'stubborn',command:process.execPath,args:['-e',childCode],env:{MARKER:${JSON.stringify(marker)}}}],{shutdownMs:150});process.exitCode=await supervisor.finished;`;
  const outer = supervise([{ name: 'nested', command: process.execPath, args: ['--import','tsx','--input-type=module','-e',inner], env: {} }], { shutdownMs: 1500 });
  t.after(() => outer.close());
  let pid = 0;
  for (let n = 0; n < 100 && !pid; n++) { try { pid = Number(await readFile(marker, 'utf8')); } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
  assert.ok(pid); await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(await outer.close(), 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
