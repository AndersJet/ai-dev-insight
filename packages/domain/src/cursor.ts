import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DomainError } from './errors.js';
export function createCursorCodec(clock: () => Date, secret = randomBytes(32)) {
  const sign = (text: string) => createHmac('sha256', secret).update(text).digest('hex');
  return {
    encode(scope: string, key: string) {
      const body = Buffer.from(JSON.stringify({ scope, key, expires: clock().getTime() + 3600_000 })).toString('base64url');
      return `${body}.${sign(body)}`;
    },
    decode(cursor: string, scope: string): string {
      try {
        const match = /^([A-Za-z0-9_-]{1,1800})\.([0-9a-f]{64})$/.exec(cursor);
        if (!match?.[1] || !match[2] || !timingSafeEqual(Buffer.from(match[2], 'hex'), Buffer.from(sign(match[1]), 'hex'))) throw new Error();
        const value: { scope: string; key: string; expires: number } = JSON.parse(Buffer.from(match[1], 'base64url').toString());
        if (value.scope !== scope || !Number.isSafeInteger(value.expires) || value.expires <= clock().getTime() || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.key)) throw new Error();
        return value.key;
      } catch { throw new DomainError('invalid_cursor', 400); }
    },
  };
}
