import type { Database } from '@adi/storage';
import type { CurrentUser } from '@adi/contracts';
import type { IdentityService } from './identity.js';
import { DomainError } from './errors.js';
import { SESSION_DERIVATION_VERSION, SESSION_PURPOSE_ORDER } from './session-derivation.js';
import { createHash } from 'node:crypto';
import { createCursorCodec } from './cursor.js';
import { queryOfficialUsage, queryModels, emptyModels, modelRevision, type OfficialUsageSummary, type ModelFilter } from './official-usage.js';
import { queryContentEstimate } from './content-estimation.js';
import { recentPeriod as range } from './recent-period.js';
import {createPageCursor,cursorScope} from './page-cursor.js';
import {queryDeclaredModels,declaredModelRevision} from './declared-models.js';

export interface AnalyticsQuery { from?: string; to?: string; scope?: 'self' | 'organization'; department_id?: string; member_id?: string }
export interface AnalyticsPageQuery extends AnalyticsQuery { limit?: number; cursor?: string; search?: string }
export interface AnalyticsModelQuery extends AnalyticsQuery {scene?:ModelFilter['scene'];client?:ModelFilter['client'];model_key?:string;limit?:number;cursor?:string}
type Scope = { kind: 'self' | 'organization'; userId: string | null; departmentIds: string[] | null; label: string; member?: {id:string;name:string;email:string;archived:boolean} };
const global = (actor: CurrentUser) => actor.roles.includes('super') || actor.roles.includes('anc_admin');
function permitted(actor: CurrentUser, scope: Scope) {
  if (scope.kind === 'self') return actor.user_id === scope.userId;
  if (global(actor)) return true;
  return scope.departmentIds !== null && scope.departmentIds.length > 0 && scope.departmentIds.every(id => actor.managed_departments.some(department => department.id === id));
}
function count(value: string | number) {
  const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new DomainError('metric_overflow', 503); return n;
}

// Select metadata only. Payload/response/repository fields never enter the
// statistics result or this query's row materialization. Non-overlapping
// membership and eligibility constraints make the qualification join at most
// one row per event; a correlated scan here would repeat the entire cohort.
const baseSql = `WITH eligible_candidates AS MATERIALIZED (
  SELECT u.id AS user_id,m.department_id,GREATEST(m.valid_from,u.registered_at,$1::timestamptz,(SELECT collection_baseline_at FROM data_identity)) AS from_at,
    LEAST(COALESCE(m.valid_to,$2::timestamptz),$2::timestamptz) AS to_at
  FROM membership_periods m JOIN users u ON u.id=m.user_id AND u.registered_at IS NOT NULL
  WHERE NOT $5::boolean AND ($3::uuid IS NULL OR m.user_id=$3) AND ($4::uuid[] IS NULL OR m.department_id=ANY($4))
    AND m.valid_from<$2 AND (m.valid_to IS NULL OR m.valid_to>$1) AND u.registered_at<$2
  UNION ALL
  SELECT u.id,NULL::uuid,GREATEST(u.registered_at,$1::timestamptz,(SELECT collection_baseline_at FROM data_identity)),$2::timestamptz
  FROM users u WHERE $5::boolean AND u.id=$3 AND u.registered_at IS NOT NULL AND u.registered_at<$2
), eligible AS MATERIALIZED (SELECT * FROM eligible_candidates WHERE from_at<to_at), scoped AS MATERIALIZED (
  SELECT e.id,e.session_id,e.user_id,e.department_id,e.occurred_at,e.received_at,e.event_type,e.capture_generation
  FROM hook_events e WHERE e.occurred_at>=GREATEST($1::timestamptz,(SELECT collection_baseline_at FROM data_identity)) AND e.occurred_at<$2
    AND ($3::uuid IS NULL OR e.user_id=$3) AND ($4::uuid[] IS NULL OR e.department_id=ANY($4))
    AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at)
), observed AS MATERIALIZED (
  SELECT e.*,p.user_id IS NOT NULL AS qualified
  FROM scoped e LEFT JOIN eligible p ON p.user_id=e.user_id AND ($5 OR p.department_id=e.department_id) AND e.occurred_at>=p.from_at AND e.occurred_at<p.to_at
), freshness AS (
  SELECT e.session_id,e.received_at,
    (r.id IS NULL OR r.state<>'published' OR r.cleanup_generation<>u.cleanup_generation OR r.metric_version<>$6 OR e.capture_generation>r.source_generation) AS pending,
    (r.id IS NOT NULL AND (r.state<>'published' OR r.cleanup_generation<>u.cleanup_generation OR r.metric_version<>$6)) AS rebuilding
  FROM scoped e JOIN sessions s ON s.id=e.session_id JOIN users u ON u.id=e.user_id
    LEFT JOIN session_derivations r ON r.id=s.derived_run_id AND r.session_id=s.id AND r.user_id=s.user_id
)`;
interface OverviewRow {
  observed_users: string; eligible_users: string; eligible_observed_users: string; sessions: string; prompt_turns: string;
  tool_events: string; active_days: string; outside_prompts: string; unassigned_events: string;
  source_watermark: Date | null; pending_sessions: string; rebuilding_sessions: string; pending_since: Date | null;
}
export function createAnalyticsService(db: Database, identity: Pick<IdentityService,'requireUser'>, options: { clock?: () => Date; providerAccount?: string } = {}) {
  const now = options.clock ?? (() => new Date());
  const cursors = createCursorCodec(now);
  const modelCursors=createPageCursor(now);
  async function selectScope(actor: CurrentUser, input: AnalyticsQuery, period: {from:string;to:string}): Promise<Scope> {
    if (input.scope !== undefined && !['self', 'organization'].includes(input.scope)) throw new DomainError('invalid_request', 400);
    const manager = global(actor) || actor.managed_departments.length > 0;
    const self = input.scope === 'self' || (!manager && input.scope === undefined && input.department_id === undefined);
    if (self) {
      if (input.department_id !== undefined || input.member_id !== undefined) throw new DomainError('invalid_scope', 422);
      return { kind: 'self', userId: actor.user_id, departmentIds: null, label: '本人' };
    }
    if (!manager) throw new DomainError('forbidden', 403);
    if(input.member_id!==undefined&&(input.department_id===undefined||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.member_id)))throw new DomainError('invalid_scope',422);
    if (input.department_id !== undefined) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.department_id)) throw new DomainError('invalid_scope', 422);
      const departmentId = input.department_id.toLowerCase();
      const scope: Scope = { kind: 'organization', userId: null, departmentIds: [departmentId], label: '' };
      if (!permitted(actor, scope)) throw new DomainError('forbidden', 403);
      const department = (await db.query<{ name: string; deleted_at: Date | null }>('SELECT name,deleted_at FROM departments WHERE id=$1', [departmentId])).rows[0];
      if (!department) throw new DomainError('not_found', 404);
      scope.label = department.name + (department.deleted_at ? '（历史部门）' : '');
      if(input.member_id!==undefined){
        const member=(await db.query<{id:string;name:string;email:string;archived:boolean}>(`SELECT u.id,u.display_name AS name,u.email_key AS email,u.status<>'active' AS archived FROM users u WHERE u.id=$1 AND (
          EXISTS(SELECT 1 FROM membership_periods m WHERE m.user_id=u.id AND m.department_id=$2 AND m.valid_from<$4 AND (m.valid_to IS NULL OR m.valid_to>$3))
          OR EXISTS(SELECT 1 FROM hook_events e WHERE e.user_id=u.id AND e.department_id=$2 AND e.occurred_at>=$3 AND e.occurred_at<$4 AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at)))`,[input.member_id.toLowerCase(),departmentId,period.from,period.to])).rows[0];
        if(!member)throw new DomainError('not_found',404);scope.userId=member.id;scope.member=member;
      }
      return scope;
    }
    return { kind: 'organization', userId: null, departmentIds: global(actor) ? null : actor.managed_departments.map(department => department.id), label: global(actor) ? '组织' : '我的管理范围' };
  }
  async function overview(token: string, input: AnalyticsQuery = {}) {
    const actor = await identity.requireUser(token); const period = range(input, now()); const scope = await selectScope(actor, input, period);
    const row = (await db.query<OverviewRow>(`${baseSql}
      SELECT count(DISTINCT user_id) FILTER(WHERE event_type='UserPromptSubmit') AS observed_users,
        (SELECT count(DISTINCT user_id) FROM eligible) AS eligible_users,
        count(DISTINCT user_id) FILTER(WHERE event_type='UserPromptSubmit' AND qualified) AS eligible_observed_users,
        count(DISTINCT session_id) AS sessions,count(*) FILTER(WHERE event_type='UserPromptSubmit') AS prompt_turns,
        count(*) FILTER(WHERE event_type='PostToolUse') AS tool_events,
        count(DISTINCT (occurred_at AT TIME ZONE 'Asia/Shanghai')::date) FILTER(WHERE event_type='UserPromptSubmit') AS active_days,
        count(*) FILTER(WHERE event_type='UserPromptSubmit' AND NOT qualified) AS outside_prompts,
        count(*) FILTER(WHERE department_id IS NULL) AS unassigned_events,max(received_at) AS source_watermark,
        (SELECT count(DISTINCT session_id) FROM freshness WHERE pending) AS pending_sessions,
        (SELECT count(DISTINCT session_id) FROM freshness WHERE rebuilding) AS rebuilding_sessions,
        (SELECT min(received_at) FROM freshness WHERE pending AND NOT rebuilding) AS pending_since
      FROM observed`, [period.from, period.to, scope.userId, scope.departmentIds, scope.kind === 'self', SESSION_DERIVATION_VERSION])).rows[0]!;
    // Recheck before returning; read queries never hold user locks that would
    // block collection or administrator revocation while a report is calculated.
    if (!permitted(await identity.requireUser(token), scope)) throw new DomainError('forbidden', 403);
    const computed = now(); const observed = count(row.observed_users); const eligible = count(row.eligible_users); const covered = count(row.eligible_observed_users);
    const rebuilding = count(row.rebuilding_sessions); const pending = count(row.pending_sessions);
    return {
      period, scope: { kind: scope.kind, label: scope.label, department_ids: scope.departmentIds, member: scope.member ?? null },
      observed_users: observed, eligible_users: eligible, eligible_observed_users: covered, observed_outside_eligibility: observed - covered,
      outside_eligibility_prompt_events: count(row.outside_prompts), coverage_ratio: eligible ? covered / eligible : null,
      coverage_reason: eligible ? null : 'no_eligible_members', sessions: count(row.sessions), prompt_turns: count(row.prompt_turns), tool_events: count(row.tool_events), active_days: count(row.active_days),
      quality: { source: 'trae_personal_hooks', metric_version: 'usage-metadata-v1', computed_at: computed.toISOString(), source_watermark: row.source_watermark?.toISOString() ?? null, pending_sessions: pending, state: rebuilding ? 'rebuilding' : pending ? 'processing' : 'ready', lag_seconds: rebuilding ? null : pending && row.pending_since ? Math.max(0, Math.floor((computed.getTime() - row.pending_since.getTime()) / 1000)) : 0, unassigned_events: count(row.unassigned_events) },
    };
  }
  async function trends(token: string, input: AnalyticsQuery & { granularity?: 'day' | 'week' } = {}) {
    const actor = await identity.requireUser(token); const period = range(input, now()); const scope = await selectScope(actor, input, period);
    const granularity = input.granularity ?? 'day'; if (!['day', 'week'].includes(granularity)) throw new DomainError('invalid_request', 400);
    const rows = (await db.query<{ date: string; from_at: Date; to_at: Date; observed_users: string; eligible_users: string; eligible_observed_users: string; sessions: string; prompt_turns: string; tool_events: string }>(`${baseSql}, calendar AS (
      SELECT generate_series(date_trunc('day',$1::timestamptz AT TIME ZONE 'Asia/Shanghai'),date_trunc('day',($2::timestamptz-interval '1 microsecond') AT TIME ZONE 'Asia/Shanghai'),interval '1 day') AS d
    ), bucket_starts AS (SELECT DISTINCT CASE WHEN $7='week' THEN date_trunc('week',d) ELSE d END AS local_start FROM calendar), buckets AS (
      SELECT to_char(local_start,'YYYY-MM-DD') AS date,GREATEST(local_start AT TIME ZONE 'Asia/Shanghai',$1::timestamptz) AS from_at,
        LEAST((local_start+CASE WHEN $7='week' THEN interval '7 days' ELSE interval '1 day' END) AT TIME ZONE 'Asia/Shanghai',$2::timestamptz) AS to_at FROM bucket_starts
    ) SELECT b.date,b.from_at,b.to_at,count(DISTINCT e.user_id) FILTER(WHERE e.event_type='UserPromptSubmit') AS observed_users,
      (SELECT count(DISTINCT p.user_id) FROM eligible p WHERE p.from_at<b.to_at AND p.to_at>b.from_at) AS eligible_users,
      count(DISTINCT e.user_id) FILTER(WHERE e.event_type='UserPromptSubmit' AND e.qualified) AS eligible_observed_users,
      count(DISTINCT e.session_id) AS sessions,count(*) FILTER(WHERE e.event_type='UserPromptSubmit') AS prompt_turns,
      count(*) FILTER(WHERE e.event_type='PostToolUse') AS tool_events
      FROM buckets b LEFT JOIN observed e ON e.occurred_at>=b.from_at AND e.occurred_at<b.to_at
      GROUP BY b.date,b.from_at,b.to_at ORDER BY b.date`, [period.from, period.to, scope.userId, scope.departmentIds, scope.kind === 'self', SESSION_DERIVATION_VERSION, granularity])).rows;
    if (!permitted(await identity.requireUser(token), scope)) throw new DomainError('forbidden', 403);
    return { period, scope: { kind: scope.kind, label: scope.label, department_ids: scope.departmentIds, member: scope.member ?? null }, granularity, computed_at: now().toISOString(), items: rows.map(row => {
      const eligible = count(row.eligible_users); const covered = count(row.eligible_observed_users);
      return { date: row.date, from: row.from_at.toISOString(), to: row.to_at.toISOString(), observed_users: count(row.observed_users), eligible_users: eligible, eligible_observed_users: covered, coverage_ratio: eligible ? covered / eligible : null, sessions: count(row.sessions), prompt_turns: count(row.prompt_turns), tool_events: count(row.tool_events) };
    }) };
  }
  async function groups(token: string, input: AnalyticsPageQuery, kind: 'departments' | 'members') {
    if(input.member_id!==undefined)throw new DomainError('invalid_scope',422);
    const actor = await identity.requireUser(token); const period = range(input, now()); const scope = await selectScope(actor, input, period);
    if (scope.kind !== 'organization') throw new DomainError('forbidden', 403);
    if (kind === 'members' && !input.department_id) throw new DomainError('department_required', 422);
    const limit = input.limit ?? 50; const search = input.search?.trim() ?? '';
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || search.length > 128) throw new DomainError('invalid_request', 400);
    const binding = createHash('sha256').update(JSON.stringify([actor.user_id, scope.departmentIds ? [...scope.departmentIds].sort() : null, period, kind, limit, search])).digest('hex');
    const after = input.cursor ? cursors.decode(input.cursor, binding) : null;
    const pattern = `%${search.replace(/[\\%_]/g, value => `\\${value}`)}%`;
    const roster = kind === 'departments' ? `SELECT d.id,d.name,NULL::text AS email,d.deleted_at IS NOT NULL AS archived FROM departments d
      WHERE ($4::uuid[] IS NULL OR d.id=ANY($4)) AND (d.deleted_at IS NULL OR EXISTS(SELECT 1 FROM scoped e WHERE e.department_id=d.id)
        OR EXISTS(SELECT 1 FROM membership_periods m WHERE m.department_id=d.id AND m.valid_from<$2 AND (m.valid_to IS NULL OR m.valid_to>$1)))`
      : `SELECT u.id,u.display_name AS name,u.email_key AS email,false AS archived FROM users u WHERE
        EXISTS(SELECT 1 FROM membership_periods m WHERE m.user_id=u.id AND m.department_id=ANY($4) AND m.valid_from<$2 AND (m.valid_to IS NULL OR m.valid_to>$1))
        OR EXISTS(SELECT 1 FROM scoped e WHERE e.user_id=u.id)`;
    const groupColumn = kind === 'departments' ? 'department_id' : 'user_id';
    type GroupRow = { id: string; name: string; email: string | null; archived: boolean; observed_users: string | number; eligible_users: string | number; eligible_observed_users: string | number; sessions: string | number; prompt_turns: string | number; tool_events: string | number; active_days: string | number; last_observed_at: string | null };
    const response = (await db.query<{ total: string; cursor_valid: boolean; items: GroupRow[] }>(`${baseSql}, roster AS MATERIALIZED (${roster}), grouped AS (
      SELECT r.id,r.name,r.email,r.archived,count(DISTINCT e.user_id) FILTER(WHERE e.event_type='UserPromptSubmit') AS observed_users,
        (SELECT count(DISTINCT p.user_id) FROM eligible p WHERE p.${groupColumn}=r.id) AS eligible_users,
        count(DISTINCT e.user_id) FILTER(WHERE e.event_type='UserPromptSubmit' AND e.qualified) AS eligible_observed_users,
        count(DISTINCT e.session_id) AS sessions,count(*) FILTER(WHERE e.event_type='UserPromptSubmit') AS prompt_turns,
        count(*) FILTER(WHERE e.event_type='PostToolUse') AS tool_events,
        count(DISTINCT (e.occurred_at AT TIME ZONE 'Asia/Shanghai')::date) FILTER(WHERE e.event_type='UserPromptSubmit') AS active_days,
        max(e.occurred_at) AS last_observed_at
      FROM roster r LEFT JOIN observed e ON e.${groupColumn}=r.id GROUP BY r.id,r.name,r.email,r.archived
    ), matched AS MATERIALIZED (SELECT * FROM grouped WHERE name ILIKE $8 OR email ILIKE $8), page AS (
      SELECT * FROM matched WHERE $7::uuid IS NULL OR (name COLLATE "C",id)>(SELECT name COLLATE "C",id FROM matched WHERE id=$7)
      ORDER BY name COLLATE "C",id LIMIT $9
    ) SELECT (SELECT count(*) FROM matched) AS total,($7::uuid IS NULL OR EXISTS(SELECT 1 FROM matched WHERE id=$7)) AS cursor_valid,
      COALESCE(jsonb_agg(to_jsonb(page) ORDER BY name COLLATE "C",id),'[]'::jsonb) AS items FROM page`, [period.from, period.to, scope.userId, scope.departmentIds, false, SESSION_DERIVATION_VERSION, after, pattern, limit + 1])).rows[0]!;
    if (!response.cursor_valid) throw new DomainError('invalid_cursor', 400);
    if (!permitted(await identity.requireUser(token), scope)) throw new DomainError('forbidden', 403);
    const hasMore = response.items.length > limit;
    const items = response.items.slice(0, limit).map(row => {
      const eligible = count(row.eligible_users); const covered = count(row.eligible_observed_users);
      return { id: row.id, name: row.name, email: row.email, archived: row.archived, observed_users: count(row.observed_users), eligible_users: eligible, eligible_observed_users: covered, coverage_ratio: eligible ? covered / eligible : null, sessions: count(row.sessions), prompt_turns: count(row.prompt_turns), tool_events: count(row.tool_events), active_days: count(row.active_days), last_observed_at: row.last_observed_at ? new Date(row.last_observed_at).toISOString() : null };
    });
    return { period, scope: { kind: scope.kind, label: scope.label, department_ids: scope.departmentIds, member: scope.member ?? null }, computed_at: now().toISOString(), items, total: count(response.total), has_more: hasMore, next_cursor: hasMore ? cursors.encode(binding, items.at(-1)!.id) : null };
  }
  async function purposes(token: string, input: AnalyticsQuery = {}) {
    const actor = await identity.requireUser(token); const period = range(input, now()); const scope = await selectScope(actor, input, period);
    const rows = (await db.query<{ purpose: string; sessions: string; rule_sessions: string; behavior_sessions: string; pending_sessions: string }>(`${baseSql}, visible_fragments AS MATERIALIZED (
      SELECT e.session_id,e.id,f.event_id,f.purpose,f.behavior_purpose FROM scoped e JOIN sessions s ON s.id=e.session_id JOIN users u ON u.id=e.user_id
      LEFT JOIN session_derivations r ON r.id=s.derived_run_id AND r.session_id=s.id AND r.user_id=s.user_id AND r.state='published' AND r.cleanup_generation=u.cleanup_generation AND r.metric_version=$6
      LEFT JOIN session_fragments f ON f.run_id=r.id AND f.event_id=e.id AND f.occurred_at=e.occurred_at AND f.occurred_at>=$1 AND f.occurred_at<$2
    ), votes AS (
      SELECT session_id,purpose,count(*) AS votes FROM visible_fragments WHERE purpose IS NOT NULL GROUP BY session_id,purpose
    ), ranked AS (
      SELECT session_id,purpose,row_number() OVER(PARTITION BY session_id ORDER BY votes DESC,array_position($7::text[],purpose)) AS rank FROM votes
    ), signals AS (
      SELECT session_id,bool_or(event_id IS NULL) AS pending,bool_or(behavior_purpose='test') AS testing,bool_or(behavior_purpose='feature') AS writing,bool_or(behavior_purpose='learning') AS reading FROM visible_fragments GROUP BY session_id
    ), classified AS (
      SELECT CASE WHEN s.pending THEN 'unknown' WHEN r.purpose IS NOT NULL THEN r.purpose WHEN s.testing THEN 'test' WHEN s.writing THEN 'feature' WHEN s.reading THEN 'learning' ELSE 'unknown' END AS purpose,
        CASE WHEN s.pending THEN 'pending' WHEN r.purpose IS NOT NULL THEN 'rule' WHEN s.testing OR s.writing OR s.reading THEN 'behavior' ELSE 'unknown' END AS source
      FROM signals s LEFT JOIN ranked r ON r.session_id=s.session_id AND r.rank=1
    ) SELECT purpose,count(*)::text AS sessions,count(*) FILTER(WHERE source='rule')::text AS rule_sessions,count(*) FILTER(WHERE source='behavior')::text AS behavior_sessions,count(*) FILTER(WHERE source='pending')::text AS pending_sessions FROM classified GROUP BY purpose`, [period.from, period.to, scope.userId, scope.departmentIds, scope.kind === 'self', SESSION_DERIVATION_VERSION, SESSION_PURPOSE_ORDER])).rows;
    if (!permitted(await identity.requireUser(token), scope)) throw new DomainError('forbidden', 403);
    const total = rows.reduce((sum, row) => sum + count(row.sessions), 0);
    return { period, scope: { kind: scope.kind, label: scope.label, department_ids: scope.departmentIds, member: scope.member ?? null }, metric_version: SESSION_DERIVATION_VERSION, computed_at: now().toISOString(), total_sessions: total, pending_sessions: rows.reduce((sum, row) => sum + count(row.pending_sessions), 0), items: [...SESSION_PURPOSE_ORDER, 'unknown'].map(purpose => {
      const row = rows.find(item => item.purpose === purpose); const sessions = count(row?.sessions ?? 0);
      return { purpose, sessions, ratio: total ? sessions / total : null, rule_sessions: count(row?.rule_sessions ?? 0), behavior_sessions: count(row?.behavior_sessions ?? 0), pending_sessions: count(row?.pending_sessions ?? 0) };
    }) };
  }
  async function contentEstimate(token: string, input: AnalyticsQuery = {}) {
    const actor = await identity.requireUser(token); const period = range(input, now()); const scope = await selectScope(actor, input, period);
    const estimate = await queryContentEstimate(db, period, scope);
    if (!permitted(await identity.requireUser(token), scope)) throw new DomainError('forbidden', 403);
    return { period, scope: { kind: scope.kind, label: scope.label, department_ids: scope.departmentIds, member: scope.member ?? null }, estimate };
  }
  async function officialUsage(token:string,input:AnalyticsQuery={}) {
    const actor=await identity.requireUser(token);const period=range(input,now());const scope=await selectScope(actor,input,period);
    const data:OfficialUsageSummary=options.providerAccount?await queryOfficialUsage(db,options.providerAccount,period,scope,now()):{model_check:null,reconciliation:null,configured:false,source:'trae_openapi',token_basis:'provider_reported',settlement:'unverified',coverage:{expected_user_days:0,verified_user_days:0,missing_user_days:0,invalidated_user_days:0,refreshing_user_days:0,oldest_verified_at:null,complete:false},unassigned_records:null,excluded_client_records:0,groups:[]};
    if(!permitted(await identity.requireUser(token),scope))throw new DomainError('forbidden',403);
    return {period,scope:{kind:scope.kind,label:scope.label,department_ids:scope.departmentIds,member:scope.member??null},...data};
  }
  async function models(token:string,input:AnalyticsModelQuery={}){
    const actor=await identity.requireUser(token);const period=range(input,now());const scope=await selectScope(actor,input,period);const scene=input.scene??'Chat';const client=input.client??'ide';const limit=input.limit??20;
    if(!['Chat','CUE','other'].includes(scene)||!['ide','unspecified'].includes(client)||!Number.isSafeInteger(limit)||limit<1||limit>100||(input.model_key!==undefined&&!/^[a-f0-9]{64}$/.test(input.model_key)))throw new DomainError('invalid_request',400);
    const revision=await modelRevision(db,options.providerAccount??null,period,scope);const binding=cursorScope(['models',actor.user_id,scope,period,scene,client,limit,revision]);
    const cursor=input.cursor?modelCursors.decode(input.cursor,binding):null;const offset=cursor?.offset??0;if(!Number.isSafeInteger(offset)||Number(offset)<0||Number(offset)>2147483646)throw new DomainError('invalid_cursor',400);
    const data=options.providerAccount?await queryModels(db,options.providerAccount,period,scope,{scene,client,...(input.model_key?{model_key:input.model_key}:{})},{limit,offset:Number(offset)}):emptyModels();
    if(!permitted(await identity.requireUser(token),scope))throw new DomainError('forbidden',403);
    if(revision!==await modelRevision(db,options.providerAccount??null,period,scope))throw new DomainError('content_changed',409);
    const next=Number(offset)+data.items.length;
    return {period,scope:{kind:scope.kind,label:scope.label,department_ids:scope.departmentIds,member:scope.member??null},filters:{scene,client},...data,has_more:next<data.total,next_cursor:next<data.total?modelCursors.encode(binding,{offset:next}):null};
  }
  async function declaredModels(token:string,input:AnalyticsPageQuery={}){
    const actor=await identity.requireUser(token);const period=range(input,now());const scope=await selectScope(actor,input,period);const limit=input.limit??20;const search=input.search?.trim()??'';
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||search.length>128)throw new DomainError('invalid_request',400);
    const revision=await declaredModelRevision(db,scope);const binding=cursorScope(['declared-models',actor.user_id,scope,period,limit,search,revision]);const cursor=input.cursor?modelCursors.decode(input.cursor,binding):null;const offset=cursor?.offset??0;
    if(!Number.isSafeInteger(offset)||Number(offset)<0||Number(offset)>2147483646)throw new DomainError('invalid_cursor',400);
    const {cohort_revision,...data}=await queryDeclaredModels(db,period,scope,{limit,offset:Number(offset),search});
    if(cursor&&cursor.cohort!==cohort_revision)throw new DomainError('invalid_cursor',400);
    if(!permitted(await identity.requireUser(token),scope))throw new DomainError('forbidden',403);
    if(revision!==await declaredModelRevision(db,scope))throw new DomainError('content_changed',409);
    const next=Number(offset)+data.items.length;return {period,scope:{kind:scope.kind,label:scope.label,department_ids:scope.departmentIds,member:scope.member??null},...data,has_more:next<data.total,next_cursor:next<data.total?modelCursors.encode(binding,{offset:next,cohort:cohort_revision}):null};
  }
  async function member(token:string,id:string,input:AnalyticsQuery={}){if(input.member_id!==undefined||input.scope==='self')throw new DomainError('invalid_scope',422);return overview(token,{...input,scope:'organization',member_id:id});}
  return { member, overview, trends, purposes, contentEstimate, officialUsage,models,declaredModels, departments: (token: string, input: AnalyticsPageQuery = {}) => groups(token, input, 'departments'), members: (token: string, input: AnalyticsPageQuery) => groups(token, input, 'members') };
}
export type AnalyticsService = ReturnType<typeof createAnalyticsService>;
