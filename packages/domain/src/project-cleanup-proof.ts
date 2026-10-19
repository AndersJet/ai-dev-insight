import type {Queryable,Transaction,CleanupJournal,CleanupRecord,ProjectBarrier,ProjectDeletedKey} from '@adi/storage';

/** Freeze ordering barriers under the same user lock that establishes cleanup. */
export async function freezeProjectBarriers(sql:Transaction,job:string,user:string,from:string,to:string){
  await sql.query(`INSERT INTO cleanup_project_barriers(job_id,source_kind,collector_id,workspace_key,latest_sequence,confirmed_sequence,seen_sequence,platform)
    SELECT $1,s.source_kind,s.collector_id,s.workspace_key,s.latest_sequence,s.confirmed_sequence,GREATEST(s.seen_sequence,s.latest_sequence,s.confirmed_sequence),s.platform FROM project_streams s WHERE s.user_id=$2
    AND (EXISTS(SELECT 1 FROM project_observations o WHERE o.project_id=s.id AND ((o.observed_at>=$3::timestamptz AND o.observed_at<$4::timestamptz) OR (o.source_event_at>=$3::timestamptz AND o.source_event_at<$4::timestamptz)))
      OR EXISTS(SELECT 1 FROM project_hook_links h WHERE h.project_id=s.id AND h.occurred_at>=$3::timestamptz AND h.occurred_at<$4::timestamptz))`,[job,user,from,to]);
  await sql.query(`INSERT INTO cleanup_project_keys(job_id,source_kind,collector_id,observation_id,sequence,workspace_key,payload_hash)
    SELECT $1,k.source_kind,k.collector_id,k.observation_id,k.sequence,k.workspace_key,k.payload_hash FROM project_observation_keys k WHERE k.user_id=$2
    AND ((k.observed_at>=$3 AND k.observed_at<$4) OR (k.source_kind='hook' AND k.source_event_at>=$3 AND k.source_event_at<$4)
      OR EXISTS(SELECT 1 FROM project_observations o WHERE o.user_id=k.user_id AND o.source_kind=k.source_kind AND o.collector_id=k.collector_id AND o.id=k.fact_id
        AND ((o.observed_at>=$3 AND o.observed_at<$4) OR (o.source_event_at>=$3 AND o.source_event_at<$4))))`,[job,user,from,to]);
  await sql.query(`UPDATE project_streams s SET barrier_sequence=GREATEST(s.barrier_sequence,b.seen_sequence) FROM cleanup_project_barriers b WHERE b.job_id=$1 AND s.user_id=$2 AND s.source_kind=b.source_kind AND s.collector_id=b.collector_id AND s.workspace_key=b.workspace_key`,[job,user]);
  await sql.query('UPDATE cleanup_requests SET project_barriers_required=true WHERE job_id=$1',[job]);
}
export async function projectCleanupSnapshot(sql:Queryable,user:string,from:string,to:string){
  return (await sql.query<{project_observations:number;hook_project_observations:number;plugin_project_observations:number;project_links:number;revision:string}>(`WITH observations AS MATERIALIZED (
    SELECT id,source_kind,collector_id,project_id,payload_hash FROM project_observations o WHERE user_id=$1
    AND ((observed_at>=$2::timestamptz AND observed_at<$3::timestamptz) OR (source_event_at>=$2::timestamptz AND source_event_at<$3::timestamptz))
    AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=o.user_id AND ((t.from_at<=o.observed_at AND t.to_at>o.observed_at) OR (t.from_at<=o.source_event_at AND t.to_at>o.source_event_at)))
  ), links AS MATERIALIZED (
    SELECT event_id,occurred_at,project_id FROM project_hook_links h WHERE user_id=$1 AND occurred_at>=$2::timestamptz AND occurred_at<$3::timestamptz
    AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=h.user_id AND t.from_at<=h.occurred_at AND t.to_at>h.occurred_at)
  ), heads AS (
    SELECT id,source_kind,latest_sequence,confirmed_sequence,seen_sequence FROM project_streams WHERE user_id=$1 AND id IN(SELECT project_id FROM observations UNION SELECT project_id FROM links)
  ) SELECT (SELECT count(*)::int FROM observations) AS project_observations,(SELECT count(*)::int FROM observations WHERE source_kind='hook') AS hook_project_observations,(SELECT count(*)::int FROM observations WHERE source_kind='plugin') AS plugin_project_observations,(SELECT count(*)::int FROM links) AS project_links,
    md5(COALESCE((SELECT string_agg(concat(source_kind,':',collector_id,':',id,':',payload_hash),',' ORDER BY collector_id,id) FROM observations),'')||'/'||
      COALESCE((SELECT string_agg(concat(event_id,':',occurred_at),',' ORDER BY occurred_at,event_id) FROM links),'')||'/'||
      COALESCE((SELECT string_agg(concat(id,':',source_kind,':',latest_sequence,':',confirmed_sequence,':',seen_sequence),',' ORDER BY id) FROM heads),'')) AS revision`,[user,from,to])).rows[0]!;
}
export async function* frozenProjectPages(sql:Queryable,job:string):AsyncGenerator<ProjectBarrier[]>{
  let kind:string|null=null,collector:string|null=null,key:string|null=null;
  for(;;){
    const rows:ProjectBarrier[]=(await sql.query<ProjectBarrier>(`SELECT source_kind,collector_id,workspace_key,platform,latest_sequence::text,confirmed_sequence::text,seen_sequence::text FROM cleanup_project_barriers
      WHERE job_id=$1 AND ($2::text IS NULL OR (source_kind,collector_id,workspace_key)>($2,$3::uuid,$4)) ORDER BY source_kind,collector_id,workspace_key LIMIT 200`,[job,kind,collector,key])).rows;
    if(!rows.length)return;yield rows;const last:ProjectBarrier=rows.at(-1)!;kind=last.source_kind??'hook';collector=last.collector_id;key=last.workspace_key;
  }
}
export async function* frozenProjectKeyPages(sql:Queryable,job:string):AsyncGenerator<ProjectDeletedKey[]>{
  let kind:string|null=null,collector:string|null=null,id:string|null=null;
  for(;;){
    const rows:ProjectDeletedKey[]=(await sql.query<ProjectDeletedKey>(`SELECT source_kind,collector_id,observation_id,sequence::text,workspace_key,payload_hash FROM cleanup_project_keys
      WHERE job_id=$1 AND ($2::text IS NULL OR (source_kind,collector_id,observation_id)>($2,$3::uuid,$4::uuid)) ORDER BY source_kind,collector_id,observation_id LIMIT 200`,[job,kind,collector,id])).rows;
    if(!rows.length)return;yield rows;const last:ProjectDeletedKey=rows.at(-1)!;kind=last.source_kind;collector=last.collector_id;id=last.observation_id;
  }
}
export async function withProjectProof(sql:Queryable,journal:CleanupJournal,record:CleanupRecord,required:boolean):Promise<CleanupRecord>{
  if(!required)return record;
  return {...record,project_barriers:await journal.writeProjects(record,frozenProjectPages(sql,record.operation_id)),project_keys:await journal.writeProjectKeys(record,frozenProjectKeyPages(sql,record.operation_id))};
}
export async function restoreProjectBarriers(sql:Transaction,user:string,barriers:ProjectBarrier[]){
  if(!(await sql.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user])).rowCount)return;
  for(const b of barriers)await sql.query(`INSERT INTO project_streams(user_id,source_kind,collector_id,workspace_key,platform,latest_sequence,confirmed_sequence,seen_sequence,barrier_sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)
    ON CONFLICT(user_id,source_kind,collector_id,workspace_key) DO UPDATE SET latest_sequence=GREATEST(project_streams.latest_sequence,excluded.latest_sequence),confirmed_sequence=GREATEST(project_streams.confirmed_sequence,excluded.confirmed_sequence),seen_sequence=GREATEST(project_streams.seen_sequence,excluded.seen_sequence),barrier_sequence=GREATEST(project_streams.barrier_sequence,excluded.barrier_sequence)`,[user,b.source_kind??'hook',b.collector_id,b.workspace_key,b.platform??null,b.latest_sequence,b.confirmed_sequence,b.seen_sequence??b.latest_sequence]);
}
export async function restoreProjectDeletedKeys(sql:Transaction,user:string,keys:ProjectDeletedKey[]){
  if(!(await sql.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user])).rowCount)return;
  for(const k of keys){
    const stream=(await sql.query<{id:string}>(`INSERT INTO project_streams(user_id,source_kind,collector_id,workspace_key,seen_sequence) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(user_id,source_kind,collector_id,workspace_key) DO UPDATE SET seen_sequence=GREATEST(project_streams.seen_sequence,excluded.seen_sequence) RETURNING id`,[user,k.source_kind,k.collector_id,k.workspace_key,k.sequence])).rows[0]!;
    const old=(await sql.query<{sequence:string;payload_hash:string}>('SELECT sequence::text,payload_hash FROM project_observation_keys WHERE user_id=$1 AND source_kind=$2 AND collector_id=$3 AND observation_id=$4',[user,k.source_kind,k.collector_id,k.observation_id])).rows[0];
    if(old&&(old.sequence!==k.sequence||old.payload_hash!==k.payload_hash))throw new Error('Conflicting project deletion key');
    await sql.query(`INSERT INTO project_observation_keys(user_id,source_kind,collector_id,observation_id,sequence,project_id,workspace_key,payload_hash,cleared) VALUES($1,$2,$3,$4,$5,$6,$7,$8,true)
      ON CONFLICT(user_id,source_kind,collector_id,observation_id) DO UPDATE SET cleared=true,fact_id=NULL`,[user,k.source_kind,k.collector_id,k.observation_id,k.sequence,stream.id,k.workspace_key,k.payload_hash]);
  }
}
