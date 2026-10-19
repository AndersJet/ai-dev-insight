import {DatabaseIoTimeout,type Database} from '@adi/storage';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import type {SessionListDto} from '@adi/contracts';
import {DomainError} from './errors.js';
import {createPageCursor,cursorScope} from './page-cursor.js';
import {eventTime} from './event-time.js';
import {unknownSessionCoverage} from './session-official-usage.js';
import {sessionListSnapshotConfigKey,type SessionListSnapshot} from './session-list-snapshot-publisher.js';
import type {SessionListSnapshotOwner,SessionListSnapshotSession,SessionListSnapshotRecord} from './session-list-snapshot-loader.js';

type Period={from:string;to:string};
type Input={actor:string;all:boolean;owner:string|null;department:string|null;period:Period;channel:'all'|'official'|'pending'|'custom';search:string;limit:number;cursor?:string;sourceEnabled:boolean};
type Metrics={records:number;missing:number;tokens:bigint;models:Set<string>;modelName:string|null};
type PackedSession={source:Omit<SessionListSnapshotSession,'events'|'query_records'|'legacy_records'>;times:Float64Array;departments:(string|null)[];departmentCodes:Uint16Array;promptFlags:Uint8Array;prompts:{at:number;id:string;department:string|null;title:string}[];query:Map<string|null,Metrics>;legacy:Map<string,Map<string|null,Metrics>>};
type PackedOwner={user_id:string;name:string;email:string;cleanup_generation:number;sessions:PackedSession[]};
type Row=SessionListDto['items'][number]&{at_us:number};
type PromptHits={all:Set<string>;departments:Map<string|null,Set<string>>};
type CachedSearch={created:number;reference:string;promise:Promise<PromptHits>;kind:'owner'|'global';epoch:number;members:number;settled:boolean;remove:()=>void};
type PromptSearchGroup={owners:PackedOwner[]|null;oversized:boolean};
type PreparedMetadata={snapshot:SessionListSnapshot;owned:PackedOwner[];reference:string;epoch:number};
type MetadataPreparation={epoch:number;metadata:Promise<PreparedMetadata>;promise:Promise<PreparedMetadata>};
const ownerSearchLimit=8,searchEntryLimit=4096,searchMemberLimit=262144,smallSearchOwnerLimit=32,smallSearchPromptLimit=4096,searchBatchDeadlineMs=5000;
const emptyHits=():PromptHits=>({all:new Set(),departments:new Map()});
const hitMembers=(hits:PromptHits)=>hits.all.size+hits.departments.size+[...hits.departments.values()].reduce((count,ids)=>count+ids.size,0);
function createSearchSlot(cache:Map<string,CachedSearch>,cacheKey:string,promise:Promise<PromptHits>,kind:CachedSearch['kind'],epoch:number,created:number,reference=''):CachedSearch{
 // Isolate the remover's context from search batches and their captured owners.
 const slot:CachedSearch={created,reference,promise,kind,epoch,members:0,settled:false,remove:()=>{if(cache.get(cacheKey)===slot)cache.delete(cacheKey);}};
 return slot;
}

/** Decode PostgreSQL's already-lowered literal LIKE pattern. This helper does
 * not fold case: PostgreSQL supplies the source and pattern under one locale. */
export function literalPromptQuery(loweredPattern:string):{literal:string;grams:string[]}|null{
 if(!loweredPattern.startsWith('%')||!loweredPattern.endsWith('%'))return null;
 const inner=loweredPattern.slice(1,-1);let literal='';
 for(let n=0;n<inner.length;n++){
  let character=inner[n]!;
  if(character==='\\'){if(++n===inner.length)return null;character=inner[n]!;}
  else if(character==='%'||character==='_')return null;
  literal+=character;
 }
 const points=Array.from(literal,character=>character.codePointAt(0)!);
 if(points.some(point=>point===0||point>=0xd800&&point<=0xdfff))return null;
 const grams=new Set<bigint>();
 for(let n=0;n+2<points.length;n++)grams.add(BigInt(points[n]!)*4398046511104n+BigInt(points[n+1]!)*2097152n+BigInt(points[n+2]!));
 return {literal,grams:[...grams].sort((a,b)=>a<b?-1:a>b?1:0).map(String)};
}

const empty=():Metrics=>({records:0,missing:0,tokens:0n,models:new Set(),modelName:null});
function add(metrics:Metrics,record:SessionListSnapshotRecord){
 metrics.records++;if(record.value.total_tokens===null)metrics.missing++;else metrics.tokens+=BigInt(record.value.total_tokens);
 if(record.value.model_name){metrics.models.add(JSON.stringify([record.value.model_source,record.value.model_name]));metrics.modelName=metrics.modelName===null||record.value.model_name<metrics.modelName?record.value.model_name:metrics.modelName;}
}
function aggregate(records:SessionListSnapshotRecord[]){const map=new Map<string|null,Metrics>();for(const record of records){let m=map.get(record.department_id);if(!m){m=empty();map.set(record.department_id,m);}add(m,record);}return map;}
function merge(target:Metrics,source:Metrics){target.records+=source.records;target.missing+=source.missing;target.tokens+=source.tokens;for(const model of source.models)target.models.add(model);if(source.modelName&&(target.modelName===null||source.modelName<target.modelName))target.modelName=source.modelName;}
function pack(owner:SessionListSnapshotOwner):PackedOwner{
 return {...owner,sessions:owner.sessions.map(session=>{
  const departments:(string|null)[]=[],codes=new Map<string|null,number>(),times=new Float64Array(session.events.length),departmentCodes=new Uint16Array(session.events.length),promptFlags=new Uint8Array(session.events.length),prompts:PackedSession['prompts']=[];
  session.events.forEach((event,n)=>{let code=codes.get(event.department_id);if(code===undefined){code=departments.length;if(code>=65536)throw new DomainError('metric_overflow',503);codes.set(event.department_id,code);departments.push(event.department_id);}times[n]=event.at_us;departmentCodes[n]=code;if(event.event_type==='UserPromptSubmit'){promptFlags[n]=1;prompts.push({at:event.at_us,id:event.id,department:departments[code]!,title:event.prompt_excerpt??''});}});
  const legacy=new Map<string,Map<string|null,Metrics>>();for(const record of session.legacy_records){let day=legacy.get(record.business_date);if(!day){day=new Map();legacy.set(record.business_date,day);}let m=day.get(record.department_id);if(!m){m=empty();day.set(record.department_id,m);}add(m,record);}
  const {events:_events,query_records:_queries,legacy_records:_legacy,...source}=session;void _events;void _queries;void _legacy;
  return {source,times,departments,departmentCodes,promptFlags,prompts,query:aggregate(session.query_records),legacy};
 })};
}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const day=(at:number)=>new Date(Math.floor(at/1000)+28800000).toISOString().slice(0,10);
const iso=(at:number)=>{const seconds=Math.floor(at/1000000),micros=at-seconds*1000000;return eventTime(new Date(seconds*1000).toISOString().replace('.000Z','.'+String(micros).padStart(6,'0')+'Z'));};
function promptDepartment(session:PackedSession|undefined,id:string,atText:string){
 if(!session)return undefined;const at=Number(atText);let left=0,right=session.prompts.length;
 // The loader orders captured facts by (occurred_at,id). Preserve that full
 // identity with a binary lookup without duplicating 230k composite-string keys.
 while(left<right){const middle=(left+right)>>>1,prompt=session.prompts[middle]!;if(prompt.at<at||prompt.at===at&&prompt.id<id)left=middle+1;else right=middle;}
 const prompt=session.prompts[left];return prompt?.at===at&&prompt.id===id?prompt.department:undefined;
}

/** Immutable, published read views. The publisher owns quantity calculations;
 * this adapter only selects already-published metadata. Its caches never grant
 * authority: callers authenticate before/after, and every read checks current
 * cleanup/recovery/retention fences. Ordinary additions do not break a pinned
 * page, and cursor replay across actors or query scopes is rejected by HMAC.
 */
export function createSessionListSnapshotReader(db:Database,options:{providerAccount?:string;stopWindowEnabled?:boolean;clock?:()=>Date}={}){
 const now=options.clock??(()=>new Date()),key=sessionListSnapshotConfigKey(options.providerAccount??null,options.stopWindowEnabled===true),cursors=createPageCursor(now);
 const entries=new Map<string,{owner:PackedOwner;touched:number}>(),views=new Map<string,{created:number;reference:string;promise:Promise<Row[]>}>();
 let ownerBases=new WeakMap<PackedOwner,Map<string,Row[]>>();
 const searches=new Map<string,CachedSearch>();
 let ownerSearches=new WeakMap<PackedOwner,Map<string,CachedSearch>>(),searchEpoch=0,searchMembers=0;
 let promptWork=new WeakMap<PackedOwner,Map<string,number>>();
 const retainedSearches=new Set<CachedSearch>();
 const ownerLoads=new Map<string,{created:number;promise:Promise<PackedOwner[]>}>();
 const headers=new Map<string,Promise<SessionListSnapshot|undefined>>(),references=new WeakMap<SessionListSnapshot,string>();
 let activeEntries=new Set<string>(),activeAllKey='',metadataEpoch=0;
 let ready:PreparedMetadata|undefined,preparing:MetadataPreparation|undefined;
 const resultEpochs=new WeakMap<SessionListDto,number>();
 function discardSearch(search:CachedSearch){if(retainedSearches.delete(search))searchMembers-=search.members;search.remove();}
 function touchSearch(search:CachedSearch){if(retainedSearches.delete(search))retainedSearches.add(search);}
 function trimSearches(latest:CachedSearch){
  if(latest.members>searchMemberLimit){discardSearch(latest);return;}
  while(retainedSearches.size>searchEntryLimit||searchMembers>searchMemberLimit){
   // Completed global unions are expendable: owner results can recreate them
   // without PostgreSQL, so avoid evicting stable positive/empty owner caches.
   const values=[...retainedSearches],victim=values.find(value=>value!==latest&&value.kind==='global'&&value.settled)??values.find(value=>value.kind==='global'&&value.settled)??values.find(value=>value!==latest&&value.settled)??values.find(value=>value!==latest)??latest;
   discardSearch(victim);
  }
 }
 function retainSearch(search:CachedSearch){
  retainedSearches.add(search);trimSearches(search);
  search.promise.then(hits=>{
   // An evicted or pre-clear query may still finish for its caller, but cannot
   // repopulate a new cache epoch or remove another query's replacement slot.
   if(search.epoch!==searchEpoch||!retainedSearches.has(search))return;
   search.settled=true;search.members=hitMembers(hits);searchMembers+=search.members;touchSearch(search);trimSearches(search);
  },()=>discardSearch(search));
 }
 function clearCaches(){searchEpoch++;metadataEpoch++;ready=undefined;preparing=undefined;for(const search of [...retainedSearches])discardSearch(search);entries.clear();views.clear();searches.clear();ownerLoads.clear();headers.clear();ownerBases=new WeakMap();ownerSearches=new WeakMap();promptWork=new WeakMap();activeEntries=new Set();activeAllKey='';}
 const currentReference=(reference:string)=>reference===activeAllKey||reference.startsWith('owner:')&&activeEntries.has(reference.slice('owner:'.length));
 function referenceKey(snapshot:SessionListSnapshot,input:Pick<Input,'owner'>){
  if(input.owner)return 'owner:'+(snapshot.owner_entries[input.owner]??'absent');
  let value=references.get(snapshot);if(!value){value='all:'+createHash('sha256').update(JSON.stringify(Object.values(snapshot.owner_entries))).digest('hex');references.set(snapshot,value);}return value;
 }
 async function latestId(){
  return (await db.query<{id:string}>('SELECT id FROM session_list_snapshots WHERE config_key=$1 ORDER BY as_of DESC,created_at DESC,id DESC LIMIT 1',[key])).rows[0]?.id;
 }
 async function header(id:string,epoch=metadataEpoch){
  // Fixed UUID lookup never changes the prepared current reference.
  let pending=headers.get(id);
  if(!pending){
   pending=db.query<SessionListSnapshot>('SELECT * FROM session_list_snapshots WHERE id=$1 AND config_key=$2',[id,key]).then(result=>result.rows[0]);
   if(epoch===metadataEpoch){headers.set(id,pending);const token=pending;pending.catch(()=>{if(epoch===metadataEpoch&&headers.get(id)===token)headers.delete(id);});}
  }
  const snapshot=await pending;
  if(!snapshot||snapshot.expires_at.getTime()<=now().getTime()){
   if(epoch===metadataEpoch&&headers.get(id)===pending)headers.delete(id);
   throw new DomainError('session_snapshot_expired',409);
  }
  if(epoch===metadataEpoch)while(headers.size>16)headers.delete(headers.keys().next().value!);
  return snapshot;
 }
 async function loadOwners(snapshot:SessionListSnapshot,input:Pick<Input,'owner'>,epoch:number){
  if(input.owner&&!Object.hasOwn(snapshot.safety_fence.cleanup,input.owner))return [];
  const refs=input.owner?[[input.owner,snapshot.owner_entries[input.owner]]]:Object.entries(snapshot.owner_entries);
  if(refs.some(([,id])=>!id))throw new DomainError('session_snapshot_pending',503);
  // Capture results locally. A clear can revoke admission without revoking a
  // safe scoped caller's immutable data or making it depend on the shared Map.
  const local=new Map<string,PackedOwner>();
  for(const [,id]of refs){const cached=entries.get(id!);if(cached)local.set(id!,cached.owner);}
  const missing=refs.filter(([,id])=>!local.has(id!));
  for(let start=0;start<missing.length;start+=4){
   const ids=missing.slice(start,start+4).map(([,id])=>id!);
   const rows=(await db.query<{id:string;user_id:string;cleanup_generation:number;payload:SessionListSnapshotOwner}>('SELECT id,user_id,cleanup_generation,payload FROM session_list_snapshot_entries WHERE id=ANY($1::uuid[])',[ids])).rows;
   for(const row of rows){
    if(row.payload.user_id!==row.user_id||snapshot.safety_fence.cleanup[row.user_id]!==row.cleanup_generation)throw new DomainError('content_changed',409);
    const cached=entries.get(row.id),owner=cached?.owner??pack(row.payload);local.set(row.id,owner);
    if(epoch===metadataEpoch&&!cached)entries.set(row.id,{owner,touched:now().getTime()});
   }
  }
  const output:PackedOwner[]=[];
  for(const [,id]of refs){const owner=local.get(id!);if(!owner)throw new DomainError('session_snapshot_expired',409);output.push(owner);if(epoch===metadataEpoch){const cached=entries.get(id!);if(cached)cached.touched=now().getTime();}}
  if(epoch===metadataEpoch)for(const [id,value]of entries)if(!activeEntries.has(id)&&value.touched<now().getTime()-75000)entries.delete(id);
  return output;
 }
 function owners(snapshot:SessionListSnapshot,input:Pick<Input,'owner'>,epoch=metadataEpoch){
  const cacheKey=referenceKey(snapshot,input);
  if(epoch!==metadataEpoch)return loadOwners(snapshot,input,epoch);
  let load=ownerLoads.get(cacheKey);
  if(!load){
   load={created:now().getTime(),promise:loadOwners(snapshot,input,epoch)};ownerLoads.set(cacheKey,load);const token=load;
   load.promise.catch(()=>{if(epoch===metadataEpoch&&ownerLoads.get(cacheKey)===token)ownerLoads.delete(cacheKey);});
  }
  for(const [k,value]of ownerLoads)if(k!==activeAllKey&&!activeEntries.has(k.slice('owner:'.length))&&value.created<now().getTime()-75000)ownerLoads.delete(k);
  while(ownerLoads.size>128)ownerLoads.delete(ownerLoads.keys().next().value!);
  return load.promise;
 }
 async function checkFence(snapshot:SessionListSnapshot,owner:string|null,canClear:()=>boolean=()=>true){
  // Compare against the immutable stored fence inside one database statement.
  // Send a boolean instead of allocating/parsing 500 cleanup identities on
  // every global read. Cached metadata still cannot grant access.
  const row=(await db.query<{recovery_id:string|null;safe:boolean}>(`SELECT d.recovery_id,
   (s.id IS NOT NULL AND d.dataset_id::text=s.safety_fence->>'dataset_id'
    AND (d.retention_cutoff::text IS NOT DISTINCT FROM s.safety_fence->>'retention_cutoff')
    AND CASE WHEN $3::uuid IS NULL THEN NOT EXISTS(
     SELECT 1 FROM jsonb_each_text(s.safety_fence->'cleanup') expected
     LEFT JOIN users u ON u.id=expected.key::uuid WHERE u.cleanup_generation::text IS DISTINCT FROM expected.value
    ) ELSE NOT(s.safety_fence->'cleanup' ? $3::uuid::text) OR (
     SELECT cleanup_generation::text FROM users WHERE id=$3
    ) IS NOT DISTINCT FROM s.safety_fence->'cleanup'->>($3::uuid::text) END) AS safe
   FROM data_identity d LEFT JOIN session_list_snapshots s ON s.id=$1 AND s.config_key=$2`,[snapshot.id,key,owner])).rows[0];
  if(!row||row.recovery_id){if(canClear())clearCaches();throw new DomainError('recovery_quarantined',503);}
  if(!row.safe){if(canClear())clearCaches();throw new DomainError('content_changed',409);}
 }
 function cachedView(input:Input,owned:PackedOwner[],reference:string,epoch=metadataEpoch){
  const viewKey=JSON.stringify([reference,input.period,input.owner,input.department,input.channel,input.search,input.sourceEnabled]);
  if(epoch!==metadataEpoch)return build(input,owned,reference,epoch);
  let view=views.get(viewKey);if(!view){view={created:now().getTime(),reference,promise:build(input,owned,reference,epoch)};views.set(viewKey,view);const token=view;view.promise.catch(()=>{if(epoch===metadataEpoch&&views.get(viewKey)===token)views.delete(viewKey);});}return view.promise;
 }
 function capturedPromptWork(owner:PackedOwner,period:Period){
  const cacheKey=JSON.stringify(period);let cached=promptWork.get(owner);const found=cached?.get(cacheKey);
  if(found!==undefined){cached!.delete(cacheKey);cached!.set(cacheKey,found);return found;}
  const from=Date.parse(period.from)*1000,to=Date.parse(period.to)*1000;let count=0;
  for(const session of owner.sessions){
   const bound=(at:number)=>{let left=0,right=session.prompts.length;while(left<right){const middle=(left+right)>>>1;if(session.prompts[middle]!.at<at)left=middle+1;else right=middle;}return left;};
   count+=bound(to)-bound(from);
  }
  if(!cached){cached=new Map();promptWork.set(owner,cached);}cached.set(cacheKey,count);while(cached.size>ownerSearchLimit)cached.delete(cached.keys().next().value!);return count;
 }
 function promptSearchGroups(input:Input,owned:PackedOwner[],missing:PackedOwner[]):PromptSearchGroup[]{
  if(input.owner)return [{owners:missing,oversized:capturedPromptWork(missing[0]!,input.period)>smallSearchPromptLimit}];
  // Cold means either most owners or most captured work is still missing.
  // An owned prewarm must not redirect a first broad query into a full scan.
  if(missing.length>smallSearchOwnerLimit||missing.length*2>=owned.length)return [{owners:null,oversized:false}];
  const weighted=missing.map(owner=>({owner,count:capturedPromptWork(owner,input.period)})),missingWork=weighted.reduce((sum,value)=>sum+value.count,0),totalWork=owned.reduce((sum,owner)=>sum+capturedPromptWork(owner,input.period),0);
  if(missingWork*2>=totalWork)return [{owners:null,oversized:false}];
  const groups:PromptSearchGroup[]=[];let owners:PackedOwner[]=[],count=0;
  const flush=()=>{if(owners.length){groups.push({owners,oversized:false});owners=[];count=0;}};
  for(const value of weighted){
   if(value.count>smallSearchPromptLimit){flush();groups.push({owners:[value.owner],oversized:true});continue;}
   if(count+value.count>smallSearchPromptLimit)flush();owners.push(value.owner);count+=value.count;
  }
  flush();return groups;
 }
 function remainingSearchTime(deadline:number){
  const remaining=Math.floor(deadline-performance.now());if(remaining<1)throw new DatabaseIoTimeout();return remaining;
 }
 async function ownerPromptHits(input:Input,owned:PackedOwner[],pattern:string){
  const cacheKey=JSON.stringify([input.period,input.search]),promises:Promise<PromptHits>[]=[];
  const missing:Array<{owner:PackedOwner;resolve:(hits:PromptHits)=>void;reject:(error:unknown)=>void}>=[];
  for(const owner of owned){
   let cache=ownerSearches.get(owner);if(!cache){cache=new Map();ownerSearches.set(owner,cache);}
   const cached=cache.get(cacheKey);
   if(cached){cache.delete(cacheKey);cache.set(cacheKey,cached);touchSearch(cached);promises.push(cached.promise);continue;}
   let resolve!:(hits:PromptHits)=>void,reject!:(error:unknown)=>void;
   const promise=new Promise<PromptHits>((accept,fail)=>{resolve=accept;reject=fail;}),ownerCache=cache;
   const slot=createSearchSlot(ownerCache,cacheKey,promise,'owner',searchEpoch,now().getTime());
   // Reserve every missing owner before issuing SQL, including empty owners.
   // Concurrent global/owned callers await the same per-owner promise.
   ownerCache.set(cacheKey,slot);retainSearch(slot);
   while(ownerCache.size>ownerSearchLimit)discardSearch(ownerCache.values().next().value!);
   promises.push(promise);missing.push({owner,resolve,reject});
  }
  if(missing.length){
   const missingOwners=missing.map(value=>value.owner);
   const deadline=performance.now()+searchBatchDeadlineMs;
   void (async()=>{
    try{
     const groups=promptSearchGroups(input,owned,missingOwners);
     const sessionById=new Map<string,{owner:PackedOwner;session:PackedSession}>(),byOwner=new Map<PackedOwner,PromptHits>();
     for(const owner of missingOwners){byOwner.set(owner,emptyHits());for(const session of owner.sessions)sessionById.set(session.source.id,{owner,session});}
     for(const group of groups){
      remainingSearchTime(deadline);
      // Release each connection between sequential groups. Reject batch work
      // that overruns the former single 5-second SQL budget, including mapping.
      const found=await db.transaction(async client=>{
      await client.query('SET TRANSACTION READ ONLY');await client.query('SET LOCAL jit=off');
      await client.query("SELECT set_config('statement_timeout',$1,true)",[String(remainingSearchTime(deadline))]);
      let sql=group.owners?`${group.oversized?'/* oversized captured owner: original owned route, not a 4096-row bound */\n':''}WITH candidates AS MATERIALIZED (
       SELECT id,occurred_at,session_id FROM hook_events WHERE event_type='UserPromptSubmit'
        AND user_id=ANY($3::uuid[]) AND occurred_at>=$1 AND occurred_at<$2 AND ($4::uuid IS NULL OR department_id=$4)
      ) SELECT c.id,c.session_id,(extract(epoch FROM c.occurred_at)*1000000)::bigint::text AS at_us
       FROM candidates c JOIN LATERAL(SELECT e.prompt_search AS prompt FROM hook_events e
        WHERE e.id=c.id AND e.occurred_at=c.occurred_at OFFSET 0) p ON true WHERE p.prompt LIKE lower($5::text)`
       :`SELECT id,session_id,(extract(epoch FROM occurred_at)*1000000)::bigint::text AS at_us FROM hook_events WHERE event_type='UserPromptSubmit' AND occurred_at>=$1 AND occurred_at<$2 AND ($3::uuid IS NULL OR user_id=$3) AND ($4::uuid IS NULL OR department_id=$4) AND prompt_search LIKE $5::text`;
      const values:unknown[]=[input.period.from,input.period.to,group.owners?.map(owner=>owner.user_id)??null,null,pattern];
      if(!group.owners){
       const lowered=(await client.query<{pattern:string}>('SELECT pg_catalog.lower($1::text) AS pattern',[pattern])).rows[0]!.pattern;
       values[4]=lowered;
       const query=literalPromptQuery(lowered);
       if(query?.grams.length){
        // The trusted schema is validated by storage. Every candidate still
        // confirms the literal against this current Hook row's native value.
        sql=`SELECT id,session_id,(extract(epoch FROM occurred_at)*1000000)::bigint::text AS at_us FROM hook_events WHERE event_type='UserPromptSubmit' AND occurred_at>=$1 AND occurred_at<$2 AND ($3::uuid IS NULL OR user_id=$3) AND ($4::uuid IS NULL OR department_id=$4)
         AND "${db.schema}".hook_prompt_codepoint_grams(prompt_search) @> $6::bigint[]
         AND CASE WHEN left(prompt_search,160) LIKE $5::text THEN true ELSE prompt_search LIKE $5::text END`;
        values.push(query.grams);
       }
       // Normalization, decoding and packing consume the same monotonic batch
       // deadline. Do not renew the original SQL allowance after that work.
       await client.query("SELECT set_config('statement_timeout',$1,true)",[String(remainingSearchTime(deadline))]);
      }
      // Captured work is an estimate; raw additions can still be scanned. No
      // LIMIT truncates native matching, and the fixed client 6s limit remains.
      return client.query<{id:string;session_id:string;at_us:string}>(sql,values);
      });
      remainingSearchTime(deadline);
      for(const row of found.rows){
       const captured=sessionById.get(row.session_id),department=promptDepartment(captured?.session,row.id,row.at_us);if(!captured||department===undefined)continue;
       const hits=byOwner.get(captured.owner)!,id=captured.session.source.id;hits.all.add(id);let departmentHits=hits.departments.get(department);if(!departmentHits){departmentHits=new Set();hits.departments.set(department,departmentHits);}departmentHits.add(id);
      }
     }
     // Completed groups remain local until every group succeeds. An old epoch
     // controls cache admission, not authority; callers still check real fences.
     remainingSearchTime(deadline);
     for(const value of missing)value.resolve(byOwner.get(value.owner)!);
    }catch(error){for(const value of missing)value.reject(error);}
   })();
  }
  return Promise.all(promises);
 }
 async function promptHits(input:Input,owned:PackedOwner[],reference:string,pattern:string){
  const searchKey=JSON.stringify([reference,input.period,input.owner,input.search]);
  let search=searches.get(searchKey);if(!search){
   const promise=ownerPromptHits(input,owned,pattern).then(parts=>{
    const hits=emptyHits();for(const part of parts){for(const id of part.all)hits.all.add(id);for(const [department,ids]of part.departments){let group=hits.departments.get(department);if(!group){group=new Set();hits.departments.set(department,group);}for(const id of ids)group.add(id);}}return hits;
   });
   const slot=createSearchSlot(searches,searchKey,promise,'global',searchEpoch,now().getTime(),reference);
   search=slot;searches.set(searchKey,slot);retainSearch(slot);
  }else touchSearch(search);
  for(const value of searches.values())if(!currentReference(value.reference)&&value.created<now().getTime()-60000)discardSearch(value);while(searches.size>64)discardSearch(searches.values().next().value!);
  const hits=await search.promise;return input.department===null?hits.all:hits.departments.get(input.department)??new Set<string>();
 }
 function ownerBase(input:Input,owner:PackedOwner,epoch:number):Row[]{
  const baseKey=JSON.stringify([input.period,input.department,input.sourceEnabled]);let bases=ownerBases.get(owner);const cached=epoch===metadataEpoch?bases?.get(baseKey):undefined;
  if(cached){bases!.delete(baseKey);bases!.set(baseKey,cached);return cached;}
  const from=Date.parse(input.period.from)*1000,to=Date.parse(input.period.to)*1000,fromDay=day(from),toDay=day(to),rows:Row[]=[];
  for(const s of owner.sessions){
   let first=Infinity,last=-Infinity,prompts=0;
   for(let i=0;i<s.times.length;i++){const at=s.times[i]!;if(at<from||at>=to||input.department!==null&&s.departments[s.departmentCodes[i]!]!==input.department)continue;first=Math.min(first,at);last=Math.max(last,at);prompts+=s.promptFlags[i]!;}
   if(first===Infinity)continue;
   const metrics=empty();let unassigned=0;
   if(input.sourceEnabled){
    const sources=s.source.has_session_query?[s.query]:[...s.legacy].filter(([date])=>date>=fromDay&&date<toDay).map(([,values])=>values);
    for(const values of sources){unassigned+=values.get(null)?.records??0;for(const [department,value]of values)if(input.department===null||department===input.department)merge(metrics,value);}
   }
   const personal=s.source.personal_models,pending=input.sourceEnabled&&(s.source.pending_link||s.source.pending_days.some(date=>date>=day(first)&&date<=day(last)));
   const official=metrics.records+unassigned>0,channel=official?(personal.length?'mixed':'official'):personal.length?'custom':pending?'pending':'unknown';
   const title=s.prompts.find(p=>p.at>=from&&p.at<to&&(input.department===null||p.department===input.department))?.title||'未观测到提示';
   rows.push({id:s.source.id,user_id:owner.user_id,name:owner.name,email:owner.email,source_session_id:s.source.source_session_id,title,first_at:iso(first),last_at:iso(last),at_us:last,prompt_turns:prompts,channel,model:metrics.models.size===1?metrics.modelName:null,model_count:metrics.models.size,official_tokens:metrics.records&&metrics.missing===0?metrics.tokens.toString():null,official_records:metrics.records,department_unassigned_records:unassigned,attribution_conflicts:input.sourceEnabled?s.source.conflicts:0,personal_models:personal,session_coverage:unknownSessionCoverage()});
  }
  if(epoch===metadataEpoch){if(!bases){bases=new Map();ownerBases.set(owner,bases);}bases.set(baseKey,rows);while(bases.size>8)bases.delete(bases.keys().next().value!);}return rows;
 }
 async function build(input:Input,owned:PackedOwner[],reference:string,epoch:number):Promise<Row[]>{
  const variant=input.channel!=='all'||!!input.search;
  // Reuse immutable owner rows across publications. Ordinary updates replace
  // only changed owner payloads, so global views merge/sort existing rows rather
  // than rebuilding 50,000 quantities and timestamps on the event loop.
  const rows:Row[]=variant?await cachedView({...input,channel:'all',search:''},owned,reference,epoch):owned.flatMap(owner=>ownerBase(input,owner,epoch));
  let hits:Set<string>|undefined;
  if(input.search){
   const pattern=`%${input.search.replace(/[\\%_]/g,value=>`\\${value}`)}%`;
   hits=new Set(await promptHits(input,owned,reference,pattern));
   // ASCII needles can still match Unicode metadata according to the server's
   // locale (e.g. en_US UTF8 İA ILIKE ia). Captured snapshot metadata has the
   // same PostgreSQL authority as body search, for every query.
   const metadata=(await db.query<{id:string}>(`SELECT id FROM jsonb_to_recordset($1::jsonb) r(id text,source_session_id text,email text) WHERE source_session_id ILIKE $2 OR email ILIKE $2`,[JSON.stringify(rows.map(r=>({id:r.id,source_session_id:r.source_session_id,email:r.email}))),pattern])).rows;for(const row of metadata)hits.add(row.id);
  }
  const channels=input.channel==='all'?rows:rows.filter(r=>r.channel===input.channel||r.channel==='mixed'&&['official','custom'].includes(input.channel));
  const filtered=input.search?channels.filter(r=>hits!.has(r.id)):channels;
  return filtered.sort((a,b)=>b.at_us-a.at_us||(a.id<b.id?1:a.id>b.id?-1:0));
 }
 function preparation(){
  if(preparing?.epoch===metadataEpoch)return preparing;
  const epoch=metadataEpoch;
  const metadata=(async():Promise<PreparedMetadata>=>{
   const id=await latestId();if(!id)throw new DomainError('session_snapshot_pending',503);
   const current=ready;
   if(epoch===metadataEpoch&&current?.snapshot.id===id&&current.snapshot.expires_at.getTime()>now().getTime())return current;
   let snapshot:SessionListSnapshot;
   try{snapshot=await header(id,epoch);}catch(error){if(error instanceof DomainError&&error.code==='session_snapshot_expired')throw new DomainError('session_snapshot_pending',503);throw error;}
   const owned=await owners(snapshot,{owner:null},epoch),reference=referenceKey(snapshot,{owner:null}),midnight=Math.floor((now().getTime()+28800000)/86400000)*86400000-28800000;
   // Prepare only common metadata windows. Never warm target words or bodies.
   for(const days of [45,7]){
    const input:Input={actor:'startup',all:true,owner:null,department:null,period:{from:new Date(midnight-(days-1)*86400000).toISOString(),to:new Date(midnight+86400000).toISOString()},channel:'all',search:'',limit:20,sourceEnabled:!!options.providerAccount};
    await cachedView(input,owned,reference,epoch);
   }
   return {snapshot,owned,reference,epoch};
  })();
  const promise=metadata.then(async value=>{
   await checkFence(value.snapshot,null,()=>epoch===metadataEpoch&&preparing===slot);
   if(value.snapshot.expires_at.getTime()<=now().getTime())throw new DomainError('session_snapshot_pending',503);
   // One synchronous switch after complete metadata and real global safety.
   if(epoch===metadataEpoch&&preparing===slot){ready=value;activeEntries=new Set(Object.values(value.snapshot.owner_entries));activeAllKey=value.reference;}
   return value;
  }).catch(error=>{
   if(error instanceof DomainError&&error.code==='session_snapshot_pending'&&epoch===metadataEpoch&&preparing===slot&&(!ready||ready.snapshot.expires_at.getTime()<=now().getTime()))clearCaches();
   throw error;
  }).finally(()=>{if(preparing===slot)preparing=undefined;});
  const slot:MetadataPreparation={epoch,metadata,promise};preparing=slot;
  // Foreground scoped reads may await local metadata independently of the
  // global promotion fence. Their own real fences still decide authorization.
  void promise.catch(()=>{});return slot;
 }
 function kickPreparation(){void preparation().promise.catch(()=>{});}
 async function warm(){return (await preparation().promise).snapshot.id;}
 async function read(input:Input):Promise<SessionListDto>{
  const binding=cursorScope(['session-list-snapshot',input.actor,input.all,input.owner,input.department,input.period,input.channel,input.search,input.limit,key]);
  const decoded=input.cursor?cursors.decode(input.cursor,binding):null;
  if(decoded&&(!uuid(decoded.snapshot)||!uuid(decoded.id)||!Number.isSafeInteger(decoded.at_us)))throw new DomainError('invalid_cursor',400);
  let snapshot:SessionListSnapshot,prepared:PreparedMetadata|undefined,epoch=metadataEpoch;
  if(decoded){snapshot=await header(decoded.snapshot as string,epoch);kickPreparation();}
  else if(ready&&ready.snapshot.expires_at.getTime()>now().getTime()){prepared=ready;snapshot=prepared.snapshot;epoch=prepared.epoch;kickPreparation();}
  else if(input.owner){
   // An unrelated owner may have been physically removed after publication.
   // A scoped read needs only its own immutable payload and real scoped fence.
   const id=await latestId();if(!id)throw new DomainError('session_snapshot_pending',503);
   try{snapshot=await header(id,epoch);}catch(error){if(error instanceof DomainError&&error.code==='session_snapshot_expired')throw new DomainError('session_snapshot_pending',503);throw error;}
   kickPreparation();
  }else{const slot=preparation();prepared=await slot.metadata;snapshot=prepared.snapshot;epoch=slot.epoch;}
  const canClear=()=>epoch===metadataEpoch;await checkFence(snapshot,input.owner,canClear);
  const owned=prepared?(input.owner?prepared.owned.filter(owner=>owner.user_id===input.owner):prepared.owned):await owners(snapshot,input,epoch);
  const rows=await cachedView(input,owned,referenceKey(snapshot,input),epoch),after=decoded?rows.findIndex(r=>r.id===decoded.id&&r.at_us===decoded.at_us)+1:0;
  if(decoded&&after===0)throw new DomainError('invalid_cursor',400);
  const selected=rows.slice(after,after+input.limit),hasMore=after+selected.length<rows.length;
  await checkFence(snapshot,input.owner,canClear);
  if(snapshot.expires_at.getTime()<=now().getTime())throw new DomainError('session_snapshot_expired',409);
  if(epoch===metadataEpoch){for(const [k,value]of views)if(!currentReference(value.reference)&&value.created<now().getTime()-60000)views.delete(k);while(views.size>64)views.delete(views.keys().next().value!);}
  const last=selected.at(-1),latest=await latestId();
  const result:SessionListDto={period:input.period,items:selected.map(({at_us:_at,...row})=>{void _at;return row;}),total:rows.length,has_more:hasMore,next_cursor:hasMore&&last?cursors.encode(binding,{snapshot:snapshot.id,id:last.id,at_us:last.at_us}):null,channel_available:input.sourceEnabled,available_channels:input.sourceEnabled?['all','official','pending','custom']:['all','custom'],snapshot:{id:snapshot.id,as_of:snapshot.as_of.toISOString(),expires_at:snapshot.expires_at.toISOString(),updating:latest!==snapshot.id}};
  resultEpochs.set(result,epoch);return result;
 }
 async function assertSafe(result:SessionListDto,owner:string|null){
  if(!result.snapshot)throw new DomainError('session_snapshot_pending',503);
  const epoch=resultEpochs.get(result)??metadataEpoch,snapshot=await header(result.snapshot.id,epoch);
  await checkFence(snapshot,owner,()=>epoch===metadataEpoch);
  if(snapshot.expires_at.getTime()<=now().getTime())throw new DomainError('session_snapshot_expired',409);
 }
 return {read,warm,assertSafe};
}
export type SessionListSnapshotReader=ReturnType<typeof createSessionListSnapshotReader>;
