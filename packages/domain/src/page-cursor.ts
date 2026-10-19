import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DomainError } from './errors.js';
export const cursorScope = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createPageCursor(clock: () => Date) {
  const secret = randomBytes(32);
  const sign = (body: string) => createHmac('sha256', secret).update(body).digest('hex');
  return {
    encode(scope: string, key: Record<string, unknown>) {
      const body = Buffer.from(JSON.stringify({ scope, key, expires: clock().getTime() + 5 * 60_000 })).toString('base64url');
      return `${body}.${sign(body)}`;
    },
    decode(cursor: string, scope: string): Record<string, unknown> {
      try {
        const parts = /^([A-Za-z0-9_-]{1,3000})\.([0-9a-f]{64})$/.exec(cursor);
        if (!parts?.[1] || !parts[2] || !timingSafeEqual(Buffer.from(parts[2], 'hex'), Buffer.from(sign(parts[1]), 'hex'))) throw new Error();
        const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        if (parsed.scope !== scope || !Number.isSafeInteger(parsed.expires) || parsed.expires <= clock().getTime() || !parsed.key || typeof parsed.key !== 'object' || Array.isArray(parsed.key)) throw new Error();
        return parsed.key;
      } catch { throw new DomainError('invalid_cursor', 400); }
    },
  };
}
