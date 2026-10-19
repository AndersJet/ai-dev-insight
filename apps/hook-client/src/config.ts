import { lstat, open } from 'node:fs/promises';

export interface ClientConfig { endpoint: string; installation_id: string; token: string; protocol_version: 2; runtime_owner: string }
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateCredentials(value: unknown): { installation_id: string; token: string } {
  if (!value || typeof value !== 'object' || !('installation_id' in value) || typeof value.installation_id !== 'string' || !uuid.test(value.installation_id) || !('token' in value) || typeof value.token !== 'string' || !/^adi_[A-Za-z0-9_-]{43}$/.test(value.token)) throw new Error('invalid_credentials_file');
  return { installation_id: value.installation_id, token: value.token };
}
export function validateEndpoint(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search || url.pathname !== '/hooks') throw new Error('invalid_collector_endpoint');
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('invalid_collector_endpoint');
  return url.href;
}
export async function readSmallJson(path: string, privateFile = false, maximum=16_384): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.size > maximum || (privateFile && process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('invalid_config_file');
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(maximum+1); let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    if (offset > maximum) throw new Error('invalid_config_file');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)));
  } finally { await handle.close(); }
}
export async function readClientConfig(path: string): Promise<ClientConfig> {
  const parsed = await readSmallJson(path, true);
  const credentials = validateCredentials(parsed);
  if (!parsed || typeof parsed !== 'object' || !('endpoint' in parsed) || typeof parsed.endpoint !== 'string') throw new Error('invalid_collector_endpoint');
  if (!('protocol_version' in parsed) || parsed.protocol_version !== 2 || !('runtime_owner' in parsed) || typeof parsed.runtime_owner !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.runtime_owner)) throw new Error('invalid_runtime_binding');
  return { ...credentials, endpoint: validateEndpoint(parsed.endpoint), protocol_version: 2, runtime_owner: parsed.runtime_owner };
}
