import type {Transaction} from '@adi/storage';
type Range={userId:string|null;from:Date|string;to:Date|string;sourceKind?:'hook'|'plugin'};
const inRange=`((observed_at>=$2::timestamptz AND observed_at<$3::timestamptz) OR (source_kind='hook' AND source_event_at>=$2::timestamptz AND source_event_at<$3::timestamptz))`;
/** Erase readable evidence, retaining minimal identity and ordering barriers. */
export async function eraseProjectEvidenceBatch(sql:Transaction,range:Range,batch:number):Promise<number>{
  const values=[range.userId,range.from,range.to,batch,range.sourceKind??null];
  const removed=await sql.query<{user_id:string;source_kind:string;collector_id:string;id:string}>(`DELETE FROM project_observations WHERE ctid IN(
    SELECT ctid FROM project_observations WHERE ($1::uuid IS NULL OR user_id=$1) AND ($5::text IS NULL OR source_kind=$5)
    AND ${inRange} LIMIT $4 FOR UPDATE) RETURNING user_id,source_kind,collector_id,id`,values);
  for(const row of removed.rows){
    await sql.query('UPDATE project_observation_keys SET cleared=true,fact_id=NULL WHERE user_id=$1 AND source_kind=$2 AND collector_id=$3 AND fact_id=$4',[row.user_id,row.source_kind,row.collector_id,row.id]);
    if(row.source_kind==='hook')await sql.query('UPDATE project_hook_links SET observation_id=NULL WHERE user_id=$1 AND collector_id=$2 AND observation_id=$3',[row.user_id,row.collector_id,row.id]);
  }
  if(removed.rowCount)return removed.rowCount;
  const keys=await sql.query(`UPDATE project_observation_keys SET cleared=true,fact_id=NULL WHERE ctid IN(
    SELECT ctid FROM project_observation_keys WHERE NOT cleared AND ($1::uuid IS NULL OR user_id=$1)
      AND ($5::text IS NULL OR source_kind=$5) AND ${inRange} LIMIT $4 FOR UPDATE)`,values);
  if(keys.rowCount)return keys.rowCount;
  if(range.sourceKind==='plugin')return 0;
  return (await sql.query(`DELETE FROM project_hook_links WHERE ctid IN(SELECT ctid FROM project_hook_links
    WHERE ($1::uuid IS NULL OR user_id=$1) AND occurred_at>=$2::timestamptz AND occurred_at<$3::timestamptz LIMIT $4 FOR UPDATE)`,values.slice(0,4))).rowCount??0;
}
export async function hasProjectEvidenceInRange(sql:Transaction,range:Range):Promise<boolean>{
  return (await sql.query<{remaining:boolean}>(`SELECT EXISTS(SELECT 1 FROM project_observations WHERE ($1::uuid IS NULL OR user_id=$1)
    AND ($4::text IS NULL OR source_kind=$4) AND ${inRange})
    OR EXISTS(SELECT 1 FROM project_observation_keys WHERE NOT cleared AND ($1::uuid IS NULL OR user_id=$1) AND ($4::text IS NULL OR source_kind=$4) AND ${inRange})
    OR ($4::text IS DISTINCT FROM 'plugin' AND EXISTS(SELECT 1 FROM project_hook_links WHERE ($1::uuid IS NULL OR user_id=$1) AND occurred_at>=$2::timestamptz AND occurred_at<$3::timestamptz)) AS remaining`,[range.userId,range.from,range.to,range.sourceKind??null])).rows[0]!.remaining;
}
