import {normalizeRepositoryAddresses,type PluginObservation,type PluginQuery,type PluginLinkedUser,type PluginProjectDelete,type PluginRecord,type PluginProject} from '@adi/contracts';
import type {Database,Transaction,Queryable} from './index.js';
import {normalizeProjectPath} from './project-path.js';
import {persistProjectObservation} from './project-observation-store.js';

type Query=PluginQuery&{project_id?:string;user_id?:string};
const uuid=(value:string)=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const failure=(code:string,status=400)=>Object.assign(new Error(code),{code,status});
const visible=`o.source_kind='plugin' AND o.observed_at>=COALESCE(d.collection_baseline_at,'-infinity'::timestamptz)
  AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=o.user_id AND t.from_at<=o.observed_at AND t.to_at>o.observed_at)`;
const record=`jsonb_build_object('observation_id',o.id,'collector_id',o.collector_id,'sequence',o.sequence::text,
  'nt_email',u.email_key,'source_config_id',o.source_config_id,'platform',o.evidence->>'platform',
  'workspace_path',o.evidence->>'workspace','workspace_key',s.workspace_key,'observed_at',o.observed_at,'received_at',o.received_at,
  'state',o.state,'reason',o.evidence->'reason','git_root',o.evidence->'git_root','remotes',o.evidence->'remotes','plugin_version',o.plugin_version)`;
function view(value:Record<string,unknown>){
  const result:Record<string,unknown>&{remotes:ReturnType<typeof normalizeRepositoryAddresses>}={...value,remotes:normalizeRepositoryAddresses(value.remotes as PluginObservation['remotes'])};
  for(const name of ['observed_at','received_at'] as const)result[name]=new Date(result[name] as string|Date).toISOString();
  return result as PluginRecord;
}
export function createPluginObservationStore(db:Database){
  async function revision(sql:Queryable=db){return (await sql.query<{value:string}>(`SELECT concat_ws(':',dataset_id,collection_baseline_at,collection_enabled,recovery_id,
    (SELECT md5(COALESCE(string_agg(concat(id,':',cleanup_generation,':',version),',' ORDER BY id),'')) FROM users),
    (SELECT md5(COALESCE(string_agg(concat(id,':',version),',' ORDER BY id),'')) FROM repository_allowlist)) AS value FROM data_identity`)).rows[0]!.value;}
  async function departmentScope(input:Query){
    const department=input.department_id?.toLowerCase()??null;
    if(department&&(!uuid(department)||!(await db.query('SELECT 1 FROM departments WHERE id=$1 AND deleted_at IS NULL',[department])).rowCount))throw failure('invalid_scope',422);
    if(input.project_id&&!uuid(input.project_id)||input.user_id&&!uuid(input.user_id))throw failure('invalid_request');
    return department;
  }
  return {
    async removeProject(_input:PluginProjectDelete,_sql:Transaction):Promise<{deleted_observations:number}>{throw failure('plugin_project_delete_retired',410);},
    async save(input:PluginObservation,context:{userId:string;receivedAt?:Date}){
      if(!context||!uuid(context.userId))throw failure('plugin_unauthorized',401);
      if(!/^[1-9][0-9]{0,18}$/.test(input.sequence)||BigInt(input.sequence)>9223372036854775807n||!normalizeProjectPath(input.workspace_path,input.platform))throw failure('invalid_request');
      if(['repository','no_remote'].includes(input.state)){
        if(!normalizeProjectPath(input.git_root,input.platform)||input.reason!==null||input.state==='repository'&&!input.remotes.length||input.state==='no_remote'&&input.remotes.length)throw failure('invalid_request');
      }else if(input.git_root!==null||input.remotes.length||input.state==='not_git'&&input.reason!==null||['failed','unknown'].includes(input.state)&&input.reason===null)throw failure('invalid_request');
      return db.transaction(async sql=>{
        const user=(await sql.query<{status:string;registered_at:Date|null;cleanup_generation:number;email_key:string}>('SELECT status,registered_at,cleanup_generation,email_key FROM users WHERE id=$1 FOR UPDATE',[context.userId])).rows[0];
        if(!user||user.status!=='active'||!user.registered_at)throw failure('plugin_unauthorized',401);
        const result=await persistProjectObservation(sql,{collector_id:input.collector_id,platform:input.platform,workspace:input.workspace_path,observation:{id:input.observation_id,sequence:input.sequence,observed_at:input.observed_at,state:input.state,reason:input.reason,git_root:input.git_root,remotes:input.remotes}},
          {userId:context.userId,sourceKind:'plugin',receivedAt:context.receivedAt??new Date(),cleanupGeneration:user.cleanup_generation,sourceConfigId:input.source_config_id,pluginVersion:input.plugin_version});
        if(result.outcome==='conflict')throw failure('plugin_conflict',409);
        if(['invalid','expired','cleared','superseded'].includes(result.outcome))throw failure(`project_${result.outcome}`,409);
        return {outcome:result.outcome==='accepted'?'saved' as const:'duplicate' as const,observation_id:input.observation_id,received_at:result.receivedAt,cleanup_generation:user.cleanup_generation,state_changed:result.stateChanged};
      });
    },
    async projects(input:Query={}){
      const page=input.page??1,limit=input.limit??20,search=input.search?.trim()??'',department=await departmentScope(input),before=await revision();
      const values=[input.nt_email?.trim().toLowerCase()??null,input.collector_id??null,input.from??null,input.to??null,`%${search.replace(/[\\%_]/g,c=>'\\'+c)}%`,limit,(page-1)*limit,department,input.project_id??null,input.user_id??null];
      const result=(await db.query<{total:number;items:Record<string,unknown>[]}>(`WITH selected AS (
        SELECT s.id AS project_id,s.user_id,u.email_key AS nt_email,s.collector_id,s.workspace_key,h.observation AS history,
          l.observation AS latest,c.observation AS confirmed,n.count AS retained_observations,
          jsonb_build_object('user_id',u.id,'name',u.display_name,'email',u.email_key,'account_status',u.status,'department_id',m.department_id,'department_name',m.department_name) AS linked_user
        FROM project_streams s JOIN users u ON u.id=s.user_id CROSS JOIN data_identity d
        LEFT JOIN LATERAL(SELECT p.department_id,x.name AS department_name FROM membership_periods p JOIN departments x ON x.id=p.department_id AND x.deleted_at IS NULL WHERE p.user_id=u.id AND tstzrange(p.valid_from,p.valid_to,'[)') @> CURRENT_TIMESTAMP LIMIT 1)m ON true
        LEFT JOIN LATERAL(SELECT ${record} AS observation FROM project_observations o WHERE o.project_id=s.id AND o.sequence=s.latest_sequence AND ${visible})l ON true
        LEFT JOIN LATERAL(SELECT ${record} AS observation FROM project_observations o WHERE o.project_id=s.id AND o.sequence=s.confirmed_sequence AND ${visible})c ON true
        JOIN LATERAL(SELECT ${record} AS observation FROM project_observations o WHERE o.project_id=s.id AND ${visible}
          AND ($3::timestamptz IS NULL OR o.observed_at>=$3) AND ($4::timestamptz IS NULL OR o.observed_at<$4) ORDER BY o.sequence DESC LIMIT 1)h ON true
        JOIN LATERAL(SELECT count(*)::int AS count FROM project_observations o WHERE o.project_id=s.id AND ${visible}
          AND ($3::timestamptz IS NULL OR o.observed_at>=$3) AND ($4::timestamptz IS NULL OR o.observed_at<$4))n ON true
        WHERE s.source_kind='plugin' AND ($1::text IS NULL OR u.email_key=$1) AND ($2::uuid IS NULL OR s.collector_id=$2)
          AND ($8::uuid IS NULL OR m.department_id=$8) AND ($9::uuid IS NULL OR s.id=$9) AND ($10::uuid IS NULL OR s.user_id=$10)
          AND ($5='%%' OR u.display_name ILIKE $5 OR u.email_key ILIKE $5 OR h.observation->>'workspace_path' ILIKE $5
            OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(c.observation->'remotes','[]'::jsonb))r WHERE r->>'address' ILIKE $5)))
        SELECT (SELECT count(*)::int FROM selected) AS total,COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM
          (SELECT * FROM selected ORDER BY COALESCE(latest->>'received_at',history->>'received_at') DESC,collector_id,workspace_key LIMIT $6 OFFSET $7)x),'[]'::jsonb) AS items`,values)).rows[0]!;
      if(before!==await revision())throw failure('content_changed',409);
      return {items:result.items.map((row):PluginProject=>{const h=row.history as Record<string,unknown>,latest=row.latest as Record<string,unknown>|null,confirmed=row.confirmed as Record<string,unknown>|null;
        return {project_id:String(row.project_id),user_id:String(row.user_id),nt_email:String(row.nt_email),collector_id:String(row.collector_id),workspace_key:String(row.workspace_key),workspace_path:String(h.workspace_path),platform:h.platform as PluginProject['platform'],linked_user:row.linked_user as PluginLinkedUser,
          latest:latest?view(latest):null,confirmed:confirmed?view(confirmed):null,current_available:latest!==null,history_only:latest===null&&confirmed===null,retained_observations:Number(row.retained_observations)};}),total:result.total,page,limit,has_more:page*limit<result.total};
    },
    async history(input:Query){
      if(!input.project_id&&(!input.collector_id||!input.nt_email||!input.workspace_key&&!input.workspace_path))throw failure('invalid_request');
      const page=input.page??1,limit=input.limit??20,department=await departmentScope(input),before=await revision();
      const values=[input.collector_id??null,input.nt_email?.trim().toLowerCase()??null,input.workspace_key??null,input.workspace_path??null,input.from??null,input.to??null,limit,(page-1)*limit,department,input.project_id??null,input.user_id??null];
      const result=(await db.query<{total:number;items:Record<string,unknown>[]}>(`WITH selected AS (
        SELECT ${record} AS observation,o.sequence FROM project_observations o JOIN project_streams s ON s.id=o.project_id JOIN users u ON u.id=o.user_id CROSS JOIN data_identity d
        WHERE ${visible} AND ($1::uuid IS NULL OR o.collector_id=$1) AND ($2::text IS NULL OR u.email_key=$2)
          AND ($3::text IS NULL OR s.workspace_key=$3) AND ($4::text IS NULL OR o.evidence->>'workspace'=$4)
          AND ($5::timestamptz IS NULL OR o.observed_at>=$5) AND ($6::timestamptz IS NULL OR o.observed_at<$6)
          AND ($10::uuid IS NULL OR s.id=$10) AND ($11::uuid IS NULL OR o.user_id=$11)
          AND ($9::uuid IS NULL OR EXISTS(SELECT 1 FROM membership_periods p JOIN departments x ON x.id=p.department_id AND x.deleted_at IS NULL WHERE p.user_id=u.id AND p.department_id=$9 AND tstzrange(p.valid_from,p.valid_to,'[)') @> CURRENT_TIMESTAMP)))
        SELECT (SELECT count(*)::int FROM selected) AS total,COALESCE((SELECT jsonb_agg(observation ORDER BY sequence DESC) FROM
          (SELECT * FROM selected ORDER BY sequence DESC LIMIT $7 OFFSET $8)x),'[]'::jsonb) AS items`,values)).rows[0]!;
      if(before!==await revision())throw failure('content_changed',409);
      return {items:result.items.map(view),total:result.total,page,limit,has_more:page*limit<result.total};
    },
  };
}
