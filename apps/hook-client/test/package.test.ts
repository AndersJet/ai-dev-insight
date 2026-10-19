import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
const execute = promisify(execFile);

test('release package is reproducible, contains only standalone client files and runs outside the repository', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'adi-package-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../../../scripts/package-hook-client.mjs', import.meta.url));
  await execute(process.execPath, [script, '--output', directory]);
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
  const archive = await readFile(join(directory, 'client.zip'));
  assert.equal(manifest.sha256, createHash('sha256').update(archive).digest('hex')); assert.equal(manifest.bytes, archive.length); assert.equal(manifest.runtime, 'system'); assert.deepEqual(manifest.platforms, ['windows','macos']);
  const files = unzipSync(archive);
  assert.ok(files['LICENSE']&&files['NOTICE'],'standalone Hook archives must retain project license and attribution');
  assert.deepEqual(Object.keys(files).sort(), ['INSTALL.md', 'LICENSE', 'NOTICE', 'install-hook.ps1', 'install-hook.sh', 'native-macos.js', 'native-windows.ps1', 'send-hook.ps1', 'send-hook.sh', 'send-worker.ps1']);
  assert.match(Buffer.from(files['LICENSE']!).toString('utf8'),/Apache License/);
  for (const [name, data] of Object.entries(files)) await writeFile(join(directory, name), data);
  assert.equal(files['package.json'], undefined, 'employee package has no Node runtime manifest');
  if (process.platform === 'darwin') {
    const status = await execute('/bin/bash', [join(directory, 'install-hook.sh'), 'status', '--trae-dir', join(directory, 'isolated-profile')], {cwd:directory,env:{...process.env,PATH:'/usr/bin:/bin'}});
    assert.equal(JSON.parse(status.stdout).installed,false);
  }
  if (process.env.ADI_TEST_PWSH) {
    const check=join(directory,'compile.ps1');
    await writeFile(check,`param([string]$Module)\n$ErrorActionPreference='Stop'\n. $Module\nAdd-Type -TypeDefinition $script:AdiProcessSource\nif([Adi.Native.ProcessRunner]::Protocol -ne 1){throw 'unsupported_process_protocol'}\nWrite-Output 'standalone Windows module compiled'\n`);
    const answer=await execute(process.env.ADI_TEST_PWSH,['-NoProfile','-NonInteractive','-File',check,join(directory,'native-windows.ps1')],{cwd:directory});
    assert.equal(answer.stderr,'');assert.equal(answer.stdout.trim(),'standalone Windows module compiled');
  }
  await execute(process.execPath, [script, '--output', directory], { env: { ...process.env, TZ: 'Pacific/Honolulu' } });
  assert.deepEqual(await readFile(join(directory, 'client.zip')), archive);
});
