export type StopObservation={reentry_count:number|null;count_state:'valid'|'missing'|'invalid';hook_active:boolean|null};
// Keep validation in PostgreSQL's exact numeric domain. Reading a rounded JS
// number could otherwise turn an out-of-range or fractional value into zero.
const validCount="CASE WHEN jsonb_typeof(e.payload->'loop_count')='number' THEN (e.payload->>'loop_count')::numeric BETWEEN 0 AND 2147483647 AND (e.payload->>'loop_count')::numeric=trunc((e.payload->>'loop_count')::numeric) ELSE false END";
export const stopObservationSql=`CASE WHEN e.event_type='Stop' THEN jsonb_build_object(
 'reentry_count',CASE WHEN ${validCount} THEN (e.payload->>'loop_count')::numeric::integer ELSE NULL END,
 'count_state',CASE WHEN NOT(e.payload ? 'loop_count') OR e.payload->'loop_count'='null'::jsonb THEN 'missing' WHEN ${validCount} THEN 'valid' ELSE 'invalid' END,
 'hook_active',CASE WHEN jsonb_typeof(e.payload->'stop_hook_active')='boolean' THEN (e.payload->>'stop_hook_active')::boolean ELSE NULL END
) ELSE NULL END`;
