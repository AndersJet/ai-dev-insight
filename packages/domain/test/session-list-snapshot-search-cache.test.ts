import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn,setTimeout as delay} from 'node:timers/promises';
import type {Database,Transaction} from '../../storage/src/index.js';
import {createSessionListSnapshotReader} from '../src/session-list-snapshot-reading.js';
import {sessionListSnapshotConfigKey,type SessionListSnapshot} from '../src/session-list-snapshot-publisher.js';
import type {SessionListSnapshotOwner,SessionListSnapshotSession} from '../src/session-list-snapshot-loader.js';

const id=(n:number)=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
const at=new Date('2026-10-10T04:00:00Z'),micros=at.getTime()*1000;
const period={from:'2026-10-10T00:00:00Z',to:'2026-10-11T00:00:00Z'};
const latch=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
type Body={id:string;session_id:string;at_us:string;text:string;owner:string};
type LowerCall={pattern:string;transaction:number;statementTimeout:number};
type BodyCall={owners:string[]|null;needle:string;transaction:number;statementTimeout:number;oversized:boolean};

// A transport double for cache lifecycle and admission limits only. Real PG
// tests cover SQL routing, native matching, captured facts and permissions.
function fixture(dense=false){
 const payloads=new Map<string,SessionListSnapshotOwner>(),bodies:Body[]=[],cleanup=new Map<string,number>(),headers=new Map<string,SessionListSnapshot>(),calls:BodyCall[]=[],lowerCalls:LowerCall[]=[];
 let onLower:((call:LowerCall)=>Promise<string>)|undefined;
 let sequence=1000000,transaction=0,latest:SessionListSnapshot,onBody:((call:BodyCall,rows:Body[])=>Promise<Body[]>)|undefined;
 const localTimeouts=new Map<number,number>(),finishedTransactions:number[]=[];
 function owner(user:string,sessions=1,departments=1,text='CACHE_TOKEN'){
  const values:SessionListSnapshotSession[]=Array.from({length:sessions},()=>{
   const session=id(++sequence),events=Array.from({length:departments},(_,d)=>{
    const event=id(++sequence),time=micros+d,department=departments===1?null:id(100+d);
    bodies.push({id:event,session_id:session,at_us:String(time),text,owner:user});
    return {id:event,at_us:time,department_id:department,event_type:'UserPromptSubmit',prompt_excerpt:text};
   });
   return {id:session,source_session_id:'source-'+session,history_redacted:false,history_expired:false,source_generation:1,events,personal_models:[],has_session_query:false,query_records:[],legacy_records:[],conflicts:0,pending_days:[],pending_link:false};
  });
  const entry=id(++sequence),generation=cleanup.get(user)??0;cleanup.set(user,generation);
  payloads.set(entry,{user_id:user,name:'Cache fixture owner',email:user+'@example.invalid',cleanup_generation:generation,sessions:values});return entry;
 }
 function publish(mapping:Record<string,string>){
  latest={id:id(++sequence),config_key:sessionListSnapshotConfigKey(null),provider_account:null,as_of:at,expires_at:new Date(at.getTime()+60000),safety_fence:{dataset_id:id(999),recovery_id:null,retention_cutoff:null,cleanup:Object.fromEntries(cleanup)},owner_entries:mapping,state:'published'};
  headers.set(latest.id,latest);
 }
 const a=id(1),b=id(2),aEntry=owner(a,dense?2500:1,dense?48:1,dense?'alpha beta gamma':'EMPTY_OWNER'),bEntry=dense?null:owner(b);
 publish({[a]:aEntry,...(bEntry?{[b]:bEntry}:{})});
 const respond=async(statement:string,values:unknown[]=[],scope=0)=>{
  let rows:unknown[]=[];
  if(statement.startsWith('SELECT id FROM session_list_snapshots'))rows=[{id:latest.id}];
  else if(statement.startsWith('SELECT * FROM session_list_snapshots'))rows=headers.has(String(values[0]))?[headers.get(String(values[0]))]:[];
  else if(statement.includes('SELECT d.recovery_id')){
   const header=headers.get(String(values[0])),expected=values[2]?Object.entries(header?.safety_fence.cleanup??{}).filter(([user])=>user===values[2]):Object.entries(header?.safety_fence.cleanup??{}),safe=!!header&&expected.every(([user,generation])=>cleanup.get(user)===generation);rows=[{recovery_id:null,safe}];
  }else if(statement.includes('SELECT id,user_id,cleanup_generation,payload FROM session_list_snapshot_entries')){
   rows=(values[0] as string[]).flatMap(entry=>{const payload=payloads.get(entry);return payload?[{id:entry,user_id:payload.user_id,cleanup_generation:payload.cleanup_generation,payload}]:[];});
  }else if(statement.includes("set_config('statement_timeout'"))localTimeouts.set(scope,Number(values[0]));
  else if(statement==='SELECT pg_catalog.lower($1::text) AS pattern'){
   const call={pattern:String(values[0]),transaction:scope,statementTimeout:localTimeouts.get(scope)??5000};lowerCalls.push(call);
   // Identity transport response; actual PostgreSQL tests own locale behavior.
   rows=[{pattern:onLower?await onLower(call):call.pattern}];
  }else if(statement.includes('prompt_search')&&statement.includes('LIKE')){
   const call={owners:Array.isArray(values[2])?values[2] as string[]:null,needle:String(values[4]).slice(1,-1).replace(/\\([\\%_])/g,'$1'),transaction:scope,statementTimeout:localTimeouts.get(scope)??5000,oversized:statement.includes('oversized captured owner')};calls.push(call);
   const found=bodies.filter(row=>(!call.owners||call.owners.includes(row.owner))&&row.text.includes(call.needle));rows=onBody?await onBody(call,found):found;
  }
  return {rows,rowCount:rows.length,command:'SELECT',oid:0,fields:[]};
 };
 const query=respond as Database['query'];
 const db={schema:'snapshot_cache_fixture',query,transaction:async<T>(work:(sql:Transaction)=>Promise<T>)=>{const scope=++transaction;try{return await work({query:((text:string,values?:unknown[])=>respond(text,values,scope)) as Database['query']});}finally{finishedTransactions.push(scope);localTimeouts.delete(scope);}}} as Database;
 const reader=createSessionListSnapshotReader(db,{clock:()=>at});
 const read=(search:string,ownerId:string|null=null,channel:'all'|'pending'|'custom'='all')=>reader.read({actor:a,all:ownerId===null,owner:ownerId,department:null,period,channel,search,limit:20,sourceEnabled:false});
 return {a,b,calls,lowerCalls,read,reader,owner,publish,finishedTransactions,setLowerHook:(hook:typeof onLower)=>{onLower=hook;},mapping:()=>({...latest.owner_entries}),setBodyHook:(hook:typeof onBody)=>{onBody=hook;},clearOther:()=>{cleanup.set(b,1);},removeOther:()=>{cleanup.delete(b);if(bEntry)payloads.delete(bEntry);},clearOwner:()=>{cleanup.set(a,1);const entry=owner(a,1,1,'CACHE_TOKEN');publish({...latest.owner_entries,[a]:entry});}};
}

test('concurrent global/owned callers share pending positive and empty owner promises',async t=>{
 const f=fixture(),started=latch(),release=latch();t.after(release.release);
 f.setBodyHook(async(_call,rows)=>{started.release();await release.promise;return rows;});
 const global=f.read('CACHE_TOKEN');void global.catch(()=>{});await started.promise;
 let emptyFinished=false,positiveFinished=false;
 const empty=f.read('CACHE_TOKEN',f.a).finally(()=>{emptyFinished=true;}),positive=f.read('CACHE_TOKEN',f.b).finally(()=>{positiveFinished=true;});void empty.catch(()=>{});void positive.catch(()=>{});
 await nextTurn();assert.equal(f.calls.length,1);assert.equal(emptyFinished,false);assert.equal(positiveFinished,false,'owned readers must wait on the still-pending broad query');
 release.release();const result=await Promise.all([global,empty,positive]);assert.deepEqual(result.map(row=>row.total),[1,0,1]);assert.equal(f.calls.length,1);
});

test('failed batches reject every missing owner and cannot delete a later empty replacement',async t=>{
 const f=fixture(),started=latch(),release=latch(),fault=new Error('body search failed');t.after(release.release);
 f.setBodyHook(async(_call,rows)=>{if(f.calls.length===1){started.release();await release.promise;throw fault;}return rows;});
 const global=f.read('CACHE_TOKEN');void global.catch(()=>{});await started.promise;
 const empty=f.read('CACHE_TOKEN',f.a),positive=f.read('CACHE_TOKEN',f.b);void empty.catch(()=>{});void positive.catch(()=>{});
 // Evict pending owner and global coalescing slots, then replace the same key
 // through a different view while the original caller still awaits its query.
 for(let n=0;n<65;n++)assert.equal((await f.read('eviction-'+n,f.a)).total,0);
 assert.equal((await f.read('CACHE_TOKEN',f.a,'custom')).total,0);release.release();
 const failed=await Promise.allSettled([global,empty,positive]);for(const value of failed){assert.equal(value.status,'rejected');if(value.status==='rejected')assert.equal(value.reason,fault);}
 const before=f.calls.length;assert.equal((await f.read('CACHE_TOKEN',f.a,'pending')).total,0);assert.equal(f.calls.length,before,'old rejection cannot delete the replacement empty slot');
 const c=id(3);f.publish({...f.mapping(),[c]:f.owner(c,1,1,'EMPTY_C')});await f.reader.warm();assert.equal((await f.read('CACHE_TOKEN',c)).total,0);
 assert.equal((await f.read('CACHE_TOKEN')).total,1);assert.deepEqual(f.calls.at(-1)?.owners,[f.b],'failed B is retried while replacement empty A and C remain cached');
});

test('a pre-cleanup empty query finishing late cannot populate the new cache epoch',async t=>{
 const f=fixture(),started=latch(),release=latch();t.after(release.release);
 f.setBodyHook(async(call,rows)=>{if(f.calls.length===1&&call.owners?.includes(f.a)){started.release();await release.promise;}return rows;});
 const stale=f.read('CACHE_TOKEN',f.a);void stale.catch(()=>{});await started.promise;
 // Settle the existing safe preparation before publishing the cleanup epoch;
 // warm joins one flight and deliberately does not chase a later publication.
 await f.reader.warm();f.clearOwner();await f.reader.warm();assert.equal((await f.read('CACHE_TOKEN',f.a)).total,1);release.release();await assert.rejects(stale,{code:'content_changed'});
 const before=f.calls.length;assert.equal((await f.read('CACHE_TOKEN',f.a)).total,1);assert.equal(f.calls.length,before+1,'post-clear query must use fresh captured hits, including after the late old request clears caches');
 assert.equal((await f.read('CACHE_TOKEN',f.a,'custom')).total,0);assert.equal(f.calls.length,before+1);
});

test('member admission limits retain complete results and requery evicted owner hits',async()=>{
 // 2,500 sessions in 48 historical departments contribute 122,548 membership
 // units per search. Two owner results fit; a third exceeds the shared budget.
 const f=fixture(true);for(const needle of ['alpha','beta','gamma'])assert.equal((await f.read(needle)).total,2500);
 const c=id(3),extra=f.owner(f.b,1,1,'NO_BODY_MATCH');f.publish({...f.mapping(),[f.b]:extra,[c]:f.owner(c,1,1,'NO_MATCH_C')});await f.reader.warm();assert.equal((await f.read('beta',c)).total,0);
 const before=f.calls.length;assert.equal((await f.read('beta')).total,2500);assert.deepEqual(f.calls.at(-1)?.owners,[f.b],'the retained body hits are recombined without truncation');
 assert.equal((await f.read('alpha')).total,2500);assert.equal(f.calls.length,before+2,'over-budget old owner result is recomputed, not truncated or silently treated as empty');
});

test('grouped warm misses use sequential short transactions and publish all reservations only after success',async t=>{
 const f=fixture(),needle='GROUP_TOKEN',mapping=f.mapping(),stable=Array.from({length:4},(_,n)=>id(10+n)),changed=[id(20),id(21)];
 for(const user of stable)mapping[user]=f.owner(user,1,1600,needle);
 for(const user of changed)mapping[user]=f.owner(user,1,2500,needle);
 f.publish(mapping);assert.equal((await f.read(needle)).total,6);
 const next=f.mapping();next[changed[0]!]=f.owner(changed[0]!,1,2501,needle);next[changed[1]!]=f.owner(changed[1]!,1,2501,'EMPTY_GROUP');f.publish(next);await f.reader.warm();
 const started=latch(),release=latch(),fault=new Error('second group failed'),before=f.calls.length;t.after(release.release);
 f.setBodyHook(async(call,rows)=>{if(call.owners?.includes(changed[1]!)){started.release();await release.promise;throw fault;}return rows;});
 const global=f.read(needle);void global.catch(()=>{});await started.promise;
 let firstFinished=false,emptyFinished=false;
 const positive=f.read(needle,changed[0]!).finally(()=>{firstFinished=true;}),empty=f.read(needle,changed[1]!).finally(()=>{emptyFinished=true;});void positive.catch(()=>{});void empty.catch(()=>{});
 await nextTurn();assert.equal(firstFinished,false);assert.equal(emptyFinished,false);assert.equal(f.calls.length,before+2);
 const groups=f.calls.slice(before);assert.deepEqual(groups.map(call=>call.owners),changed.map(user=>[user]));assert.notEqual(groups[0]!.transaction,groups[1]!.transaction);assert.ok(f.finishedTransactions.includes(groups[0]!.transaction));assert.ok(groups.every(call=>call.statementTimeout>0&&call.statementTimeout<=5000));assert.ok(groups[1]!.statementTimeout<=groups[0]!.statementTimeout);
 release.release();for(const value of await Promise.allSettled([global,positive,empty])){assert.equal(value.status,'rejected');if(value.status==='rejected')assert.equal(value.reason,fault);}
 f.setBodyHook(undefined);const retried=f.calls.length;assert.equal((await f.read(needle)).total,5);assert.equal(f.calls.length,retried+2,'both newly reserved owners retry; the first group was never partially cached');
 const warmed=f.calls.length;assert.equal((await f.read(needle,changed[0]!)).total,1);assert.equal((await f.read(needle,changed[1]!)).total,0);assert.equal(f.calls.length,warmed);
});

test('cache invalidation by an unrelated owner does not become authority for a safe owned caller',async t=>{
 const f=fixture(),started=latch(),release=latch();t.after(release.release);
 f.setBodyHook(async(_call,rows)=>{if(f.calls.length===1){started.release();await release.promise;}return rows;});
 const owned=f.read('CACHE_TOKEN',f.a);void owned.catch(()=>{});await started.promise;f.clearOther();
 await assert.rejects(f.read('unrelated-cleanup'),{code:'content_changed'});release.release();assert.equal((await owned).total,0,'A scoped fence is safe even though B cleared the shared cache epoch');
 const before=f.calls.length;assert.equal((await f.read('CACHE_TOKEN',f.a)).total,0);assert.equal(f.calls.length,before+1,'late old-epoch empty result was not admitted');
});

test('a physically removed unrelated owner cannot block a safe owned read without prepared metadata',async()=>{
 const f=fixture();assert.equal((await f.read('CACHE_TOKEN')).total,1);f.removeOther();
 await assert.rejects(f.read('CACHE_TOKEN'),{code:'content_changed'});
 const owned=await f.read('EMPTY_OWNER',f.a);assert.equal(owned.total,1);await f.reader.assertSafe(owned,f.a);
 assert.deepEqual(f.calls.at(-1)?.owners,[f.a],'the safe scope cannot depend on the removed owner payload');
 const unknown=await f.read('CACHE_TOKEN',id(9999));assert.equal(unknown.total,0);await f.reader.assertSafe(unknown,id(9999));
 await assert.rejects(f.reader.warm(),{code:'session_snapshot_expired'},'global metadata remains incomplete and cannot be promoted');
});

test('a completed query exceeding the monotonic batch budget is rejected and cannot cache success',async()=>{
 const f=fixture();let slow=true;
 f.setBodyHook(async(_call,rows)=>{if(slow){slow=false;await delay(5010);}return rows;});
 await assert.rejects(f.read('CACHE_TOKEN'),{code:'database_io_timeout'});
 assert.equal((await f.read('CACHE_TOKEN')).total,1);assert.equal(f.calls.length,2,'an over-budget complete result must be recomputed rather than retained as success');
});


test('a failed PostgreSQL normalization rejects all reserved positive and empty owner results',async t=>{
 const f=fixture(),started=latch(),release=latch(),fault=new Error('normalization failed');t.after(release.release);
 f.setLowerHook(async()=>{started.release();await release.promise;throw fault;});
 const global=f.read('CACHE_TOKEN');void global.catch(()=>{});await started.promise;
 const empty=f.read('CACHE_TOKEN',f.a),positive=f.read('CACHE_TOKEN',f.b);void empty.catch(()=>{});void positive.catch(()=>{});
 await nextTurn();assert.equal(f.lowerCalls.length,1);assert.equal(f.calls.length,0);
 release.release();for(const result of await Promise.allSettled([global,empty,positive])){assert.equal(result.status,'rejected');if(result.status==='rejected')assert.equal(result.reason,fault);}
 f.setLowerHook(undefined);assert.equal((await f.read('CACHE_TOKEN')).total,1);assert.equal(f.lowerCalls.length,2);assert.equal(f.calls.length,1);
 assert.equal(f.lowerCalls.at(-1)!.transaction,f.calls.at(-1)!.transaction,'lower and body use the same checked-out transaction');
 assert.ok(f.calls.at(-1)!.statementTimeout<=f.lowerCalls.at(-1)!.statementTimeout);
 const complete=f.calls.length;assert.equal((await f.read('CACHE_TOKEN',f.a)).total,0);assert.equal((await f.read('CACHE_TOKEN',f.b)).total,1);assert.equal(f.calls.length,complete);
});
