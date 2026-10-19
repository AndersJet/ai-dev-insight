import {stopObservationSql,type StopObservation} from './stop-observation.js';
import {createSessionTokenChecks} from './session-token-checks.js';
import {queryBillingSimulation,type SimulationInput} from './billing-simulation.js';
import type { Database } from '@adi/storage';
import type { IdentityService } from './identity.js';
import { DomainError } from './errors.js';
import { recentPeriod, type RecentPeriodQuery } from './recent-period.js';
import { createPageCursor, cursorScope } from './page-cursor.js';
import { retiredContentEstimate } from './content-estimation.js';
import { SESSION_DERIVATION_VERSION } from './session-derivation.js';
import { emptySessionOfficialUsage, querySessionOfficialUsage, unknownSessionCoverage, querySessionList, sessionSourceRevision } from './session-official-usage.js';
import {eventTime} from './event-time.js';
import type {SessionListSnapshotReader} from './session-list-snapshot-reading.js';

export interface SessionQuery extends RecentPeriodQuery { limit?: number; cursor?: string; search?: string; channel?: 'all' | 'official' | 'pending' | 'custom' }
export interface AllSessionQuery extends SessionQuery { user_id?: string; department_id?: string }
export interface FragmentQuery extends RecentPeriodQuery { limit?: number; cursor?: string; mode?: 'trace' | 'raw'; turn?: number; snapshot?: string }
export type ContentPart = 'payload' | 'prompt' | 'response' | 'tool_input' | 'tool_response';
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const orderSql = "CASE e.event_type WHEN 'SessionStart' THEN 0 WHEN 'UserPromptSubmit' THEN 1 WHEN 'PreToolUse' THEN 2 WHEN 'PostToolUse' THEN 3 WHEN 'Stop' THEN 4 WHEN 'Notification' THEN 5 ELSE 6 END";
const visibleSql = `e.session_id=$1 AND e.occurred_at>=$2 AND e.occurred_at<$3 AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at)`;
const iso = eventTime;
function pageSize(input: number | undefined, fallback = 20, maximum = 100) { const value = input ?? fallback; if (!Number.isInteger(value) || value < 1 || value > maximum) throw new DomainError('invalid_request', 400); return value; }
export function createSessionReadService(db: Database, identity: Pick<IdentityService,'requireUser'>, options: { clock?: () => Date; providerAccount?: string; stopWindowEnabled?: boolean; snapshots?:SessionListSnapshotReader } = {}) {
  const now = options.clock ?? (() => new Date()); const cursors = createPageCursor(now);
  async function list(token: string, input: AllSessionQuery, all: boolean) {
    const actor = await identity.requireUser(token); if (all && !actor.roles.includes('super')) throw new DomainError('forbidden', 403);
    if (!all && (input.user_id !== undefined || input.department_id !== undefined)) throw new DomainError('invalid_request', 400);
    if ((input.user_id !== undefined && !uuid(input.user_id)) || (input.department_id !== undefined && !uuid(input.department_id))) throw new DomainError('invalid_scope', 422);
    const channel = input.channel ?? 'all'; if (!['all', 'official', 'pending', 'custom'].includes(channel)) throw new DomainError('invalid_request', 400);
    const at = now();
    let period: ReturnType<typeof recentPeriod>;
    try { period = recentPeriod(input, at); }
    catch (error) {
      // Give a previous-day signed page to the reader for scope/expiry checks
      // after Beijing midnight. This does not extend its 60-second lifetime;
      // expired pages receive the normal cursor error and can restart.
      if (!options.snapshots || !input.cursor || !(error instanceof DomainError) || error.code !== 'invalid_period') throw error;
      period = recentPeriod(input, new Date(at.getTime() - 86_400_000));
    }
    const limit = pageSize(input.limit); const search = input.search?.trim() ?? '';
    const sourceEnabled=!!options.providerAccount&&(Date.parse(period.from)+28800000)%86400000===0&&(Date.parse(period.to)+28800000)%86400000===0;
    if(['official','pending'].includes(channel)&&!sourceEnabled)throw new DomainError('channel_source_unavailable',422);
    if (search.length > 128) throw new DomainError('invalid_request', 400);
    const owner = all ? input.user_id?.toLowerCase() ?? null : actor.user_id; const department = input.department_id?.toLowerCase() ?? null;
    if(options.snapshots){
      const result=await options.snapshots.read({actor:actor.user_id,all,owner,department,period,channel,search,limit,...(input.cursor?{cursor:input.cursor}:{}),sourceEnabled});
      const latest=await identity.requireUser(token);if(all&&!latest.roles.includes('super'))throw new DomainError('forbidden',403);
      await options.snapshots.assertSafe(result,owner);
      return result;
    }
    const epoch = (await db.query<{ epoch: string }>('SELECT COALESCE(sum(cleanup_generation),0)::text AS epoch FROM users WHERE $1::uuid IS NULL OR id=$1', [owner])).rows[0]!.epoch;
    const sourceRevision=await sessionSourceRevision(db,sourceEnabled?options.providerAccount!:null,owner,department,period,options.stopWindowEnabled===true);
    const binding = cursorScope(['sessions', actor.user_id, all, owner, department, period, channel, limit, search, epoch,sourceRevision]);
    const decoded = input.cursor ? cursors.decode(input.cursor, binding) : null;
    let after: { id: string; at: string } | null = null;
    if (decoded) {
      const { id, at } = decoded;
      if (!uuid(id) || typeof at !== 'string' || !Number.isFinite(Date.parse(at))) throw new DomainError('invalid_cursor', 400);
      after = { id, at };
    }
    const result = await querySessionList(db, {
      period, owner, department, search, after,
      limit, account: options.providerAccount ?? null,
      channel, sourceEnabled, stopWindowEnabled:options.stopWindowEnabled===true, reader: { userId: actor.user_id, super: actor.roles.includes('super') },
    });
    const latest = await identity.requireUser(token); if (all && !latest.roles.includes('super')) throw new DomainError('forbidden', 403);
    const currentEpoch = (await db.query<{ epoch: string }>('SELECT COALESCE(sum(cleanup_generation),0)::text AS epoch FROM users WHERE $1::uuid IS NULL OR id=$1', [owner])).rows[0]!.epoch;
    if (epoch !== currentEpoch||sourceRevision!==await sessionSourceRevision(db,sourceEnabled?options.providerAccount!:null,owner,department,period,options.stopWindowEnabled===true)) throw new DomainError('content_changed', 409);
    const shown = result.items.slice(0, limit); const hasMore = result.items.length > limit;
    return { period, items: shown.map(row => ({ id: row.id, user_id: row.user_id, name: row.name, email: row.email, source_session_id: row.source_session_id, title: row.title || '未观测到提示', first_at: iso(row.first_at), last_at: iso(row.last_key), prompt_turns: row.prompt_turns, channel:row.channel,model:row.model,model_count:row.model_count,official_tokens:row.official_tokens,official_records:row.official_records,department_unassigned_records:row.department_unassigned_records,session_coverage:unknownSessionCoverage(),attribution_conflicts:row.attribution_conflicts,personal_models:row.personal_models })), total: Number(result.total), has_more: hasMore, next_cursor: hasMore ? cursors.encode(binding, { at: shown.at(-1)!.last_key, id: shown.at(-1)!.id }) : null, channel_available:sourceEnabled,available_channels:sourceEnabled?['all','official','pending','custom']:['all','custom'] };
  }
  async function context(token: string, id: string, input: RecentPeriodQuery) {
    const actor = await identity.requireUser(token); if (!uuid(id)) throw new DomainError('not_found', 404);
    const period = recentPeriod(input, now(), 45);
    const row = (await db.query<{ id: string; user_id: string; source_session_id: string; first_at: Date; last_at: Date; name: string; email: string; cleanup_generation: number; derived_run_id: string | null; history_redacted:boolean;history_expired:boolean }>(`SELECT s.id,s.user_id,s.source_session_id,s.first_at,s.last_at,u.display_name AS name,u.email_key AS email,u.cleanup_generation,s.derived_run_id,s.history_redacted,s.history_expired
      FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND (s.user_id=$4 OR $5::boolean)
      AND EXISTS(SELECT 1 FROM hook_events e WHERE ${visibleSql})`, [id, period.from, period.to, actor.user_id, actor.roles.includes('super')])).rows[0];
    if (!row) throw new DomainError('not_found', 404); return { actor, period, row };
  }
  async function recheck(token: string, owner: string, epoch: number) {
    const actor = await identity.requireUser(token);
    if (actor.user_id !== owner && !actor.roles.includes('super')) throw new DomainError('not_found', 404);
    if ((await db.query<{ cleanup_generation: number }>('SELECT cleanup_generation FROM users WHERE id=$1', [owner])).rows[0]?.cleanup_generation !== epoch) throw new DomainError('content_changed', 409);
  }
  async function projectionReady(id: string, period: { from: string; to: string }, generation: number | undefined) {
    if (generation === undefined) return false;
    return !(await db.query<{ pending: boolean }>(`SELECT EXISTS(SELECT 1 FROM hook_events e WHERE ${visibleSql} AND e.capture_generation>$4) AS pending`, [id, period.from, period.to, generation])).rows[0]!.pending;
  }
  async function detail(token: string, id: string, input: RecentPeriodQuery = {}) {
    const { period, row } = await context(token, id, input);
    const metrics = (await db.query<{ events: string; prompts: string; tools: string }>(`SELECT count(*)::text AS events,count(*) FILTER(WHERE e.event_type='UserPromptSubmit')::text AS prompts,count(*) FILTER(WHERE e.event_type='PostToolUse')::text AS tools FROM hook_events e WHERE ${visibleSql}`, [id, period.from, period.to])).rows[0]!;
    const run = row.derived_run_id ? (await db.query<{ id: string; source_generation: number; computed_at: Date; summary: { status: string; quality: string[] } }>("SELECT id,source_generation,computed_at,summary FROM session_derivations WHERE id=$1 AND session_id=$2 AND user_id=$3 AND state='published' AND cleanup_generation=$4 AND metric_version=$5", [row.derived_run_id, id, row.user_id, row.cleanup_generation, SESSION_DERIVATION_VERSION])).rows[0] : null;
    const ready = await projectionReady(id, period, run?.source_generation);
    const contentEstimate = retiredContentEstimate(1);
    await recheck(token, row.user_id, row.cleanup_generation);
    return { content_estimate: contentEstimate, id: row.id, user_id: row.user_id, name: row.name, email: row.email, source_session_id: row.source_session_id, period, first_at: iso(row.first_at), last_at: iso(row.last_at), partial_history: row.history_redacted || row.history_expired || row.first_at.getTime() < Date.parse(period.from) || row.last_at.getTime() >= Date.parse(period.to), events: Number(metrics.events), prompt_turns: Number(metrics.prompts), tool_events: Number(metrics.tools), status: ready ? run!.summary.status : 'unknown', projection_ready: ready, computed_at: run?.computed_at.toISOString() ?? null, quality: [...(ready ? run!.summary.quality : [...(run?.summary.quality ?? []), 'projection_pending'])] };
  }
  async function turns(token: string, id: string, input: RecentPeriodQuery & { limit?: number; cursor?: string } = {}) {
    const { actor, period, row } = await context(token, id, input); const limit = pageSize(input.limit, 20, 50);
    const binding = cursorScope(['turns', actor.user_id, id.toLowerCase(), period, limit, row.cleanup_generation]);
    const after = input.cursor ? cursors.decode(input.cursor, binding) : null;
    if (after && (!uuid(after.run_id) || !Number.isSafeInteger(after.turn) || Number(after.turn) < 1)) throw new DomainError('invalid_cursor', 400);
    const candidate = after?.run_id ?? row.derived_run_id;
    const run = candidate ? (await db.query<{ id: string; source_generation: number }>(`SELECT id,source_generation FROM session_derivations WHERE id=$1 AND session_id=$2 AND user_id=$3 AND cleanup_generation=$4 AND metric_version=$5 AND (state='published' OR (state='superseded' AND retire_after>clock_timestamp()))`, [candidate, id, row.user_id, row.cleanup_generation, SESSION_DERIVATION_VERSION])).rows[0] : null;
    if (!run) { await recheck(token, row.user_id, row.cleanup_generation); if (after) throw new DomainError('invalid_cursor', 400); return { period, items: [], has_more: false, next_cursor: null, snapshot: null, snapshot_version: null, projection_ready: false }; }
    const rows = (await db.query<{ turn_index: number; first_at: Date; last_at: Date; events: string; prompt_preview: string | null }>(`WITH visible AS MATERIALIZED (
      SELECT f.turn_index,e.occurred_at FROM hook_events e JOIN session_fragments f ON f.run_id=$4 AND f.event_id=e.id AND f.occurred_at=e.occurred_at AND f.occurred_at>=$2 AND f.occurred_at<$3
      WHERE ${visibleSql} AND f.turn_index>$5
    ), page AS (
      SELECT turn_index,min(occurred_at) AS first_at,max(occurred_at) AS last_at,count(*)::text AS events FROM visible GROUP BY turn_index ORDER BY turn_index LIMIT $6
    ) SELECT p.*,CASE WHEN e.id IS NOT NULL THEN left(e.payload->>'prompt',120) END AS prompt_preview
      FROM page p JOIN session_turns t ON t.run_id=$4 AND t.turn_index=p.turn_index
      LEFT JOIN hook_events e ON e.id=t.prompt_event_id AND e.occurred_at=t.prompt_at AND e.session_id=$1 AND e.occurred_at>=$2 AND e.occurred_at<$3
      AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones c WHERE c.user_id=e.user_id AND c.from_at<=e.occurred_at AND c.to_at>e.occurred_at)
      ORDER BY p.turn_index`, [id, period.from, period.to, run.id, after?.turn ?? 0, limit + 1])).rows;
    const ready = await projectionReady(id, period, run.source_generation); await recheck(token, row.user_id, row.cleanup_generation);
    const items = rows.slice(0, limit);
    const snapshot = cursors.encode(cursorScope(['snapshot', actor.user_id, id.toLowerCase(), period, row.cleanup_generation]), { run_id: run.id });
    return { period, items: items.map(turn => ({ turn_index: turn.turn_index, first_at: iso(turn.first_at), last_at: iso(turn.last_at), events: Number(turn.events), prompt_preview: turn.prompt_preview })), has_more: rows.length > limit, next_cursor: rows.length > limit ? cursors.encode(binding, { run_id: run.id, turn: items.at(-1)!.turn_index }) : null, snapshot, snapshot_version: cursorScope(['session-turns-version', actor.user_id, id.toLowerCase(), period, row.cleanup_generation, run.id]), projection_ready: ready };
  }
  async function fragments(token: string, id: string, input: FragmentQuery = {}) {
    const { actor, period, row } = await context(token, id, input); const limit = pageSize(input.limit, 20, 50); const mode = input.mode ?? 'trace';
    if (!['trace', 'raw'].includes(mode) || (input.turn !== undefined && (!Number.isSafeInteger(input.turn) || input.turn < 1))) throw new DomainError('invalid_request', 400);
    const binding = cursorScope(['fragments', actor.user_id, id.toLowerCase(), period, mode, input.turn ?? null, limit, row.cleanup_generation, input.snapshot ?? null]);
    const after = input.cursor ? cursors.decode(input.cursor, binding) : null;
    if (after && (!uuid(after.id) || typeof after.at !== 'string' || !Number.isInteger(after.order) || (after.run_id !== null && !uuid(after.run_id)))) throw new DomainError('invalid_cursor', 400);
    const snapshot = input.snapshot ? cursors.decode(input.snapshot, cursorScope(['snapshot', actor.user_id, id.toLowerCase(), period, row.cleanup_generation])) : null;
    if (snapshot && !uuid(snapshot.run_id)) throw new DomainError('invalid_cursor', 400);
    const candidate = mode === 'raw' ? null : after ? after.run_id : snapshot?.run_id ?? row.derived_run_id;
    const run = candidate ? (await db.query<{ id: string; source_generation: number }>(`SELECT r.id,r.source_generation FROM session_derivations r JOIN users u ON u.id=r.user_id
      WHERE r.id=$1 AND r.session_id=$2 AND r.user_id=$3 AND r.cleanup_generation=u.cleanup_generation AND r.metric_version=$4
      AND (r.state='published' OR (r.state='superseded' AND r.retire_after>clock_timestamp()))`, [candidate, id, row.user_id, SESSION_DERIVATION_VERSION])).rows[0] : null;
    if (candidate && !run && (after || snapshot)) throw new DomainError('invalid_cursor', 400);
    if (input.turn !== undefined && !run) { await recheck(token, row.user_id, row.cleanup_generation); return { period, items: [], has_more: false, next_cursor: null, projection_ready: false }; }
    type FragmentRow = { stop:StopObservation|null; event_id: string; at: string; kind: string; order: number; timestamp_source: string; turn_index: number | null; step_id: string | null; tool_name: string | null; status: string | null; duration_ms: string | null; input_event_id: string | null; input_at: string | null; pre_event_id: string | null; pre_at: string | null; post_event_id: string | null; post_at: string | null };
    const rows = (await db.query<FragmentRow>(`SELECT e.id AS event_id,e.occurred_at::text AS at,e.event_type AS kind,${orderSql} AS "order",e.timestamp_source,f.turn_index,f.step_id,${stopObservationSql} AS stop,
      CASE WHEN e.event_type IN('PreToolUse','PostToolUse') AND jsonb_typeof(e.payload->'tool_name')='string' THEN left(e.payload->>'tool_name',256) ELSE NULL END AS tool_name,
      st.status,CASE WHEN st.pre_at>=$2 AND st.post_at<$3 THEN st.duration_ms::text ELSE NULL END AS duration_ms,
      CASE WHEN st.input_at>=$2 AND st.input_at<$3 THEN st.input_event_id END AS input_event_id,
      CASE WHEN st.input_at>=$2 AND st.input_at<$3 THEN st.input_at::text END AS input_at,
      CASE WHEN st.pre_at>=$2 AND st.pre_at<$3 THEN st.pre_event_id END AS pre_event_id,
      CASE WHEN st.pre_at>=$2 AND st.pre_at<$3 THEN st.pre_at::text END AS pre_at,
      CASE WHEN st.post_at>=$2 AND st.post_at<$3 THEN st.post_event_id END AS post_event_id,
      CASE WHEN st.post_at>=$2 AND st.post_at<$3 THEN st.post_at::text END AS post_at
      FROM hook_events e LEFT JOIN session_fragments f ON f.run_id=$4 AND f.event_id=e.id AND f.occurred_at=e.occurred_at AND f.occurred_at>=$2 AND f.occurred_at<$3
      LEFT JOIN session_steps st ON st.run_id=f.run_id AND st.id=f.step_id
      WHERE ${visibleSql} AND ($5::integer IS NULL OR e.capture_generation<=$5) AND ($6::integer IS NULL OR f.turn_index=$6)
      AND ($7::timestamptz IS NULL OR (e.occurred_at,${orderSql},e.id)>($7::timestamptz,$8::integer,$9::uuid))
      ORDER BY e.occurred_at,${orderSql},e.id LIMIT $10`, [id, period.from, period.to, run?.id ?? null, run?.source_generation ?? null, input.turn ?? null, after?.at ?? null, after?.order ?? null, after?.id ?? null, limit + 1])).rows;
    const ready = await projectionReady(id, period, run?.source_generation);
    await recheck(token, row.user_id, row.cleanup_generation);
    const items = rows.slice(0, limit); const last = items.at(-1);
    return { period, items: items.map(event => ({ stop:event.stop,event_id: event.event_id, occurred_at: iso(event.at), kind: event.kind, timestamp_source: event.timestamp_source, turn_index: event.turn_index, step_id: event.step_id, tool_name: event.tool_name, status: event.status, duration_ms: event.duration_ms, input_ref: event.input_event_id ? { event_id: event.input_event_id, occurred_at: iso(event.input_at!) } : null, pre_ref: event.pre_event_id ? { event_id: event.pre_event_id, occurred_at: iso(event.pre_at!) } : null, post_ref: event.post_event_id ? { event_id: event.post_event_id, occurred_at: iso(event.post_at!) } : null })), has_more: rows.length > limit, next_cursor: rows.length > limit && last ? cursors.encode(binding, { id: last.event_id, at: last.at, order: last.order, run_id: run?.id ?? null }) : null, projection_ready: ready };
  }
  async function content(token: string, id: string, eventId: string, input: RecentPeriodQuery & { part: ContentPart; occurred_at?:string; offset?: number; limit?: number }) {
    const { period, row } = await context(token, id, input); if (!uuid(eventId)) throw new DomainError('not_found', 404);
    const offset = input.offset ?? 0; const limit = pageSize(input.limit, 8192, 8192);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2147483646) throw new DomainError('invalid_request', 400);
    const expressions: Record<ContentPart, string> = { payload: 'e.payload::text', prompt: "CASE WHEN jsonb_typeof(e.payload->'prompt')='string' THEN e.payload->>'prompt' END", response: "CASE WHEN jsonb_typeof(e.payload->'last_assistant_message')='string' THEN e.payload->>'last_assistant_message' WHEN jsonb_typeof(e.payload->'text_content')='string' THEN e.payload->>'text_content' END", tool_input: "(e.payload->'tool_input')::text", tool_response: "CASE WHEN jsonb_typeof(e.payload->'tool_response')='string' THEN e.payload->>'tool_response' ELSE (e.payload->'tool_response')::text END" };
    if (!Object.hasOwn(expressions, input.part)) throw new DomainError('invalid_request', 400);
    const at=input.occurred_at===undefined?null:eventTime(input.occurred_at);
    const matches = (await db.query<{ text: string | null; total_chars: number | null; chars: number | null }>(`WITH value AS MATERIALIZED(SELECT ${expressions[input.part]} AS body FROM hook_events e WHERE ${visibleSql} AND e.id=$4 AND ($7::timestamptz IS NULL OR e.occurred_at=$7) LIMIT 2)
      SELECT substring(body FROM $5::integer+1 FOR $6::integer) AS text,length(body) AS total_chars,length(substring(body FROM $5::integer+1 FOR $6::integer)) AS chars FROM value`, [id, period.from, period.to, eventId, offset, limit,at])).rows;
    if(matches.length>1)throw new DomainError('content_changed',409);const result=matches[0];
    if (!result) throw new DomainError('not_found', 404); await recheck(token, row.user_id, row.cleanup_generation);
    const loaded = offset + (result.chars ?? 0);
    return { event_id: eventId, part: input.part, available: result.text !== null, text: result.text ?? '', offset, returned_chars: result.chars ?? 0, total_chars: result.total_chars ?? 0, next_offset: loaded < (result.total_chars ?? 0) ? loaded : null };
  }
  async function officialUsage(token:string,id:string,input:RecentPeriodQuery={}){
    const {actor,period,row}=await context(token,id,input);
    const data=options.providerAccount?await querySessionOfficialUsage(db,options.providerAccount,row.id,row.user_id,period,{userId:actor.user_id,super:actor.roles.includes('super')},options.stopWindowEnabled===true):emptySessionOfficialUsage();
    await recheck(token,row.user_id,row.cleanup_generation);return {period,...data};
  }
  async function simulation(token:string,id:string,input:SimulationInput={}){
    const {period,row}=await context(token,id,{});const result=await queryBillingSimulation(db,id,row.user_id,period,input,options.providerAccount,now());await recheck(token,row.user_id,row.cleanup_generation);return result;
  }
  async function tokenCheck(token:string,id:string){
    const {row}=await context(token,id,{});const result=await createSessionTokenChecks(db,options).read(row.id);await recheck(token,row.user_id,row.cleanup_generation);return result;
  }
  /** Full retained facts, independent of list filters, page limits and derived readiness. */
  async function analysisData(token:string,ids:string[]){
    if(!Array.isArray(ids)||!ids.length||ids.length>20||ids.some(id=>!uuid(id))||new Set(ids.map(id=>id.toLowerCase())).size!==ids.length)throw new DomainError('invalid_request',400);
    const contexts:Array<Awaited<ReturnType<typeof context>>>=[];
    for(const id of ids)contexts.push(await context(token,id,{}));
    const owner=contexts[0]!.row.user_id;
    if(contexts.some(c=>c.row.user_id!==owner))throw new DomainError('analysis_same_owner',400);
    const fence=async()=>JSON.stringify((await db.query('SELECT dataset_id,recovery_id,collection_enabled,collection_baseline_at FROM data_identity')).rows[0]);
    const before=await fence();
    const bundles=await db.transaction(async sql=>{
      await sql.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const bundles=[];let bytes=0,events=0;
      for(const {row,period} of contexts){
        const values=[row.id,period.from,period.to];
        const size=(await sql.query<{events:string;bytes:string}>(`SELECT count(*)::text AS events,COALESCE(sum(octet_length(e.payload::text)),0)::text AS bytes FROM hook_events e WHERE ${visibleSql}`,values)).rows[0]!;
        events+=Number(size.events);bytes+=Number(size.bytes);
        if(events>20000||bytes>24*1024*1024)throw new DomainError('analysis_too_large',413);
        const records=(await sql.query(`SELECT e.id AS event_id,e.occurred_at::text AS occurred_at,e.event_type AS kind,e.timestamp_source,e.payload::text AS payload_json,
          to_jsonb(e)-'payload' AS stored_metadata,f.turn_index,f.step_id
          FROM hook_events e LEFT JOIN session_fragments f ON f.run_id=$4 AND f.event_id=e.id AND f.occurred_at=e.occurred_at
          WHERE ${visibleSql} ORDER BY e.occurred_at,${orderSql},e.id`,[...values,row.derived_run_id])).rows;
        bundles.push({session_id:row.id,source_session_id:row.source_session_id,user_id:owner,name:row.name,email:row.email,period,first_at:iso(row.first_at),last_at:iso(row.last_at),
          partial_history:row.history_redacted||row.history_expired||row.first_at.getTime()<Date.parse(period.from)||row.last_at.getTime()>=Date.parse(period.to),
          history_redacted:row.history_redacted,history_expired:row.history_expired,derived_run_id:row.derived_run_id,
          events:records,exported_events:records.length,source:'retained_hook_facts',derived_fields_are_hints:true});
      }
      return bundles;
    });
    const usage=[];
    for(const {row} of contexts)usage.push({session_id:row.id,...await officialUsage(token,row.id)});
    for(const {row} of contexts)await recheck(token,row.user_id,row.cleanup_generation);
    if(before!==await fence())throw new DomainError('content_changed',409);
    const assertCurrent=async()=>{for(const {row} of contexts)await recheck(token,row.user_id,row.cleanup_generation);if(before!==await fence())throw new DomainError('content_changed',409);};
    return {assertCurrent,version:'token-efficiency-v1',exported_at:now().toISOString(),user_id:owner,sessions:bundles,official_usage:usage,
      notes:['用户多选不证明同一任务','仅导出现存可读事实，留存/清理/采集裁剪缺口不补造','官方关联量不代表完整任务成本，不将不同会话展示数量直接相加','派生轮次/步骤只作提示，以原始事件及来源为准']};
  }
  return { analysisData, listMine: (token: string, input: SessionQuery = {}) => list(token, input, false), listAll: (token: string, input: AllSessionQuery = {}) => list(token, input, true), detail, turns, fragments, content, officialUsage,simulation,tokenCheck };
}
export type SessionReadService = ReturnType<typeof createSessionReadService>;
