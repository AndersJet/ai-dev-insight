/** Internal SQL shared by official readers. s/o/p are the published person scope,
 * observation and query part. A bill aggregates an interval, not one timestamp:
 * only a local membership covering the entire interval may own its quantities.
 * Missing history and crossing transfers remain unassigned; provider department
 * labels and today's membership must never be fallback evidence. */
export const localUsageDepartmentSql=`SELECT CASE WHEN count(*)=1 THEN min(m.department_id::text)::uuid END AS department_id
 FROM membership_periods m
 WHERE m.user_id=s.user_id
  AND (o.value->>'start_time')::bigint<=p.end_second
  AND m.valid_from<=to_timestamp((o.value->>'start_time')::bigint)
  AND (m.valid_to IS NULL OR m.valid_to>=to_timestamp(p.end_second+1))`;
