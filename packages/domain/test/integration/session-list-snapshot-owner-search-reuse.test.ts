import {test,type TestContext} from 'node:test';
import {setImmediate as nextTurn,setTimeout as delay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import type {SessionListDto} from '@adi/contracts';
import type {Transaction} from '../../../storage/src/index.js';
import {stopUsageFixture} from '../helpers/stop-usage.js';
import {createSessionReadService} from '../../src/session-reading.js';
import {createSessionListSnapshotPublisher} from '../../src/session-list-snapshot-publisher.js';
import {createSessionListSnapshotReader} from '../../src/session-list-snapshot-reading.js';

type Fixture=Awaited<ReturnType<typeof stopUsageFixture>>;
type Person={user:string;installation:string};
type Statement={text:string;values:unknown[];completed:boolean};
type Fact={id:string;at:string;department:string|null;prompt:string};
const comparable=(page:SessionListDto)=>({items:page.items,total:page.total,has_more:page.has_more,channel_available:page.channel_available,available_channels:page.available_channels});
const ids=(page:SessionListDto)=>new Set(page.items.map(row=>row.id));
const isBody=(text:string)=>text.includes('hook_events')&&text.includes('prompt_search')&&text.includes('LIKE');

function observe(f:Fixture,onPayload?:()=>Promise<void>,onBody?:(sql:Transaction,statement:Statement)=>Promise<void>,onLower?:(sql:Transaction,statement:Statement)=>Promise<void>){
 const statements:Statement[]=[];
 const trace=(sql:Transaction)=>new Proxy(sql,{get(target,key,receiver){
  if(key==='query')return async(text:string,values?:unknown[])=>{
   const statement:Statement={text,values:values??[],completed:false};statements.push(statement);
   const result=await target.query(text,values);statement.completed=true;
   if(onBody&&isBody(text))await onBody(target,statement);
   if(onLower&&text==='SELECT pg_catalog.lower($1::text) AS pattern')await onLower(target,statement);
   if(onPayload&&text.includes('SELECT id,user_id,cleanup_generation,payload FROM session_list_snapshot_entries'))await onPayload();
   return result;
  };
  return Reflect.get(target,key,receiver);
 }});
 const db=new Proxy(f.db,{get(target,key,receiver){
  if(key==='query')return trace(target).query;
  if(key==='transaction')return <T>(work:(sql:Transaction)=>Promise<T>)=>target.transaction(sql=>work(trace(sql)));
  return Reflect.get(target,key,receiver);
 }});
 return {db,statements,bodies:()=>statements.filter(row=>isBody(row.text))};
}
async function person(f:Fixture):Promise<Person>{
 const user=randomUUID(),installation=randomUUID();
 await f.db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)',[user,'owner-search-'+user+'@example.invalid','Synthetic search owner']);
 await f.db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)',[installation,user,randomBytes(32).toString('hex'),'Synthetic owner search installation']);
 return {user,installation};
}
async function prompt(f:Fixture,owner:Person,source:string,at:Date,body:string){
 const saved=await f.db.ingest({schema_version:2,installation_id:owner.installation,client_event_id:randomUUID(),source_session_id:source,event_type:'UserPromptSubmit',occurred_at:at.toISOString(),payload:{prompt:body}},{admissionEpoch:1,receivedAt:f.at});
 assert.equal(saved.outcome,'committed');if(saved.outcome!=='committed')throw new Error('Synthetic owner-search fact did not commit');return saved.sessionId;
}
async function facts(f:Fixture,owner:Person,session:string,rows:Fact[]){
 await f.db.transaction(async sql=>{
  const generation=(await sql.query<{generation:number}>("UPDATE jobs SET generation=generation+1 WHERE dedupe_key='derive:'||$1::text RETURNING generation",[session])).rows[0]!.generation;
  await sql.query(`INSERT INTO hook_events(id,occurred_at,received_at,user_id,department_id,installation_id,session_id,event_type,payload,capture_generation)
   SELECT x.id,x.at,$2,$3,x.department,$4,$5,'UserPromptSubmit',jsonb_build_object('prompt',x.prompt),$6
   FROM jsonb_to_recordset($1::jsonb) x(id uuid,at timestamptz,department uuid,prompt text)`,[JSON.stringify(rows),f.at,owner.user,owner.installation,session,generation]);
  await sql.query('UPDATE sessions SET first_at=LEAST(first_at,(SELECT min(occurred_at) FROM hook_events WHERE session_id=$1)),last_at=GREATEST(last_at,(SELECT max(occurred_at) FROM hook_events WHERE session_id=$1)) WHERE id=$1',[session]);
 });
}
async function manyPrompts(f:Fixture,owner:Person,session:string,count:number,needle:string){
 await f.db.transaction(async sql=>{
  const generation=(await sql.query<{generation:number}>("UPDATE jobs SET generation=generation+1 WHERE dedupe_key='derive:'||$1::text RETURNING generation",[session])).rows[0]!.generation;
  await sql.query(`INSERT INTO hook_events(id,occurred_at,received_at,user_id,installation_id,session_id,event_type,payload,capture_generation)
   SELECT gen_random_uuid(),$1::timestamptz+n*interval '1 microsecond',$2,$3,$4,$5,'UserPromptSubmit',
    jsonb_build_object('prompt',repeat('Synthetic broad prompt ',12)||CASE WHEN n=$6 THEN $7::text ELSE n::text END),$8
   FROM generate_series(1,$6::integer) n`,[new Date(f.start.getTime()+1000),f.at,owner.user,owner.installation,session,count,needle,generation]);
  await sql.query('UPDATE sessions SET last_at=(SELECT max(occurred_at) FROM hook_events WHERE session_id=$1) WHERE id=$1',[session]);
 });
}
function readers(f:Fixture,db=f.db){
 let time=f.at.getTime();const clock=()=>new Date(time),options={providerAccount:'stop-test',stopWindowEnabled:false,clock};
 const publisher=createSessionListSnapshotPublisher(f.db,options),snapshots=createSessionListSnapshotReader(db,options);
 return {publisher,snapshots,current:createSessionReadService(db,f.identity,{...options,snapshots}),legacy:createSessionReadService(f.db,f.identity,options),advance:()=>{time+=1000;}};
}
function assertOnlyOwner(statement:Statement,owner:string){
 assert.match(statement.text,/JOIN LATERAL/,'the small changed-owner route must bound identities before reading bodies');
 assert.match(statement.text,/user_id\s*=\s*ANY/i,'a changed-owner batch must scope real SQL to its UUID array');
 const arrays=statement.values.filter(Array.isArray);assert.equal(arrays.length,1);assert.deepEqual(new Set(arrays[0]),new Set([owner]));
}

test('a global body search retains both positive and empty owner results when only another owner publishes',async t=>{
 const f=await stopUsageFixture(t),b=await person(f),c=await person(f),needle='OWNER_REUSE_SHARED_SUFFIX';
 const bFirst=await prompt(f,b,'reuse-b-first',new Date(f.start.getTime()+1000),'x'.repeat(220)+needle);
 const cStable=await prompt(f,c,'reuse-c-stable',new Date(f.start.getTime()+2000),'y'.repeat(220)+needle);
 await prompt(f,c,'reuse-c-stable',new Date(f.start.getTime()+2100),'Stable C second prompt without the search phrase');
 const observed=observe(f),x=readers(f,observed.db);await x.publisher.runOne(true);
 const initial=(await x.publisher.latest())!,first=await x.current.listAll(f.login.token,{search:needle,limit:100});
 assert.deepEqual(ids(first),new Set([bFirst,cStable]));assert.deepEqual(comparable(first),comparable(await x.legacy.listAll(f.login.token,{search:needle,limit:100})));
 assert.equal(observed.bodies().length,1);assert.ok(!observed.bodies()[0]!.text.includes('JOIN LATERAL'),'a fully cold global search keeps the broad global route');
 assert.equal((await x.current.listMine(f.login.token,{search:needle})).total,0);
 assert.deepEqual(ids(await x.current.listAll(f.login.token,{user_id:c.user,search:needle})),new Set([cStable]));
 assert.equal(observed.bodies().length,1,'initial broad search must seed positive AND empty owner caches');
 x.advance();const bNew=await prompt(f,b,'reuse-b-new',new Date(f.start.getTime()+3000),'z'.repeat(220)+needle);await x.publisher.runOne(true);await x.snapshots.warm();
 const latest=(await x.publisher.latest())!;assert.equal(latest.owner_entries[f.user],initial.owner_entries[f.user]);assert.equal(latest.owner_entries[c.user],initial.owner_entries[c.user]);assert.notEqual(latest.owner_entries[b.user],initial.owner_entries[b.user]);
 const before=observed.bodies().length,changed=await x.current.listAll(f.login.token,{search:needle,limit:100});
 assert.deepEqual(ids(changed),new Set([bFirst,bNew,cStable]));assert.deepEqual(comparable(changed),comparable(await x.legacy.listAll(f.login.token,{search:needle,limit:100})));
 const refresh=observed.bodies().slice(before);assert.equal(refresh.length,1);assertOnlyOwner(refresh[0]!,b.user);
 assert.equal((await x.current.listMine(f.login.token,{search:needle})).total,0);
 assert.deepEqual(ids(await x.current.listAll(f.login.token,{user_id:c.user,search:needle})),new Set([cStable]));
 assert.deepEqual(ids(await x.current.listAll(f.login.token,{search:needle,channel:'custom'})),new Set());
 assert.equal(observed.bodies().length,before+1,'stable positive and negative owners must not be queried again after publication');
});

test('a preceding owned empty search cannot turn the first broad global search into an owner body scan',async t=>{
 const f=await stopUsageFixture(t),b=await person(f),c=await person(f),needle='OWNER_REUSE_BROAD_SUFFIX';
 const bSession=await prompt(f,b,'broad-b',f.start,'Synthetic initial B prompt');
 const cSession=await prompt(f,c,'broad-c',f.start,'Synthetic initial C prompt');
 await manyPrompts(f,b,bSession,4000,needle);await manyPrompts(f,c,cSession,4000,needle);
 await prompt(f,c,'broad-c',new Date(f.start.getTime()+1500),'Stable C extra captured prompt without the search phrase');
 const observed=observe(f),x=readers(f,observed.db);await x.publisher.runOne(true);
 assert.equal((await x.current.listMine(f.login.token,{search:needle})).total,0);const ownedCount=observed.bodies().length;assert.equal(ownedCount,1);
 const global=await x.current.listAll(f.login.token,{search:needle,limit:100});assert.deepEqual(ids(global),new Set([bSession,cSession]));
 assert.deepEqual(comparable(global),comparable(await x.legacy.listAll(f.login.token,{search:needle,limit:100})));
 const broad=observed.bodies().slice(ownedCount);assert.equal(broad.length,1);assert.ok(!broad[0]!.text.includes('JOIN LATERAL'),'more than eight thousand uncached captured prompts retain broad global body search');
 assert.equal((await x.current.listMine(f.login.token,{search:needle})).total,0);assert.equal(observed.bodies().length,ownedCount+1);
 x.advance();await prompt(f,b,'broad-b',new Date(f.start.getTime()+2000),'Late '+needle);await x.publisher.runOne(true);await x.snapshots.warm();
 const before=observed.bodies().length,next=await x.current.listAll(f.login.token,{search:needle,limit:100});assert.deepEqual(ids(next),new Set([bSession,cSession]));
 const refresh=observed.bodies().slice(before);assert.equal(refresh.length,1);assertOnlyOwner(refresh[0]!,b.user);
});

test('overlapping global preparation and independent owned load reuse one canonical owner body search',async t=>{
 const f=await stopUsageFixture(t),needle='OWNER_REUSE_OVERLAP_SUFFIX';await prompt(f,{user:f.user,installation:f.installation},'synthetic-hook',new Date(f.start.getTime()+1000),'x'.repeat(220)+needle);
 let release!:()=>void,arrived!:()=>void,payloadReads=0;
 const gate=new Promise<void>(resolve=>{release=resolve;}),firstPayload=new Promise<void>(resolve=>{arrived=resolve;});t.after(release);
 const observed=observe(f,async()=>{if(++payloadReads===1){arrived();await gate;}}),x=readers(f,observed.db);await x.publisher.runOne(true);
 const all=x.current.listAll(f.login.token,{search:needle,limit:100});void all.catch(()=>{});
 try{
  await Promise.race([firstPayload,all.then(()=>{throw new Error('Global read completed without the real payload-load barrier');})]);
  const own=await x.current.listMine(f.login.token,{search:needle,limit:100});assert.deepEqual(ids(own),new Set([f.session]));assert.equal(observed.bodies().length,1);
 }finally{release();}
 const global=await all;assert.deepEqual(ids(global),new Set([f.session]));assert.equal(payloadReads,2,'the scoped read completes without waiting for unrelated global metadata');
 assert.equal(observed.bodies().length,1,'the late global payload reuses the independently loaded canonical owner body-hit cache');
 assert.deepEqual(comparable(global),comparable(await x.legacy.listAll(f.login.token,{search:needle,limit:100})));
});

test('owner search reuse keeps captured departments, native metadata and complete UUID/microsecond identities on old pages',async t=>{
 const f=await stopUsageFixture(t),owner={user:f.user,installation:f.installation},a=randomUUID(),b=randomUUID(),needle='OWNER_IDENTITY_SHARED_NEEDLE';
 await f.db.query("INSERT INTO departments(id,name) VALUES($1,'Synthetic historical A'),($2,'Synthetic historical B')",[a,b]);
 const prefix=new Date(f.start.getTime()+1000).toISOString().slice(0,19),at=(microsecond:number)=>prefix+'.'+String(microsecond).padStart(6,'0')+'Z',original=randomUUID();
 await facts(f,owner,f.session,[{id:original,at:at(123456),department:a,prompt:'x'.repeat(220)+needle}]);
 const metas:string[]=[];
 for(let n=0;n<2;n++){
  const session=await prompt(f,owner,needle+'-metadata-İA-'+n,new Date(f.start.getTime()+3000+n*4000),'Metadata-only prompt without the search phrase');metas.push(session);
  await facts(f,owner,session,[{id:randomUUID(),at:new Date(f.start.getTime()+3500+n*4000).toISOString(),department:a,prompt:'Historical A metadata only'},{id:randomUUID(),at:new Date(f.start.getTime()+4000+n*4000).toISOString(),department:b,prompt:'Historical B metadata only'}]);
 }
 const unassigned=await prompt(f,owner,'identity-null-source',new Date(f.start.getTime()+9000),'y'.repeat(220)+needle);
 const emailNeedle='OWNER_CAPTURED_EMAIL_NEEDLE';await f.db.query('UPDATE users SET email_key=$2 WHERE id=$1',[f.user,'email-'+emailNeedle.toLowerCase()+'-'+randomUUID()+'@example.invalid']);
 const observed=observe(f),x=readers(f,observed.db);await x.publisher.runOne(true);
 const whole=await x.current.listAll(f.login.token,{search:needle,limit:100});assert.deepEqual(ids(whole),new Set([f.session,...metas,unassigned]));
 const aPage=await x.current.listAll(f.login.token,{search:needle,department_id:a,limit:100});assert.deepEqual(ids(aPage),new Set([f.session,...metas]));
 const bPage=await x.current.listAll(f.login.token,{search:needle,department_id:b,limit:100});assert.deepEqual(ids(bPage),new Set(metas),'a B event cannot borrow the A prompt hit; metadata hits still apply to both captured departments');
 assert.deepEqual(comparable(bPage),comparable(await x.legacy.listAll(f.login.token,{search:needle,department_id:b,limit:100})));
 const bodyCount=observed.bodies().length;assert.equal(bodyCount,1,'historical department selections reuse the same complete body hits');
 const unicode={search:'-ia-',limit:100};assert.deepEqual(comparable(await x.current.listAll(f.login.token,unicode)),comparable(await x.legacy.listAll(f.login.token,unicode)),'captured Unicode source IDs keep the real PostgreSQL metadata ILIKE result');
 const fixed=await x.current.listAll(f.login.token,{search:needle,department_id:b,limit:1});assert.ok(fixed.next_cursor);assert.equal(fixed.total,2);
 const emailPage=await x.current.listAll(f.login.token,{search:emailNeedle,limit:100});assert.deepEqual(ids(emailPage),new Set([f.session,...metas,unassigned]));
 const emailFixed=await x.current.listAll(f.login.token,{search:emailNeedle,department_id:b,limit:1});assert.ok(emailFixed.next_cursor);assert.equal(emailFixed.total,2);
 const lateUuid='OWNER_LATE_SAME_UUID_NEEDLE',lateTime='OWNER_LATE_SAME_MICRO_NEEDLE',coldUuid='OWNER_UNCACHED_UUID_MICRO_CHECK',coldTime='OWNER_UNCACHED_TIME_UUID_CHECK';
 for(const search of [lateUuid,lateTime])assert.equal((await x.current.listAll(f.login.token,{search})).total,0);
 await facts(f,owner,f.session,[{id:original,at:at(123457),department:b,prompt:needle+' '+lateUuid+' '+coldUuid},{id:randomUUID(),at:at(123456),department:b,prompt:needle+' '+lateTime+' '+coldTime}]);
 for(const search of [lateUuid,lateTime]){
  assert.equal((await x.current.listAll(f.login.token,{search})).total,0,'late facts must not invalidate a pinned negative owner result');
  assert.equal((await x.current.listMine(f.login.token,{search})).total,0,'owned reads share the same exact captured negative result');
 }
 for(const search of [coldUuid,coldTime]){
  assert.equal((await x.legacy.listAll(f.login.token,{search})).total,1,'the complete late fact really matches the live PostgreSQL reader');
  assert.equal((await x.current.listAll(f.login.token,{search})).total,0,'a cold old-page lookup must reject the new UUID/microsecond tuple even though real SQL finds its body');
  assert.equal((await x.current.listMine(f.login.token,{search})).total,0);
 }
 await f.db.query('UPDATE users SET email_key=$2 WHERE id=$1',[f.user,'changed-email-'+randomUUID()+'@example.invalid']);x.advance();await x.publisher.runOne(true);await x.snapshots.warm();
 const fresh=await x.current.listAll(f.login.token,{search:needle,department_id:b,limit:100});assert.deepEqual(ids(fresh),new Set([f.session,...metas]));assert.notEqual(fresh.snapshot?.id,fixed.snapshot?.id);
 const old=await x.current.listAll(f.login.token,{search:needle,department_id:b,limit:1,cursor:fixed.next_cursor});assert.equal(old.snapshot?.id,fixed.snapshot?.id);assert.equal(old.total,2);assert.ok(old.items.every(row=>row.id!==f.session));assert.deepEqual(new Set([...fixed.items,...old.items].map(row=>row.id)),new Set(metas));
 assert.equal((await x.current.listAll(f.login.token,{search:emailNeedle})).total,0,'new captured metadata uses the changed email without borrowing old metadata into body hits');
 const oldEmail=await x.current.listAll(f.login.token,{search:emailNeedle,department_id:b,limit:1,cursor:emailFixed.next_cursor});assert.equal(oldEmail.snapshot?.id,emailFixed.snapshot?.id);assert.equal(oldEmail.total,2);assert.deepEqual(new Set([...emailFixed.items,...oldEmail.items].map(row=>row.id)),new Set(metas),'old pages retain their captured email rather than querying current users');
 for(const search of [lateUuid,lateTime,coldUuid,coldTime]){
  assert.deepEqual(ids(await x.current.listAll(f.login.token,{search,department_id:b})),new Set([f.session]));
  assert.deepEqual(ids(await x.current.listMine(f.login.token,{search})),new Set([f.session]));
 }
});


type GroupOwner=Person&{session:string;source:string;matches:boolean;captured:number};
async function groupedOwners(t:TestContext,needle:string){
 const f=await stopUsageFixture(t),stable:GroupOwner[]=[{user:f.user,installation:f.installation,session:f.session,source:'synthetic-hook',matches:true,captured:2001}],changed:GroupOwner[]=[];
 for(let n=0;n<6;n++){
  const owner=await person(f),source='grouped-owner-'+n,matches=n!==5,session=await prompt(f,owner,source,f.start,'Initial grouped prompt without its search phrase');
  (n<3?stable:changed).push({...owner,session,source,matches,captured:2001});
 }
 for(const owner of [...stable,...changed])await manyPrompts(f,owner,owner.session,2000,owner.matches?needle:'UNMATCHED_GROUP_OWNER');
 return {f,stable,changed,expected:new Set([...stable,...changed].filter(owner=>owner.matches).map(owner=>owner.session))};
}
async function changeGroupOwners(f:Fixture,owners:GroupOwner[],needle:string){
 for(const owner of owners){assert.equal(await prompt(f,owner,owner.source,new Date(f.start.getTime()+2000),owner.matches?'Updated '+needle:'Updated unmatched group owner'),owner.session);owner.captured++;}
}
function queryOwners(statement:Statement){
 const arrays=statement.values.filter(Array.isArray);assert.equal(arrays.length,1);return arrays[0] as string[];
}
function assertGroupedScopes(statements:Statement[],owners:GroupOwner[]){
 assert.equal(statements.length,2,'6,006 missing captured prompts must be split across two small groups');
 const selected:string[]=[];
 for(const statement of statements){
  assert.match(statement.text,/JOIN LATERAL/);const scope=queryOwners(statement);selected.push(...scope);
  const work=scope.reduce((sum,user)=>{const owner=owners.find(value=>value.user===user);assert.ok(owner,'group SQL cannot scan an unchanged owner');return sum+owner.captured;},0);
  assert.ok(work>0&&work<=4096,'each ordinary group respects the captured-work estimate without a SQL LIMIT');
 }
 assert.equal(selected.length,owners.length);assert.deepEqual(new Set(selected),new Set(owners.map(owner=>owner.user)));
}

type TimeoutState={pid:number;setting:string;timeout_ms:number};
async function timeoutState(sql:Transaction){
 return (await sql.query<TimeoutState>("SELECT pg_backend_pid() AS pid,current_setting('statement_timeout') AS setting,(SELECT setting::integer FROM pg_settings WHERE name='statement_timeout') AS timeout_ms")).rows[0]!;
}
async function assertPoolTimeoutRestored(f:Fixture,expectedPids:number[]=[],originalSetting?:string){
 // Hold every existing pool connection simultaneously so the actual grouped
 // backends are checked, rather than accidentally sampling an untouched client.
 const count=Math.max(1,f.db.health().total),states:TimeoutState[]=[];let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),probes=Array.from({length:count},()=>f.db.transaction(async sql=>{
  const state=await timeoutState(sql);states.push(state);if(states.length===count)release();await gate;return state;
 }));
 try{
  await Promise.all(probes);assert.equal(new Set(states.map(state=>state.pid)).size,count);
  for(const state of states){assert.equal(state.timeout_ms,5000,'SET LOCAL statement_timeout must reset on commit and rollback');if(originalSetting!==undefined)assert.equal(state.setting,originalSetting);}
  for(const pid of expectedPids)assert.ok(states.some(state=>state.pid===pid),'the exact PostgreSQL group backend must have its original statement timeout restored');
  return states[0]!.setting;
 }finally{release();await Promise.allSettled(probes);}
}

test('a warm majority reuses stable owners while more than 4096 missing prompts span independent SQL groups',async t=>{
 const needle='OWNER_GROUPED_BATCH_LITERAL',data=await groupedOwners(t,needle),clients:Transaction[]=[],groupPids:number[]=[];let refreshing=false;
 const observed=observe(data.f,undefined,async sql=>{if(refreshing){clients.push(sql);const state=await timeoutState(sql);groupPids.push(state.pid);assert.ok(state.timeout_ms>0&&state.timeout_ms<=5000);}}),x=readers(data.f,observed.db);await x.publisher.runOne(true);
 const initial=await x.current.listAll(data.f.login.token,{search:needle,limit:100});assert.deepEqual(ids(initial),data.expected);assert.equal(observed.bodies().length,1);assert.ok(!observed.bodies()[0]!.text.includes('JOIN LATERAL'));
 await changeGroupOwners(data.f,data.changed,needle);x.advance();await x.publisher.runOne(true);await x.snapshots.warm();
 const originalSetting=await assertPoolTimeoutRestored(data.f),before=observed.bodies().length,statementStart=observed.statements.length;refreshing=true;
 const fresh=await x.current.listAll(data.f.login.token,{search:needle,limit:100});refreshing=false;assert.deepEqual(ids(fresh),data.expected);await assertPoolTimeoutRestored(data.f,groupPids,originalSetting);
 assert.deepEqual(comparable(fresh),comparable(await x.legacy.listAll(data.f.login.token,{search:needle,limit:100})));
 assertGroupedScopes(observed.bodies().slice(before),data.changed);assert.equal(clients.length,2);assert.notEqual(clients[0],clients[1],'each group must finish its own real PostgreSQL transaction');
 const settings=observed.statements.slice(statementStart).filter(row=>row.text.includes("set_config('statement_timeout'"));assert.equal(settings.length,2);
 const budgets=settings.map(row=>Number(row.values[0]));assert.ok(budgets.every(value=>value>0&&value<=5000));assert.ok(budgets[1]!<=budgets[0]!,'later groups cannot renew or extend the original query budget');
 const completed=observed.bodies().length;
 for(const owner of [...data.stable,...data.changed])assert.equal((await x.current.listAll(data.f.login.token,{user_id:owner.user,search:needle})).total,owner.matches?1:0);
 assert.equal(observed.bodies().length,completed,'every positive and EMPTY owner result is reusable after all groups succeed');
});

test('a real second-group SQL failure rejects all reserved owner results and leaves no false empty cache',async t=>{
 const needle='OWNER_GROUPED_FAILURE_LITERAL',data=await groupedOwners(t,needle),groupPids:number[]=[];let armed=false,groupCalls=0,release!:()=>void,arrived!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;}),secondGroup=new Promise<void>(resolve=>{arrived=resolve;});t.after(release);
 const observed=observe(data.f,undefined,async sql=>{
  if(!armed)return;const state=await timeoutState(sql);groupPids.push(state.pid);assert.ok(state.timeout_ms>0&&state.timeout_ms<=5000);
  if(++groupCalls===2){arrived();await gate;await sql.query('SELECT * FROM synthetic_owner_search_second_group_missing_relation');}
 }),x=readers(data.f,observed.db);await x.publisher.runOne(true);await x.current.listAll(data.f.login.token,{search:needle,limit:100});
 await changeGroupOwners(data.f,data.changed,needle);x.advance();await x.publisher.runOne(true);await x.snapshots.warm();const originalSetting=await assertPoolTimeoutRestored(data.f);armed=true;
 const before=observed.bodies().length,all=x.current.listAll(data.f.login.token,{search:needle,limit:100});void all.catch(()=>{});
 const scoped:Promise<SessionListDto>[]=[];const finished:string[]=[];
 try{
  await Promise.race([secondGroup,all.then(()=>{throw new Error('Grouped search completed without its second real SQL transaction');})]);
  const start=observed.statements.length;
  scoped.push(...data.changed.map(owner=>{const result=x.current.listAll(data.f.login.token,{user_id:owner.user,search:needle}).finally(()=>{finished.push(owner.user);});void result.catch(()=>{});return result;}));
  const deadline=Date.now()+1000;
  while(!data.changed.every(owner=>observed.statements.slice(start).some(row=>row.completed&&row.text.includes('SELECT d.recovery_id')&&row.values[2]===owner.user))&&Date.now()<deadline)await delay(5);
  assert.ok(data.changed.every(owner=>observed.statements.slice(start).some(row=>row.completed&&row.text.includes('SELECT d.recovery_id')&&row.values[2]===owner.user)),'all scoped callers must complete their actual pre-read safety fence');await nextTurn();
  assert.deepEqual(finished,[],'even an EMPTY owner in an earlier group must await the whole batch');
  const missingSessions=new Set(data.changed.map(owner=>owner.session));
  const prematureMetadata=observed.statements.slice(start).filter(row=>row.text.includes('jsonb_to_recordset')&&row.text.includes('ILIKE')).some(row=>(JSON.parse(String(row.values[0])) as {id:string}[]).some(value=>missingSessions.has(value.id)));
  assert.equal(prematureMetadata,false,'no completed first-group owner result may leak through to metadata assembly');
 }finally{release();}
 const results=await Promise.allSettled([all,...scoped]);assert.equal(results.length,4);
 for(const result of results){assert.equal(result.status,'rejected');if(result.status==='rejected')assert.equal(result.reason.code,'42P01');}
 assertGroupedScopes(observed.bodies().slice(before),data.changed);armed=false;await assertPoolTimeoutRestored(data.f,groupPids,originalSetting);
 const retryStart=observed.bodies().length,retry=await x.current.listAll(data.f.login.token,{search:needle,limit:100});assert.deepEqual(ids(retry),data.expected);
 assertGroupedScopes(observed.bodies().slice(retryStart),data.changed);
 const after=observed.bodies().length,empty=data.changed.find(owner=>!owner.matches)!;assert.equal((await x.current.listAll(data.f.login.token,{user_id:empty.user,search:needle})).total,0);assert.equal(observed.bodies().length,after,'only a complete successful retry may cache the real EMPTY result');
});

test('an exactly half-missing owner count keeps broad global search despite mostly cached prompt work',async t=>{
 const f=await stopUsageFixture(t),b=await person(f),needle='OWNER_COUNT_TIE_LITERAL',a={user:f.user,installation:f.installation};
 await manyPrompts(f,a,f.session,100,needle);const bSession=await prompt(f,b,'count-tie-b',f.start,needle);
 const observed=observe(f),x=readers(f,observed.db);await x.publisher.runOne(true);assert.deepEqual(ids(await x.current.listAll(f.login.token,{search:needle,limit:100})),new Set([f.session,bSession]));
 await prompt(f,b,'count-tie-b',new Date(f.start.getTime()+2000),needle);x.advance();await x.publisher.runOne(true);await x.snapshots.warm();
 const before=observed.bodies().length,page=await x.current.listAll(f.login.token,{search:needle,limit:100});assert.deepEqual(ids(page),new Set([f.session,bSession]));
 const refresh=observed.bodies().slice(before);assert.equal(refresh.length,1);assert.ok(!refresh[0]!.text.includes('JOIN LATERAL'),'one missing of two owners is not a warm majority even when the cached owner has 101 prompts');
});

test('an exactly half-missing captured-work count keeps broad search when most owners are cached',async t=>{
 const f=await stopUsageFixture(t),b=await person(f),c=await person(f),needle='OWNER_WORK_TIE_LITERAL';
 const bSession=await prompt(f,b,'work-tie-b',f.start,needle),cSession=await prompt(f,c,'work-tie-c',f.start,needle);
 const observed=observe(f),x=readers(f,observed.db);await x.publisher.runOne(true);await x.current.listAll(f.login.token,{search:needle,limit:100});
 await prompt(f,b,'work-tie-b',new Date(f.start.getTime()+2000),needle);x.advance();await x.publisher.runOne(true);await x.snapshots.warm();
 const before=observed.bodies().length,page=await x.current.listAll(f.login.token,{search:needle,limit:100});assert.deepEqual(ids(page),new Set([bSession,cSession]));
 const refresh=observed.bodies().slice(before);assert.equal(refresh.length,1);assert.ok(!refresh[0]!.text.includes('JOIN LATERAL'),'two missing prompts equal the two cached prompts; owner majority alone cannot select grouped scans');
});

test('mostly uncached captured work remains broad even when a majority of owners is warm',async t=>{
 const f=await stopUsageFixture(t),b=await person(f),c=await person(f),needle='OWNER_WORK_COLD_LITERAL';
 const bSession=await prompt(f,b,'work-cold-b',f.start,'Initial B prompt without its search phrase'),cSession=await prompt(f,c,'work-cold-c',f.start,needle);await manyPrompts(f,b,bSession,6000,needle);
 const observed=observe(f),x=readers(f,observed.db);await x.publisher.runOne(true);await x.current.listAll(f.login.token,{search:needle,limit:100});
 await prompt(f,b,'work-cold-b',new Date(f.start.getTime()+2000),'Updated '+needle);x.advance();await x.publisher.runOne(true);await x.snapshots.warm();
 const before=observed.bodies().length,page=await x.current.listAll(f.login.token,{search:needle,limit:100});assert.deepEqual(ids(page),new Set([bSession,cSession]));
 const refresh=observed.bodies().slice(before);assert.equal(refresh.length,1);assert.ok(!refresh[0]!.text.includes('JOIN LATERAL'),'the single missing owner contains 6002 of the 6004 captured prompts');
 assert.deepEqual(comparable(page),comparable(await x.legacy.listAll(f.login.token,{search:needle,limit:100})));
});

test('a single oversized changed owner retains its complete original scoped route after a warm majority',async t=>{
 const f=await stopUsageFixture(t),b=await person(f),c=await person(f),needle='OWNER_OVERSIZED_SCOPE_LITERAL',a={user:f.user,installation:f.installation};
 const bSession=await prompt(f,b,'oversized-b',f.start,'Initial B prompt without its search phrase'),cSession=await prompt(f,c,'oversized-c',f.start,'Initial C prompt without its search phrase');
 await manyPrompts(f,a,f.session,6000,needle);await manyPrompts(f,c,cSession,6000,needle);await manyPrompts(f,b,bSession,5000,needle);
 const observed=observe(f),x=readers(f,observed.db);await x.publisher.runOne(true);await x.current.listAll(f.login.token,{search:needle,limit:100});
 await prompt(f,b,'oversized-b',new Date(f.start.getTime()+2000),'Updated B prompt without its search phrase');x.advance();await x.publisher.runOne(true);await x.snapshots.warm();
 const before=observed.bodies().length,page=await x.current.listAll(f.login.token,{search:needle,limit:100});assert.deepEqual(ids(page),new Set([f.session,bSession,cSession]));
 const refresh=observed.bodies().slice(before);assert.equal(refresh.length,1);assertOnlyOwner(refresh[0]!,b.user);
 assert.deepEqual(comparable(page),comparable(await x.legacy.listAll(f.login.token,{search:needle,limit:100})),'the suffix match beyond the 4096th captured prompt cannot be truncated');
});


test('cold literal grams preserve short Unicode fallback, escaped tails and captured security boundaries',async t=>{
 const f=await stopUsageFixture(t),b=await person(f),a=randomUUID(),other=randomUUID();
 await f.db.query("INSERT INTO departments(id,name) VALUES($1,'Literal A'),($2,'Literal B')",[a,other]);
 const tail='GRAMS%_\\🙂',short='猫😀',combining='e\u0301猫',serverCase='İABC';
 const prefix=new Date(f.start.getTime()+2000).toISOString().slice(0,19),at=(n:number)=>prefix+'.'+String(n).padStart(6,'0')+'Z',event=randomUUID();
 await facts(f,{user:f.user,installation:f.installation},f.session,[
  {id:event,at:at(101),department:a,prompt:'x'.repeat(524288-Buffer.byteLength(tail))+tail},
  {id:randomUUID(),at:at(102),department:other,prompt:short},
  {id:randomUUID(),at:at(103),department:null,prompt:combining},
  {id:randomUUID(),at:at(104),department:other,prompt:serverCase},
 ]);
 await prompt(f,b,'literal-empty-owner',f.start,':::');
 const observed=observe(f),x=readers(f,observed.db);await x.publisher.runOne(true);
 for(const search of [tail,short,combining,serverCase,':::::']){
  for(const department_id of [other,undefined,a]){
   const query={search,limit:100,...(department_id?{department_id}:{})};
   const current=await x.current.listAll(f.login.token,query),legacy=await x.legacy.listAll(f.login.token,query);
   assert.deepEqual(comparable(current),comparable(legacy));
   if(search===':::::')assert.equal(current.total,0,'one repeated packed gram is not proof of a longer literal');
  }
 }
 const shortBody=observed.bodies().find(row=>row.values[4]==='%'+short+'%');assert.ok(shortBody);assert.equal(shortBody.text.includes('hook_prompt_codepoint_grams'),false,'two Unicode codepoints retain native matching');
 assert.ok(observed.bodies().some(row=>row.text.includes('hook_prompt_codepoint_grams')),'cold broad searches really reach the packed SQL route');
 // A later occurrence with the same UUID cannot borrow the captured µ identity.
 await facts(f,{user:f.user,installation:f.installation},f.session,[{id:event,at:at(105),department:other,prompt:'LATE_GRAMS_ONLY'}]);
 assert.equal((await x.current.listAll(f.login.token,{search:'LATE_GRAMS_ONLY'})).total,0);assert.equal((await x.legacy.listAll(f.login.token,{search:'LATE_GRAMS_ONLY'})).total,1);
 await f.db.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1',[f.user]);
 await assert.rejects(x.current.listAll(f.login.token,{search:tail}),{code:'content_changed'});
});

test('real PostgreSQL helper time consumes the original body budget and a timeout cannot cache completed hits',async t=>{
 const f=await stopUsageFixture(t),needle='LITERAL_READER_BUDGET_TOKEN',lowerStates:TimeoutState[]=[],bodyStates:TimeoutState[]=[];
 await prompt(f,{user:f.user,installation:f.installation},'synthetic-hook',new Date(f.start.getTime()+1000),needle);
 let slow=true;
 const observed=observe(f,undefined,async sql=>{
  if(!slow)return;bodyStates.push(await timeoutState(sql));await sql.query('SELECT pg_catalog.pg_sleep(2.0)');
 },async sql=>{
  if(!slow)return;lowerStates.push(await timeoutState(sql));await sql.query('SELECT pg_catalog.pg_sleep(4.0)');
 }),x=readers(f,observed.db);await x.publisher.runOne(true);const before=f.db.health().readTimeouts;
 await assert.rejects(x.current.listAll(f.login.token,{search:needle}),{code:'database_io_timeout'});
 assert.equal(lowerStates.length,1);assert.equal(bodyStates.length,1);assert.equal(lowerStates[0]!.pid,bodyStates[0]!.pid);
 assert.ok(bodyStates[0]!.timeout_ms>0&&bodyStates[0]!.timeout_ms<1500,'the next statement must not regain a fresh 5-second allowance');
 assert.ok(f.db.health().readTimeouts>before,'the live PostgreSQL statement timer, not only a fake transport delay, rejected the work');
 slow=false;await assertPoolTimeoutRestored(f);assert.equal((await x.current.listAll(f.login.token,{search:needle})).total,1);
 const complete=observed.bodies().length;assert.equal((await x.current.listAll(f.login.token,{user_id:f.user,search:needle})).total,1);assert.equal(observed.bodies().length,complete,'only the successful fresh retry admits owner hits');
});
