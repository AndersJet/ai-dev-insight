import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const entry = fileURLToPath(new URL('../dist/install.js', import.meta.url));

test('install, update and uninstall preserve unrelated Trae hooks and keep credentials out of hook commands', async t => {
  const dir = await mkdtemp(join(tmpdir(), "adi-install-quote'$-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const trae = join(dir, 'profile'); await mkdir(trae);
  const original = { version: 1, custom: { preserved: true }, hooks: { Stop: [{ loop_limit: 3, hooks: [{ type: 'command', command: 'echo personal-validator', timeout: 20 }] }], Notification: [{ hooks: [{ command: 'echo personal-notification' }] }] } };
  const hooks = join(trae, 'hooks.json'); await writeFile(hooks, JSON.stringify(original));
  const credential = join(dir, 'download.json'); const token = 'adi_' + 'c'.repeat(43);
  await writeFile(credential, JSON.stringify({ installation_id: 'a163f758-49a9-4d19-b713-0680c1810f66', token }));
  const args = ['--trae-dir', trae, '--credentials', credential, '--endpoint', 'http://127.0.0.1:4186/hooks'];
  const before = await readFile(hooks, 'utf8');
  await execute(process.execPath, [entry, 'plan', ...args]); assert.equal(await readFile(hooks, 'utf8'), before);
  const installed = await execute(process.execPath, [entry, 'install', ...args]); assert.ok(!installed.stdout.includes(token)); assert.equal(installed.stderr, '');
  const config = JSON.parse(await readFile(hooks, 'utf8')); assert.deepEqual(config.custom, original.custom);
  assert.deepEqual(config.hooks.Stop[0], original.hooks.Stop[0]); assert.equal(config.hooks.Stop.length, 2); assert.ok(!JSON.stringify(config).includes(token));
  const command: string = config.hooks.UserPromptSubmit[0].hooks[0].command;
  const smoke = await execute('/bin/bash', ['-c', command]);
  assert.equal(smoke.stdout, ''); assert.equal(smoke.stderr, '');
  const state = JSON.parse(await readFile(join(trae, 'adi-collector', 'manifest.json'), 'utf8'));
  const secretFile = join(trae, 'adi-collector', state.release, 'config.json');
  assert.equal(JSON.parse(await readFile(secretFile, 'utf8')).token, token);
  if (process.platform !== 'win32') assert.equal((await stat(secretFile)).mode & 0o777, 0o600);
  await execute(process.execPath, [entry, 'install', ...args]);
  const updated = JSON.parse(await readFile(hooks, 'utf8')); assert.equal(updated.hooks.Stop.length, 2); assert.equal(updated.hooks.UserPromptSubmit.length, 1);
  // An unrelated hook added after installation must survive uninstall as well.
  updated.hooks.Stop.push({ hooks: [{ command: 'echo added-after-install' }] }); await writeFile(hooks, JSON.stringify(updated));
  await execute(process.execPath, [entry, 'uninstall', '--trae-dir', trae]);
  const removed = JSON.parse(await readFile(hooks, 'utf8'));
  assert.equal(removed.hooks.Stop.length, 2); assert.equal(removed.hooks.Stop[1].hooks[0].command, 'echo added-after-install');
  assert.deepEqual(removed.hooks.Notification, original.hooks.Notification); assert.deepEqual(removed.custom, original.custom);
  assert.ok(!JSON.stringify(removed).includes('adi-collector'));
  await assert.rejects(readFile(secretFile), { code: 'ENOENT' });
});

test('an interrupted hooks commit recovers its manifest and a conflicting user edit is never overwritten', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adi-recovery-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const credential = join(dir, 'download.json'); await writeFile(credential, JSON.stringify({ installation_id: 'a163f758-49a9-4d19-b713-0680c1810f66', token: 'adi_' + 'e'.repeat(43) }));
  const args = [entry, 'install', '--trae-dir', dir, '--credentials', credential, '--endpoint', 'http://127.0.0.1:4186/hooks'];
  await execute(process.execPath, args);
  const base = join(dir, 'adi-collector'); const hooksPath = join(dir, 'hooks.json');
  const installed = await readFile(hooksPath, 'utf8'); const manifest = JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8'));
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  // Reconstruct the documented on-disk state of a crash after hooks.json was
  // renamed but before manifest.json was committed; recovery uses only the CLI.
  const journal = { before: hash(''), after: hash(installed), manifest, created: manifest.release, remove: [] };
  await writeFile(join(base, 'pending.json'), JSON.stringify(journal), { mode: 0o600 }); await unlink(join(base, 'manifest.json'));
  await execute(process.execPath, args);
  assert.equal(JSON.parse(await readFile(hooksPath, 'utf8')).hooks.Stop.length, 1);
  await assert.rejects(readFile(join(base, 'pending.json')), { code: 'ENOENT' });
  // A third-party edit after the crash makes recovery ambiguous: preserve it.
  const custom = JSON.stringify({ version: 1, hooks: { Stop: [{ hooks: [{ command: 'echo user-edit' }] }] } });
  await writeFile(hooksPath, custom); await writeFile(join(base, 'pending.json'), JSON.stringify(journal));
  await assert.rejects(execute(process.execPath, args), error => error instanceof Error && 'stderr' in error && String(error.stderr).includes('installation_recovery_conflict'));
  assert.equal(await readFile(hooksPath, 'utf8'), custom);
  // Unsafe manifest paths cannot reach files outside the installer-owned area.
  await writeFile(join(base, 'pending.json'), JSON.stringify({ ...journal, created: `../${randomUUID()}` }));
  await assert.rejects(execute(process.execPath, args), error => error instanceof Error && 'stderr' in error && String(error.stderr).includes('invalid_installation_journal'));
});

test('legacy collection is replaced only with an explicit migration flag, while other hooks remain intact', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adi-legacy-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const command = `"${join(dir, 'trae-hook-send.sh')}"`;
  const before = JSON.stringify({ version: 1, hooks: { Stop: [{ hooks: [{ type: 'command', command, timeout: 5 }] }, { hooks: [{ command: 'echo keep-this' }] }] } });
  await writeFile(join(dir, 'hooks.json'), before);
  const credential = join(dir, 'download.json'); await writeFile(credential, JSON.stringify({ installation_id: 'a163f758-49a9-4d19-b713-0680c1810f66', token: 'adi_' + 'd'.repeat(43) }));
  const args = [entry, 'install', '--trae-dir', dir, '--credentials', credential, '--endpoint', 'http://127.0.0.1:4186/hooks'];
  await assert.rejects(execute(process.execPath, args), error => error instanceof Error && 'stderr' in error && String(error.stderr).includes('legacy_hook_requires_migration'));
  assert.equal(await readFile(join(dir, 'hooks.json'), 'utf8'), before);
  await execute(process.execPath, [...args, '--replace-legacy']);
  const after = JSON.parse(await readFile(join(dir, 'hooks.json'), 'utf8'));
  assert.equal(after.hooks.Stop.length, 2); assert.equal(after.hooks.Stop[0].hooks[0].command, 'echo keep-this');
  assert.ok(!JSON.stringify(after).includes('trae-hook-send.sh'));
});

test('a prepared but uncommitted update discards its staged credentials before retrying', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'adi-prepared-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const credential = join(dir, 'download.json'); await writeFile(credential, JSON.stringify({ installation_id: 'a163f758-49a9-4d19-b713-0680c1810f66', token: 'adi_' + 'f'.repeat(43) }));
  const args = [entry, 'install', '--trae-dir', dir, '--credentials', credential, '--endpoint', 'http://127.0.0.1:4186/hooks'];
  await execute(process.execPath, args);
  const base = join(dir, 'adi-collector'); const hooks = await readFile(join(dir, 'hooks.json'), 'utf8');
  const manifest = JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8')); const staged = randomUUID();
  await mkdir(join(base, staged)); await writeFile(join(base, staged, 'config.json'), '{"unfinished":true}');
  const next = JSON.parse(JSON.stringify(manifest).replaceAll(manifest.release, staged)); next.releases = [...manifest.releases, staged];
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  await writeFile(join(base, 'pending.json'), JSON.stringify({ before: hash(hooks), after: hash('uncommitted-next-hooks'), manifest: next, created: staged, remove: [] }));
  await execute(process.execPath, args);
  await assert.rejects(readFile(join(base, staged, 'config.json')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(join(dir, 'hooks.json'), 'utf8')).hooks.Stop.length, 1);
});

test('a downloaded credential file can carry the published endpoint without putting secrets in commands', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'adi-setup-file-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const credentials = join(directory, 'downloaded.json');
  await writeFile(credentials, JSON.stringify({ installation_id: 'a163f758-49a9-4d19-b713-0680c1810f66', token: 'adi_' + 'g'.repeat(43), endpoint: 'https://collector.example.invalid/hooks' }));
  const args = ['--trae-dir', join(directory, 'profile'), '--credentials', credentials];
  await execute(process.execPath, [entry, 'plan', ...args]); await execute(process.execPath, [entry, 'install', ...args]);
  const base = join(directory, 'profile', 'adi-collector'); const manifest = JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8'));
  assert.equal(JSON.parse(await readFile(join(base, manifest.release, 'config.json'), 'utf8')).endpoint, 'https://collector.example.invalid/hooks');
  assert.ok(!(await readFile(join(directory, 'profile', 'hooks.json'), 'utf8')).includes('adi_' + 'g'.repeat(43)));
});
