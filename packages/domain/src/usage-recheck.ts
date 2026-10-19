import {incompleteTokenRecordSql} from './official-token-quality.js';
import type { Transaction } from '@adi/storage';

/** Schedule from actual observations, never last_verified_at or query-window growth. */
export async function nextUsageCheck(sql:Transaction,scope:{userId:string;businessDate:string;runId:string;contentChangedAt:Date|null},at:Date){
 const start=new Date(`${scope.businessDate}T00:00:00+08:00`),end=new Date(start.getTime()+86400000);
 const row=(await sql.query<{last_activity:Date|null;has_gap:boolean}>(`WITH activity AS (
  SELECT max(e.received_at) AS last_activity FROM hook_events e WHERE e.user_id=$1 AND e.occurred_at>=$2 AND e.occurred_at<$3
   AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at)
 ), records AS MATERIALIZED (
  SELECT o.value FROM usage_observations o WHERE o.run_id=$4
 ) SELECT last_activity,(last_activity IS NOT NULL OR EXISTS(
  SELECT 1 FROM records r WHERE ${incompleteTokenRecordSql}
   OR (r.value->>'scene'='Chat' AND COALESCE(r.value->>'client','') IN('','ide')))) AS has_gap FROM activity`,[scope.userId,start,end,scope.runId])).rows[0]!;
 // Hook days and Chat records need a complete session inventory, even when all
 // known IDs match. Cross-day bills must not silently drop to monthly checks.
 const observed=Math.max(row.last_activity?.getTime()??-Infinity,scope.contentChangedAt?.getTime()??-Infinity);
 const age=Math.max(0,at.getTime()-observed);
 const delay=age<3600000?300000:age<86400000||at<end?3600000:row.has_gap?86400000:30*86400000;
 return new Date(at.getTime()+delay);
}
