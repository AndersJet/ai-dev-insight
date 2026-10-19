import {createHash} from 'node:crypto';
import type {Database,Queryable,Transaction} from '@adi/storage';
import {DomainError} from './errors.js';

const basis=['users','credentials','departments','membership_periods','eligibility_periods','role_grants','repository_allowlist','usage_provider_identities','usage_department_catalog','usage_department_mappings','usage_mapping_state','installations','plugin_account_credentials','plugin_collectors','plugin_releases','plugin_release_channels'] as const;
const usage=['session_list_snapshots','session_list_snapshot_entries','hook_events','sessions','session_derivations','session_fragments','session_steps','session_turns','session_days','session_personal_models','session_simulation_cache','session_usage_queries','usage_observations','usage_scopes','usage_snapshot_runs','usage_snapshot_parts','usage_snapshot_pages','usage_attribution_evidence','usage_attribution_subjects','usage_attribution_revisions','usage_model_checks','session_token_checks','project_observations','project_hook_links','jobs','login_sessions','cleanup_previews','cleanup_requests','cleanup_tombstones','recovery_runs','usage_backfills','usage_backfill_days','usage_provider_control'] as const;
type Row=Record<string,unknown>;
type Snapshot={identity:Row;tables:Record<string,Row[]>;fingerprint:string};
export interface DatasetRebuildPlan{version:1;source_schema:string;target_schema:string;source_dataset:string;target_dataset:string;baseline_at:string;source_fingerprint:string;table_counts:Record<string,number>;table_columns:Record<string,string[]>;digest:string}
export interface DatasetRebuildReview{source_writers_stopped:boolean;network_isolated:boolean;backup_and_journal_verified:boolean;credential_key_verified:boolean}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier=(value:string)=>{if(!/^[a-z][a-z0-9_]{0,62}$/.test(value))throw new DomainError('invalid_rebuild_identifier',422);return '"'+value+'"';};
async function exists(sql:Queryable,name:string){return (await sql.query<{present:boolean}>('SELECT to_regclass($1) IS NOT NULL AS present',[name])).rows[0]!.present;}
async function counts(sql:Queryable,names:readonly string[]){
  const result:Record<string,number>={};for(const name of names){if(!await exists(sql,name))continue;const n=Number((await sql.query<{count:string}>(`SELECT count(*)::text AS count FROM ${identifier(name)}`)).rows[0]!.count);if(!Number.isSafeInteger(n)||n<0)throw new DomainError('metric_overflow',503);result[name]=n;}return result;
}
function baseline(date:string){
  const at=Date.parse(date+'T00:00:00+08:00');if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(at)||new Date(at+28800000).toISOString().slice(0,10)!==date)throw new DomainError('invalid_baseline_date',422);return new Date(at).toISOString();
}
async function readSnapshot(sql:Queryable):Promise<Snapshot>{
    const identity=(await sql.query<{value:Row}>('SELECT to_jsonb(d) AS value FROM data_identity d')).rows[0]?.value;if(!identity)throw new DomainError('source_identity_missing',409);
    const tables:Record<string,Row[]>={};
    for(const name of [...basis,'project_streams','project_observation_keys']){
      if(!await exists(sql,name))continue;
      if(name==='plugin_releases'){const bytes=(await sql.query<{bytes:string}>('SELECT COALESCE(sum(bytes),0)::text AS bytes FROM plugin_releases')).rows[0]!.bytes;if(BigInt(bytes)>128n*1024n*1024n)throw new DomainError('rebuild_transfer_limit',422);}
      let sequences='';
      if(name==='project_streams'||name==='project_observation_keys'){
        const available=(await sql.query<{column_name:string}>('SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1',[name])).rows.map(r=>r.column_name);
        const fields=(name==='project_streams'?['latest_sequence','confirmed_sequence','seen_sequence','barrier_sequence']:['sequence']).filter(c=>available.includes(c));
        sequences=` || jsonb_build_object(${fields.map(c=>`'${c}',${c}::text`).join(',')})`;
      }
      const rows=(await sql.query<{value:Row}>(`SELECT to_jsonb(t)${sequences} AS value FROM ${identifier(name)} t ORDER BY to_jsonb(t)::text LIMIT 50001`)).rows;
      if(rows.length>50000)throw new DomainError('rebuild_transfer_limit',422);tables[name]=rows.map(row=>row.value);
    }
    // Old Hook sources already had authenticated user_id; only minimal ordering
    // evidence is read from their observations. Anonymous plugin rows are ignored.
    if(!tables.project_observation_keys&&await exists(sql,'project_observations')){
      const modern=(await sql.query('SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 AND column_name=$2',['project_observations','source_kind'])).rowCount;
      const kind=modern?'o.source_kind':"'hook'::text";
      const rows=(await sql.query<Row>(`SELECT o.user_id,${kind} AS source_kind,o.collector_id,o.id AS observation_id,o.sequence::text,o.project_id,s.workspace_key,o.payload_hash,true AS cleared
        FROM project_observations o JOIN project_streams s ON s.id=o.project_id ORDER BY o.user_id,o.collector_id,o.id LIMIT 50001`)).rows;
      if(rows.length>50000)throw new DomainError('rebuild_transfer_limit',422);tables.project_observation_keys=rows;
    }
    return {identity,tables,fingerprint:digest({identity,tables})};
}
async function snapshot(db:Database):Promise<Snapshot>{return db.transaction(async sql=>{await sql.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');return readSnapshot(sql);});}
function transformed(data:Snapshot){
  const tables:Record<string,Row[]>={};
  for(const name of basis)tables[name]=(data.tables[name]??[]).map(row=>name==='users'?{...row,adopted_at:null,ingest_epoch:Number(row.ingest_epoch??1)+1}:name==='installations'||name==='plugin_collectors'?{...row,last_seen:null}:row);
  if(!Object.hasOwn(data.tables,'plugin_release_channels'))tables.plugin_release_channels=[{singleton:true,stable_id:null,pilot_id:null}];
  const trusted=new Set((data.tables.users??[]).map(u=>String(u.id))),pluginSources=new Set((data.tables.plugin_collectors??[]).map(c=>String(c.collector_id)));
  tables.project_streams=(data.tables.project_streams??[]).filter(s=>trusted.has(String(s.user_id))&&(s.source_kind!=='plugin'||pluginSources.has(String(s.collector_id)))).map(s=>{
    const seen=String([s.seen_sequence??0,s.latest_sequence??0,s.confirmed_sequence??0].map(v=>BigInt(String(v))).reduce((a,b)=>a>b?a:b));
    return {...s,source_kind:s.source_kind??'hook',platform:s.platform??null,barrier_sequence:seen,seen_sequence:seen};
  });
  const streamIds=new Set(tables.project_streams.map(s=>String(s.id)));
  tables.project_observation_keys=(data.tables.project_observation_keys??[]).filter(k=>trusted.has(String(k.user_id))&&streamIds.has(String(k.project_id))).map(k=>({...k,source_kind:k.source_kind??'hook',cleared:true,fact_id:null}));
  return tables;
}
/** Read-only inventory works against the old ledger without running migrations. */
export async function previewDatasetRebuild(source:Database){
  const data=await snapshot(source);
  return {source_schema:source.schema,source_dataset:String(data.identity.dataset_id),source_fingerprint:data.fingerprint,basis_counts:await counts(source,basis),excluded_counts:await counts(source,[...usage,'plugin_project_observations','project_streams','project_observation_keys']),source_modified:false};
}
async function insertRows(sql:Transaction,name:string,rows:Row[]){
  if(!rows.length)return;
  const allowed=(await sql.query<{column_name:string}>('SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position',[name])).rows.map(r=>r.column_name);
  const columns=allowed.filter(c=>rows.every(row=>Object.hasOwn(row,c)));if(!columns.length)throw new DomainError('rebuild_column_mismatch',409);
  const names=columns.map(identifier).join(',');
  for(let offset=0;offset<rows.length;offset+=500){
    const values=rows.slice(offset,offset+500).map(row=>Object.fromEntries(columns.map(c=>[c,row[c]])));
    await sql.query(`INSERT INTO ${identifier(name)}(${names}) SELECT ${names} FROM jsonb_populate_recordset(NULL::${identifier(name)},$1::jsonb)`,[JSON.stringify(values)]);
  }
}
/** Copies a reviewed allowlist into a separate closed dataset; never clears source. */
export function createDatasetRebuildService(source:Database,target:Database,options:{baselineDate:string;clock?:()=>Date}){
  if(source.schema===target.schema)throw new DomainError('independent_target_required',409);
  const from=baseline(options.baselineDate),now=options.clock??(()=>new Date());
  async function targetIdentity(){const row=(await target.query<{dataset_id:string;collection_enabled:boolean}>('SELECT dataset_id,collection_enabled FROM data_identity')).rows[0];if(!row)throw new DomainError('target_identity_missing',409);return row;}
  async function cleanTarget(sql:Queryable=target){const amounts=await counts(sql,[...basis,...usage,'project_streams','project_observation_keys']);if(!amounts.plugin_releases&&amounts.plugin_release_channels===1){const empty=(await sql.query('SELECT 1 FROM plugin_release_channels WHERE stable_id IS NULL AND pilot_id IS NULL')).rowCount;if(empty===1)amounts.plugin_release_channels=0;}if(Object.values(amounts).some(n=>n>0))throw new DomainError('target_not_clean',409);}
  async function plan():Promise<DatasetRebuildPlan>{
    const data=await snapshot(source),dest=await targetIdentity();await cleanTarget();
    if(dest.collection_enabled)throw new DomainError('target_must_be_closed',409);
    if(data.identity.dataset_id===dest.dataset_id)throw new DomainError('independent_target_required',409);
    const table_columns:Record<string,string[]>={};
    for(const name of basis){const available=(await target.query<{column_name:string}>('SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position',[name])).rows.map(r=>r.column_name);table_columns[name]=available.filter(c=>(data.tables[name]??[]).every(row=>Object.hasOwn(row,c)));}
    const body={version:1 as const,source_schema:source.schema,target_schema:target.schema,source_dataset:String(data.identity.dataset_id),target_dataset:dest.dataset_id,baseline_at:from,source_fingerprint:data.fingerprint,table_counts:Object.fromEntries(basis.map(name=>[name,data.tables[name]?.length??0])),table_columns};
    return {...body,digest:digest(body)};
  }
  async function status(){
    const identity=(await target.query<{dataset_id:string;collection_enabled:boolean;collection_baseline_at:Date|null}>('SELECT dataset_id,collection_enabled,collection_baseline_at FROM data_identity')).rows[0]!;
    const c=await counts(target,[...basis,...usage]);const persons=(await target.query<{registered:number;adopted:number}>('SELECT count(*) FILTER(WHERE registered_at IS NOT NULL)::int AS registered,count(*) FILTER(WHERE adopted_at IS NOT NULL)::int AS adopted FROM users')).rows[0]!;
    const rebuild=(await target.query<{manifest_digest:string;validation_digest:string|null;prepared_at:Date;opened_at:Date|null}>('SELECT manifest_digest,validation_digest,prepared_at,opened_at FROM dataset_rebuild_state')).rows[0];
    return {dataset_id:identity.dataset_id,collection_enabled:identity.collection_enabled,baseline_at:identity.collection_baseline_at?.toISOString()??null,table_counts:Object.fromEntries(basis.map(n=>[n,c[n]??0])),usage_rows:usage.reduce((total,n)=>total+(c[n]??0),0),registered_users:persons.registered,adopted_users:persons.adopted,rebuild:rebuild?{...rebuild,prepared_at:rebuild.prepared_at.toISOString(),opened_at:rebuild.opened_at?.toISOString()??null}:null};
  }
  async function execute(saved:DatasetRebuildPlan,review:DatasetRebuildReview){
    if(!review.source_writers_stopped||!review.network_isolated||!review.backup_and_journal_verified||!review.credential_key_verified)throw new DomainError('rebuild_review_required',409);
    const {digest:hash,...body}=saved;if(hash!==digest(body)||saved.source_schema!==source.schema||saved.target_schema!==target.schema||saved.baseline_at!==from)throw new DomainError('rebuild_plan_mismatch',409);
    const dest=await targetIdentity();if(dest.dataset_id!==saved.target_dataset||dest.collection_enabled)throw new DomainError('target_identity_changed',409);
    const existing=(await target.query<{manifest_digest:string}>('SELECT manifest_digest FROM dataset_rebuild_state')).rows[0];
    if(existing){if(existing.manifest_digest!==hash)throw new DomainError('target_not_clean',409);return status();}
    const data=await snapshot(source);if(data.fingerprint!==saved.source_fingerprint||data.identity.dataset_id!==saved.source_dataset)throw new DomainError('rebuild_source_changed',409);
    await cleanTarget();
    await target.transaction(async sql=>{
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`adi:dataset-rebuild:${target.schema}`]);
      const current=(await sql.query<{dataset_id:string;collection_enabled:boolean}>('SELECT dataset_id,collection_enabled FROM data_identity FOR UPDATE')).rows[0]!;
      if(current.dataset_id!==saved.target_dataset||current.collection_enabled||(await sql.query('SELECT 1 FROM users LIMIT 1')).rowCount||(await sql.query('SELECT 1 FROM dataset_rebuild_state')).rowCount)throw new DomainError('target_not_clean',409);
      await cleanTarget(sql);
      const tables=transformed(data);
      if(await exists(sql,'plugin_release_channels'))await sql.query('DELETE FROM plugin_release_channels');
      for(const name of [...basis,'project_streams','project_observation_keys'])await insertRows(sql,name,tables[name]??[]);
      await sql.query('UPDATE data_identity SET collection_baseline_at=$1,collection_enabled=false,retention_cutoff=$1',[from]);
      await sql.query('INSERT INTO dataset_rebuild_state(singleton,source_dataset_id,manifest_digest,baseline_at) VALUES(true,$1,$2,$3)',[saved.source_dataset,hash,from]);
      if((await snapshot(source)).fingerprint!==saved.source_fingerprint)throw new DomainError('rebuild_source_changed',409);
    });
    return status();
  }
  async function verify(saved:DatasetRebuildPlan){
    const {digest:hash,...body}=saved;if(hash!==digest(body)||saved.source_schema!==source.schema||saved.target_schema!==target.schema||saved.baseline_at!==from)throw new DomainError('rebuild_plan_mismatch',409);
    const sourceData=await snapshot(source);if(sourceData.fingerprint!==saved.source_fingerprint)throw new DomainError('rebuild_source_changed',409);
    const actual=await snapshot(target),expected=transformed(sourceData),current=await status();
    if(actual.identity.dataset_id!==saved.target_dataset||new Date(String(actual.identity.collection_baseline_at)).toISOString()!==from||actual.identity.collection_enabled||actual.identity.recovery_id||current.usage_rows)throw new DomainError('rebuild_validation_failed',409);
    const row=(await target.query<{manifest_digest:string}>('SELECT manifest_digest FROM dataset_rebuild_state')).rows[0];if(row?.manifest_digest!==hash)throw new DomainError('rebuild_plan_mismatch',409);
    const sort=(rows:Row[])=>rows.map(r=>JSON.stringify(Object.fromEntries(Object.keys(r).sort().map(k=>[k,r[k]])))).sort();
    for(const name of [...basis,'project_streams','project_observation_keys']){
      const wanted=expected[name]??[],found=actual.tables[name]??[];
      const columns=name in saved.table_columns?saved.table_columns[name]!:Object.keys(wanted[0]??{});
      const select=(rows:Row[])=>rows.map(r=>Object.fromEntries(columns.map(k=>[k,r[k]])));
      if(digest(sort(select(wanted)))!==digest(sort(select(found))))throw new DomainError('rebuild_validation_failed',409);
    }
    return {...current,validation_digest:digest({dataset:saved.target_dataset,manifest:hash,basis:actual.tables,baseline:from}),external_isolation_verified:false};
  }
  async function open(hash:string,review:{validation_digest:string;validation_completed:boolean}){
    if(!review.validation_completed||!/^[a-f0-9]{64}$/.test(review.validation_digest))throw new DomainError('rebuild_validation_required',409);
    if(now().getTime()<Date.parse(from))throw new DomainError('baseline_not_started',409);
    await target.transaction(async sql=>{
      const row=(await sql.query<{manifest_digest:string;baseline_at:Date}>('SELECT manifest_digest,baseline_at FROM dataset_rebuild_state FOR UPDATE')).rows[0];
      if(!row||row.manifest_digest!==hash||row.baseline_at.toISOString()!==from)throw new DomainError('rebuild_plan_mismatch',409);
      const policy=(await sql.query<{dataset_id:string;collection_enabled:boolean;collection_baseline_at:Date;recovery_id:string|null}>('SELECT dataset_id,collection_enabled,collection_baseline_at,recovery_id FROM data_identity FOR UPDATE')).rows[0]!;
      if(policy.recovery_id)throw new DomainError('recovery_quarantined',409);
      if(policy.collection_enabled||policy.collection_baseline_at.toISOString()!==from)throw new DomainError('rebuild_validation_changed',409);
      const actual=await readSnapshot(sql),validation=digest({dataset:policy.dataset_id,manifest:hash,basis:actual.tables,baseline:from});
      if(validation!==review.validation_digest||Object.values(await counts(sql,usage)).some(n=>n>0))throw new DomainError('rebuild_validation_changed',409);
      await sql.query('UPDATE dataset_rebuild_state SET validation_digest=$1,opened_at=clock_timestamp()',[validation]);
      const updated=await sql.query('UPDATE data_identity SET collection_enabled=true WHERE recovery_id IS NULL AND NOT collection_enabled RETURNING dataset_id');
      if(updated.rowCount!==1)throw new DomainError('rebuild_validation_changed',409);
    });return status();
  }
  return {plan,execute,status,verify,open};
}
