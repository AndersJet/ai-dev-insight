import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { unzipSync } from 'fflate';
import { managedRuntime } from '../../../hook-client/test/managed-runtime-fixture.js';

export async function realHookClient(archivePath: string, runtimeOwner: string) {
  assert.match(runtimeOwner, /^[a-f0-9]{64}$/);
  const directory = await mkdtemp(join(tmpdir(), 'adi-browser-client-'));
  const runtime = await managedRuntime(directory, runtimeOwner);
  const config = join(directory, 'adi-installation.json');
  const profile = join(directory, 'profile');
  let command: string;
  try {
    const files = unzipSync(await readFile(archivePath));
    assert.deepEqual(Object.keys(files).sort(), ['INSTALL.md', 'LICENSE', 'NOTICE', 'adi-installation.json', 'install-hook.ps1', 'install-hook.sh', 'native-macos.js', 'native-windows.ps1', 'send-hook.ps1', 'send-hook.sh', 'send-worker.ps1']);
    assert.match(Buffer.from(files['LICENSE']!).toString('utf8'),/Apache License/);
    assert.match(Buffer.from(files['NOTICE']!).toString('utf8'),/AI Dev Insight/);
    for (const [name, bytes] of Object.entries(files)) await writeFile(join(directory, name), bytes, { mode: 0o600 });
    const material = JSON.parse(await readFile(config, 'utf8'));
    await writeFile(config, JSON.stringify({ ...material, protocol_version: 2, runtime_owner: runtimeOwner }), { mode: 0o600 });
    if (process.platform === 'darwin') await promisify(execFile)('/bin/bash', [join(directory,'install-hook.sh'),'install','--trae-dir',profile,'--credentials',config], {cwd:directory,env:{...runtime.env,PATH:'/usr/bin:/bin'}});
    else if (process.platform === 'win32') await promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'), ['-NoProfile','-ExecutionPolicy','Bypass','-File',join(directory,'install-hook.ps1'),'install','-TraeDir',profile,'-Credentials',config],{cwd:directory,env:runtime.env});
    else throw new Error('Native employee client acceptance requires macOS or Windows');
    command = JSON.parse(await readFile(join(profile, 'hooks.json'), 'utf8')).hooks.UserPromptSubmit[0].hooks[0].command;
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return installedClient(directory, command, runtime);
}

function installedClient(directory: string, command: string, runtime: Awaited<ReturnType<typeof managedRuntime>>) {
  const pulse = setInterval(() => { void runtime.renew().catch(() => {}); }, 5000); pulse.unref();
  return {
    dispose: () => { clearInterval(pulse); return rm(directory, { recursive: true, force: true }); },
    send: async (event: Record<string, unknown>, environment: NodeJS.ProcessEnv = {}) => {
      await runtime.renew();
      const shell = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/bash';
      const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];
      const child = spawn(shell, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...runtime.env, ...environment, HOME: directory, USERPROFILE: directory } });
      let stdout = ''; let stderr = ''; child.stdout.on('data', value => { stdout += value; }); child.stderr.on('data', value => { stderr += value; }); child.stdin.on('error', () => {});
      const exit = once(child, 'exit'); const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { child.stdin.end(JSON.stringify(event)); const [code, signal] = await exit; assert.equal(code, 0); assert.equal(signal, null); assert.equal(stdout, ''); assert.equal(stderr, ''); }
      finally { clearTimeout(timeout); child.kill('SIGKILL'); }
    },
  };
}
