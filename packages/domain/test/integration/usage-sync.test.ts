import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { testDatabase,connectionString } from '../../../storage/test/helpers.js';
import { postgresFaultProxy } from '../../../storage/test/fixtures/pg-fault-proxy.js';
import { openDatabase } from '../../../storage/src/index.js';
import { createUsageAttributionService } from '../../src/usage-attribution.js';
import { createUsageSyncService } from '../../src/usage-sync.js';
import { createUsageSnapshotStore } from '../../src/usage-snapshots.js';
import { UsageProviderError } from '../../src/usage-provider.js';
import type { MemberUsageQuery, ProviderUsagePage, ProviderUsageItem } from '../../src/usage-provider.js';
const clock=()=>new Date('2026-09-24T12:00:00Z');const date='2026-09-23';
function value(id:string,tokens:string):ProviderUsageItem{return {billing_session_id:id,provider_user_id:'sync-person',email:'sync@example.invalid',start_time:String(Date.parse('2026-09-23T01:00:00Z')/1000),client:'ide',scene:'Chat',model_name:'synthetic',model_type:'Chat',model_source:'Trae',consumption_source:'pay_go',model_call_count:'1',departments:[],usage:{prompt_tokens:tokens,completion_tokens:'0',total_tokens:tokens,cache_creation_input_tokens:'0',cache_read_input_tokens:'0'},amount:'0.100000',amount_reason:null,currency:'CNY',quality:[],token_basis:'provider_reported'};}
function response(query:MemberUsageQuery,rows:ProviderUsageItem[]):ProviderUsagePage {const page=query.page??1;const size=query.page_size??200;const items=rows.slice((page-1)*size,page*size);return {items,pagination:{page,page_size:size,total:rows.length,total_pages:Math.max(1,Math.ceil(rows.length/size))},request_id:'synthetic',observed_at:clock().toISOString(),response_hash:createHash('sha256').update(JSON.stringify(items)).digest('hex'),query:{endpoint:'user_usage_detail',parameters:{...query,page,page_size:size}}};}

test('a database reply timeout retries a fenced usage job and publishes only the recovered complete snapshot',{timeout:20000},async t=>{
 const baseline=await testDatabase(t);await baseline.migrate();const user=randomUUID();await baseline.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)',[user,'sync@example.invalid','网络重试夹具']);
 const proxy=await postgresFaultProxy(connectionString);const db=openDatabase({connectionString:proxy.connectionString,schema:baseline.schema,maxConnections:1});let timer:ReturnType<typeof setTimeout>|undefined;let fault=true;
 const provider={getMemberUsage:async(query:MemberUsageQuery)=>{if(fault){fault=false;proxy.setMode('drop-responses');timer=setTimeout(()=>proxy.setMode('healthy'),1000);}return response(query,[value('A','100')]);}};
 const sync=createUsageSyncService(db,{providerAccount:'network-retry',provider,clock,pageSize:1});const reader=createUsageSnapshotStore(baseline,{providerAccount:'network-retry',clock,pageSize:1});
 try{
  const job=await sync.enqueue(user,date);await sync.runOne();await sync.runOne();assert.ok(proxy.snapshot().droppedBytes>0);assert.equal((await sync.status(job)).status,'queued');assert.equal((await sync.status(job)).error_code,'database_io_timeout');assert.equal((await reader.readCurrent(user,date)).status,'missing');
  await baseline.query("UPDATE jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[job]);let steps=0;while(await sync.runOne())assert.ok(++steps<12);
  assert.equal((await sync.status(job)).status,'succeeded');assert.deepEqual((await reader.readCurrent(user,date)).items.map(row=>row.billing_session_id),['A']);
 }finally{clearTimeout(timer);await proxy.close();await db.close();}
});

test('a durable sync resumes between pages and publishes only after a second matching pass',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID();await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)',[user,'sync@example.invalid','持久同步夹具']);
 const calls:number[]=[];const provider={getMemberUsage:async(query:MemberUsageQuery)=>{calls.push(query.page??1);return response(query,[value('A','100'),value('B','200')]);}};
 const options={providerAccount:'synthetic-sync',provider,clock,pageSize:1};const first=createUsageSyncService(db,options);const job=await first.enqueue(user,date);
 const reader=createUsageSnapshotStore(db,{providerAccount:'synthetic-sync',clock,pageSize:1});
 await first.runOne();await first.runOne();assert.equal((await reader.readCurrent(user,date)).status,'missing');
 const resumed=createUsageSyncService(db,options);let turns=0;while(await resumed.runOne())assert.ok(++turns<12);
 assert.deepEqual(calls,[1,2,1,2]);assert.equal((await resumed.status(job)).status,'succeeded');
 assert.deepEqual((await reader.readCurrent(user,date)).items.map(row=>row.billing_session_id),['A','B']);
});

test('a changed verification pass preserves the previously published result and records a retryable failure',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID();await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)',[user,'sync@example.invalid','复核夹具']);
 let calls=0;let change=false;const provider={getMemberUsage:async(query:MemberUsageQuery)=>{calls++;return response(query,[value('A',change&&calls>1?'101':'100')]);}};
 const sync=createUsageSyncService(db,{providerAccount:'verify-test',provider,clock,pageSize:1});await sync.enqueue(user,date);while(await sync.runOne()){/* complete stable baseline */}
 const reader=createUsageSnapshotStore(db,{providerAccount:'verify-test',clock,pageSize:1});assert.equal((await reader.readCurrent(user,date)).items[0]?.usage.total_tokens,'100');
 calls=0;change=true;const job=await sync.enqueue(user,date);let steps=0;while(await sync.runOne())assert.ok(++steps<8);
 const status=await sync.status(job);assert.equal(status.error_code,'usage_page_changed');assert.equal(status.status,'queued');
 assert.equal((await reader.readCurrent(user,date)).items[0]?.usage.total_tokens,'100');
});

test('losing the job lease during the final database publication cannot switch the current snapshot',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID();await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)',[user,'sync@example.invalid','最终屏障夹具']);
 let tokens='100';const provider={getMemberUsage:async(query:MemberUsageQuery)=>response(query,[value('A',tokens)])};
 const sync=createUsageSyncService(db,{providerAccount:'fence-test',provider,clock,pageSize:1});await sync.enqueue(user,date);while(await sync.runOne()){/* baseline */}
 const reader=createUsageSnapshotStore(db,{providerAccount:'fence-test',clock,pageSize:1});tokens='120';const job=await sync.enqueue(user,date);
 for(let i=0;i<8&&(await sync.status(job)).phase!=='publish';i++)await sync.runOne();assert.equal((await sync.status(job)).phase,'publish');
 await db.query("CREATE FUNCTION usage_job_slow_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$");
 await db.query('CREATE TRIGGER usage_job_slow_publish BEFORE UPDATE OF published_run_id ON usage_scopes FOR EACH ROW EXECUTE FUNCTION usage_job_slow_publish()');
 const publishing=sync.runOne();let sleeping=false;const until=Date.now()+2000;
 while(Date.now()<until){sleeping=Boolean((await db.query("SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid WHERE l.relation=to_regclass($1) AND a.wait_event='PgSleep' LIMIT 1",[`${db.schema}.usage_scopes`])).rowCount);if(sleeping)break;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.equal(sleeping,true,'observe the real publication inside its slow trigger');
 await db.query('UPDATE jobs SET lease_token=$2 WHERE id=$1',[job,randomUUID()]);await publishing;
 assert.equal((await reader.readCurrent(user,date)).items[0]?.usage.total_tokens,'100');assert.notEqual((await sync.status(job)).status,'succeeded');
});

test('recent-day discovery is bounded, deduplicated and survives a new coordinator instance',async t=>{
 const db=await testDatabase(t);await db.migrate();const ids=[randomUUID(),randomUUID()];
 for(const [i,id] of ids.entries())await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)',[id,`discovery-${i}@example.invalid`,'发现夹具']);
 const provider={getMemberUsage:async(query:MemberUsageQuery)=>response(query,[])};const options={providerAccount:'discovery-test',provider,clock,pageSize:1};
 const one=createUsageSyncService(db,options);assert.equal(await one.discoverRecent(),20);
 const other=createUsageSyncService(db,options);assert.equal(await other.discoverRecent(),0);
 const jobs=(await db.query("SELECT payload->>'business_date' AS day,count(*)::integer AS count FROM jobs WHERE kind='usage_sync' GROUP BY day ORDER BY day")).rows;
 assert.equal(jobs.length,10);assert.deepEqual(jobs.slice(-3),[{day:'2026-09-22',count:2},{day:'2026-09-23',count:2},{day:'2026-09-24',count:2}]);assert.ok(jobs.every(row=>row.count===2));
});

test('an expired in-flight task is restarted and its old response cannot abort or publish the replacement',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID();await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)',[user,'sync@example.invalid','接管夹具']);
 let signalEntered:()=>void=()=>{};const entered=new Promise<void>(resolve=>{signalEntered=resolve;});let releaseOld:()=>void=()=>{};const release=new Promise<void>(resolve=>{releaseOld=resolve;});t.after(()=>releaseOld());let calls=0;
 const provider={getMemberUsage:async(query:MemberUsageQuery)=>{const number=++calls;if(number===1){signalEntered();await release;}return response(query,[value('A',number===1?'100':'200')]);}};
 const options={providerAccount:'takeover-test',provider,clock,pageSize:1};const original=createUsageSyncService(db,options);const id=await original.enqueue(user,date);await original.runOne();const old=original.runOne();await entered;
 await db.query("UPDATE jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
 const replacement=createUsageSyncService(db,options);await replacement.runOne();releaseOld();await old;
 let loops=0;while(await replacement.runOne())assert.ok(++loops<10);
 assert.equal((await replacement.status(id)).status,'succeeded');assert.equal((await createUsageSnapshotStore(db,{providerAccount:'takeover-test',clock,pageSize:1}).readCurrent(user,date)).items[0]?.usage.total_tokens,'200');
});

test('a shared provider pause prevents starting unrelated HTTP work and a stale scope restarts before another fetch',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID();await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)',[user,'sync@example.invalid','暂停夹具']);let calls=0;
 const provider={getMemberUsage:async(query:MemberUsageQuery)=>{calls++;return response(query,[value('A','100')]);}};const sync=createUsageSyncService(db,{providerAccount:'pause-test',provider,clock,pageSize:1});const id=await sync.enqueue(user,date);
 await db.query("INSERT INTO usage_provider_control(provider_account,interval_ms,paused_until) VALUES('pause-test',500,clock_timestamp()+interval '1 minute')");assert.equal(await sync.runOne(),false);assert.equal(calls,0);
 await db.query("UPDATE usage_provider_control SET paused_until=clock_timestamp()-interval '1 second' WHERE provider_account='pause-test'");await sync.runOne();
 await db.query("UPDATE usage_snapshot_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE state='building'");await sync.runOne();assert.equal(calls,0);assert.equal((await sync.status(id)).error_code,'stale_usage_lease');
});


test('recurring checks follow actual bill changes and cool down across restart without treating repeated verification as activity',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'sync@example.invalid','分级重查')",[user]);
 let at=new Date('2026-09-24T12:00:00Z'),tokens='100';const options={providerAccount:'adaptive-test',clock:()=>at,provider:{getMemberUsage:async(query:MemberUsageQuery)=>response(query,[value('A',tokens)])}};
 async function refresh(){const sync=createUsageSyncService(db,options);const job=await sync.enqueue(user,date,{recurring:true});for(let step=0;step<8;step++){await sync.runOne();const state=await sync.status(job);if(state.status==='succeeded')return state;}throw new Error('synthetic sync did not finish');}
 const hot=await refresh();assert.equal(hot.available_at,'2026-09-24T12:05:00.000Z');
 at=new Date('2026-09-24T14:00:00Z');const warm=await refresh();assert.equal(warm.available_at,'2026-09-24T15:00:00.000Z');
 at=new Date('2026-09-24T14:10:00Z');tokens='80';const revised=await refresh();assert.equal(revised.available_at,'2026-09-24T14:15:00.000Z');
 at=new Date('2026-09-25T15:00:00Z');const coldGap=await refresh();assert.equal(coldGap.available_at,'2026-09-26T15:00:00.000Z','an unresolved bill is retried daily, not once every 30 days');
 const stored=await createUsageSnapshotStore(db,{providerAccount:'adaptive-test',clock:()=>at}).readCurrent(user,date);assert.equal(stored.items[0]?.usage.total_tokens,'80');
});


test('extending the current-day query window does not keep an unchanged ledger hot, but a new Hook observation does',async t=>{
 const db=await testDatabase(t);await db.migrate();await db.ensurePartitions(new Date('2026-09-01Z'),new Date('2026-10-01Z'));
 const user=randomUUID(),installation=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'sync@example.invalid','活动重查')",[user]);await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'测试')",[installation,user,'a'.repeat(64)]);
 let at=new Date('2026-09-23T02:00:00Z');const options={providerAccount:'window-test',clock:()=>at,provider:{getMemberUsage:async(query:MemberUsageQuery)=>response(query,[value('A','100')])}};
 async function refresh(){const sync=createUsageSyncService(db,options);const job=await sync.enqueue(user,date,{recurring:true});for(let step=0;step<8;step++){await sync.runOne();const state=await sync.status(job);if(state.status==='succeeded')return state;}throw new Error('sync did not finish');}
 assert.equal((await refresh()).available_at,'2026-09-23T02:05:00.000Z');
 at=new Date('2026-09-23T04:00:00Z');assert.equal((await refresh()).available_at,'2026-09-23T05:00:00.000Z');
 const activity=await db.ingest({schema_version:2,installation_id:installation,client_event_id:'new-activity',event_type:'UserPromptSubmit',source_session_id:'active-hook',occurred_at:at.toISOString(),payload:{prompt:'合成活动'}},{admissionEpoch:1,receivedAt:at});
 assert.equal((await refresh()).available_at,'2026-09-23T04:05:00.000Z');
 if(activity.outcome!=='committed')throw new Error('fixture activity missing');
 await createUsageAttributionService(db,{providerAccount:'window-test',clock:()=>at,provider:{getSessionUsage:async hook=>({items:[value('A','100')],pagination:null,request_id:'synthetic',observed_at:at.toISOString(),response_hash:'a'.repeat(64),query:{endpoint:'session_usage_detail',parameters:{session_ids:[hook]}}})}}).probe(activity.sessionId);
 at=new Date('2026-09-25T05:00:00Z');assert.equal((await refresh()).available_at,'2026-09-26T05:00:00.000Z','known links do not prove the Hook day is complete');
});


test('a recurring failed source stays visibly failed, then resumes its daily retry after coordinator restart',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'sync@example.invalid','失败恢复')",[user]);
 let unavailable=true;const options={providerAccount:'failed-recurring',clock,provider:{getMemberUsage:async(query:MemberUsageQuery)=>{if(unavailable)throw new UsageProviderError('provider_auth_failed',401);return response(query,[value('A','100')]);}}};
 const sync=createUsageSyncService(db,options);const id=await sync.enqueue(user,date,{recurring:true});await sync.runOne();await sync.runOne();
 const failed=await sync.status(id);assert.equal(failed.status,'failed');assert.equal(failed.error_code,'provider_auth_failed');
 assert.ok(Date.parse(failed.available_at)>Date.now()+23*3600000,'terminal failures keep a bounded daily retry, not an immediately due dead job');
 unavailable=false;await db.query("UPDATE jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
 const restarted=createUsageSyncService(db,options);for(let step=0;step<8&&(await restarted.status(id)).status!=='succeeded';step++)assert.equal(await restarted.runOne(),true);
 assert.equal((await restarted.status(id)).status,'succeeded');assert.equal((await createUsageSnapshotStore(db,{providerAccount:'failed-recurring',clock}).readCurrent(user,date)).items[0]?.usage.total_tokens,'100');
});


test('new same-day Hooks advance a cold pending check once without creating one query job per message',async t=>{
 const db=await testDatabase(t);await db.migrate();await db.ensurePartitions(new Date('2026-09-01Z'),new Date('2026-10-01Z'));
 const user=randomUUID(),installation=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'sync@example.invalid','活动唤醒')",[user]);await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'测试')",[installation,user,'b'.repeat(64)]);
 let at=new Date('2026-09-24T12:00:00Z');const options={providerAccount:'wake-test',clock:()=>at,provider:{getMemberUsage:async(query:MemberUsageQuery)=>response(query,[])}};
 const sync=createUsageSyncService(db,options);const id=await sync.enqueue(user,'2026-09-24',{recurring:true});for(let step=0;step<4;step++)await sync.runOne();assert.equal((await sync.status(id)).available_at,'2026-09-24T13:00:00.000Z');
 at=new Date('2026-09-24T12:10:00Z');for(let i=0;i<3;i++)await db.ingest({schema_version:2,installation_id:installation,client_event_id:`wake-${i}`,event_type:'UserPromptSubmit',source_session_id:`wake-${i}`,occurred_at:at.toISOString(),payload:{prompt:'合成活动'}},{admissionEpoch:1,receivedAt:at});
 await sync.discoverRecent();const advanced=await sync.status(id);assert.equal(advanced.available_at,'2026-09-24T12:15:00.000Z');assert.equal(advanced.status,'succeeded');
 await db.query("UPDATE usage_provider_control SET discovery_at='1970-01-01Z' WHERE provider_account='wake-test'");await createUsageSyncService(db,options).discoverRecent();assert.equal((await sync.status(id)).available_at,advanced.available_at);
});


test('a historical backfill with unresolved usage remains recurring after its initial pass',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'sync@example.invalid','历史缺口')",[user]);
 let at=new Date();const target=new Date(at.getTime()+28800000-10*86400000).toISOString().slice(0,10);
 const options={providerAccount:'history-gap',clock:()=>at,provider:{getMemberUsage:async(query:MemberUsageQuery)=>response(query,new Date(query.start_time*1000+28800000).toISOString().slice(0,10)===target?[{...value('A','100'),start_time:String(query.start_time+1)}]:[])}};
 const sync=createUsageSyncService(db,options);await sync.retryBackfill(user);for(let step=0;step<250&&await sync.runOne();step++)assert.ok(step<249);
 const id=(await db.query<{id:string}>('SELECT id FROM jobs WHERE dedupe_key=$1',[`usage:history-gap:${user}:${target}`])).rows[0]!.id;
 assert.equal((await sync.status(id)).status,'succeeded');
 at=new Date(at.getTime()+26*3600000);await db.query("UPDATE jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);
 const restarted=createUsageSyncService(db,options);assert.equal(await restarted.runOne(),true,'the historical gap must still be eligible after initial backfill');
 for(let step=0;step<8&&(await restarted.status(id)).status!=='succeeded';step++)assert.equal(await restarted.runOne(),true);
 assert.equal((await restarted.status(id)).available_at,new Date(at.getTime()+86400000).toISOString());
});


test('a late historical Hook atomically advances its existing cold day even while the usage worker is stopped',async t=>{
 const db=await testDatabase(t);await db.migrate();await db.ensurePartitions(new Date('2026-09-01Z'),new Date('2026-10-01Z'));
 const user=randomUUID(),installation=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'sync@example.invalid','迟到唤醒')",[user]);await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'测试')",[installation,user,'c'.repeat(64)]);
 let at=new Date('2026-09-24T12:00:00Z');const sync=createUsageSyncService(db,{providerAccount:'late-wake',clock:()=>at,provider:{getMemberUsage:async(query:MemberUsageQuery)=>response(query,[])}});
 const id=await sync.enqueue(user,'2026-09-14',{recurring:true});for(let step=0;step<4;step++)await sync.runOne();assert.equal((await sync.status(id)).available_at,'2026-10-24T12:00:00.000Z');
 at=new Date('2026-09-24T12:10:00Z');const event={schema_version:2 as const,installation_id:installation,client_event_id:'late-history',event_type:'UserPromptSubmit' as const,source_session_id:'late-history',occurred_at:'2026-09-14T12:00:00Z',payload:{prompt:'合成迟到'}};
 assert.equal((await db.ingest(event,{admissionEpoch:1,receivedAt:at})).outcome,'committed');assert.equal((await sync.status(id)).available_at,'2026-09-24T12:15:00.000Z');
 assert.equal((await db.ingest(event,{admissionEpoch:1,receivedAt:new Date(at.getTime()+600000)})).outcome,'duplicate');assert.equal((await sync.status(id)).available_at,'2026-09-24T12:15:00.000Z','replay cannot postpone the merged task');
});


test('reactivation resumes a failed historical recurring job even when its backfill receipts already complete the window',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID(),at=new Date();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'sync@example.invalid','恢复旧缺口')",[user]);
 const options={providerAccount:'reactivated-history',clock:()=>at,provider:{getMemberUsage:async(query:MemberUsageQuery)=>response(query,[])}};const sync=createUsageSyncService(db,options);await sync.retryBackfill(user);for(let step=0;step<250&&await sync.runOne();step++)assert.ok(step<249);
 assert.equal((await sync.backfillStatus()).completed_users,1);const target=new Date(at.getTime()+28800000-10*86400000).toISOString().slice(0,10);
 const id=(await db.query<{id:string}>('SELECT id FROM jobs WHERE dedupe_key=$1',[`usage:reactivated-history:${user}:${target}`])).rows[0]!.id;
 await db.query("UPDATE users SET status='suspended',ingest_epoch=ingest_epoch+1 WHERE id=$1",[user]);await db.query("UPDATE jobs SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",[id]);assert.equal(await sync.runOne(),true);assert.equal((await sync.status(id)).error_code,'account_inactive');
 await db.query("UPDATE users SET status='active',ingest_epoch=ingest_epoch+1 WHERE id=$1",[user]);const restarted=createUsageSyncService(db,options);await restarted.discoverRecent();
 assert.equal((await restarted.backfillStatus()).completed_users,1);assert.equal((await restarted.status(id)).status,'queued');
});


for(const promptTokens of [null,'100'])test(`a cross-day linked bill with ${promptTokens===null?'missing input tokens':'complete Token fields'} stays in daily reconciliation`,async t=>{
 const db=await testDatabase(t);await db.migrate();await db.ensurePartitions(new Date('2026-09-01Z'),new Date('2026-10-01Z'));
 const user=randomUUID(),installation=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'sync@example.invalid','跨日字段缺口')",[user]);await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'测试')",[installation,user,'d'.repeat(64)]);
 const event=await db.ingest({schema_version:2,installation_id:installation,client_event_id:'cross-day',event_type:'UserPromptSubmit',source_session_id:'cross-day',occurred_at:'2026-09-23T01:00:00Z',payload:{prompt:'合成跨日'}},{admissionEpoch:1,receivedAt:new Date('2026-09-23T01:00:00Z')});if(event.outcome!=='committed')throw new Error('fixture event missing');
 let at=new Date('2026-09-24T02:00:00Z');const options={providerAccount:'missing-input',clock:()=>at,provider:{getMemberUsage:async(query:MemberUsageQuery)=>response(query,[{...value('A','100'),start_time:String(query.start_time+1),usage:{...value('A','100').usage,prompt_tokens:promptTokens}}])}};
 async function refresh(){const sync=createUsageSyncService(db,options);const id=await sync.enqueue(user,'2026-09-24',{recurring:true});for(let step=0;step<4;step++)await sync.runOne();return sync.status(id);}
 await refresh();await createUsageAttributionService(db,{providerAccount:'missing-input',clock:()=>at,provider:{getSessionUsage:async hook=>({items:[value('A','100')],pagination:null,request_id:'synthetic',observed_at:at.toISOString(),response_hash:'a'.repeat(64),query:{endpoint:'session_usage_detail',parameters:{session_ids:[hook]}}})}}).probe(event.sessionId);
 at=new Date('2026-09-26T05:00:00Z');assert.equal((await refresh()).available_at,'2026-09-27T05:00:00.000Z');
});

test('upgrading an existing scope learns its record fingerprint without reheating unchanged historical bills',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'sync@example.invalid','升级冷数据')",[user]);
 let at=new Date('2026-09-24T12:00:00Z');const options={providerAccount:'upgraded-scope',clock:()=>at,provider:{getMemberUsage:async(query:MemberUsageQuery)=>response(query,[value('A','100')])}};
 async function refresh(){const sync=createUsageSyncService(db,options);const id=await sync.enqueue(user,date,{recurring:true});for(let step=0;step<4;step++)await sync.runOne();return sync.status(id);}
 await refresh();await db.query('UPDATE usage_scopes SET records_hash=NULL,last_content_change_at=NULL WHERE user_id=$1',[user]);
 at=new Date('2026-09-25T15:00:00Z');assert.equal((await refresh()).available_at,'2026-09-26T15:00:00.000Z');
});

test('the same person and business day keep one job regardless of UUID letter casing',async t=>{
 const db=await testDatabase(t);await db.migrate();const user=randomUUID();await db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'sync@example.invalid','同日任务身份')",[user]);
 const sync=createUsageSyncService(db,{providerAccount:'case-test',clock,provider:{getMemberUsage:async(query:MemberUsageQuery)=>response(query,[value('A','100')])}});
 const lower=await sync.enqueue(user,date),upper=await sync.enqueue(user.toUpperCase(),date);assert.equal(upper,lower);
 for(let step=0;await sync.runOne();step++)assert.ok(step<8);assert.equal((await sync.status(lower)).status,'succeeded');assert.equal((await createUsageSnapshotStore(db,{providerAccount:'case-test',clock}).readCurrent(user,date)).items[0]?.usage.total_tokens,'100');
});
