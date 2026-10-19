import type {Queryable,Transaction} from '@adi/storage';
export interface BackfillPerson{id:string;ingest_epoch:number;active_recently:boolean}
export async function markBackfillCoverage(sql:Transaction,account:string,userId:string){
 await sql.query(`INSERT INTO usage_backfill_days(backfill_id,business_date)
  SELECT f.id,s.business_date FROM usage_backfills f JOIN users u ON u.id=f.user_id AND u.ingest_epoch=f.ingest_epoch
  JOIN usage_scopes s ON s.provider_account=f.provider_account AND s.user_id=f.user_id AND s.business_date BETWEEN f.from_date AND f.to_date
  JOIN usage_snapshot_runs v ON v.id=s.verified_run_id JOIN usage_snapshot_runs d ON d.id=s.published_run_id
  WHERE f.provider_account=$1 AND f.user_id=$2 AND f.completed_at IS NULL AND f.superseded_at IS NULL AND v.state IN('published','unchanged') AND d.state='published' AND v.data_run_id=d.id
  AND v.captured_email=u.email_key AND v.content_hash LIKE 'scope-v2:%' AND d.content_hash LIKE 'scope-v2:%'
  AND v.from_second<=extract(epoch FROM (s.business_date::timestamp AT TIME ZONE 'Asia/Shanghai'))
  AND v.to_second>=LEAST(extract(epoch FROM ((s.business_date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'))-1,floor(extract(epoch FROM f.as_of)))
  AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=f.user_id AND t.generation>v.cleanup_generation AND t.from_at<to_timestamp(v.to_second+1) AND t.to_at>to_timestamp(v.from_second))
  ON CONFLICT DO NOTHING`,[account,userId]);
 await sql.query(`UPDATE usage_backfills f SET completed_at=clock_timestamp() WHERE provider_account=$1 AND user_id=$2 AND completed_at IS NULL AND superseded_at IS NULL
  AND (SELECT count(*) FROM usage_backfill_days d WHERE d.backfill_id=f.id)=45`,[account,userId]);
}
export async function queueRecentDays(sql:Transaction,account:string,person:BackfillPerson,at:Date){
 const wakeForActivity="jobs.status='succeeded' AND (excluded.payload->>'activity_at')::timestamptz>COALESCE((jobs.progress->>'checked_at')::timestamptz,'-infinity'::timestamptz) AND jobs.available_at>(excluded.payload->>'activity_at')::timestamptz+interval '5 minutes'";
 const result=await sql.query(`INSERT INTO jobs(id,kind,dedupe_key,payload)
  SELECT gen_random_uuid(),'usage_sync','usage:'||$1||':'||$2::text||':'||d::text,jsonb_build_object('provider_account',$1::text,'user_id',$2::text,'business_date',d::text,'recurring',true,'activity_priority',$4::boolean,'activity_at',activity.last_at)
  FROM (SELECT ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date-g AS d FROM generate_series(0,2) g) days
  LEFT JOIN LATERAL (SELECT max(e.received_at) AS last_at FROM hook_events e WHERE e.user_id=$2
   AND e.occurred_at>=(days.d::timestamp AT TIME ZONE 'Asia/Shanghai') AND e.occurred_at<((days.d+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
   AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at)) activity ON true
  ON CONFLICT(dedupe_key) DO UPDATE SET payload=jobs.payload||jsonb_build_object('recurring',true,'activity_priority',$4::boolean),
  status=CASE WHEN jobs.status='failed' AND jobs.error_code='account_inactive' THEN 'queued' ELSE jobs.status END,
  generation=jobs.generation+CASE WHEN jobs.status='failed' AND jobs.error_code='account_inactive' THEN 1 ELSE 0 END,
  progress=CASE WHEN jobs.status='failed' AND jobs.error_code='account_inactive' THEN '{}'::jsonb ELSE jobs.progress END,
  attempt=CASE WHEN jobs.status='failed' AND jobs.error_code='account_inactive' THEN 0 ELSE jobs.attempt END,
  available_at=CASE WHEN jobs.status='failed' AND jobs.error_code='account_inactive' THEN clock_timestamp() WHEN ${wakeForActivity} THEN (excluded.payload->>'activity_at')::timestamptz+interval '5 minutes' ELSE jobs.available_at END,
  error_code=CASE WHEN jobs.status='failed' AND jobs.error_code='account_inactive' THEN NULL ELSE jobs.error_code END
  WHERE jobs.payload->>'recurring' IS DISTINCT FROM 'true' OR jobs.payload->>'activity_priority' IS DISTINCT FROM $4::text OR (jobs.status='failed' AND jobs.error_code='account_inactive') OR (${wakeForActivity}) RETURNING id`,[account,person.id,at,person.active_recently]);return result.rowCount??0;
}
export async function queueBackfill(sql:Transaction,account:string,person:BackfillPerson,at:Date,freshWindow=false){
 await sql.query("UPDATE usage_backfills SET superseded_at=clock_timestamp() WHERE provider_account=$1 AND user_id=$2 AND ingest_epoch=$3 AND superseded_at IS NULL AND ((completed_at IS NULL AND from_date<(($4::timestamptz-interval '365 days') AT TIME ZONE 'Asia/Shanghai')::date+1) OR created_at<(SELECT backfill_reset_at FROM usage_provider_control WHERE provider_account=$1) OR ($5::boolean AND to_date<($4::timestamptz AT TIME ZONE 'Asia/Shanghai')::date))",[account,person.id,person.ingest_epoch,at,freshWindow]);
 await sql.query(`INSERT INTO usage_backfills(provider_account,user_id,ingest_epoch,from_date,to_date,as_of,next_date)
  VALUES($1,$2,$3,($4::timestamptz AT TIME ZONE 'Asia/Shanghai')::date-44,($4::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,$4,($4::timestamptz AT TIME ZONE 'Asia/Shanghai')::date-3) ON CONFLICT(provider_account,user_id,ingest_epoch) WHERE superseded_at IS NULL DO NOTHING`,[account,person.id,person.ingest_epoch,at]);
 await markBackfillCoverage(sql,account,person.id);
 const plan=(await sql.query<{id:string;from_date:string;next_date:string;completed_at:Date|null}>(`SELECT id,from_date::text,next_date::text,completed_at FROM usage_backfills WHERE provider_account=$1 AND user_id=$2 AND ingest_epoch=$3 AND superseded_at IS NULL FOR UPDATE`,[account,person.id,person.ingest_epoch])).rows[0]!;
 // Upgrade existing one-shot backfill jobs too, including already completed plans.
 // The fixed 45-day key set uses the unique dedupe index, not an all-history scan.
 await sql.query(`UPDATE jobs SET payload=payload||'{"recurring":true}'::jsonb WHERE kind='usage_sync' AND payload->>'backfill'='true' AND payload->>'recurring' IS DISTINCT FROM 'true'
  AND dedupe_key IN(SELECT 'usage:'||$1||':'||$2::text||':'||(d::date)::text FROM generate_series($3::date,$3::date+44,interval '1 day') d)`,[account,person.id,plan.from_date]);
 const resumed=await sql.query(`UPDATE jobs SET status='queued',generation=generation+1,progress='{}',attempt=0,error_code=NULL,lease_token=NULL,lease_until=NULL,available_at=clock_timestamp()
  WHERE kind='usage_sync' AND status='failed' AND error_code='account_inactive'
   AND dedupe_key IN(SELECT 'usage:'||$1||':'||$2::text||':'||(d::date)::text FROM generate_series($3::date,$3::date+44,interval '1 day') d) RETURNING id`,[account,person.id,plan.from_date]);
 if(plan.completed_at||plan.next_date<plan.from_date)return resumed.rowCount??0;
 const inserted=await sql.query(`INSERT INTO jobs(id,kind,dedupe_key,payload)
  SELECT gen_random_uuid(),'usage_sync','usage:'||$1||':'||$2::text||':'||(d::date)::text,jsonb_build_object('provider_account',$1::text,'user_id',$2::text,'business_date',(d::date)::text,'recurring',true,'backfill',true,'activity_priority',$6::boolean)
  FROM (SELECT $4::date-g AS d FROM generate_series(0,LEAST(6,$4::date-$5::date)) g) days
  WHERE NOT EXISTS(SELECT 1 FROM usage_backfill_days v WHERE v.backfill_id=$3::uuid AND v.business_date=d)
  ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`,[account,person.id,plan.id,plan.next_date,plan.from_date,person.active_recently]);
 await sql.query(`UPDATE usage_backfills SET next_date=GREATEST(from_date-1,next_date-7),queued_at=CASE WHEN next_date-7<from_date THEN clock_timestamp() ELSE queued_at END WHERE provider_account=$1 AND user_id=$2 AND id=$3::uuid`,[account,person.id,plan.id]);
 return (inserted.rowCount??0)+(resumed.rowCount??0);
}
export async function queryBackfillProgress(sql:Queryable,account:string){
 const row=(await sql.query<{users:number;queuing_users:number;completed_users:number;paused_users:number;expected_days:number;verified_days:number;not_queued_days:number;failed_days:number}>(`WITH current AS MATERIALIZED (
  SELECT f.* FROM usage_backfills f JOIN users u ON u.id=f.user_id AND u.ingest_epoch=f.ingest_epoch AND u.status='active' WHERE f.provider_account=$1 AND f.superseded_at IS NULL
 ), days AS MATERIALIZED (SELECT f.*,f.from_date+g AS business_date FROM current f CROSS JOIN generate_series(0,44) g)
 SELECT (SELECT count(*)::int FROM current) AS users,(SELECT count(*) FILTER(WHERE completed_at IS NULL AND next_date>=from_date)::int FROM current) AS queuing_users,
 (SELECT count(*) FILTER(WHERE completed_at IS NOT NULL)::int FROM current) AS completed_users,
 (SELECT count(*)::int FROM users u WHERE u.status<>'active' AND EXISTS(SELECT 1 FROM usage_backfills f WHERE f.user_id=u.id AND f.provider_account=$1)) AS paused_users,
 count(*)::int AS expected_days,count(*) FILTER(WHERE v.business_date IS NOT NULL)::int AS verified_days,
 count(*) FILTER(WHERE v.business_date IS NULL AND d.business_date<=d.next_date AND d.business_date<d.to_date-2)::int AS not_queued_days,
 count(*) FILTER(WHERE v.business_date IS NULL AND j.status='failed')::int AS failed_days
 FROM days d LEFT JOIN usage_backfill_days v ON v.backfill_id=d.id AND v.business_date=d.business_date
 LEFT JOIN jobs j ON j.dedupe_key='usage:'||d.provider_account||':'||d.user_id::text||':'||d.business_date::text`,[account])).rows[0]!;
 return {...row,pending_days:Math.max(0,row.expected_days-row.verified_days-row.not_queued_days-row.failed_days),meaning:'initial_window_verifications' as const};
}
