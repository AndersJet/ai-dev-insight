import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadInstallationKey } from '../src/installation-key.js';
test('installation key persists privately across restart and rejects public files or symlinks', t => {
  const directory = mkdtempSync(join(tmpdir(), 'adi-credential-key-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'key');
  const first = loadInstallationKey(path);
  assert.equal(first.length, 32); assert.deepEqual(loadInstallationKey(path), first);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  chmodSync(path, 0o644); assert.throws(() => loadInstallationKey(path), /installation_key_unavailable/);
  chmodSync(path, 0o600); symlinkSync(path, join(directory, 'link'));
  assert.throws(() => loadInstallationKey(join(directory, 'link')), /installation_key_unavailable/);
});
