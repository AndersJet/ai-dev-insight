import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {SessionListDto} from '@adi/contracts';
import {stopUsageFixture} from '../helpers/stop-usage.js';
import {createSessionReadService,type AllSessionQuery} from '../../src/session-reading.js';
import {createSessionPersonalModelService} from '../../src/session-personal-models.js';
import {createUsageSnapshotStore} from '../../src/usage-snapshots.js';
import {createUsageAttributionService} from '../../src/usage-attribution.js';
import {createSessionListSnapshotPublisher} from '../../src/session-list-snapshot-publisher.js';
import {createSessionListSnapshotReader} from '../../src/session-list-snapshot-reading.js';

type Fixture=Awaited<ReturnType<typeof stopUsageFixture>>;
async function put(f:Fixture,source:string,at:string,prompt=source){
 const saved=await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:randomUUID(),source_session_id:source,event_type:'UserPromptSubmit',occurred_at:at,payload:{prompt}},{admissionEpoch:1,receivedAt:f.at});
 assert.equal(saved.outcome,'committed');if(saved.outcome!=='committed')throw new Error('Synthetic snapshot event did not commit');return saved;
}
async function legacyQuantity(f:Fixture){
 const store=createUsageSnapshotStore(f.db,{providerAccount:'stop-test'}),date=new Date(f.stop.getTime()+28800000).toISOString().slice(0,10),draft=await store.begin(f.user,date);
 for(const [index,part]of draft.parts.entries())await store.stage(draft,index,await f.provider.getMemberUsage(part.query));
 await store.publish(draft);
 await createUsageAttributionService(f.db,{providerAccount:'stop-test',provider:{getSessionUsage:async hook=>({...await f.provider.getSessionUsage('official-bill'),query:{endpoint:'session_usage_detail',parameters:{session_ids:[hook]}}})}}).probe(f.session);
}
async function anotherOwner(f:Fixture){
 const user=randomUUID(),installation=randomUUID(),email=`snapshot-other-${randomUUID()}@example.invalid`;
 await f.db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)',[user,email,'另一位快照本人']);
 const issued=await f.identity.resetPassword(f.login.token,user,1),initial=await f.identity.login(email,issued.temporaryPassword),login=await f.identity.changePassword(initial.token,issued.temporaryPassword,'snapshot-other-synthetic-password');
 await f.db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'另一位合成安装')",[installation,user,'b'.repeat(64)]);
 const saved=await f.db.ingest({schema_version:2,installation_id:installation,client_event_id:randomUUID(),source_session_id:'snapshot-other-owner',event_type:'UserPromptSubmit',occurred_at:f.at.toISOString(),payload:{prompt:'PRIVATE_SNAPSHOT_OTHER_OWNER'}},{admissionEpoch:1,receivedAt:f.at});
 assert.equal(saved.outcome,'committed');if(saved.outcome!=='committed')throw new Error('Synthetic other snapshot owner did not commit');return {user,login,session:saved.sessionId};
}
function readers(f:Fixture,stopWindowEnabled=true){
 let time=f.at.getTime();const clock=()=>new Date(time),options={providerAccount:'stop-test',stopWindowEnabled,clock};
 const publisher=createSessionListSnapshotPublisher(f.db,options),snapshots=createSessionListSnapshotReader(f.db,options);
 const current=createSessionReadService(f.db,f.identity,{...options,snapshots}),legacy=createSessionReadService(f.db,f.identity,options);
 return {publisher,snapshots,current,legacy,clock,advance:(ms:number)=>{time+=ms;}};
}
function comparable(page:SessionListDto){return {period:page.period,items:page.items,total:page.total,has_more:page.has_more,channel_available:page.channel_available,available_channels:page.available_channels};}
async function pages(read:(input:AllSessionQuery)=>Promise<SessionListDto>,input:AllSessionQuery={}){
 const first=await read({...input,limit:1}),all=[...first.items];let cursor=first.next_cursor;
 while(cursor){const next=await read({...input,limit:1,cursor});assert.equal(next.total,first.total);all.push(...next.items);cursor=next.next_cursor;assert.ok(all.length<=first.total,'fixed pagination must terminate without repeating facts');}
 assert.equal(all.length,first.total);assert.equal(new Set(all.map(row=>row.id)).size,all.length);return {total:first.total,items:all};
}
async function classifiedFixture(t:TestContext,stop:boolean){
 const f=await stopUsageFixture(t);assert.equal((await f.run()).status,'succeeded');await legacyQuantity(f);
 const custom=(await put(f,'snapshot-custom',new Date(f.start.getTime()-120000).toISOString())).sessionId;
 const pending=(await put(f,'snapshot-pending',new Date(f.start.getTime()-180000).toISOString())).sessionId;
 const needle='SNAPSHOT_NEEDLE_AFTER_160',unknown=(await put(f,'snapshot-unknown',new Date(f.start.getTime()-240000).toISOString(),'界🙂'.repeat(100)+needle)).sessionId;
 const declarations=createSessionPersonalModelService(f.db,f.identity);
 for(const session of [f.session,custom])await declarations.replace(f.login.token,session,{version:0,cleanup_generation:0,models:['本人确认模型']});
 await f.jobs.enqueue(pending);const other=await anotherOwner(f);
 const departments=(await f.db.query<{id:string}>("INSERT INTO departments(id,name) VALUES(gen_random_uuid(),'快照部门一'),(gen_random_uuid(),'快照部门二') RETURNING id")).rows;
 await f.db.query('INSERT INTO membership_periods(user_id,department_id,valid_from) VALUES($1,$2,$3),($4,$5,$3)',[f.user,departments[0]!.id,new Date(f.start.getTime()-7*86400000),other.user,departments[1]!.id]);
 await f.db.query('UPDATE hook_events SET department_id=$1 WHERE user_id=$2',[departments[0]!.id,f.user]);await f.db.query('UPDATE hook_events SET department_id=$1 WHERE user_id=$2',[departments[1]!.id,other.user]);
 const r=readers(f,stop);assert.equal(await r.publisher.runOne(true),true);return {f,...r,custom,pending,unknown,other,departments,needle};
}

for(const stop of [false,true])test(`published snapshots match live mine, super, department and all four channel semantics with Stop ${stop?'on':'off'}`,async t=>{
 const x=await classifiedFixture(t,stop),{f}=x;
 for(const channel of ['all','official','pending','custom'] as const){
  const old=await x.legacy.listMine(f.login.token,{channel,limit:1}),current=await x.current.listMine(f.login.token,{channel,limit:1});assert.deepEqual(comparable(current),comparable(old));
  const expected=await pages(input=>x.legacy.listMine(f.login.token,input),{channel}),actual=await pages(input=>x.current.listMine(f.login.token,input),{channel});assert.deepEqual(actual,expected);
 }
 const mine=await x.current.listMine(f.login.token,{});assert.equal(mine.total,4);assert.ok(!mine.items.some(row=>row.user_id===x.other.user));
 const primary=mine.items.find(row=>row.id===f.session)!;assert.equal(primary.channel,'mixed');assert.equal(primary.official_tokens,stop?'176004':'31336');
 assert.equal(mine.items.find(row=>row.id===x.custom)?.channel,'custom');assert.equal(mine.items.find(row=>row.id===x.pending)?.channel,'pending');assert.equal(mine.items.find(row=>row.id===x.unknown)?.channel,'unknown');
 for(const input of [{},{user_id:f.user},{department_id:x.departments[0]!.id},{department_id:x.departments[1]!.id}] as AllSessionQuery[])assert.deepEqual(comparable(await x.current.listAll(f.login.token,input)),comparable(await x.legacy.listAll(f.login.token,input)));
 assert.deepEqual(comparable(await x.current.listMine(x.other.login.token,{})),comparable(await x.legacy.listMine(x.other.login.token,{})));await assert.rejects(x.current.listAll(x.other.login.token,{}),{code:'forbidden'});
 const searched=await x.current.listMine(f.login.token,{search:x.needle,limit:1});assert.equal(searched.total,1);assert.equal(searched.items[0]?.id,x.unknown);assert.ok(!searched.items[0]?.title.includes(x.needle));assert.deepEqual(comparable(searched),comparable(await x.legacy.listMine(f.login.token,{search:x.needle,limit:1})));
 assert.equal((await x.current.listMine(f.login.token,{search:'PRIVATE_SNAPSHOT_OTHER_OWNER'})).total,0);assert.equal((await x.current.listAll(f.login.token,{search:'PRIVATE_SNAPSHOT_OTHER_OWNER'})).total,1);
 const snapshot=(await x.publisher.latest())!,stored=(await f.db.query<{payload:unknown}>('SELECT payload FROM session_list_snapshot_entries WHERE id=$1',[snapshot.owner_entries[f.user]])).rows[0]!.payload;assert.ok(!JSON.stringify(stored).includes(x.needle),'full private prompt suffixes must stay out of published owner payloads');
});

test('new Hook and background source refresh enter the next snapshot while old cursors retain their original complete pages',async t=>{
 const x=await classifiedFixture(t,true),{f}=x,initial=await x.current.listMine(f.login.token,{limit:1});assert.ok(initial.next_cursor);
 const expected=await pages(input=>x.current.listMine(f.login.token,input));
 const added=(await put(f,'snapshot-new-after-publish',f.at.toISOString(),'AFTER_SNAPSHOT_NEW_PROMPT')).sessionId;
 const pending=await x.current.listMine(f.login.token,{});assert.equal(pending.total,4);assert.ok(!pending.items.some(row=>row.id===added));
 f.control.tokens=222222;assert.equal((await f.run()).status,'succeeded');x.advance(1000);assert.equal(await x.publisher.runOne(true),true);
 const pinned=await x.current.listMine(f.login.token,{limit:1,cursor:initial.next_cursor});assert.equal(pinned.total,4);assert.equal(pinned.snapshot?.id,initial.snapshot?.id);assert.equal(pinned.snapshot?.updating,true);assert.equal(pinned.items[0]?.id,expected.items[1]?.id);
 const oldItems=[...initial.items,...pinned.items];let cursor=pinned.next_cursor;while(cursor){const next=await x.current.listMine(f.login.token,{limit:1,cursor});assert.equal(next.total,4);assert.equal(next.snapshot?.id,initial.snapshot?.id);oldItems.push(...next.items);cursor=next.next_cursor;}assert.deepEqual(oldItems,expected.items);
 await x.snapshots.warm(); // This assertion explicitly requests the latest complete prepared publication.
 const fresh=await x.current.listMine(f.login.token,{});assert.equal(fresh.total,5);assert.notEqual(fresh.snapshot?.id,initial.snapshot?.id);assert.ok(fresh.items.some(row=>row.id===added));assert.equal(fresh.items.find(row=>row.id===f.session)?.official_tokens,'222222');
});

test('snapshot expiration requires a fresh query and a cursor cannot be replayed by another authenticated actor or scope',async t=>{
 const x=await classifiedFixture(t,false),{f}=x,page=await x.current.listMine(f.login.token,{limit:1});assert.ok(page.next_cursor);
 await assert.rejects(x.current.listMine(x.other.login.token,{limit:1,cursor:page.next_cursor}),{code:'invalid_cursor'});
 await assert.rejects(x.current.listMine(f.login.token,{limit:1,channel:'custom',cursor:page.next_cursor}),{code:'invalid_cursor'});
 x.advance(60001);await assert.rejects(x.current.listMine(f.login.token,{limit:1,cursor:page.next_cursor}),{code:'session_snapshot_expired',status:409});
 assert.equal(await x.publisher.runOne(true),true);await x.snapshots.warm();const fresh=await x.current.listMine(f.login.token,{limit:1});assert.notEqual(fresh.snapshot?.id,page.snapshot?.id);assert.equal(fresh.total,4);
});

test('snapshot metadata preserves microseconds and fixes stable page order for distinct facts within one millisecond',async t=>{
 const f=await stopUsageFixture(t),base=new Date(f.at.getTime()-5000).toISOString().slice(0,19),firstAt=base+'.123456Z',lastAt=base+'.123457Z';
 const first=await put(f,'snapshot-micro-first',firstAt),last=await put(f,'snapshot-micro-last',lastAt),x=readers(f,false);await x.publisher.runOne(true);
 const page=await x.current.listMine(f.login.token,{limit:1});assert.equal(page.items[0]?.id,last.sessionId);assert.equal(page.items[0]?.first_at,lastAt);assert.equal(page.items[0]?.last_at,lastAt);
 assert.deepEqual(comparable(page),comparable(await x.legacy.listMine(f.login.token,{limit:1})));assert.ok(page.next_cursor);const next=await x.current.listMine(f.login.token,{limit:1,cursor:page.next_cursor});assert.equal(next.items[0]?.id,first.sessionId);assert.equal(next.items[0]?.last_at,firstAt);
});

for(const changed of ['cleanup','retention','recovery'] as const)test(`a warmed snapshot immediately rejects ${changed} changes before refresh or physical removal`,async t=>{
 const f=await stopUsageFixture(t),x=readers(f,false);await x.publisher.runOne(true);assert.equal((await x.current.listMine(f.login.token,{})).total,1);
 if(changed==='cleanup')await f.db.transaction(async client=>{await client.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1',[f.user]);await client.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,1)',[f.user,f.start,new Date(f.at.getTime()+1000)]);});
 if(changed==='retention')await f.db.query('UPDATE data_identity SET retention_cutoff=$1',[new Date(f.start.getTime()-1000)]);
 if(changed==='recovery')await f.db.query("WITH r AS(INSERT INTO recovery_runs(id,dataset_id,state) SELECT gen_random_uuid(),dataset_id,'quarantined' FROM data_identity RETURNING id) UPDATE data_identity SET recovery_id=(SELECT id FROM r)");
 const expected=changed==='recovery'?['recovery_quarantined']:['content_changed','session_snapshot_pending'];
 await assert.rejects(x.current.listMine(f.login.token,{}),error=>!!error&&typeof error==='object'&&'code'in error&&expected.includes(String(error.code)));
 assert.ok((await f.db.query('SELECT count(*)::int AS n FROM hook_events WHERE user_id=$1',[f.user])).rows[0]!.n>0,'safety rejection must not depend on physical removal of the facts');
});

test('role revocation after the snapshot read withdraws the response before service delivery',async t=>{
 const f=await stopUsageFixture(t),x=readers(f,false);await x.publisher.runOne(true);let revoked=false;
 const snapshots={...x.snapshots,read:async(input:Parameters<typeof x.snapshots.read>[0])=>{const result=await x.snapshots.read(input);const removed=await f.db.query("DELETE FROM role_grants WHERE user_id=$1 AND role='super' RETURNING id",[f.user]);assert.equal(removed.rowCount,1);revoked=true;return result;}};
 const reader=createSessionReadService(f.db,f.identity,{providerAccount:'stop-test',clock:x.clock,snapshots});await assert.rejects(reader.listAll(f.login.token,{}),{code:'forbidden'});assert.equal(revoked,true);
});

test('authentication revocation after loading a fixed snapshot prevents delivery to the old login',async t=>{
 const f=await stopUsageFixture(t),x=readers(f,false);await x.publisher.runOne(true);
 const snapshots={...x.snapshots,read:async(input:Parameters<typeof x.snapshots.read>[0])=>{const result=await x.snapshots.read(input);await f.db.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1',[f.user]);return result;}};
 const reader=createSessionReadService(f.db,f.identity,{providerAccount:'stop-test',clock:x.clock,snapshots});await assert.rejects(reader.listMine(f.login.token,{}),{code:'unauthenticated'});
});

test('cleanup committed after loading a fixed snapshot still prevents delivery even when the login remains valid',async t=>{
 const f=await stopUsageFixture(t),x=readers(f,false);await x.publisher.runOne(true);
 const snapshots={...x.snapshots,read:async(input:Parameters<typeof x.snapshots.read>[0])=>{const result=await x.snapshots.read(input);await f.db.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1',[f.user]);return result;}};
 const reader=createSessionReadService(f.db,f.identity,{providerAccount:'stop-test',clock:x.clock,snapshots});
 await assert.rejects(reader.listMine(f.login.token,{}),error=>!!error&&typeof error==='object'&&'code'in error&&['content_changed','session_snapshot_expired','session_snapshot_pending'].includes(String(error.code)));
 assert.ok(await f.identity.resolve(f.login.token),'cleanup must not be misrepresented as login revocation');
});

test('snapshot legacy quantities retain business-date and local department scope while an invalid stored trial still suppresses fallback when enabled',async t=>{
 const f=await stopUsageFixture(t);await f.run();
 const midnight=Math.floor((f.at.getTime()+28800000)/86400000)*86400000-28800000,previous=new Date(f.start.getTime()-86400000);await f.db.ensurePartitions(previous,new Date(f.at.getTime()+1000));
 await put(f,'synthetic-hook',previous.toISOString(),'PREVIOUS_BUSINESS_DAY_PROMPT');
 const departments=(await f.db.query<{id:string}>("INSERT INTO departments(id,name) VALUES(gen_random_uuid(),'旧日部门'),(gen_random_uuid(),'新日部门') RETURNING id")).rows;
 await f.db.query('INSERT INTO membership_periods(user_id,department_id,valid_from,valid_to) VALUES($1,$2,$3,$4),($1,$5,$4,NULL)',[f.user,departments[0]!.id,new Date(midnight-7*86400000),new Date(midnight),departments[1]!.id]);
 await f.db.query('UPDATE hook_events SET department_id=CASE WHEN occurred_at<$1 THEN $2::uuid ELSE $3::uuid END WHERE user_id=$4',[new Date(midnight),departments[0]!.id,departments[1]!.id,f.user]);
 const store=createUsageSnapshotStore(f.db,{providerAccount:'stop-test'});
 for(const date of [new Date(previous.getTime()+28800000).toISOString().slice(0,10),new Date(f.stop.getTime()+28800000).toISOString().slice(0,10)]){const draft=await store.begin(f.user,date);for(const [index,part]of draft.parts.entries())await store.stage(draft,index,await f.provider.getMemberUsage(part.query));await store.publish(draft);}
 await createUsageAttributionService(f.db,{providerAccount:'stop-test',provider:{getSessionUsage:async hook=>({...await f.provider.getSessionUsage('official-bill'),query:{endpoint:'session_usage_detail',parameters:{session_ids:[hook]}}})}}).probe(f.session);
 for(const enabled of [false,true]){
  const x=readers(f,enabled);await x.publisher.runOne(true);
  const periods=[{from:new Date(midnight-86400000).toISOString(),to:new Date(midnight).toISOString()},{from:new Date(midnight).toISOString(),to:new Date(midnight+86400000).toISOString()}];
  for(const period of periods)for(const department_id of [undefined,departments[0]!.id,departments[1]!.id]){const input={...period,...(department_id?{department_id}:{})};assert.deepEqual(comparable(await x.current.listAll(f.login.token,input)),comparable(await x.legacy.listAll(f.login.token,input)));}
  const mine=await x.current.listMine(f.login.token,{});assert.equal(mine.items[0]?.official_tokens,enabled?null:'62672');assert.equal(mine.items[0]?.official_records,enabled?0:2);
 }
});

test('full-text search cannot borrow a new occurrence of an event UUID from outside the fixed snapshot',async t=>{
 const f=await stopUsageFixture(t),x=readers(f,false);await x.publisher.runOne(true);
 const event=(await f.db.query<{id:string}>('SELECT id FROM hook_events WHERE session_id=$1 AND event_type=$2 ORDER BY occurred_at,id LIMIT 1',[f.session,'UserPromptSubmit'])).rows[0]!;
 const needle='ONLY_LATER_OCCURRENCE_NEEDLE';
 await f.db.transaction(async client=>{
  const generation=(await client.query<{generation:number}>("UPDATE jobs SET generation=generation+1 WHERE dedupe_key='derive:'||$1::text RETURNING generation",[f.session])).rows[0]!.generation;
  await client.query('INSERT INTO hook_events(id,occurred_at,user_id,installation_id,session_id,event_type,payload,capture_generation) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[event.id,f.at,f.user,f.installation,f.session,'UserPromptSubmit',{prompt:needle},generation]);
  await client.query('UPDATE sessions SET last_at=GREATEST(last_at,$2) WHERE id=$1',[f.session,f.at]);
 });
 assert.equal((await x.current.listMine(f.login.token,{search:needle})).total,0,'UUID equality alone must not turn a later fact into a pinned prompt');
 assert.equal((await x.current.listAll(f.login.token,{search:needle})).total,0,'the global literal prefilter must also bind the complete event identity including its microsecond time');
 x.advance(1000);await x.publisher.runOne(true);await x.snapshots.warm();assert.equal((await x.current.listMine(f.login.token,{search:needle})).items[0]?.id,f.session);
 assert.equal((await x.current.listAll(f.login.token,{search:needle})).items[0]?.id,f.session);
});

test('global native stored normalization preserves exact literal, Unicode and short PostgreSQL search results',async t=>{
 const f=await stopUsageFixture(t),texts=['prefix [a%_\\] suffix','prefix [aXXq] suffix','中文🙂 123-ABC and İIK','中文 École éCOLE','prefix ab suffix','prefix iik suffix'];
 for(const [n,prompt]of texts.entries())await put(f,'literal-exact-'+n,new Date(f.start.getTime()+n+1).toISOString(),prompt);
 const x=readers(f,false);await x.publisher.runOne(true);
 for(const search of ['[a%_\\]','123','ABC','iik','中文','École','ab']){
  const input={search,limit:100};assert.deepEqual(comparable(await x.current.listAll(f.login.token,input)),comparable(await x.legacy.listAll(f.login.token,input)),search);
 }
 assert.equal((await x.current.listAll(f.login.token,{search:'[a%_\\]'})).total,1,'LIKE metacharacters remain literal text');
});

test('non-business-day list windows disable official conflict evidence exactly as the live reader does',async t=>{
 const f=await stopUsageFixture(t);await f.run();await legacyQuantity(f);
 const competitor=(await put(f,'snapshot-competing-claim',new Date(f.start.getTime()-1000).toISOString())).sessionId;
 await createUsageAttributionService(f.db,{providerAccount:'stop-test',provider:{getSessionUsage:async hook=>({...await f.provider.getSessionUsage('official-bill'),query:{endpoint:'session_usage_detail',parameters:{session_ids:[hook]}}})}}).probe(competitor);
 const x=readers(f,false);await x.publisher.runOne(true);
 const whole=await x.current.listMine(f.login.token,{});assert.equal(whole.items.find(row=>row.id===f.session)?.attribution_conflicts,1,'the fixture must contain a real owner-wide competing billing claim');
 const period={from:new Date(f.start.getTime()-2000).toISOString(),to:new Date(f.at.getTime()+1000).toISOString()},old=await x.legacy.listMine(f.login.token,period),current=await x.current.listMine(f.login.token,period);
 assert.equal(old.channel_available,false);assert.ok(old.items.every(row=>row.attribution_conflicts===0));assert.deepEqual(comparable(current),comparable(old));
});

test('an authenticated fixed 45-day page crosses Beijing midnight until snapshot expiration while fresh requests keep the current 45-day bound',async t=>{
 const f=await stopUsageFixture(t);await put(f,'midnight-second-page',new Date(f.start.getTime()-1000).toISOString());
 const day=86400000,midnight=Math.floor((f.at.getTime()+28800000)/day)*day-28800000,publishedAt=midnight+day-20000;let time=publishedAt;
 const clock=()=>new Date(time),publisher=createSessionListSnapshotPublisher(f.db,{providerAccount:'stop-test',clock:()=>new Date(publishedAt)}),snapshots=createSessionListSnapshotReader(f.db,{providerAccount:'stop-test',clock});
 const reader=createSessionReadService(f.db,f.identity,{providerAccount:'stop-test',clock,snapshots});await publisher.runOne(true);
 const period={from:new Date(midnight-44*day).toISOString(),to:new Date(midnight+day).toISOString()},first=await reader.listMine(f.login.token,{...period,limit:1});assert.equal(first.total,2);assert.ok(first.next_cursor);
 time+=30000;const next=await reader.listMine(f.login.token,{...period,limit:1,cursor:first.next_cursor});assert.equal(next.snapshot?.id,first.snapshot?.id);assert.equal(next.total,2);assert.notEqual(next.items[0]?.id,first.items[0]?.id);
 await assert.rejects(reader.listMine(f.login.token,{...period,limit:1}),{code:'invalid_period',status:422});
 time=publishedAt+80001;await assert.rejects(reader.listMine(f.login.token,{...period,limit:1,cursor:first.next_cursor}),{code:'session_snapshot_expired',status:409});
 await assert.rejects(reader.listMine(f.login.token,{...period,limit:1,cursor:'invalid-snapshot-cursor'}),{code:'invalid_cursor'});
});

test('a valid absent owner filter returns the same complete empty page as the legacy organization reader',async t=>{
 const f=await stopUsageFixture(t),x=readers(f,false),missing=randomUUID();await x.publisher.runOne(true);
 const old=await x.legacy.listAll(f.login.token,{user_id:missing}),current=await x.current.listAll(f.login.token,{user_id:missing});
 assert.equal(current.total,0);assert.deepEqual(current.items,[]);assert.equal(current.has_more,false);assert.equal(current.next_cursor,null);assert.deepEqual(comparable(current),comparable(old));
 assert.ok(current.snapshot);assert.equal((await x.current.listAll(f.login.token,{})).total,1,'a missing owner filter must not hide the independently visible existing owner');
});

test('a newly created selected owner keeps the old safe empty snapshot until a complete next publication includes its facts',async t=>{
 const f=await stopUsageFixture(t),x=readers(f,false),missing=randomUUID(),installation=randomUUID();await x.publisher.runOne(true);
 const initial=await x.current.listAll(f.login.token,{user_id:missing});assert.equal(initial.total,0);
 const snapshots={...x.snapshots,read:async(input:Parameters<typeof x.snapshots.read>[0])=>{
  const result=await x.snapshots.read(input);assert.equal(result.total,0);
  await f.db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)',[missing,`snapshot-new-${missing}@example.invalid`,'后来出现的合成人员']);
  await f.db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'新 owner 合成安装')",[installation,missing,'c'.repeat(64)]);
  const saved=await f.db.ingest({schema_version:2,installation_id:installation,client_event_id:randomUUID(),source_session_id:'next-published-new-owner',event_type:'UserPromptSubmit',occurred_at:f.at.toISOString(),payload:{prompt:'NEXT_PUBLISHED_OWNER_ONLY'}},{admissionEpoch:1,receivedAt:f.at});assert.equal(saved.outcome,'committed');return result;
 }};
 const reader=createSessionReadService(f.db,f.identity,{providerAccount:'stop-test',clock:x.clock,snapshots});
 const created=await reader.listAll(f.login.token,{user_id:missing});assert.equal(created.total,0);assert.deepEqual(created.items,[]);assert.equal(created.snapshot?.id,initial.snapshot?.id);
 const stillPinned=await x.current.listAll(f.login.token,{user_id:missing});assert.equal(stillPinned.total,0);assert.equal(stillPinned.snapshot?.id,initial.snapshot?.id);
 x.advance(1000);await x.publisher.runOne(true);await x.snapshots.warm();
 const fresh=await x.current.listAll(f.login.token,{user_id:missing});assert.equal(fresh.total,1);assert.equal(fresh.items[0]?.user_id,missing);assert.equal(fresh.items[0]?.title,'NEXT_PUBLISHED_OWNER_ONLY');assert.notEqual(fresh.snapshot?.id,initial.snapshot?.id);
 assert.deepEqual(comparable(fresh),comparable(await x.legacy.listAll(f.login.token,{user_id:missing})));
});

test('warming stable owner references survives renewed immutable headers and scope changes beyond the former 75-second cache window',async t=>{
 const f=await stopUsageFixture(t),owners=Array.from({length:17},(_,index)=>({id:randomUUID(),email:`stable-snapshot-${index}@example.invalid`,name:`Stable owner ${index}`}));
 await f.db.query('INSERT INTO users(id,email_key,display_name) SELECT id,email,name FROM jsonb_to_recordset($1::jsonb) x(id uuid,email text,name text)',[JSON.stringify(owners)]);
 const midnight=Math.floor((f.at.getTime()+28800000)/86400000)*86400000-28800000;let time=midnight+12*3600000,entryReads=0,headerReads=0;
 const clock=()=>new Date(time),db=new Proxy(f.db,{get(target,key,receiver){
  if(key==='query')return async(text:string,values?:unknown[])=>{
   if(text.includes('cleanup_generation,payload FROM session_list_snapshot_entries'))entryReads++;
   if(text.startsWith('SELECT * FROM session_list_snapshots WHERE id='))headerReads++;
   return target.query(text,values);
  };return Reflect.get(target,key,receiver);
 }});
 const publisher=createSessionListSnapshotPublisher(f.db,{providerAccount:'stop-test',clock}),snapshots=createSessionListSnapshotReader(db,{providerAccount:'stop-test',clock}),reader=createSessionReadService(f.db,f.identity,{providerAccount:'stop-test',clock,snapshots});
 await publisher.runOne(true);const initial=(await publisher.latest())!;assert.equal(Object.keys(initial.owner_entries).length,18);
 await snapshots.warm();assert.equal(entryReads,5,'the real JSON payloads must first be loaded in four-owner batches');assert.equal(headerReads,1);
 assert.equal((await reader.listAll(f.login.token,{})).total,1);const warmedReads=entryReads;
 for(let step=0;step<2;step++){
  time+=55000;await publisher.runOne(true);await snapshots.warm();const current=(await publisher.latest())!;assert.notEqual(current.id,initial.id);assert.deepEqual(current.owner_entries,initial.owner_entries,'renewed publications must actually reuse every unchanged immutable owner entry');
  assert.equal((await reader.listMine(f.login.token,{})).total,1);assert.equal((await reader.listAll(f.login.token,{channel:'custom'})).total,0);
  assert.equal((await reader.listAll(f.login.token,{user_id:owners[step]!.id})).total,0);assert.equal((await reader.listAll(f.login.token,{})).total,1);
 }
 assert.equal(headerReads,3,'each of three immutable headers is fetched once despite repeated current/header safety checks');assert.equal(entryReads,warmedReads,'changing scopes after 110 seconds must not reload the stable rich owner payloads');
 await f.db.query("DELETE FROM role_grants WHERE user_id=$1 AND role='super'",[f.user]);await assert.rejects(reader.listAll(f.login.token,{}),{code:'forbidden'});assert.equal(entryReads,warmedReads,'warm caches cannot bypass current authorization');
});
