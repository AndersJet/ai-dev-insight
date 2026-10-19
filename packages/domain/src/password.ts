import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { DomainError } from './errors.js';

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, key) => { if (error) reject(error); else resolve(key); }));
}
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 128) throw new DomainError('password_length');
  const salt = randomBytes(16); const key = await derive(password, salt);
  return `scrypt-v1$${salt.toString('hex')}$${key.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (password.length > 128) return false;
  const match = /^scrypt-v1\$([0-9a-f]{32})\$([0-9a-f]{128})$/.exec(encoded);
  if (!match?.[1] || !match[2]) return false;
  return timingSafeEqual(await derive(password, Buffer.from(match[1], 'hex')), Buffer.from(match[2], 'hex'));
}
