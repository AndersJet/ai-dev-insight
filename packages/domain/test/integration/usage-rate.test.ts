import { test } from 'node:test';import assert from 'node:assert/strict';
import { testDatabase } from '../../../storage/test/helpers.js';
import { createUsageRequestGate } from '../../src/usage-rate.js';
test('separate workers share request spacing and a persisted rate-limit pause',async t=>{
 const db=await testDatabase(t);await db.migrate();const a=createUsageRequestGate(db,{providerAccount:'rate-test',intervalMs:30});const b=createUsageRequestGate(db,{providerAccount:'rate-test',intervalMs:30});
 const grants=await Promise.all([a.acquire(),b.acquire()]);const times=grants.map(x=>Date.parse(x)).sort((x,y)=>x-y);assert.ok(times[1]!-times[0]!>=30);
 await a.pause(2);await assert.rejects(b.acquire(),error=>error instanceof Error&&'code' in error&&error.code==='provider_rate_limited');
});
