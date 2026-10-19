import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {SessionListDto} from '@adi/contracts';
import type {Transaction} from '../../../storage/src/index.js';
import {stopUsageFixture} from '../helpers/stop-usage.js';
import {createSessionReadService,type AllSessionQuery} from '../../src/session-reading.js';
import {createSessionPersonalModelService} from '../../src/session-personal-models.js';
import {createSessionListSnapshotPublisher} from '../../src/session-list-snapshot-publisher.js';
import {createSessionListSnapshotReader} from '../../src/session-list-snapshot-reading.js';

const comparable=(data:SessionListDto)=>({period:data.period,items:data.items,total:data.total,has_more:data.has_more,available_channels:data.available_channels,channel_available:data.channel_available});

test('shared global prompt hits retain historical department boundaries across transfer, channel and owner views',async t=>{
 const f=await stopUsageFixture(t),needle='CACHE_GROUP_TRANSFER_NEEDLE',boundary=new Date(f.start.getTime()-1000),aAt=new Date(boundary.getTime()-1000),bAt=new Date(boundary.getTime()+1000);
 const a=randomUUID(),b=randomUUID();await f.db.query("INSERT INTO departments(id,name) VALUES($1,'共享命中旧部门'),($2,'共享命中新部门')",[a,b]);
 await f.db.query('INSERT INTO membership_periods(user_id,department_id,valid_from,valid_to) VALUES($1,$2,$3,$4),($1,$5,$4,NULL)',[f.user,a,new Date(boundary.getTime()-86400000),boundary,b]);
 await f.db.query('UPDATE hook_events SET department_id=$1 WHERE user_id=$2',[b,f.user]);
 const put=async(source:string,at:Date,prompt:string)=>{const saved=await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:randomUUID(),source_session_id:source,event_type:'UserPromptSubmit',occurred_at:at.toISOString(),payload:{prompt}},{admissionEpoch:1,receivedAt:f.at});assert.equal(saved.outcome,'committed');if(saved.outcome!=='committed')throw new Error('Synthetic transfer event did not commit');return saved.sessionId;};
 const shared=await put('transfer-shared',aAt,'x'.repeat(220)+needle);await put('transfer-shared',bAt,'B_DEPARTMENT_WITHOUT_THIS_NEEDLE');
 const onlyB=await put('transfer-b-only',new Date(bAt.getTime()+1000),'y'.repeat(220)+needle);
 const metadata=await put('metadata-'+needle,new Date(aAt.getTime()+500),'A_METADATA_ONLY');await put('metadata-'+needle,new Date(bAt.getTime()+500),'B_METADATA_ONLY');
 await f.jobs.enqueue(shared);
 await createSessionPersonalModelService(f.db,f.identity).replace(f.login.token,onlyB,{version:0,cleanup_generation:0,models:['Synthetic local model']});
 const other=randomUUID(),installation=randomUUID();await f.db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'shared-null@example.invalid','合成未分配用户')",[other]);await f.db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'未分配合成安装')",[installation,other,'b'.repeat(64)]);
 const unassigned=await f.db.ingest({schema_version:2,installation_id:installation,client_event_id:randomUUID(),source_session_id:'transfer-null-owner',event_type:'UserPromptSubmit',occurred_at:bAt.toISOString(),payload:{prompt:needle}},{admissionEpoch:1,receivedAt:f.at});assert.equal(unassigned.outcome,'committed');if(unassigned.outcome!=='committed')throw new Error('Synthetic null-department fact did not commit');
 const clock=()=>f.at,options={providerAccount:'stop-test',stopWindowEnabled:false,clock};
 const publisher=createSessionListSnapshotPublisher(f.db,options);assert.equal(await publisher.runOne(true),true);
 const statements:string[]=[];
 const trace=(sql:Transaction)=>new Proxy(sql,{get(target,key,receiver){if(key==='query')return (text:string,values?:unknown[])=>{statements.push(text);return target.query(text,values);};return Reflect.get(target,key,receiver);}});
 const db=new Proxy(f.db,{get(target,key,receiver){if(key==='query')return trace(target).query;if(key==='transaction')return (action:Parameters<typeof f.db.transaction>[0])=>target.transaction(sql=>action(trace(sql)));return Reflect.get(target,key,receiver);}});
 const snapshots=createSessionListSnapshotReader(db,options),current=createSessionReadService(db,f.identity,{...options,snapshots}),legacy=createSessionReadService(f.db,f.identity,options);
 const bodySearchCount=()=>statements.filter(text=>text.includes('LIKE')&&text.includes('prompt_search')&&text.includes('hook_events')).length;
 const equal=async(input:AllSessionQuery)=>{const expected=await legacy.listAll(f.login.token,input),actual=await current.listAll(f.login.token,input);assert.deepEqual(comparable(actual),comparable(expected));return actual;};
 const global=await equal({search:needle,limit:100});assert.deepEqual(new Set(global.items.map(row=>row.id)),new Set([shared,onlyB,metadata,unassigned.sessionId]));assert.equal(bodySearchCount(),1);
 const oldDepartment=await equal({department_id:a,search:needle,limit:100});assert.deepEqual(new Set(oldDepartment.items.map(row=>row.id)),new Set([shared,metadata]));
 const newDepartment=await equal({department_id:b,search:needle,limit:100});assert.deepEqual(new Set(newDepartment.items.map(row=>row.id)),new Set([onlyB,metadata]));assert.equal(bodySearchCount(),1,'department filters must reuse global hits and select their captured historical department');
 const pendingB=await equal({department_id:b,search:needle,channel:'pending',limit:100});assert.equal(pendingB.total,0,'a B event must not borrow a keyword from its A event in the same Hook session');
 const pendingA=await equal({department_id:a,search:needle,channel:'pending',limit:100});assert.deepEqual(pendingA.items.map(row=>row.id),[shared]);
 const customB=await equal({department_id:b,search:needle,channel:'custom',limit:100});assert.deepEqual(customB.items.map(row=>row.id),[onlyB]);assert.ok(!customB.items[0]?.title.includes(needle),'exact search must read suffixes beyond the published 160-character preview');assert.equal(bodySearchCount(),1,'channel filters must share the same raw hit promise');
 await equal({user_id:f.user,department_id:a,search:needle,limit:100});await equal({user_id:f.user,department_id:b,search:needle,limit:100});assert.equal(bodySearchCount(),1,'owned views reuse the immutable owner hits populated by the global lookup');
});

test('current publication references retain warmed owner payloads beyond the lazy old-entry TTL',async t=>{
 const f=await stopUsageFixture(t);let time=f.at.getTime(),payloadReads=0;const clock=()=>new Date(time),options={providerAccount:'stop-test',clock};
 const publisher=createSessionListSnapshotPublisher(f.db,options);await publisher.runOne(true);const initial=(await publisher.latest())!;
 const db=new Proxy(f.db,{get(target,key,receiver){if(key==='query')return (text:string,values?:unknown[])=>{if(text.includes('SELECT id,user_id,cleanup_generation,payload FROM session_list_snapshot_entries'))payloadReads++;return target.query(text,values);};return Reflect.get(target,key,receiver);}});
 const snapshots=createSessionListSnapshotReader(db,options),reader=createSessionReadService(db,f.identity,{...options,snapshots});
 await snapshots.warm();assert.equal(payloadReads,1);const first=await reader.listMine(f.login.token,{});assert.equal(first.total,1);
 time+=80000;await publisher.runOne(true);const latest=(await publisher.latest())!;assert.deepEqual(latest.owner_entries,initial.owner_entries);assert.notEqual(latest.id,initial.id);
 const own=await reader.listMine(f.login.token,{}),all=await reader.listAll(f.login.token,{});assert.equal(own.snapshot?.id,latest.id);assert.equal(all.snapshot?.id,latest.id);assert.equal(all.total,1);
 assert.equal(payloadReads,1,'unchanged entries of the current complete publication must not be fetched and repacked after 75 seconds');
});

test('base rows survive current-reference TTL and reuse unchanged owners when another owner publishes new facts',async t=>{
 const f=await stopUsageFixture(t);let time=f.at.getTime();const clock=()=>new Date(time),options={providerAccount:'stop-test',stopWindowEnabled:false,clock};
 const other=randomUUID(),installation=randomUUID();await f.db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'other-base@example.invalid','合成变更用户')",[other]);
 await f.db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'变更用户安装')",[installation,other,'d'.repeat(64)]);
 const put=async(at:Date,prompt:string)=>{const saved=await f.db.ingest({schema_version:2,installation_id:installation,client_event_id:randomUUID(),source_session_id:'other-base-source',event_type:'UserPromptSubmit',occurred_at:at.toISOString(),payload:{prompt}},{admissionEpoch:1,receivedAt:clock()});assert.equal(saved.outcome,'committed');if(saved.outcome!=='committed')throw new Error('fixture did not commit');return saved.sessionId;};
 const otherSession=await put(f.start,'INITIAL_OTHER_BASE_PROMPT'),publisher=createSessionListSnapshotPublisher(f.db,options);await publisher.runOne(true);const initial=(await publisher.latest())!;
 const snapshots=createSessionListSnapshotReader(f.db,options),reader=createSessionReadService(f.db,f.identity,{...options,snapshots}),legacy=createSessionReadService(f.db,f.identity,options);
 const mine=await reader.listMine(f.login.token,{}),all=await reader.listAll(f.login.token,{}),coverage=mine.items.find(row=>row.id===f.session)!.session_coverage;
 assert.equal(all.items.find(row=>row.id===f.session)?.session_coverage,coverage,'mine and global base calculations reuse the same immutable owner rows');
 time+=80000;await put(new Date(f.start.getTime()+1),'NEW_OTHER_BASE_PROMPT');await publisher.runOne(true);const latest=(await publisher.latest())!;
 assert.equal(latest.owner_entries[f.user],initial.owner_entries[f.user]);assert.notEqual(latest.owner_entries[other],initial.owner_entries[other]);
 const nextMine=await reader.listMine(f.login.token,{}),nextAll=await reader.listAll(f.login.token,{});
 assert.equal(nextMine.items.find(row=>row.id===f.session)?.session_coverage,coverage,'current own view remains reusable beyond its former 60-second TTL');
 assert.equal(nextAll.items.find(row=>row.id===f.session)?.session_coverage,coverage,'dirty global publication reuses the unchanged owner base');
 assert.equal(nextAll.items.find(row=>row.id===otherSession)?.prompt_turns,2);assert.deepEqual(comparable(nextAll),comparable(await legacy.listAll(f.login.token,{})));
 const period=nextMine.period,disabled=await snapshots.read({actor:f.user,all:false,owner:f.user,department:null,period,channel:'all',search:'',limit:20,sourceEnabled:false});
 assert.equal(disabled.channel_available,false);assert.ok(disabled.items.every(row=>row.official_records===0&&row.official_tokens===null));
 await f.db.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1',[f.user]);
 await assert.rejects(reader.listMine(f.login.token,{}),{code:'content_changed'});await assert.rejects(reader.listAll(f.login.token,{}),{code:'content_changed'});
});

test('stable current prompt identities retain bounded raw search hits across TTL and channel views',async t=>{
 const f=await stopUsageFixture(t);let time=f.at.getTime(),searchReads=0;const clock=()=>new Date(time),options={providerAccount:'stop-test',clock};
 const publisher=createSessionListSnapshotPublisher(f.db,options);await publisher.runOne(true);
 const trace=(sql:Transaction)=>new Proxy(sql,{get(target,key,receiver){if(key==='query')return(text:string,values?:unknown[])=>{if(text.includes('prompt_search')&&text.includes('LIKE'))searchReads++;return target.query(text,values);};return Reflect.get(target,key,receiver);}});
 const db=new Proxy(f.db,{get(target,key,receiver){if(key==='query')return trace(target).query;if(key==='transaction')return(action:Parameters<typeof f.db.transaction>[0])=>target.transaction(sql=>action(trace(sql)));return Reflect.get(target,key,receiver);}});
 const snapshots=createSessionListSnapshotReader(db,options),reader=createSessionReadService(db,f.identity,{...options,snapshots});
 const first=await reader.listAll(f.login.token,{search:'synthetic'});assert.equal(searchReads,1);
 time+=80000;await publisher.runOne(true);await reader.listAll(f.login.token,{search:'synthetic',channel:'pending'});assert.equal(searchReads,1,'the same captured identities must not repeat a large body query merely because an unused channel starts after sixty seconds');
 const again=await reader.listAll(f.login.token,{search:'synthetic'});assert.equal(again.total,first.total);assert.equal(searchReads,1);
 const saved=await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:randomUUID(),source_session_id:'synthetic-after-search',event_type:'UserPromptSubmit',occurred_at:clock().toISOString(),payload:{prompt:'synthetic new true captured identity'}},{admissionEpoch:1,receivedAt:clock()});assert.equal(saved.outcome,'committed');
 await publisher.runOne(true);await snapshots.warm();const changed=await reader.listAll(f.login.token,{search:'synthetic'});assert.equal(changed.total,first.total+1);assert.equal(searchReads,2,'a replaced owner payload must perform a fresh exact query');
 await f.db.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1',[f.user]);await assert.rejects(reader.listAll(f.login.token,{search:'synthetic'}),{code:'content_changed'});
});
