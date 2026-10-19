import { constants, openSync, readFileSync, fstatSync, closeSync, mkdirSync, writeFileSync, linkSync, rmSync, fsyncSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

// Kept outside PostgreSQL so a database export alone cannot recover credentials.
// All API replicas must use this same persistent private key file.
export function loadInstallationKey(path = resolve('.local/installation-credentials.key')): Buffer {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const read = () => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size !== 32 || (info.mode & 0o077) !== 0) throw new Error('installation_key_unavailable');
      return readFileSync(fd);
    } finally { closeSync(fd); }
  };
  try { return read(); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw new Error('installation_key_unavailable', { cause: error });
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, randomBytes(32), { mode: 0o600, flag: 'wx', flush: true });
    try { linkSync(temporary, path); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error; }
    const parent = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(parent); } finally { closeSync(parent); }
    return read();
  } catch { throw new Error('installation_key_unavailable'); }
  finally { rmSync(temporary, { force: true }); }
}
