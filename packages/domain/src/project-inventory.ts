import type {Database} from '@adi/storage';
import {normalizeRepositoryAddresses,type ProjectObservation} from '@adi/contracts';
import type {IdentityService} from './identity.js';
import {DomainError} from './errors.js';
import {createPageCursor,cursorScope} from './page-cursor.js';
import {recentPeriod} from './recent-period.js';
import {createRepositoryClassifier,type RepositoryRule} from './project-repositories.js';
type Evidence={workspace:string;platform:'macos'|'windows'|'linux';git_root:string|null;reason:string|null;remotes:ProjectObservation['remotes']};
type Observation={id:string;hook_session_id:string|null;state:string;sequence:string;observed_at:string;evidence:Evidence};
type ProjectRow={id:string;user_id:string;name:string;email:string;account_status:string;department_id:string|null;department_name:string|null;collector_id:string;latest:Observation|null;confirmed:Observation|null;display:Evidence|null;retained_observations:number;session_count:number;last_hook_at:string|null};
const visible=`o.source_kind='hook' AND o.observed_at>=GREATEST($1::timestamptz,COALESCE(d.retention_cutoff,'-infinity'::timestamptz),COALESCE(d.collection_baseline_at,'-infinity'::timestamptz))
 AND o.source_event_at>=GREATEST($1::timestamptz,COALESCE(d.retention_cutoff,'-infinity'::timestamptz),COALESCE(d.collection_baseline_at,'-infinity'::timestamptz))
 AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=o.user_id AND ((t.from_at<=o.observed_at AND t.to_at>o.observed_at) OR (t.from_at<=o.source_event_at AND t.to_at>o.source_event_at)))`;
export function createProjectInventoryService(db:Database,identity:IdentityService,options:{clock?:()=>Date}={}){
  const now=options.clock??(()=>new Date()),cursors=createPageCursor(now);
  async function revision(){
    return (await db.query<{epoch:string;rules:string}>(`SELECT concat(dataset_id,':',retention_cutoff,':',collection_baseline_at,':',collection_enabled,':',
      (SELECT md5(COALESCE(string_agg(id::text||':'||cleanup_generation::text,',' ORDER BY id),'')) FROM users)) AS epoch,
      (SELECT md5(COALESCE(string_agg(id::text||':'||version::text,',' ORDER BY id),'')) FROM repository_allowlist) AS rules FROM data_identity`)).rows[0]!;
  }
  async function list(token:string,input:{department_id?:string;search?:string;limit?:number;cursor?:string;from?:string;to?:string}={}){
    const actor=await identity.requireUser(token);if(!actor.roles.includes('super'))throw new DomainError('forbidden',403);
    const at=now(),cutoff=new Date(at.getTime()-365*86400000),department=input.department_id?.toLowerCase()??null;
    if(department&&(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(department)||!(await db.query('SELECT 1 FROM departments WHERE id=$1 AND deleted_at IS NULL',[department])).rowCount))throw new DomainError('invalid_scope',422);
    const limit=input.limit??20,search=input.search?.trim()??'';
    if(!Number.isInteger(limit)||limit<1||limit>100||search.length>128)throw new DomainError('invalid_request',400);
    const before=await revision(),binding=cursorScope(['project-inventory',actor.user_id,department,search,limit,before.epoch]);
    const after=input.cursor?cursors.decode(input.cursor,binding):null;
    if(after&&(typeof after.id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(after.id)))throw new DomainError('invalid_cursor',400);
    const pattern=`%${search.replace(/[\\%_]/g,value=>`\\${value}`)}%`;
    const {page,rules}=await db.transaction(async sql=>{
      await sql.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      // This bounded interactive read must not pay JIT startup for inflated plan estimates.
      await sql.query('SET LOCAL jit=off');
      const page=(await sql.query<{total:number;pending_hooks:number;items:ProjectRow[]}>(`WITH eligible AS MATERIALIZED (SELECT s.id,s.user_id,u.display_name AS name,u.email_key AS email,u.status AS account_status,s.collector_id,m.department_id,m.department_name,
      l.observation AS latest,c.observation AS confirmed,COALESCE(COALESCE(l.observation,c.observation,h.observation)->'evidence',z.evidence) AS display,h.count AS retained_observations
      FROM project_streams s JOIN users u ON u.id=s.user_id CROSS JOIN data_identity d
      LEFT JOIN LATERAL(SELECT p.department_id,x.name AS department_name FROM membership_periods p JOIN departments x ON x.id=p.department_id AND x.deleted_at IS NULL WHERE p.user_id=s.user_id AND tstzrange(p.valid_from,p.valid_to,'[)') @> $2::timestamptz LIMIT 1) m ON true
      LEFT JOIN LATERAL(SELECT jsonb_build_object('id',o.id,'hook_session_id',(SELECT x.source_session_id FROM sessions x WHERE x.id=o.source_session_id AND x.user_id=o.user_id),'state',o.state,'sequence',o.sequence::text,'observed_at',o.observed_at,'evidence',o.evidence) AS observation FROM project_observations o WHERE o.project_id=s.id AND o.sequence=s.latest_sequence AND ${visible}) l ON true
      LEFT JOIN LATERAL(SELECT jsonb_build_object('id',o.id,'hook_session_id',(SELECT x.source_session_id FROM sessions x WHERE x.id=o.source_session_id AND x.user_id=o.user_id),'state',o.state,'sequence',o.sequence::text,'observed_at',o.observed_at,'evidence',o.evidence) AS observation FROM project_observations o WHERE o.project_id=s.id AND o.sequence=s.confirmed_sequence AND ${visible}) c ON true
      LEFT JOIN LATERAL(SELECT
        (SELECT jsonb_build_object('id',o.id,'state',o.state,'sequence',o.sequence::text,'observed_at',o.observed_at,'evidence',o.evidence) FROM project_observations o WHERE o.project_id=s.id AND ${visible} ORDER BY o.sequence DESC LIMIT 1) AS observation,
        (SELECT count(*)::int FROM project_observations o WHERE o.project_id=s.id AND ${visible}) AS count)h ON true
      LEFT JOIN LATERAL(SELECT jsonb_build_object('workspace',k.workspace,'platform',k.platform,'git_root',NULL,'reason','project_observation_unavailable','remotes','[]'::jsonb) AS evidence
        FROM project_hook_links k JOIN hook_events e ON e.id=k.event_id AND e.occurred_at=k.occurred_at AND e.user_id=k.user_id
        WHERE k.project_id=s.id AND k.workspace IS NOT NULL AND k.occurred_at>=GREATEST($1::timestamptz,COALESCE(d.retention_cutoff,'-infinity'),COALESCE(d.collection_baseline_at,'-infinity'))
        AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=k.user_id AND t.from_at<=k.occurred_at AND t.to_at>k.occurred_at) ORDER BY k.occurred_at DESC,k.event_id DESC LIMIT 1)z ON true
      WHERE s.source_kind='hook' AND (h.count>0 OR z.evidence IS NOT NULL) AND ($3::uuid IS NULL OR m.department_id=$3)
      AND ($4='' OR u.display_name ILIKE $5 OR u.email_key ILIKE $5 OR (COALESCE(COALESCE(l.observation,c.observation,h.observation)->'evidence',z.evidence)->>'workspace') ILIKE $5
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(c.observation->'evidence'->'remotes','[]'::jsonb)) r WHERE r->>'address' ILIKE $5)))
        SELECT (SELECT count(*)::int FROM eligible) AS total,
          (SELECT count(*)::int FROM project_hook_links h JOIN hook_events e ON e.id=h.event_id AND e.occurred_at=h.occurred_at AND e.user_id=h.user_id CROSS JOIN data_identity d
           WHERE h.project_id IS NULL AND h.occurred_at>=GREATEST($1::timestamptz,COALESCE(d.retention_cutoff,'-infinity'::timestamptz))
           AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=h.user_id AND t.from_at<=h.occurred_at AND t.to_at>h.occurred_at)
           AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM membership_periods m WHERE m.user_id=h.user_id AND m.department_id=$3 AND tstzrange(m.valid_from,m.valid_to,'[)') @> $2::timestamptz))) AS pending_hooks,COALESCE((SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('session_count',COALESCE(a.session_count,0),'last_hook_at',a.last_hook_at) ORDER BY p.id)
          FROM (SELECT * FROM eligible WHERE ($6::uuid IS NULL OR id>$6) ORDER BY id LIMIT $7) p CROSS JOIN data_identity d
      LEFT JOIN LATERAL(SELECT count(DISTINCT k.session_id)::int AS session_count,max(k.occurred_at) AS last_hook_at FROM project_hook_links k
        JOIN hook_events e ON e.id=k.event_id AND e.occurred_at=k.occurred_at AND e.user_id=k.user_id
        WHERE k.project_id=p.id AND k.occurred_at>=GREATEST($1::timestamptz,COALESCE(d.retention_cutoff,'-infinity'::timestamptz))
        AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=k.user_id AND t.from_at<=k.occurred_at AND t.to_at>k.occurred_at)) a ON true
),'[]'::jsonb) AS items`,[cutoff,at,department,search,pattern,after?.id??null,limit+1])).rows[0]!;
      const rules=(await sql.query<RepositoryRule>('SELECT kind,value FROM repository_allowlist')).rows;
      return {page,rules};
    });
    if(!(await identity.requireUser(token)).roles.includes('super'))throw new DomainError('forbidden',403);
    const current=await revision();if(current.epoch!==before.epoch||current.rules!==before.rules)throw new DomainError('content_changed',409);
    if(after&&!page.items.length)throw new DomainError('invalid_cursor',400);
    const rows=page.items.slice(0,limit),last=rows.at(-1),classify=createRepositoryClassifier(rules);
    return {as_of:at.toISOString(),pending_hooks:page.pending_hooks,total:page.total,next_cursor:page.items.length>limit&&last?cursors.encode(binding,{id:last.id}):null,items:rows.map(row=>{
      const evidence=row.display!;
      return {id:row.id,user_id:row.user_id,name:row.name,email:row.email,account_status:row.account_status,department_id:row.department_id,department_name:row.department_name,collector_id:row.collector_id,workspace:evidence.workspace,platform:evidence.platform,
        observation_id:row.latest?.id??null,source_hook_session_id:row.latest?.hook_session_id??null,confirmed_source_hook_session_id:row.confirmed?.hook_session_id??null,state:row.latest?.state??'unknown',reason:row.latest?.evidence.reason??(row.latest?null:'current_evidence_unavailable'),observed_at:row.latest?new Date(row.latest.observed_at).toISOString():null,
        confirmed_at:row.confirmed?new Date(row.confirmed.observed_at).toISOString():null,confirmed_state:row.confirmed?.state??null,unconfirmed:!row.latest||row.latest.sequence!==row.confirmed?.sequence,
        git_root:row.confirmed?.evidence.git_root??null,remotes:normalizeRepositoryAddresses(row.confirmed?.state==='repository'?row.confirmed.evidence.remotes:[]).map(remote=>({...remote,...classify(remote.address??'')})),
        current_available:row.latest!==null,history_only:row.latest===null&&row.confirmed===null,retained_observations:row.retained_observations,session_count:row.session_count,last_hook_at:row.last_hook_at?new Date(row.last_hook_at).toISOString():null};
    })};
  }
  async function sessions(token:string,id:string,input:{department_id?:string;limit?:number;cursor?:string}={}){
    const actor=await identity.requireUser(token);if(!actor.roles.includes('super'))throw new DomainError('forbidden',403);
    if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new DomainError('not_found',404);
    const at=now(),cutoff=new Date(at.getTime()-365*86400000),department=input.department_id?.toLowerCase()??null,limit=input.limit??20;
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new DomainError('invalid_request',400);
    if(department&&(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(department)||!(await db.query('SELECT 1 FROM departments WHERE id=$1 AND deleted_at IS NULL',[department])).rowCount))throw new DomainError('invalid_scope',422);
    const before=await revision(),binding=cursorScope(['project-sessions',actor.user_id,id,department,limit,before.epoch]);
    const after=input.cursor?cursors.decode(input.cursor,binding):null;
    if(after&&(typeof after.id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(after.id)))throw new DomainError('invalid_cursor',400);
    const period=recentPeriod({},at,45);
    const page=await db.transaction(async sql=>{
      await sql.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await sql.query('SET LOCAL jit=off');
      const project=(await sql.query<{user_id:string}>(`SELECT s.user_id FROM project_streams s CROSS JOIN data_identity d
        WHERE s.id=$4 AND s.source_kind='hook' AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM membership_periods m WHERE m.user_id=s.user_id AND m.department_id=$3 AND tstzrange(m.valid_from,m.valid_to,'[)') @> $2::timestamptz))
        AND (EXISTS(SELECT 1 FROM project_observations o WHERE o.project_id=s.id AND ${visible}) OR EXISTS(SELECT 1 FROM project_hook_links k JOIN hook_events e ON e.id=k.event_id AND e.occurred_at=k.occurred_at AND e.user_id=k.user_id WHERE k.project_id=s.id AND k.occurred_at>=GREATEST($1::timestamptz,COALESCE(d.retention_cutoff,'-infinity'),COALESCE(d.collection_baseline_at,'-infinity')) AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=k.user_id AND t.from_at<=k.occurred_at AND t.to_at>k.occurred_at)))`,[cutoff,at,department,id])).rows[0];
      if(!project)throw new DomainError('not_found',404);
      return (await sql.query<{total:number;items:Array<{session_id:string;hook_session_id:string;first_hook_at:string;last_hook_at:string;last_session_at:string;hook_events:number;readable:boolean}>}>(`WITH linked AS MATERIALIZED (
        SELECT k.session_id,s.source_session_id AS hook_session_id,min(k.occurred_at) AS first_hook_at,max(k.occurred_at) AS last_hook_at,s.last_at AS last_session_at,count(*)::int AS hook_events
        FROM project_hook_links k JOIN sessions s ON s.id=k.session_id AND s.user_id=k.user_id JOIN hook_events e ON e.id=k.event_id AND e.occurred_at=k.occurred_at AND e.user_id=k.user_id CROSS JOIN data_identity d
        WHERE k.project_id=$1 AND k.user_id=$2 AND k.occurred_at>=GREATEST($3::timestamptz,COALESCE(d.retention_cutoff,'-infinity'::timestamptz))
        AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=k.user_id AND t.from_at<=k.occurred_at AND t.to_at>k.occurred_at)
        GROUP BY k.session_id,s.source_session_id,s.last_at)
        SELECT (SELECT count(*)::int FROM linked) AS total,COALESCE((SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object('readable',EXISTS(
          SELECT 1 FROM hook_events e CROSS JOIN data_identity d WHERE e.session_id=p.session_id AND e.user_id=$2 AND e.occurred_at>=GREATEST($6::timestamptz,COALESCE(d.retention_cutoff,'-infinity'::timestamptz)) AND e.occurred_at<$7::timestamptz
          AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at))) ORDER BY p.session_id)
          FROM (SELECT * FROM linked WHERE ($4::uuid IS NULL OR session_id>$4) ORDER BY session_id LIMIT $5) p),'[]'::jsonb) AS items`,[id,project.user_id,cutoff,after?.id??null,limit+1,period.from,period.to])).rows[0]!;
    });
    if(!(await identity.requireUser(token)).roles.includes('super'))throw new DomainError('forbidden',403);
    if((await revision()).epoch!==before.epoch)throw new DomainError('content_changed',409);
    if(after&&!page.items.length)throw new DomainError('invalid_cursor',400);
    const shown=page.items.slice(0,limit),last=shown.at(-1);
    return {project_id:id,as_of:at.toISOString(),total:page.total,next_cursor:page.items.length>limit&&last?cursors.encode(binding,{id:last.session_id}):null,
      items:shown.map(({last_session_at,...row})=>({...row,first_hook_at:new Date(row.first_hook_at).toISOString(),last_hook_at:new Date(row.last_hook_at).toISOString(),
        unavailable_reason:row.readable?null:Date.parse(last_session_at)<Date.parse(period.from)?'outside_recent_window' as const:'content_unavailable' as const}))};
  }
  return {list,sessions};
}
export type ProjectInventoryService=ReturnType<typeof createProjectInventoryService>;
