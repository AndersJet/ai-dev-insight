import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {stopUsageFixture} from '../../../../packages/domain/test/helpers/stop-usage.js';
import {connectionString} from '../../../../packages/storage/test/helpers.js';
import {createSessionListSnapshotPublisher} from '../../../../packages/domain/src/session-list-snapshot-publisher.js';

async function startup(t:TestContext,beforeStart?:(f:Awaited<ReturnType<typeof stopUsageFixture>>)=>Promise<void>){
 const f=await stopUsageFixture(t),directory=await mkdtemp(join(tmpdir(),'adi-api-snapshot-startup-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 await beforeStart?.(f);
 const reserved=createServer();reserved.listen(0,'127.0.0.1');await once(reserved,'listening');const address=reserved.address();assert.ok(address&&typeof address!=='string');
 await new Promise<void>((resolve,reject)=>reserved.close(error=>error?reject(error):resolve()));
 const application='api-snapshot-startup-'+randomUUID(),url=new URL(connectionString);url.searchParams.set('application_name',application);
 const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../../src/main.ts',import.meta.url))],{
  cwd:fileURLToPath(new URL('../../../../',import.meta.url)),
  env:{PATH:process.env.PATH,LANG:process.env.LANG,ADI_DATABASE_URL:url.href,ADI_DATABASE_SCHEMA:f.db.schema,ADI_EMAIL_DOMAINS:'example.invalid',ADI_USAGE_PROVIDER_ACCOUNT:'stop-test',ADI_USAGE_STOP_WINDOW_ENABLED:'true',ADI_API_HOST:'127.0.0.1',ADI_API_PORT:String(address.port),ADI_WEB_ORIGIN:`http://127.0.0.1:${address.port}`,ADI_INSTALLATION_KEY_FILE:join(directory,'installation.key'),ADI_CLIENT_RELEASE_DIR:directory},
  stdio:['ignore','pipe','pipe'],
 });
 let stderr='';child.stderr.on('data',value=>{stderr+=value;});
 const exited=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 async function waitFor(predicate:()=>Promise<boolean>,budget=6000){const until=Date.now()+budget;while(!await predicate()){assert.equal(child.exitCode,null,'API must keep waiting for publication');if(Date.now()>=until)throw new Error('Synthetic API startup observation expired');await delay(50);}}
 async function pending(){await waitFor(async()=>!!(await f.db.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND query LIKE '%session_list_snapshots%'",[application])).rowCount);}
 async function close(){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{return await exited;}finally{clearTimeout(timer);}}
 return {f,child,application,exited,endpoint:`http://127.0.0.1:${address.port}/api/v1/me`,pending,waitFor,close,stderr:()=>stderr};
}

test('the real API listens only after a delayed complete publication has been warmed',{timeout:20000},async t=>{
 const x=await startup(t);
 try{
  await x.pending();await delay(300);
  await assert.rejects(fetch(x.endpoint,{signal:AbortSignal.timeout(400)}),'API must not advertise HTTP readiness before publication');
  assert.equal((await x.f.db.query('SELECT count(*)::int AS n FROM session_list_snapshots')).rows[0]!.n,0);
  const publisher=createSessionListSnapshotPublisher(x.f.db,{providerAccount:'stop-test',stopWindowEnabled:true});assert.equal(await publisher.runOne(true),true);
  let status=0;
  await x.waitFor(async()=>{try{const response=await fetch(x.endpoint,{signal:AbortSignal.timeout(400)});status=response.status;await response.body?.cancel();return status===401;}catch{return false;}});
  assert.equal(status,401);assert.equal(x.child.exitCode,null);assert.ok(!x.stderr().includes('api_start_failed'));
  t.diagnostic('Real src+tsx API: no listener while complete publication is missing; delayed publication and metadata warm precede HTTP 401 readiness.');
 }finally{const result=await x.close();assert.equal(result.code,0);}
});

test('SIGTERM while the real API waits for its first publication closes its database and exits without a startup failure',{timeout:15000},async t=>{
 const x=await startup(t);
 try{
  await x.pending();await assert.rejects(fetch(x.endpoint,{signal:AbortSignal.timeout(400)}));
  const result=await x.close();assert.equal(result.code,0);assert.equal(result.signal,null);
  assert.ok(!x.stderr().includes('api_start_failed'));
  await x.waitFor(async()=>!(await x.f.db.query('SELECT 1 FROM pg_stat_activity WHERE application_name=$1',[x.application])).rowCount,2000);
  t.diagnostic('Pending-publication SIGTERM: exit 0, no api_start_failed, and no remaining child database sessions.');
 }finally{await x.close();}
});


for(const invalidation of ['expired','cleanup-fenced'] as const)test('startup waits for a new complete publication after an '+invalidation+' candidate',{timeout:20000},async t=>{
 const x=await startup(t,async f=>{
  const publisher=createSessionListSnapshotPublisher(f.db,{providerAccount:'stop-test',stopWindowEnabled:true,...(invalidation==='expired'?{clock:()=>new Date(Date.now()-61000)}:{})});
  assert.equal(await publisher.runOne(true),true);
  if(invalidation==='cleanup-fenced')await f.db.query('UPDATE users SET cleanup_generation=cleanup_generation+1');
 });
 try{
  await x.pending();await delay(300);assert.equal(x.child.exitCode,null,'invalid candidates cannot abort initial readiness');
  await assert.rejects(fetch(x.endpoint,{signal:AbortSignal.timeout(400)}),'invalid candidates cannot expose HTTP readiness');
  const publisher=createSessionListSnapshotPublisher(x.f.db,{providerAccount:'stop-test',stopWindowEnabled:true});assert.equal(await publisher.runOne(true),true);
  await x.waitFor(async()=>{try{const response=await fetch(x.endpoint,{signal:AbortSignal.timeout(400)});await response.body?.cancel();return response.status===401;}catch{return false;}});
  assert.ok(!x.stderr().includes('api_start_failed'));
 }finally{await x.close();}
});


test('a permanent startup SQL failure is reported and exits nonzero instead of being swallowed by close',{timeout:15000},async t=>{
 const x=await startup(t,async f=>{await f.db.query('DROP TABLE session_list_snapshots');});
 try{
  let timer:ReturnType<typeof setTimeout>|undefined;
  const result=await Promise.race([x.exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Permanent startup failure must exit')),5000);})]).finally(()=>clearTimeout(timer));
  assert.equal(result.code,1);assert.equal(result.signal,null);assert.match(x.stderr(),/api_start_failed/);
  assert.doesNotMatch(x.stderr(),/relation .* does not exist|SELECT .*session_list_snapshots/);
 }finally{await x.close();}
});
