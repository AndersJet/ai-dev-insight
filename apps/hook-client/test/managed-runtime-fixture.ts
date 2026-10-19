import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {readLeaseClock} from '../src/runtime-clock.js';

// Synthetic current-user home; never touches the employee's real Trae profile.
export async function managedRuntime(home: string, owner = 'a'.repeat(64)) {
  const directory = join(home, '.trae-cn', 'adi-plugin-control');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'control.json'), lease = randomUUID();
  const sample=await readLeaseClock();
  const state = { version: 2, clock_kind:sample.kind,owner, generation: randomUUID(), enabled: true, leases: [{ id: lease,clock_scope:sample.scope,issued_at:0,expires_at: 0,monotonic_issued_at:0,monotonic_expires_at:0 }] };
  async function renew(updates: {version?:number;clock_kind?:string;owner?:string;generation?:string;enabled?:boolean;leases?:unknown[]} = {}) {
    const clock=await readLeaseClock(),now=Date.now();
    Object.assign(state, { version:2,clock_kind:clock.kind,leases: [{ id: lease,clock_scope:clock.scope,issued_at:now,expires_at:now+20_000,monotonic_issued_at:clock.monotonic_ms,monotonic_expires_at:clock.monotonic_ms+20_000 }] }, updates);
    const temporary = join(directory, `control-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 }); await rename(temporary, path);
  }
  await renew();
  return { path, owner, state, renew, env: { ...process.env, HOME: home, USERPROFILE: home } };
}
