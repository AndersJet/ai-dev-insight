import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {stopUsageFixture} from '../helpers/stop-usage.js';
import {connectionString} from '../../../storage/test/helpers.js';
import {createUsageSyncService} from '../../src/usage-sync.js';
import {createUsageSnapshotStore} from '../../src/usage-snapshots.js';

test('the real usage worker enables Stop discovery only under the trial switch and publishes readable session quantities',async t=>{
 const f=await stopUsageFixture(t);await f.jobs.enqueue(f.session);
 const schema=(await f.db.query<{schema:string}>('SELECT current_schema() AS schema')).rows[0]!.schema;
 const child=spawn(process.execPath,['apps/worker/dist/usage-main.js'],{env:{PATH:process.env.PATH,NODE_ENV:'test',ADI_DATABASE_URL:connectionString,ADI_DATABASE_SCHEMA:schema,ADI_USAGE_ENABLED:'true',ADI_USAGE_STOP_WINDOW_ENABLED:'true',ADI_USAGE_PROVIDER_ACCOUNT:'stop-test',ADI_USAGE_DISCOVERY:'false',ADI_USAGE_MIN_INTERVAL_MS:'20',TRAE_OPENAPI_BASE_URL:f.baseUrl,TRAE_OPENAPI_APP_ID:'synthetic',TRAE_OPENAPI_APP_SECRET:'synthetic'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',chunk=>{output+=String(chunk);});child.stderr.on('data',chunk=>{output+=String(chunk);});const closed=new Promise<number|null>(resolve=>child.once('close',resolve));t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await closed;});
 const deadline=Date.now()+10000;let tokens:string|null|undefined;
 while(Date.now()<deadline){tokens=(await f.read()).groups[0]?.tokens;if(tokens==='176004')break;if(child.exitCode!==null)break;await delay(50);}
 assert.equal(tokens,'176004',output);assert.ok(output.includes('usage_worker_ready'));child.kill('SIGTERM');assert.equal(await closed,0,output);
});

test('the real worker publishes a newly queued person-day while a long Stop refresh is still in progress',async t=>{
 const f=await stopUsageFixture(t);
 for(let i=1;i<=50;i++)await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:'fairness-stop-'+i,source_session_id:'synthetic-hook',event_type:'Stop',occurred_at:new Date(f.stop.getTime()-i*1000).toISOString(),payload:{last_assistant_message:'合成历史'}},{admissionEpoch:1,receivedAt:f.at});
 const date=new Date(Date.now()+28800000).toISOString().slice(0,10),sync=createUsageSyncService(f.db,{providerAccount:'stop-test'});let dayJob:string|undefined;
 f.control.onSession=async()=>{dayJob??=await sync.enqueue(f.user,date);};
 const linkJob=await f.jobs.enqueue(f.session),schema=f.db.schema;
 const child=spawn(process.execPath,['apps/worker/dist/usage-main.js'],{env:{PATH:process.env.PATH,NODE_ENV:'test',ADI_DATABASE_URL:connectionString,ADI_DATABASE_SCHEMA:schema,ADI_USAGE_ENABLED:'true',ADI_USAGE_STOP_WINDOW_ENABLED:'true',ADI_USAGE_PROVIDER_ACCOUNT:'stop-test',ADI_USAGE_DISCOVERY:'false',ADI_USAGE_MIN_INTERVAL_MS:'20',TRAE_OPENAPI_BASE_URL:f.baseUrl,TRAE_OPENAPI_APP_ID:'synthetic',TRAE_OPENAPI_APP_SECRET:'synthetic'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',chunk=>{output+=String(chunk);});child.stderr.on('data',chunk=>{output+=String(chunk);});const closed=new Promise<number|null>(resolve=>child.once('close',resolve));t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await closed;});
 const deadline=Date.now()+15000;let dayReady=false;
 while(Date.now()<deadline){if(dayJob&&(await sync.status(dayJob)).status==='succeeded'){dayReady=true;break;}if(child.exitCode!==null)break;await delay(10);}
 assert.equal(dayReady,true,output);assert.notEqual((await f.jobs.status(linkJob)).status,'succeeded','the person-day must complete before all historical Stop windows');
 const ledger=createUsageSnapshotStore(f.db,{providerAccount:'stop-test'});assert.equal((await ledger.readCurrent(f.user,date)).items[0]?.usage.total_tokens,'31336');
 while(Date.now()<deadline&&(await f.jobs.status(linkJob)).status!=='succeeded')await delay(20);
 assert.equal((await f.jobs.status(linkJob)).status,'succeeded',output);assert.equal((await f.read()).groups[0]?.tokens,'176004');assert.equal((await ledger.readCurrent(f.user,date)).items[0]?.usage.total_tokens,'31336');
 child.kill('SIGTERM');assert.equal(await closed,0,output);
});
