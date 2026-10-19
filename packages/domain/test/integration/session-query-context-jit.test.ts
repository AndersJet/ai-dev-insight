import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase,type Transaction} from '../../../storage/src/index.js';
import {connectionString} from '../../../storage/test/helpers.js';
import {stopUsageFixture} from '../helpers/stop-usage.js';
import {createUsageAttributionService} from '../../src/usage-attribution.js';
import {createUsageAttributionJobs} from '../../src/usage-attribution-jobs.js';
import {readSessionQuery} from '../../src/session-usage-query.js';

test('all session fingerprint entry points disable JIT only in their real transaction and restore it on commit and rollback',async t=>{
 const f=await stopUsageFixture(t),single=openDatabase({connectionString,schema:f.db.schema,maxConnections:1});t.after(()=>single.close());
 await single.query('SET jit=on');
 const setting=async()=>String((await single.query<{jit:string}>('SHOW jit')).rows[0]!.jit);
 const seen:string[]=[];let abortNext=false;
 const traced=(sql:Transaction)=>new Proxy(sql,{get(target,key,receiver){
  if(key==='query')return async(text:string,values?:unknown[])=>{
   if(text.startsWith('SELECT md5(jsonb_build_array(s.first_at')){
    const jit=(await target.query<{jit:string}>('SHOW jit')).rows[0]!.jit;seen.push(jit);assert.equal(jit,'off');
    if(abortNext){abortNext=false;throw new Error('fingerprint_test_abort');}
   }
   return target.query(text,values);
  };
  return Reflect.get(target,key,receiver);
 }});
 const monitored=new Proxy(single,{get(target,key,receiver){if(key==='transaction')return (action:Parameters<typeof single.transaction>[0])=>target.transaction(sql=>action(traced(sql)));return Reflect.get(target,key,receiver);}});
 const provider={...f.provider,getSessionUsage:async(id:string)=>{assert.equal(await setting(),'on','provider request runs after the local transaction has committed');return f.provider.getSessionUsage(id);},getMemberUsage:async(query:Parameters<typeof f.provider.getMemberUsage>[0])=>{assert.equal(await setting(),'on');return f.provider.getMemberUsage(query);}};
 const service=createUsageAttributionService(monitored,{providerAccount:'stop-test',provider});
 await service.probe(f.session);assert.equal(await setting(),'on');assert.ok(seen.length>=2,'claim and final publication each execute a real fingerprint');
 const jobs=createUsageAttributionJobs(monitored,{providerAccount:'stop-test',provider}),job=await jobs.enqueue(f.session);let partial=false;
 for(let step=0;step<8;step++){await jobs.runOne();const state=await jobs.status(job);assert.equal(await setting(),'on');if(state.status==='queued')partial=true;if(state.status==='succeeded')break;}
 assert.equal((await jobs.status(job)).status,'succeeded');assert.equal(partial,true,'the intermediate Stop checkpoint path must also validate its fingerprint locally');
 const result=await readSessionQuery(monitored,'stop-test',f.session,f.user,{userId:f.user,super:true});assert.equal(result?.groups[0]?.tokens,'176004');assert.equal(await setting(),'on');
 const beforeAbort=seen.length;abortNext=true;await assert.rejects(readSessionQuery(monitored,'stop-test',f.session,f.user,{userId:f.user,super:true}),/fingerprint_test_abort/);assert.equal(seen.length,beforeAbort+1);assert.equal(await setting(),'on','local JIT setting is restored by rollback on the same one-connection pool');
 assert.ok(seen.length>=8);assert.ok(seen.every(value=>value==='off'));
});
