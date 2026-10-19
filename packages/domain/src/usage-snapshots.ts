import {nextUsageCheck} from './usage-recheck.js';
import {markBackfillCoverage} from './usage-backfill.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Database, Transaction } from '@adi/storage';
import type { MemberUsageRequest, ProviderUsageItem, ProviderUsagePage } from './usage-provider.js';
import { DomainError } from './errors.js';
const day = 86400;
const uuid = (value: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function canonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,item]) => [key,canonical(item)])); return value; }
export interface UsageJobCompletion { id: string; leaseToken: string; generation: number; nextAt?: Date; reschedule?: boolean }
export interface UsageDraft { runId: string; leaseToken: string; scopeId: string; parts: { index: number; query: MemberUsageRequest }[] }
type User = { id: string; email_key: string; status: string; ingest_epoch: number; cleanup_generation: number };
type Run = { id: string; scope_id: string; user_id: string; state: string; lease_token: string | null; valid: boolean; captured_email: string; requested_provider_user_id: string | null; observed_provider_user_id: string | null; ingest_epoch: number; cleanup_generation: number; from_second: string; to_second: string; page_size: number; row_count: number; byte_count: number; active_run_id: string | null; business_date: string };
type Part = { part: number; start_second: string; end_second: string; expected_total: number | null; expected_pages: number | null; next_page: number };
/** Internal worker storage seam; it is not an HTTP authorization boundary. */
export function createUsageSnapshotStore(db: Database, options: { providerAccount: string; clock?: () => Date; pageSize?: number; leaseMs?: number; maxRows?: number; maxBytes?: number }) {
  const account = options.providerAccount; const now = options.clock ?? (() => new Date()); const pageSize = options.pageSize ?? 200; const leaseMs = options.leaseMs ?? 30000; const maxRows = options.maxRows ?? 10000; const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(account) || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500 || !Number.isInteger(leaseMs) || leaseMs < 50 || leaseMs > 60000 || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 50000 || !Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 64 * 1024 * 1024) throw new Error('Invalid usage store limits');
  function range(date: string,at=now()) {
    const start = Date.parse(`${date}T00:00:00+08:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(start) || new Date(start + 28800000).toISOString().slice(0,10) !== date) throw new DomainError('invalid_usage_day',422);
    const from = Math.max(start / 1000, Math.ceil((at.getTime() - 365 * day * 1000) / 1000));
    const to = Math.min(start / 1000 + day - 1, Math.floor(at.getTime() / 1000));
    if (from > to) throw new DomainError('invalid_usage_day',422); return { from, to };
  }
  async function policy(client:Transaction){
    const row=(await client.query<{recovery_id:string|null;cutoff:string|null;collection_enabled:boolean}>('SELECT recovery_id,collection_enabled,ceil(extract(epoch FROM GREATEST(retention_cutoff,collection_baseline_at)))::text AS cutoff FROM data_identity FOR SHARE')).rows[0];
    if(!row||row.recovery_id)throw new DomainError('recovery_quarantined',503);
    if(!row.collection_enabled)throw new DomainError('collection_disabled',503);
    return row.cutoff===null?null:Number(row.cutoff);
  }
  async function user(client: Transaction, id: string) {
    const row = (await client.query<User>('SELECT id,email_key,status,ingest_epoch,cleanup_generation FROM users WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if (!row) throw new DomainError('not_found',404); return row;
  }
  async function begin(userId: string, businessDate: string): Promise<UsageDraft> {
    if (!uuid(userId)) throw new DomainError('invalid_request',400); const capturedAt=now();
    return db.transaction(async client => {
      const cutoff=await policy(client),period=range(businessDate,capturedAt);period.from=Math.max(period.from,cutoff??-Infinity);if(period.from>period.to)throw new DomainError('invalid_usage_day',422);
      const owner = await user(client,userId); if (owner.status !== 'active') throw new DomainError('account_inactive',409);
      await client.query('INSERT INTO usage_scopes(id,provider_account,user_id,business_date) VALUES($1,$2,$3,$4) ON CONFLICT(provider_account,user_id,business_date) DO NOTHING',[randomUUID(),account,userId,businessDate]);
      const scope = (await client.query<{id:string;active_run_id:string|null}>('SELECT id,active_run_id FROM usage_scopes WHERE provider_account=$1 AND user_id=$2 AND business_date=$3 FOR UPDATE',[account,userId,businessDate])).rows[0]!;
      if (scope.active_run_id) {
        const active = (await client.query<{state:string;valid:boolean;captured_email:string;ingest_epoch:number;cleanup_generation:number}>("SELECT state,lease_until>clock_timestamp() AS valid,captured_email,ingest_epoch,cleanup_generation FROM usage_snapshot_runs WHERE id=$1 FOR UPDATE",[scope.active_run_id])).rows[0]!;
        if (active.state === 'building' && active.valid && active.captured_email === owner.email_key && active.ingest_epoch === owner.ingest_epoch && active.cleanup_generation === owner.cleanup_generation) throw new DomainError('usage_scope_busy',409);
        await client.query("UPDATE usage_snapshot_runs SET state='abandoned',completed_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE id=$1 AND state='building'",[scope.active_run_id]);
      }
      const providerId = (await client.query<{provider_user_id:string}>('SELECT provider_user_id FROM usage_provider_identities WHERE provider_account=$1 AND user_id=$2',[account,userId])).rows[0]?.provider_user_id ?? null;
      // Round outward in SQL before JS conversion: a cleared microsecond must
      // exclude its whole upstream second rather than leak through truncation.
      const tombstones = (await client.query<{from_second:string;to_second:string}>('SELECT floor(extract(epoch FROM from_at))::text AS from_second,ceil(extract(epoch FROM to_at))::text AS to_second FROM cleanup_tombstones WHERE user_id=$1 AND from_at<to_timestamp($3::double precision+1) AND to_at>to_timestamp($2) ORDER BY from_at,to_at',[userId,period.from,period.to])).rows;
      const windows: {from:number;to:number}[] = []; let cursor = period.from;
      for (const cleared of tombstones) { const from = Math.max(period.from,Number(cleared.from_second)); const to = Math.min(period.to + 1,Number(cleared.to_second)); if (from > cursor) windows.push({from:cursor,to:from-1}); cursor = Math.max(cursor,to); }
      if (cursor <= period.to) windows.push({from:cursor,to:period.to});
      if (windows.length > 64) throw new DomainError('usage_scope_limit',422);
      const runId = randomUUID(); const leaseToken = randomUUID();
      await client.query("INSERT INTO usage_snapshot_runs(id,scope_id,state,lease_token,lease_until,captured_email,requested_provider_user_id,ingest_epoch,cleanup_generation,from_second,to_second,page_size,captured_at) VALUES($1,$2,'building',$3,clock_timestamp()+$4*interval '1 millisecond',$5,$6,$7,$8,$9,$10,$11,$12)",[runId,scope.id,leaseToken,leaseMs,owner.email_key,providerId,owner.ingest_epoch,owner.cleanup_generation,period.from,period.to,pageSize,capturedAt]);
      const parts: UsageDraft['parts'] = [];
      for (const [index,window] of windows.entries()) {
        await client.query('INSERT INTO usage_snapshot_parts(run_id,part,start_second,end_second) VALUES($1,$2,$3,$4)',[runId,index,window.from,window.to]);
        parts.push({index,query:{start_time:window.from,end_time:window.to,...(providerId?{user_ids:[providerId]}:{emails:[owner.email_key]}),page:1,page_size:pageSize}});
      }
      await client.query('UPDATE usage_scopes SET active_run_id=$2 WHERE id=$1',[scope.id,runId]);
      return {runId,leaseToken,scopeId:scope.id,parts};
    });
  }
  async function locked<T>(draft: UsageDraft, action: (client: Transaction,run:Run,owner:User)=>Promise<T>) {
    const runId=draft.runId; const leaseToken=draft.leaseToken;
    if (!uuid(runId) || !uuid(leaseToken)) throw new DomainError('stale_usage_lease',409);
    return db.transaction(async client => {
      const cutoff=await policy(client);
      const target = (await client.query<{user_id:string;scope_id:string}>('SELECT s.user_id,s.id AS scope_id FROM usage_snapshot_runs r JOIN usage_scopes s ON s.id=r.scope_id WHERE r.id=$1 AND s.provider_account=$2',[runId,account])).rows[0];
      if (!target) throw new DomainError('stale_usage_lease',409);
      const owner = await user(client,target.user_id);
      await client.query('SELECT id FROM usage_scopes WHERE id=$1 FOR UPDATE',[target.scope_id]);
      const run = (await client.query<Run>(`SELECT r.*,s.user_id,s.active_run_id,s.business_date::text AS business_date,r.lease_until>clock_timestamp() AS valid FROM usage_snapshot_runs r JOIN usage_scopes s ON s.id=r.scope_id WHERE r.id=$1 FOR UPDATE OF r`,[runId])).rows[0]!;
      if (run.state !== 'building' || run.active_run_id !== run.id || run.lease_token !== leaseToken || !run.valid) throw new DomainError('stale_usage_lease',409);
      if (owner.status !== 'active' || owner.email_key !== run.captured_email || owner.ingest_epoch !== run.ingest_epoch || owner.cleanup_generation !== run.cleanup_generation) throw new DomainError('usage_owner_changed',409);
      range(run.business_date);if(cutoff!==null&&(await client.query('SELECT 1 FROM usage_snapshot_parts WHERE run_id=$1 AND start_second<$2 LIMIT 1',[run.id,cutoff])).rowCount)throw new DomainError('usage_scope_expired',409);
      return action(client,run,owner);
    });
  }
  async function renew(client:Transaction,run:Run) {
    const result = await client.query("UPDATE usage_snapshot_runs SET lease_until=clock_timestamp()+$3*interval '1 millisecond' WHERE id=$1 AND lease_token=$2 AND state='building' AND lease_until>clock_timestamp() RETURNING id",[run.id,run.lease_token,leaseMs]);
    if (!result.rowCount) throw new DomainError('stale_usage_lease',409);
  }
  async function fail(client:Transaction,run:Run,code:string) {
    await client.query("UPDATE usage_snapshot_runs SET state='failed',error_code=$2,lease_token=NULL,lease_until=NULL,completed_at=clock_timestamp() WHERE id=$1",[run.id,code]);
    await client.query('UPDATE usage_scopes SET active_run_id=NULL WHERE id=$1 AND active_run_id=$2',[run.scope_id,run.id]);
    return {error:code};
  }
  async function stage(draft:UsageDraft,partIndex:number,received:ProviderUsagePage) {
    const page=structuredClone(received);
    if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= 64 || !Array.isArray(page.items) || page.items.length > pageSize || !page.pagination || page.query.endpoint !== 'user_usage_detail' || !Number.isFinite(Date.parse(page.observed_at)) || !/^[a-f0-9]{64}$/.test(page.response_hash)) throw new DomainError('usage_page_invalid',422);
    const rows = page.items.map(value=>({value:canonical(value),hash:digest(canonical(value))})); const bytes = Buffer.byteLength(JSON.stringify(rows));
    if (bytes > 8 * 1024 * 1024) throw new DomainError('usage_scope_limit',422);
    const result = await locked(draft,async(client,run)=>{
      const part = (await client.query<Part>('SELECT * FROM usage_snapshot_parts WHERE run_id=$1 AND part=$2 FOR UPDATE',[run.id,partIndex])).rows[0];
      const p = page.pagination!; const parameters = page.query.parameters;
      if (!part || !('start_time' in parameters) || parameters.start_time !== Number(part.start_second) || parameters.end_time !== Number(part.end_second) || parameters.page !== p.page || parameters.page_size !== run.page_size) return fail(client,run,'usage_scope_mismatch');
      const targetMatches = run.requested_provider_user_id ? parameters.user_ids?.length === 1 && parameters.user_ids[0] === run.requested_provider_user_id && !parameters.emails?.length : parameters.emails?.length === 1 && parameters.emails[0] === run.captured_email && !parameters.user_ids?.length;
      if (!targetMatches) return fail(client,run,'usage_scope_mismatch');
      const count = Math.min(run.page_size,Math.max(0,p.total-(p.page-1)*run.page_size)); const pages = Math.max(1,Math.ceil(p.total/run.page_size));
      if (![p.page,p.page_size,p.total,p.total_pages].every(Number.isSafeInteger) || p.page<1 || p.page_size!==run.page_size || p.total<0 || p.page>pages || page.items.length!==count || (p.total?p.total_pages!==pages:![0,1].includes(p.total_pages))) return fail(client,run,'usage_page_invalid');
      if (p.total>maxRows) return fail(client,run,'usage_scope_limit');
      if ((part.expected_total!==null && part.expected_total!==p.total) || (part.expected_pages!==null && part.expected_pages!==pages)) return fail(client,run,'usage_page_changed');
      const fingerprint = digest({query:canonical(parameters),total:p.total,pages,rows:rows.map(row=>row.hash).sort()});
      const prior = (await client.query<{fingerprint:string}>('SELECT fingerprint FROM usage_snapshot_pages WHERE run_id=$1 AND part=$2 AND page=$3',[run.id,partIndex,p.page])).rows[0];
      if (prior) { if (prior.fingerprint!==fingerprint) return fail(client,run,'usage_page_changed'); await renew(client,run); return {next_page:part.next_page>pages?null:part.next_page,staged_rows:run.row_count}; }
      if (part.next_page!==p.page) return fail(client,run,'usage_page_order');
      if (run.row_count+rows.length>maxRows || run.byte_count+bytes>maxBytes) return fail(client,run,'usage_scope_limit');
      let providerId = run.observed_provider_user_id ?? run.requested_provider_user_id;
      const binding = (await client.query<{provider_user_id:string}>('SELECT provider_user_id FROM usage_provider_identities WHERE provider_account=$1 AND user_id=$2',[account,run.user_id])).rows[0]?.provider_user_id;
      for (const value of page.items) {
        if (!value.provider_user_id || (providerId && value.provider_user_id!==providerId) || (binding && value.provider_user_id!==binding) || (!run.requested_provider_user_id && value.email!==run.captured_email) || !value.start_time || !/^\d+$/.test(value.start_time) || BigInt(value.start_time)<BigInt(part.start_second) || BigInt(value.start_time)>BigInt(part.end_second)) return fail(client,run,'usage_identity_or_time_mismatch');
        providerId=value.provider_user_id;
      }
      await client.query('INSERT INTO usage_snapshot_pages(run_id,part,page,query,fingerprint,response_hash,request_id,observed_at,row_count) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[run.id,partIndex,p.page,parameters,fingerprint,page.response_hash,page.request_id,page.observed_at,rows.length]);
      await client.query('INSERT INTO usage_observations(run_id,part,page,item_index,row_hash,value) SELECT $1,$2,$3,(entry.ordinality-1)::integer,entry.value->>\'hash\',entry.value->\'value\' FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS entry(value,ordinality)',[run.id,partIndex,p.page,JSON.stringify(rows)]);
      await client.query('UPDATE usage_snapshot_parts SET expected_total=$3,expected_pages=$4,next_page=next_page+1 WHERE run_id=$1 AND part=$2',[run.id,partIndex,p.total,pages]);
      await client.query('UPDATE usage_snapshot_runs SET observed_provider_user_id=$2,row_count=row_count+$3,byte_count=byte_count+$4 WHERE id=$1',[run.id,providerId,rows.length,bytes]);
      await renew(client,run); return {next_page:p.page>=pages?null:p.page+1,staged_rows:run.row_count+rows.length};
    });
    if ('error' in result) throw new DomainError(result.error,409); return result;
  }
  async function publish(draft:UsageDraft,completion?:UsageJobCompletion) {
    const fence=completion?structuredClone(completion):undefined;
    if(fence&&(!uuid(fence.id)||!uuid(fence.leaseToken)||!Number.isSafeInteger(fence.generation)||fence.generation<1||(fence.nextAt&&!Number.isFinite(fence.nextAt.getTime()))))throw new DomainError('invalid_request',400);
    return locked(draft,async(client,run)=>{
      const incomplete = await client.query('SELECT 1 FROM usage_snapshot_parts WHERE run_id=$1 AND (expected_pages IS NULL OR next_page<=expected_pages) LIMIT 1',[run.id]);
      if (incomplete.rowCount) throw new DomainError('usage_scope_incomplete',409);
      const hashes = (await client.query<{row_hash:string;start_second:string;end_second:string}>('SELECT o.row_hash,p.start_second,p.end_second FROM usage_observations o JOIN usage_snapshot_parts p ON p.run_id=o.run_id AND p.part=o.part WHERE o.run_id=$1 ORDER BY p.start_second,p.end_second,o.row_hash COLLATE "C"',[run.id])).rows;
      if (hashes.length!==run.row_count) throw new DomainError('usage_scope_incomplete',409);
      const windows=(await client.query<{start_second:string;end_second:string}>('SELECT start_second,end_second FROM usage_snapshot_parts WHERE run_id=$1 ORDER BY start_second,end_second',[run.id])).rows;
      const hash='scope-v2:'+digest({windows,rows:hashes});
      const recordsHash=digest(hashes.map(row=>row.row_hash).sort());
      const scope = (await client.query<{published_run_id:string|null;revision:number;content_hash:string|null;records_hash:string|null;last_content_change_at:Date|null}>('SELECT s.published_run_id,s.revision,r.content_hash,s.records_hash,s.last_content_change_at FROM usage_scopes s LEFT JOIN usage_snapshot_runs r ON r.id=s.published_run_id WHERE s.id=$1',[run.scope_id])).rows[0]!;
      if (run.observed_provider_user_id) {
        await client.query('INSERT INTO usage_provider_identities(provider_account,user_id,provider_user_id,verified_email) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[account,run.user_id,run.observed_provider_user_id,run.captured_email]);
        const binding = (await client.query<{provider_user_id:string}>('SELECT provider_user_id FROM usage_provider_identities WHERE provider_account=$1 AND user_id=$2',[account,run.user_id])).rows[0];
        if (binding?.provider_user_id!==run.observed_provider_user_id) throw new DomainError('usage_identity_conflict',409);
      }
      await client.query(`INSERT INTO usage_department_catalog(provider_account,external_department_id,name,full_path,last_observed_at)
        SELECT DISTINCT ON(department->>'id') $2,department->>'id',COALESCE(department->>'name',''),COALESCE(department->>'full_path',''),p.observed_at
        FROM usage_observations o JOIN usage_snapshot_pages p ON p.run_id=o.run_id AND p.part=o.part AND p.page=o.page
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(o.value->'departments')='array' THEN o.value->'departments' ELSE '[]'::jsonb END) department
        WHERE o.run_id=$1 ORDER BY department->>'id',p.observed_at DESC
        ON CONFLICT(provider_account,external_department_id) DO UPDATE SET name=excluded.name,full_path=excluded.full_path,last_observed_at=excluded.last_observed_at WHERE excluded.last_observed_at>=usage_department_catalog.last_observed_at`,[run.id,account]);
      const changed=scope.content_hash!==hash; const dataRun=changed?run.id:scope.published_run_id!;
      // Learn a pre-upgrade scope lazily from its published rows. A missing new
      // fingerprint is not itself evidence of an actual record change.
      let previousRecordsHash=scope.records_hash;
      if(previousRecordsHash===null&&scope.published_run_id){
        const previous=(await client.query<{row_hash:string}>('SELECT row_hash FROM usage_observations WHERE run_id=$1',[scope.published_run_id])).rows;
        previousRecordsHash=digest(previous.map(row=>row.row_hash).sort());
      }
      const publishedAt=now();const recordsChanged=previousRecordsHash!==recordsHash&&(previousRecordsHash!==null||run.row_count>0);
      const contentChangedAt=recordsChanged?publishedAt:scope.last_content_change_at;
      if (changed && scope.published_run_id) await client.query("UPDATE usage_snapshot_runs SET state='superseded' WHERE id=$1",[scope.published_run_id]);
      await client.query('UPDATE usage_snapshot_runs SET state=$2,content_hash=$3,data_run_id=$4 WHERE id=$1',[run.id,changed?'published':'unchanged',hash,dataRun]);
      await client.query('UPDATE usage_scopes SET active_run_id=NULL,published_run_id=$2,verified_run_id=$3,revision=revision+$4,last_verified_at=clock_timestamp(),records_hash=$5,last_content_change_at=$6 WHERE id=$1',[run.scope_id,dataRun,run.id,changed?1:0,recordsHash,contentChangedAt]);
      const fenced=await client.query('UPDATE usage_snapshot_runs SET lease_token=NULL,lease_until=NULL,completed_at=clock_timestamp() WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp() RETURNING id',[run.id,run.lease_token]);
      if (!fenced.rowCount) throw new DomainError('stale_usage_lease',409);
      if(fence){
        const nextAt=fence.reschedule?await nextUsageCheck(client,{userId:run.user_id,businessDate:run.business_date,runId:dataRun,contentChangedAt},publishedAt):fence.nextAt;
        const finished=await client.query(`UPDATE jobs SET status='succeeded',progress=jsonb_build_object('phase','idle','revision',$4::integer,'row_count',$5::integer,'last_success_at',clock_timestamp(),'checked_at',$10::timestamptz),attempt=0,error_code=NULL,lease_token=NULL,lease_until=NULL,available_at=COALESCE($6::timestamptz,clock_timestamp())
          WHERE id=$1 AND lease_token=$2 AND generation=$3 AND status='running' AND lease_until>clock_timestamp()
            AND kind='usage_sync' AND payload->>'provider_account'=$7 AND payload->>'user_id'=$8 AND payload->>'business_date'=$9 RETURNING id`,[fence.id,fence.leaseToken,fence.generation,scope.revision+(changed?1:0),run.row_count,nextAt??null,account,run.user_id,run.business_date,publishedAt]);
        if(!finished.rowCount)throw new DomainError('stale_usage_job',409);
      }
      await markBackfillCoverage(client,account,run.user_id);
      return {changed,revision:scope.revision+(changed?1:0),row_count:run.row_count,scope_id:run.scope_id};
    });
  }
  async function readCurrent(userId:string,businessDate:string,input:{limit?:number;offset?:number;revision?:number}={}) {
    if (!uuid(userId)) throw new DomainError('invalid_request',400); const period=range(businessDate); const limit=input.limit??100; const offset=input.offset??0; const revision=input.revision;
    if (!Number.isInteger(limit)||limit<1||limit>500||!Number.isInteger(offset)||offset<0||offset>50000||(offset>0&&revision===undefined)||(revision!==undefined&&(!Number.isInteger(revision)||revision<1))) throw new DomainError('invalid_request',400);
    const appliedCutoff=await policy(db);
    const owner=(await db.query<{cleanup_generation:number}>('SELECT cleanup_generation FROM users WHERE id=$1',[userId])).rows[0]; if(!owner)throw new DomainError('not_found',404);
    const row=(await db.query<{published_run_id:string|null;verified_run_id:string|null;revision:number;row_count:number;from_second:string;to_second:string;invalidated:boolean;last_verified_at:Date|null;provenance_valid:boolean;captured_at:Date|null}>(`SELECT s.published_run_id,s.verified_run_id,s.revision,v.row_count,v.from_second,v.to_second,v.captured_at,s.last_verified_at,(v.content_hash LIKE 'scope-v2:%' AND d.content_hash LIKE 'scope-v2:%') AS provenance_valid,
      EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=s.user_id AND t.generation>v.cleanup_generation AND t.from_at<to_timestamp(v.to_second+1) AND t.to_at>to_timestamp(v.from_second)) AS invalidated
      FROM usage_scopes s LEFT JOIN usage_snapshot_runs v ON v.id=s.verified_run_id LEFT JOIN usage_snapshot_runs d ON d.id=s.published_run_id WHERE s.provider_account=$1 AND s.user_id=$2 AND s.business_date=$3`,[account,userId,businessDate])).rows[0];
    if(!row?.published_run_id||!row.verified_run_id)return {status:'missing' as const,items:[] as ProviderUsageItem[],revision:0,run_id:null,next_offset:null,total:0,coverage:null};
    if(!row.provenance_valid||row.invalidated)return {status:'invalidated' as const,items:[] as ProviderUsageItem[],revision:row.revision,run_id:null,next_offset:null,total:0,coverage:null};
    const windows=(await db.query<{start_second:string;end_second:string}>('SELECT start_second::text,end_second::text FROM usage_snapshot_parts WHERE run_id=$1 ORDER BY part',[row.verified_run_id])).rows;
    if(appliedCutoff!==null&&windows.some(window=>Number(window.start_second)<appliedCutoff))return {status:'invalidated' as const,items:[] as ProviderUsageItem[],revision:row.revision,run_id:null,next_offset:null,total:0,coverage:null};
    if(revision!==undefined&&revision!==row.revision)throw new DomainError('content_changed',409);
    const items=(await db.query<{value:ProviderUsageItem}>('SELECT value FROM usage_observations WHERE run_id=$1 ORDER BY part,page,item_index LIMIT $2 OFFSET $3',[row.published_run_id,limit,offset])).rows.map(row=>row.value);
    if((await db.query<{cleanup_generation:number}>('SELECT cleanup_generation FROM users WHERE id=$1',[userId])).rows[0]?.cleanup_generation!==owner.cleanup_generation)throw new DomainError('content_changed',409);
    const current=(await db.query<{revision:number;published_run_id:string|null;verified_run_id:string|null}>('SELECT revision,published_run_id,verified_run_id FROM usage_scopes WHERE provider_account=$1 AND user_id=$2 AND business_date=$3',[account,userId,businessDate])).rows[0];
    const latestCutoff=await policy(db);if(!current||current.revision!==row.revision||current.published_run_id!==row.published_run_id||current.verified_run_id!==row.verified_run_id||(latestCutoff!==null&&windows.some(window=>Number(window.start_second)<latestCutoff)))throw new DomainError('content_changed',409);
    const fullStart=Date.parse(`${businessDate}T00:00:00+08:00`)/1000,queriedSeconds=windows.reduce((sum,window)=>sum+Number(window.end_second)-Number(window.start_second)+1,0);
    const coverage={from_second:Number(row.from_second),to_second:Number(row.to_second),captured_at:row.captured_at?.toISOString()??null,queried_seconds:queriedSeconds,windows:windows.map(window=>({from_second:Number(window.start_second),to_second:Number(window.end_second)})),complete_business_day:Number(row.from_second)===fullStart&&Number(row.to_second)===fullStart+day-1&&queriedSeconds===day};
    const status=windows.some(window=>Number(window.start_second)<period.from)?'boundary_snapshot' as const:'ready' as const;
    return {status,coverage,items,revision:row.revision,run_id:row.published_run_id,verified_run_id:row.verified_run_id,last_verified_at:row.last_verified_at?.toISOString()??null,total:row.row_count,next_offset:offset+items.length<row.row_count?offset+items.length:null};
  }
  async function abort(draft:UsageDraft,reason='cancelled') {
    const runId=draft.runId;const token=draft.leaseToken;
    const reasons=['cancelled','provider_timeout','provider_unavailable','provider_auth_failed','provider_rejected','provider_rate_limited','provider_response_limit','invalid_provider_response','invalid_provider_query','invalid_provider_config'];
    if(!uuid(runId)||!uuid(token)||!reasons.includes(reason))throw new DomainError('invalid_request',400);
    return db.transaction(async client=>{
      const target=(await client.query<{user_id:string;scope_id:string}>('SELECT s.user_id,s.id AS scope_id FROM usage_snapshot_runs r JOIN usage_scopes s ON s.id=r.scope_id WHERE r.id=$1 AND s.provider_account=$2',[runId,account])).rows[0];
      if(!target)return false;await user(client,target.user_id);await client.query('SELECT id FROM usage_scopes WHERE id=$1 FOR UPDATE',[target.scope_id]);
      const stopped=await client.query("UPDATE usage_snapshot_runs SET state='abandoned',error_code=$3,lease_token=NULL,lease_until=NULL,completed_at=clock_timestamp() WHERE id=$1 AND lease_token=$2 AND state='building' RETURNING id",[runId,token,reason]);
      if(!stopped.rowCount)return false;
      await client.query('UPDATE usage_scopes SET active_run_id=NULL WHERE id=$1 AND active_run_id=$2',[target.scope_id,runId]);return true;
    });
  }
  async function pruneTransient(limit=100) {
    if(!Number.isInteger(limit)||limit<1||limit>500)throw new DomainError('invalid_request',400);
    const result=await db.transaction(client=>client.query(`WITH victims AS (
      SELECT o.run_id,o.part,o.page,o.item_index FROM usage_observations o JOIN usage_snapshot_runs r ON r.id=o.run_id JOIN usage_scopes s ON s.id=r.scope_id
      WHERE s.provider_account=$1 AND r.state IN('unchanged','failed','abandoned') AND s.published_run_id IS DISTINCT FROM r.id
      ORDER BY r.completed_at,o.run_id,o.part,o.page,o.item_index FOR UPDATE OF o SKIP LOCKED LIMIT $2
    ) DELETE FROM usage_observations o USING victims v WHERE o.run_id=v.run_id AND o.part=v.part AND o.page=v.page AND o.item_index=v.item_index RETURNING o.item_index`,[account,limit]));
    return result.rowCount??0;
  }
  const heartbeat=(draft:UsageDraft)=>locked(draft,async(client,run)=>{await renew(client,run);});
  return {begin,stage,publish,readCurrent,abort,pruneTransient,heartbeat};
}
