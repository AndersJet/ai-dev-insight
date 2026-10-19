import type { Database } from '@adi/storage';
import { DomainError } from './errors.js';
type ModelScope={userId:string|null;departmentIds:string[]|null};
const count=(value:string)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<0)throw new DomainError('metric_overflow',503);return n;};
export async function declaredModelRevision(db:Database,scope:ModelScope){return (await db.query<{stamp:string}>(`SELECT md5(jsonb_build_object(
 'cleanup',(SELECT COALESCE(sum(cleanup_generation),0)::text FROM users WHERE $1::uuid IS NULL OR id=$1),
 'models',(SELECT md5(string_agg(user_id::text||':'||revision::text,',' ORDER BY user_id)) FROM personal_model_revisions WHERE $1::uuid IS NULL OR user_id=$1)
 )::text) AS stamp`,[scope.userId])).rows[0]!.stamp;}
export async function queryDeclaredModels(db:Database,period:{from:string;to:string},scope:ModelScope,page:{limit:number;offset:number;search:string}){
 const pattern=`%${page.search.replace(/[\\%_]/g,value=>`\\${value}`)}%`;
 const row=(await db.query<{total:string;confirmed_sessions:string;cohort_revision:string;items:{name:string;sessions:string;users:string}[]}>(`WITH observed AS MATERIALIZED (
  SELECT DISTINCT e.session_id,e.user_id FROM hook_events e WHERE e.occurred_at>=$1 AND e.occurred_at<$2 AND ($3::uuid IS NULL OR e.user_id=$3) AND ($4::uuid[] IS NULL OR e.department_id=ANY($4))
   AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at)
 ), declared AS MATERIALIZED (
  SELECT o.session_id,o.user_id,m.name FROM observed o JOIN users u ON u.id=o.user_id JOIN session_personal_models p ON p.session_id=o.session_id AND p.user_id=o.user_id AND p.cleanup_generation=u.cleanup_generation
  CROSS JOIN LATERAL jsonb_array_elements_text(p.models) m(name)
 ), grouped AS MATERIALIZED (
  SELECT name,count(DISTINCT session_id)::text AS sessions,count(DISTINCT user_id)::text AS users FROM declared WHERE name ILIKE $5 GROUP BY name
 ), page AS (SELECT * FROM grouped ORDER BY sessions::bigint DESC,name COLLATE "C" LIMIT $6 OFFSET $7)
 SELECT (SELECT count(*)::text FROM grouped) AS total,(SELECT count(DISTINCT session_id)::text FROM declared) AS confirmed_sessions,
  (SELECT md5(COALESCE(string_agg(session_id::text,',' ORDER BY session_id),'')) FROM (SELECT DISTINCT session_id FROM declared) cohort) AS cohort_revision,
  COALESCE((SELECT jsonb_agg(p ORDER BY p.sessions::bigint DESC,p.name COLLATE "C") FROM page p),'[]'::jsonb) AS items`,[period.from,period.to,scope.userId,scope.departmentIds,pattern,page.limit,page.offset])).rows[0]!;
 return {source:'user_declared' as const,basis:'observed_session_cohort' as const,cohort_revision:row.cohort_revision,total:count(row.total),confirmed_sessions:count(row.confirmed_sessions),items:row.items.map(item=>({name:item.name,sessions:count(item.sessions),users:count(item.users)}))};
}
