import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {readLeaseClock,type LeaseClock} from '../src/runtime-clock.js';

test('a runtime lease cannot revive after wall-clock rollback, sleep or another boot',async()=>{
  const core=runInNewContext((await readFile(new URL('../native/core.js',import.meta.url),'utf8'))+'\nADI;');
  const owner='a'.repeat(64),clock:LeaseClock={kind:'macos-continuous-v1',scope:'macos:11111111-1111-4111-8111-111111111111',monotonic_ms:100000};
  const value={version:2,owner,generation:'22222222-2222-4222-8222-222222222222',clock_kind:clock.kind,enabled:true,leases:[{id:'33333333-3333-4333-8333-333333333333',clock_scope:clock.scope,issued_at:1000000,expires_at:1020000,monotonic_issued_at:100000,monotonic_expires_at:120000}]};
  assert.equal(core.runtimeGeneration(value,owner,1000000,clock),value.generation);
  assert.equal(core.runtimeGeneration(value,owner,995000,{...clock,monotonic_ms:155000}),null,'clock rollback cannot revive an expired monotonic lease');
  assert.equal(core.runtimeGeneration(value,owner,1000001,{...clock,monotonic_ms:220000}),null,'continuous clock includes sleep even if wall time has not advanced');
  assert.equal(core.runtimeGeneration(value,owner,1000001,{...clock,scope:'macos:44444444-4444-4444-8444-444444444444',monotonic_ms:100000}),null,'another boot cannot reuse a prior lease');
  assert.equal(core.runtimeGeneration({...value,version:1},owner,1000000,clock),null);
  assert.equal(core.runtimeGeneration(value,owner,1000000),null,'the reader must possess a trusted local monotonic sample');
});

test('system lease clock samples share a stable scope and advance monotonically across calls',async()=>{
  const first=await readLeaseClock(),second=await readLeaseClock();
  assert.equal(second.kind,first.kind);assert.equal(second.scope,first.scope);assert.ok(second.monotonic_ms>=first.monotonic_ms);
  assert.ok(Number.isSafeInteger(first.monotonic_ms)&&first.monotonic_ms>0);
});
