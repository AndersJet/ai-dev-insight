import {environment as e2eEnv} from './environment.mjs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { openDatabase } from '../../../../packages/storage/src/index.js';
import type {Page} from '@playwright/test';
import assert from 'node:assert/strict';
// For tests of unrelated permissions/cleanup only. The real registration and personal ZIP flow
// is exercised separately in manual-registration.spec.ts.
export async function registeredFixture(userId: string) {
  const db=openDatabase({connectionString:e2eEnv.databaseURL,schema:e2eEnv.schema});
  try {await db.query('UPDATE users SET registered_at=now() WHERE id=$1 AND registered_at IS NULL',[userId]);}
  finally {await db.close();}
}

// Seed a legacy collection identity for tests whose subject is cleanup, not issuance.
export async function collectionFixture(userId: string) {
  const db = openDatabase({ connectionString:e2eEnv.databaseURL, schema: e2eEnv.schema });
  const id = randomUUID(), token = `adi_${randomBytes(32).toString('base64url')}`;
  try { await db.query('INSERT INTO installations(id,user_id,label,token_hash) VALUES($1,$2,$3,$4)', [id,userId,'合成采集夹具',createHash('sha256').update(token).digest('hex')]); }
  finally { await db.close(); }
  return { installation: { id }, token };
}

// Explicit test preparation for the seeded root's legacy Hook identities.
// It preserves their historical facts; product grant/download never resets.
export async function resetSyntheticHookFixture(page:Page){
  const response=await page.request.get('/api/v1/me');assert.equal(response.status(),200);
  const actor=(await response.json()).data;assert.equal(actor.email,'e2e-root@example.invalid');assert.equal(actor.registered,true);
  const csrf=(await page.context().cookies()).find(cookie=>cookie.name==='adi_csrf')?.value;assert.ok(csrf);
  const reset=await page.request.post('/api/v1/me/collection-credential/reset',{headers:{'x-csrf-token':csrf},data:{}});assert.equal(reset.status(),200,'explicit synthetic Hook credential preparation must succeed');
}
