import type { Database } from '@adi/storage';
import { DomainError } from './errors.js';
import type { ContentEstimateDto } from '@adi/contracts';
import { SESSION_DERIVATION_VERSION } from './session-derivation.js';
/** Internal read model. Callers must resolve and recheck access before returning it. */
export async function queryContentEstimate(db: Database, period: { from: string; to: string }, scope: { userId: string | null; departmentIds: string[] | null; sessionId?: string }) {
  const epochSql = 'SELECT COALESCE(sum(cleanup_generation),0)::text AS epoch FROM users WHERE $1::uuid IS NULL OR id=$1';
  const epoch = (await db.query<{ epoch: string }>(epochSql, [scope.userId])).rows[0]!.epoch;
  const row = (await db.query<{ sessions: string; pending: string; prompt: string; tool_input: string; tool_output: string; assistant: string; as_of: Date | null }>(`WITH visible AS MATERIALIZED (
    SELECT e.id,e.session_id,e.user_id,e.occurred_at FROM hook_events e
    WHERE e.occurred_at>=GREATEST($1::timestamptz,(SELECT collection_baseline_at FROM data_identity)) AND e.occurred_at<$2 AND ($3::uuid IS NULL OR e.user_id=$3)
      AND ($4::uuid[] IS NULL OR e.department_id=ANY($4)) AND ($5::uuid IS NULL OR e.session_id=$5)
      AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at)
  ), contributions AS (
    SELECT e.session_id,r.computed_at,(r.id IS NULL OR j.id IS NULL OR r.source_generation<j.generation OR f.event_id IS NULL) AS pending,
      COALESCE(t.prompt_tokens_estimate,0) AS prompt,COALESCE(si.input_tokens_estimate,0) AS tool_input,
      COALESCE(so.output_tokens_estimate,0) AS tool_output,COALESCE(f.assistant_tokens_estimate,0) AS assistant
    FROM visible e JOIN sessions s ON s.id=e.session_id JOIN users u ON u.id=e.user_id
      LEFT JOIN jobs j ON j.dedupe_key='derive:'||s.id::text AND j.kind='derive_session'
      LEFT JOIN session_derivations r ON r.id=s.derived_run_id AND r.session_id=s.id AND r.user_id=s.user_id
        AND r.state='published' AND r.cleanup_generation=u.cleanup_generation AND r.metric_version=$6
      LEFT JOIN session_fragments f ON f.run_id=r.id AND f.event_id=e.id AND f.occurred_at=e.occurred_at AND f.occurred_at>=$1 AND f.occurred_at<$2
      LEFT JOIN session_turns t ON t.run_id=f.run_id AND t.prompt_event_id=e.id AND t.prompt_at=e.occurred_at
      LEFT JOIN session_steps si ON si.run_id=f.run_id AND si.input_event_id=e.id AND si.input_at=e.occurred_at
      LEFT JOIN session_steps so ON so.run_id=f.run_id AND so.post_event_id=e.id AND so.post_at=e.occurred_at
  ) SELECT count(DISTINCT session_id)::text AS sessions,count(DISTINCT session_id) FILTER(WHERE pending)::text AS pending,
    COALESCE(sum(prompt),0)::text AS prompt,COALESCE(sum(tool_input),0)::text AS tool_input,
    COALESCE(sum(tool_output),0)::text AS tool_output,COALESCE(sum(assistant),0)::text AS assistant,min(computed_at) AS as_of
    FROM contributions`, [period.from, period.to, scope.userId, scope.departmentIds, scope.sessionId ?? null, SESSION_DERIVATION_VERSION])).rows[0]!;
  if ((await db.query<{ epoch: string }>(epochSql, [scope.userId])).rows[0]!.epoch !== epoch) throw new DomainError('content_changed', 409);
  const sessions = Number(row.sessions); const pending = Number(row.pending);
  if (![sessions, pending].every(value => Number.isSafeInteger(value) && value >= 0)) throw new DomainError('metric_overflow', 503);
  const components = { prompt: pending ? null : row.prompt, tool_input: pending ? null : row.tool_input, tool_output: pending ? null : row.tool_output, assistant: pending ? null : row.assistant };
  return { source: 'trae_personal_hooks' as const, kind: 'observed_content' as const, metric_version: 'content-heuristic-v1' as const,
    tokens: pending ? null : (BigInt(row.prompt) + BigInt(row.tool_input) + BigInt(row.tool_output) + BigInt(row.assistant)).toString(), components,
    sessions, pending_sessions: pending, as_of: row.as_of?.toISOString() ?? null,
    reason: pending ? 'projection_pending' as const : sessions ? null : 'no_observations' as const };
}

/** Deprecated compatibility envelope for detail clients; no estimation query is run. */
export function retiredContentEstimate(sessions: number): ContentEstimateDto {
  return { source: 'trae_personal_hooks', kind: 'observed_content', metric_version: 'content-heuristic-v1', tokens: null,
    components: { prompt: null, tool_input: null, tool_output: null, assistant: null }, sessions, pending_sessions: 0, as_of: null, reason: null };
}
