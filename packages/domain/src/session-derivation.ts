import {stopObservationSql,type StopObservation} from './stop-observation.js';
import { randomUUID } from 'node:crypto';
import type { Database, Transaction } from '@adi/storage';
import { DomainError } from './errors.js';

const orderSql = "CASE event_type WHEN 'SessionStart' THEN 0 WHEN 'UserPromptSubmit' THEN 1 WHEN 'PreToolUse' THEN 2 WHEN 'PostToolUse' THEN 3 WHEN 'Stop' THEN 4 WHEN 'Notification' THEN 5 ELSE 6 END";
// Bump when reconstruction semantics change; unfinished older computations must
// restart from facts instead of resuming a checkpoint under different rules.
export const SESSION_DERIVATION_VERSION = 'session-v9';
type Purpose = 'docs' | 'ops' | 'test' | 'refactor' | 'bugfix' | 'feature' | 'learning' | 'chat';
const rules: [Purpose, RegExp][] = [
  ['docs', /文档|注释|readme|使用说明|documentation|changelog/i],
  ['ops', /部署|发布|安装|配置(文件|环境)?|环境变量|迁移|上线|运维|deploy|install\b|docker|k8s|kubernetes|nginx|ci\/cd|流水线|npm\s+(install|i\b)/i],
  ['test', /测试|用例|单测|覆盖率|pytest|jest|vitest|mocha|junit|write\s+tests?|回归/i],
  ['refactor', /重构|refactor|简化(一下)?(代码|逻辑)?|抽取(公共|公共方法)?|封装|代码清理|消除重复/i],
  ['bugfix', /修复|修(一下|个|好)|缺陷|fix|debug|排查|报错|异常|出错|失败|崩溃|不工作|不生效|traceback|stack\s*trace|panic/i],
  ['feature', /帮我写|新建|创建|新增|添加|实现|开发|生成|create\b|add\b|implement|build\s+(a|an|the)/i],
  ['learning', /什么是|什么意思|解释|讲解|区别|对比|为什么|如何|怎么|how\s+(do|to|does)|what\s+is|why\b|explain/i],
  ['chat', /^(你好|您好|hi|hello|聊聊天)[!！。.\s]*$/i],
];
export const SESSION_PURPOSE_ORDER = rules.map(([purpose]) => purpose);
type Cursor = { at: string; order: number; id: string };
type Checkpoint = { last_stop_reentry_count?:number; cursor: Cursor | null; turn: number; processed: number; votes: Partial<Record<Purpose, number>>; qualities: string[]; write: boolean; read: boolean; test: boolean };
type Run = { id: string; session_id: string; user_id: string; source_generation: number; cleanup_generation: number; metric_version: string; from_at: string; to_at: string; checkpoint: Checkpoint; state: string; retention_stale?: boolean };
const runColumns = 'id,session_id,user_id,source_generation,cleanup_generation,metric_version,state,from_at::text AS from_at,to_at::text AS to_at,checkpoint';
type Fact = { stop:StopObservation|null; id: string; at: string; received_at: string; event_order: number; event_type: string; timestamp_source: string; installation_id: string; department_id: string | null; business_date: string; payload: Record<string, unknown>; payload_digest:string };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown) => typeof value === 'string' ? value : '';
const identityText = (value: unknown, maximum = 1024) => typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null;
function estimate(value: unknown) {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  let cjk = 0; let words = 0; let symbols = 0; let inWord = false;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if ((code >= 0x4e00 && code <= 0x9fa5) || (code >= 0x3000 && code <= 0x303f) || (code >= 0xff01 && code <= 0xff5e)) { cjk++; inWord = false; }
    else if (/[a-zA-Z0-9_]/.test(character)) { if (!inWord) words++; inWord = true; }
    else { if (!/\s/.test(character)) symbols++; inWord = false; }
  }
  return String(Math.ceil((cjk * 65 + words * 130 + symbols * 50) / 100));
}
function errorEvidence(value: unknown): string | null {
  if (!record(value)) return null;
  if (value.is_error === true) return 'reported_error';
  if (typeof value.exit_code === 'number' && Number.isFinite(value.exit_code) && value.exit_code !== 0) return 'exit_code';
  if (typeof value.exit_code === 'string' && value.exit_code.length <= 64 && /^-?\d+$/.test(value.exit_code) && BigInt(value.exit_code) !== 0n) return 'exit_code';
  if (typeof value.error === 'string' && value.error.trim()) return 'reported_error';
  return null;
}
function successEvidence(value: unknown): boolean {
  return record(value) && (value.success === true || value.is_error === false || value.exit_code === 0 || (typeof value.exit_code === 'string' && /^-?0+$/.test(value.exit_code)));
}
function simulationAction(name: string | null, input: unknown): boolean | null {
  if (['Edit','Write','Delete','SearchReplace'].includes(name??'')) return true;
  if (['Read','Grep','SearchCodebase','Glob','LS','GetDiagnostics','CheckCommandStatus','Skill','TodoWrite'].includes(name??'')) return false;
  if (name==='RunCommand' && record(input) && typeof input.command==='string') return !/^\s*(git\s+(status|diff|log|branch|show)|ls|cat|lsof|ps|pwd|echo)\b/i.test(input.command);
  return null;
}
function quality(state: Checkpoint, value: string) { if (!state.qualities.includes(value)) state.qualities.push(value); }
function classify(state: Checkpoint) {
  const votes = rules.map(([purpose], index) => ({ purpose, count: state.votes[purpose] ?? 0, index })).filter(row => row.count > 0).sort((a, b) => b.count - a.count || a.index - b.index);
  if (votes[0]) return { purpose: votes[0].purpose, purpose_source: 'prompt-rule', purpose_confidence: 'medium' };
  const purpose = state.test ? 'test' : state.write ? 'feature' : state.read ? 'learning' : 'unknown';
  return { purpose, purpose_source: purpose === 'unknown' ? 'insufficient_evidence' : 'behavior', purpose_confidence: purpose === 'unknown' ? 'unknown' : 'low' };
}

export function createSessionDerivationService(db: Pick<Database,'transaction'|'query'>, options: { batchSize?: number; leaseMs?: number; clock?: () => Date; minimumCutoff?:string } = {}) {
  const batchSize = options.batchSize ?? 8; const now = options.clock ?? (() => new Date()); let nextStaleDiscovery=0;
  const leaseMs = options.leaseMs ?? 30_000;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 16) throw new Error('Derivation batch size must be 1..16');
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 50 || leaseMs > 120_000) throw new Error('Derivation lease must be 50..120000 milliseconds');
  if(options.minimumCutoff!==undefined&&!Number.isFinite(Date.parse(options.minimumCutoff)))throw new Error('Valid minimum cutoff required');
  function prepareFact(event:Fact,userId:string){const payload=event.payload,prompt=event.event_type==='UserPromptSubmit',tool=['PreToolUse','PostToolUse'].includes(event.event_type);return {userId,eventType:event.event_type,installationId:event.installation_id,digest:event.payload_digest,prompt:prompt?estimate(string(payload.prompt)):'0',input:tool?estimate(payload.tool_input):'0',output:event.event_type==='PostToolUse'?estimate(payload.tool_response):'0',assistant:event.event_type==='Stop'?estimate(payload.last_assistant_message??payload.text_content):'0',purpose:prompt?rules.find(([,pattern])=>pattern.test(string(payload.prompt)))?.[0]??null:null};}
  type Prepared=ReturnType<typeof prepareFact>;
  async function prepareBatch(claimed:{id:string;generation:number;payload:{session_id:string}}){
    const cache=new Map<string,Prepared>();
    const metadata=(await db.query<{user_id:string;cleanup_generation:number;from_at:string;last_at:string;cutoff:string;progress:{run_id?:string}}>(`SELECT s.user_id,u.cleanup_generation,GREATEST(s.first_at,d.retention_cutoff,$2::timestamptz,$3::timestamptz)::text AS from_at,s.last_at::text,GREATEST(d.retention_cutoff,$2::timestamptz,$3::timestamptz)::text AS cutoff,j.progress FROM sessions s JOIN users u ON u.id=s.user_id CROSS JOIN data_identity d JOIN jobs j ON j.id=$4 WHERE s.id=$1`,[claimed.payload.session_id,new Date(now().getTime()-365*86400000),options.minimumCutoff??null,claimed.id])).rows[0];if(!metadata)return cache;
    const previous=metadata.progress.run_id?(await db.query<Run>(`SELECT ${runColumns},from_at<$3::timestamptz AS retention_stale FROM session_derivations WHERE id=$1 AND session_id=$2 AND state='building'`,[metadata.progress.run_id,claimed.payload.session_id,metadata.cutoff])).rows[0]:undefined;
    const usable=previous&&!previous.retention_stale&&previous.cleanup_generation===metadata.cleanup_generation&&previous.metric_version===SESSION_DERIVATION_VERSION?previous:undefined,cursor=usable?.checkpoint.cursor;
    const page=(await db.query<Fact>(`SELECT id,occurred_at::text AS at,received_at::text AS received_at,${orderSql} AS event_order,event_type,timestamp_source,installation_id,department_id,(occurred_at AT TIME ZONE 'Asia/Shanghai')::date::text AS business_date,payload,${stopObservationSql} AS stop,encode(sha256(convert_to(payload::text,'UTF8')),'hex') AS payload_digest FROM hook_events e WHERE session_id=$1 AND occurred_at>=$2 AND occurred_at<=$3 AND capture_generation<=$4 AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at) AND ($5::timestamptz IS NULL OR (occurred_at,${orderSql},id)>($5::timestamptz,$6::integer,$7::uuid)) ORDER BY occurred_at,${orderSql},id LIMIT $8`,[claimed.payload.session_id,usable?.from_at??metadata.from_at,usable?.to_at??metadata.last_at,usable?.source_generation??claimed.generation,cursor?.at??null,cursor?.order??null,cursor?.id??null,batchSize])).rows;
    // CPU-heavy token estimates and repository scanning run with no user/session
    // write lock. The authoritative write transaction still re-reads each fact.
    for(const event of page)cache.set(event.id+'|'+event.at,prepareFact(event,metadata.user_id));return cache;
  }
  async function consume(client: Transaction, run: Run, event: Fact, prepared:Prepared) {
    const state = run.checkpoint; const payload = event.payload; let purpose: Purpose | null = null; let behavior: string | null = null; let stepId: string | null = null; let fragmentTurn=state.turn||null;
    if (event.timestamp_source === 'client_observed') quality(state, 'client_observed_time');
    else if (event.timestamp_source === 'unknown') quality(state, 'timestamp_source_unknown');
    if (state.cursor?.at === event.at) quality(state, 'same_timestamp_order');
    state.processed++;
    if (event.event_type === 'UserPromptSubmit') {
      state.turn++; fragmentTurn=state.turn; delete state.last_stop_reentry_count;
      const prompt = string(payload.prompt); if (!prompt) quality(state, 'missing_prompt_text');
      purpose = prepared.purpose;
      if (purpose) state.votes[purpose] = (state.votes[purpose] ?? 0) + 1;
      await client.query('INSERT INTO session_turns(run_id,turn_index,prompt_event_id,prompt_at,last_at,prompt_tokens_estimate) VALUES($1,$2,$3,$4,$4,$5)', [run.id, state.turn, event.id, event.at, prepared.prompt]);
    } else if (event.event_type === 'PreToolUse' || event.event_type === 'PostToolUse') {
      const pre = event.event_type === 'PreToolUse'; const toolId = identityText(payload.tool_use_id); const name = identityText(payload.tool_name, 256); let turn = state.turn || null;
      type ToolStep={id:string;turn_index:number|null;pre_event_id:string|null;post_event_id:string|null;tool_name:string|null;input_event_id:string|null};
      const candidates=toolId?(await client.query<ToolStep>(`SELECT id,turn_index,pre_event_id,post_event_id,tool_name,input_event_id FROM session_steps
        WHERE run_id=$1 AND installation_id=$2 AND tool_use_id=$3 AND (NOT $4::boolean OR turn_index IS NOT DISTINCT FROM $5 OR (turn_index IS NULL AND pre_event_id IS NULL)) ORDER BY id LIMIT 2`,[run.id,event.installation_id,toolId,pre,turn])).rows:[];
      const repeatedPre=pre&&candidates.some(candidate=>candidate.pre_event_id!==null);
      const conflict=repeatedPre||candidates.length>1||(candidates.length===1&&!!name&&!!candidates[0]!.tool_name&&candidates[0]!.tool_name!==name);
      const found=conflict?null:candidates[0];
      if(conflict){if(!pre)turn=null;quality(state,'tool_identity_conflict');if(repeatedPre)quality(state,'repeated_tool_events');}
      else if(!pre){turn=found?.pre_event_id?found.turn_index:null;if(found?.pre_event_id&&turn!==state.turn)quality(state,'cross_turn_tool_response');}
      if(pre&&found&&found.turn_index===null&&turn!==null&&found.pre_event_id===null){
        await client.query('UPDATE session_steps SET turn_index=$3 WHERE run_id=$1 AND id=$2',[run.id,found.id,turn]);
        await client.query('UPDATE session_fragments SET turn_index=$3 WHERE run_id=$1 AND step_id=$2',[run.id,found.id,turn]);
      }
      fragmentTurn=turn;
      if (!turn) quality(state, 'orphan_events'); if (!toolId) quality(state, 'missing_tool_identity');
      stepId = found?.id ?? event.id;
      if (!found) await client.query("INSERT INTO session_steps(run_id,id,turn_index,installation_id,tool_use_id,tool_name,status) VALUES($1,$2,$3,$4,$5,$6,'incomplete')", [run.id, stepId, turn, event.installation_id, conflict&&!pre?null:toolId, name]);
      if ((pre && found?.pre_event_id) || (!pre && found?.post_event_id)) quality(state, 'repeated_tool_events');
      if (found?.tool_name && name && found.tool_name !== name) quality(state, 'tool_identity_conflict');
      if (pre) {
        await client.query(`UPDATE session_steps SET pre_event_id=COALESCE(pre_event_id,$3),pre_at=COALESCE(pre_at,$4),tool_name=COALESCE(tool_name,$5),input_tokens_estimate=CASE WHEN post_event_id IS NULL OR input_event_id IS NULL THEN $6 ELSE input_tokens_estimate END,input_event_id=CASE WHEN post_event_id IS NULL OR input_event_id IS NULL THEN $7::uuid ELSE input_event_id END,input_at=CASE WHEN post_event_id IS NULL OR input_event_id IS NULL THEN $8::timestamptz ELSE input_at END WHERE run_id=$1 AND id=$2`, [run.id, stepId, event.id, event.at, name, prepared.input, payload.tool_input === undefined ? null : event.id, payload.tool_input === undefined ? null : event.at]);
      } else {
        const error = errorEvidence(payload.tool_response);
        const status = error ? 'error' : successEvidence(payload.tool_response) ? 'success' : 'returned';
        if (status === 'returned') quality(state, 'tool_outcome_unknown');
        await client.query(`UPDATE session_steps SET post_event_id=$3,post_at=$4,tool_name=COALESCE(tool_name,$5),input_tokens_estimate=CASE WHEN $6::boolean OR pre_event_id IS NULL THEN $7 ELSE input_tokens_estimate END,output_tokens_estimate=$8,status=$9,error_evidence=$10,input_event_id=CASE WHEN $6::boolean OR pre_event_id IS NULL THEN $11::uuid ELSE input_event_id END,input_at=CASE WHEN $6::boolean OR pre_event_id IS NULL THEN $12::timestamptz ELSE input_at END WHERE run_id=$1 AND id=$2`, [run.id, stepId, event.id, event.at, name, payload.tool_input !== undefined, prepared.input, prepared.output, status, error, payload.tool_input === undefined ? null : event.id, payload.tool_input === undefined ? null : event.at]);
      }
      if(pre&&(!found||found.input_event_id===null) || !pre&&(payload.tool_input!==undefined||!found?.pre_event_id)) await client.query('UPDATE session_steps SET simulation_mutating=$3 WHERE run_id=$1 AND id=$2',[run.id,stepId,simulationAction(name,payload.tool_input)]);
      const result = await client.query<{ reversed: boolean }>(`UPDATE session_steps SET duration_ms=CASE WHEN pre_at<=post_at THEN floor(extract(epoch FROM(post_at-pre_at))*1000)::bigint ELSE NULL END WHERE run_id=$1 AND id=$2 RETURNING pre_at>post_at AS reversed`, [run.id, stepId]);
      if (result.rows[0]?.reversed) quality(state, 'clock_order_conflict');
      if (['Write', 'Edit', 'SearchReplace'].includes(name ?? '')) { state.write = true; behavior = 'feature'; }
      if (['Read', 'Grep', 'Glob', 'LS', 'SearchCodebase', 'GetDiagnostics'].includes(name ?? '')) { state.read = true; behavior = 'learning'; }
      if (name === 'RunCommand' && record(payload.tool_input) && /\b(test|pytest|jest|vitest|mocha)\b|go\s+test/i.test(string(payload.tool_input.command))) { state.test = true; behavior = 'test'; }
    } else if (event.event_type === 'Stop') {
      const observation=event.stop!;
      if(observation.count_state==='missing')quality(state,'stop_reentry_count_missing');
      else if(observation.count_state==='invalid')quality(state,'stop_reentry_count_invalid');
      else if(observation.reentry_count!==null){
        if(state.last_stop_reentry_count!==undefined&&observation.reentry_count<state.last_stop_reentry_count)quality(state,'stop_reentry_count_reset');
        state.last_stop_reentry_count=observation.reentry_count;
      }

      if (state.turn) await client.query("UPDATE session_turns SET response_event_id=$3,response_at=$4,completion_kind='stop_observed' WHERE run_id=$1 AND turn_index=$2", [run.id, state.turn, event.id, event.at]);
      else quality(state, 'orphan_events');
    } else if (event.event_type === 'Notification' && payload.notification_type === 'idle_prompt' && state.turn) {
      const candidates=(await client.query<{turn_index:number}>("SELECT turn_index FROM session_turns WHERE run_id=$1 AND response_event_id IS NOT NULL AND completion_kind<>'idle_prompt' ORDER BY turn_index LIMIT 2",[run.id])).rows;
      if(candidates.length===1&&candidates[0]!.turn_index===state.turn){
        await client.query("UPDATE session_turns SET completion_kind='idle_prompt',completion_event_id=$3,completion_at=$4 WHERE run_id=$1 AND turn_index=$2",[run.id,state.turn,event.id,event.at]);
        quality(state,'completion_association_inferred');
      }else{fragmentTurn=null;quality(state,candidates.length>1?'completion_association_ambiguous':'unpaired_completion_notification');}
    }
    if (fragmentTurn) await client.query(`UPDATE session_turns SET last_at=GREATEST(last_at,$3),
      completion_kind=CASE WHEN $4 THEN CASE WHEN response_event_id IS NULL THEN 'missing' ELSE 'stop_observed' END ELSE completion_kind END,
      completion_event_id=CASE WHEN $4 THEN NULL ELSE completion_event_id END,completion_at=CASE WHEN $4 THEN NULL ELSE completion_at END
      WHERE run_id=$1 AND turn_index=$2`, [run.id, fragmentTurn, event.at,['PreToolUse','PostToolUse','Stop'].includes(event.event_type)]);
    const assistant = prepared.assistant;
    await client.query('INSERT INTO session_fragments(run_id,session_id,user_id,department_id,event_id,occurred_at,business_date,kind,ordinal,turn_index,step_id,purpose,assistant_tokens_estimate,behavior_purpose,hook_model) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)', [run.id, run.session_id, run.user_id, event.department_id, event.id, event.at, event.business_date, event.event_type, state.processed, fragmentTurn, stepId, purpose, assistant, behavior, identityText(payload.model,256)]);
    state.cursor = { at: event.at, order: event.event_order, id: event.id };
    return { business_date: event.business_date, department_id: event.department_id, prompt_count: event.event_type === 'UserPromptSubmit' ? 1 : 0, tool_event_count: event.event_type === 'PostToolUse' ? 1 : 0, received_at: event.received_at };
  }
  async function finishBatch(client: Transaction, run: Run, jobId: string, lease: string, status: string, progress: Record<string, unknown>) {
    const committed = await client.query(`UPDATE jobs SET status=$3,progress=$4,lease_token=NULL,lease_until=NULL,error_code=NULL,attempt=0,available_at=clock_timestamp()
      WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>clock_timestamp()
      AND EXISTS(SELECT 1 FROM users WHERE id=$5 AND cleanup_generation=$6) RETURNING id`, [jobId, lease, status, progress, run.user_id, run.cleanup_generation]);
    if (!committed.rowCount) throw new DomainError('stale_derivation_lease', 409);
  }
  async function publish(client: Transaction, run: Run, jobId: string, currentGeneration: number, lease: string) {
    const steps = (await client.query<{ count: string; errors: string; missing: string; tokens: string }>("SELECT count(*) AS count,count(*) FILTER(WHERE status='error') AS errors,count(*) FILTER(WHERE pre_event_id IS NULL OR post_event_id IS NULL) AS missing,COALESCE(sum(input_tokens_estimate+output_tokens_estimate),0)::text AS tokens FROM session_steps WHERE run_id=$1", [run.id])).rows[0]!;
    const counts = (await client.query<{ events: string; prompts: string; tools: string }>('SELECT COALESCE(sum(event_count),0)::text AS events,COALESCE(sum(prompt_count),0)::text AS prompts,COALESCE(sum(tool_event_count),0)::text AS tools FROM session_days WHERE run_id=$1', [run.id])).rows[0]!;
    const promptTokens = (await client.query<{ tokens: string; unconfirmed: string }>("SELECT COALESCE(sum(prompt_tokens_estimate),0)::text AS tokens,count(*) FILTER(WHERE completion_kind<>'idle_prompt') AS unconfirmed FROM session_turns WHERE run_id=$1", [run.id])).rows[0]!;
    const assistantTokens = (await client.query<{ tokens: string }>('SELECT COALESCE(sum(assistant_tokens_estimate),0)::text AS tokens FROM session_fragments WHERE run_id=$1 AND occurred_at>=$2 AND occurred_at<=$3', [run.id, run.from_at, run.to_at])).rows[0]!.tokens;
    const last = (await client.query<{ completion_kind: string }>('SELECT completion_kind FROM session_turns WHERE run_id=$1 ORDER BY turn_index DESC LIMIT 1', [run.id])).rows[0];
    if (steps.missing !== '0') quality(run.checkpoint, 'incomplete_tool_pairs');
    if (promptTokens.unconfirmed !== '0') quality(run.checkpoint, 'completion_unconfirmed');
    const status = last?.completion_kind === 'idle_prompt' ? 'completed' : 'unknown';
    const summary = { event_count: Number(counts.events), prompt_count: Number(counts.prompts), tool_event_count: Number(counts.tools), step_count: Number(steps.count), error_count: Number(steps.errors), status, ...classify(run.checkpoint), content_tokens_estimate: (BigInt(steps.tokens) + BigInt(promptTokens.tokens) + BigInt(assistantTokens)).toString(), estimation_version: 'content-heuristic-v1', quality: [...run.checkpoint.qualities].sort() };
    await client.query("UPDATE session_derivations SET state='superseded',retire_after=clock_timestamp()+interval '10 minutes' WHERE id=(SELECT derived_run_id FROM sessions WHERE id=$1) AND id<>$2", [run.session_id, run.id]);
    await client.query("UPDATE session_derivations SET state='published',summary=$2,checkpoint=$3,computed_at=clock_timestamp() WHERE id=$1", [run.id, summary, run.checkpoint]);
    await client.query('UPDATE sessions SET derived_run_id=$2,status=$3 WHERE id=$1', [run.session_id, run.id, status]);
    await finishBatch(client, run, jobId, lease, currentGeneration === run.source_generation ? 'succeeded' : 'queued', {});
  }
  async function runOne(sessionId?:string): Promise<boolean> {
    const claimed = await db.transaction(async client => {
      const row = (await client.query<{ id: string; generation: number; payload: { session_id: string }; attempt: number }>("SELECT id,generation,payload,attempt FROM jobs WHERE kind='derive_session' AND ($1::uuid IS NULL OR payload->>'session_id'=$1::uuid::text) AND ((status='queued' AND available_at<=clock_timestamp()) OR (status='running' AND lease_until<clock_timestamp())) ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED",[sessionId??null])).rows[0];
      if (!row) return null; const lease = randomUUID();
      await client.query("UPDATE jobs SET status='running',lease_token=$2,lease_until=clock_timestamp()+$3*interval '1 millisecond',attempt=attempt+1 WHERE id=$1", [row.id, lease, leaseMs]); return { ...row, lease };
    });
    if (!claimed) return false;
    try {
      const prepared=await prepareBatch(claimed);
      await db.transaction(async client => {
        const retention = (await client.query<{cutoff:string;recovery_id:string|null}>('SELECT GREATEST(retention_cutoff,$1::timestamptz,$2::timestamptz)::text AS cutoff,recovery_id FROM data_identity FOR SHARE',[new Date(now().getTime()-365*86400000),options.minimumCutoff??null])).rows[0]!;
        if(retention.recovery_id)throw new DomainError('recovery_quarantined',503);
        const owner = (await client.query<{ user_id: string }>('SELECT user_id FROM sessions WHERE id=$1', [claimed.payload.session_id])).rows[0];
        if (!owner) throw new DomainError('session_missing', 404);
        const user = (await client.query<{ cleanup_generation: number }>('SELECT cleanup_generation FROM users WHERE id=$1 FOR UPDATE', [owner.user_id])).rows[0]!;
        const session = (await client.query<{ from_at: string; last_at: string;expired:boolean }>('SELECT GREATEST(first_at,$2::timestamptz)::text AS from_at,last_at::text AS last_at,last_at<$2::timestamptz AS expired FROM sessions WHERE id=$1 FOR UPDATE', [claimed.payload.session_id,retention.cutoff])).rows[0];
        if (!session) throw new DomainError('session_missing', 404);
        const job = (await client.query<{ generation: number; progress: { run_id?: string }; lease_token: string; valid: boolean }>("SELECT generation,progress,lease_token,(status='running' AND lease_until>clock_timestamp()) AS valid FROM jobs WHERE id=$1 FOR UPDATE", [claimed.id])).rows[0];
        if (!job?.valid || job.lease_token !== claimed.lease) throw new DomainError('stale_derivation_lease', 409);
        let run = job.progress.run_id ? (await client.query<Run>(`SELECT ${runColumns},from_at<$4::timestamptz AS retention_stale FROM session_derivations WHERE id=$1 AND session_id=$2 AND state=$3`, [job.progress.run_id, claimed.payload.session_id, 'building',retention.cutoff])).rows[0] : undefined;
        if (run && (run.retention_stale || run.cleanup_generation !== user.cleanup_generation || run.metric_version !== SESSION_DERIVATION_VERSION)) {
          await client.query("UPDATE session_derivations SET state='abandoned',retire_after=clock_timestamp() WHERE id=$1", [run.id]); run = undefined;
        }
        if (!run) {
          const checkpoint: Checkpoint = { cursor: null, turn: 0, processed: 0, votes: {}, qualities: [], write: false, read: false, test: false };
          if(session.expired){await client.query("UPDATE jobs SET status='cancelled',error_code='retention_expired',lease_token=NULL,lease_until=NULL,progress='{}' WHERE id=$1 AND lease_token=$2",[claimed.id,claimed.lease]);return;}
          const from = session.from_at;
          run = (await client.query<Run>(`INSERT INTO session_derivations(id,session_id,user_id,source_generation,cleanup_generation,from_at,to_at,checkpoint,metric_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${runColumns}`, [randomUUID(), claimed.payload.session_id, owner.user_id, claimed.generation, user.cleanup_generation, from, session.last_at, checkpoint, SESSION_DERIVATION_VERSION])).rows[0]!;
        }
        const cursor = run.checkpoint.cursor;
        const page = (await client.query<Fact>(`SELECT id,occurred_at::text AS at,received_at::text AS received_at,${orderSql} AS event_order,event_type,timestamp_source,installation_id,department_id,(occurred_at AT TIME ZONE 'Asia/Shanghai')::date::text AS business_date,payload,${stopObservationSql} AS stop,encode(sha256(convert_to(payload::text,'UTF8')),'hex') AS payload_digest FROM hook_events e
          WHERE session_id=$1 AND occurred_at>=$2 AND occurred_at<=$3 AND capture_generation<=$4
          AND NOT EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=e.user_id AND t.from_at<=e.occurred_at AND t.to_at>e.occurred_at)
          AND ($5::timestamptz IS NULL OR (occurred_at,${orderSql},id)>($5::timestamptz,$6::integer,$7::uuid))
          ORDER BY occurred_at,${orderSql},id LIMIT $8`, [run.session_id, run.from_at, run.to_at, run.source_generation, cursor?.at ?? null, cursor?.order ?? null, cursor?.id ?? null, batchSize + 1])).rows;
        const contributions: Awaited<ReturnType<typeof consume>>[]=[];
        for (const event of page.slice(0, batchSize)){const cached=prepared.get(event.id+'|'+event.at);contributions.push(await consume(client,run,event,cached?.userId===run.user_id&&cached.digest===event.payload_digest&&cached.eventType===event.event_type&&cached.installationId===event.installation_id?cached:prepareFact(event,run.user_id)));}
        if (contributions.length) {
          const values=JSON.stringify(contributions);
          // Each conflict key appears once, including NULL departments. Keep all
          // counters and the exact received-time maximum in this batch's transaction.
          await client.query(`INSERT INTO session_days(run_id,session_id,user_id,business_date,department_id,event_count,prompt_count,tool_event_count)
            SELECT $1,$2,$3,business_date,department_id,count(*)::integer,sum(prompt_count)::integer,sum(tool_event_count)::integer
            FROM jsonb_to_recordset($4::jsonb) x(business_date date,department_id uuid,prompt_count integer,tool_event_count integer)
            GROUP BY business_date,department_id
            ON CONFLICT(run_id,business_date,department_id) DO UPDATE SET event_count=session_days.event_count+excluded.event_count,prompt_count=session_days.prompt_count+excluded.prompt_count,tool_event_count=session_days.tool_event_count+excluded.tool_event_count`,[run.id,run.session_id,run.user_id,values]);
          await client.query(`UPDATE session_derivations SET source_watermark=GREATEST(source_watermark,
            (SELECT max(received_at) FROM jsonb_to_recordset($2::jsonb) x(received_at timestamptz))) WHERE id=$1`,[run.id,values]);
        }
        if (page.length <= batchSize) await publish(client, run, claimed.id, job.generation, claimed.lease);
        else {
          await client.query('UPDATE session_derivations SET checkpoint=$2 WHERE id=$1', [run.id, run.checkpoint]);
          await finishBatch(client, run, claimed.id, claimed.lease, 'queued', { run_id: run.id });
        }
      });
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'derivation_failed';
      const retry = ['55P03', '40001', '40P01', '57014', 'database_io_timeout', 'database_unavailable', 'stale_derivation_lease'].includes(code) && claimed.attempt < 2;
      await db.query("UPDATE jobs SET status=$3,error_code=$4,lease_until=NULL,lease_token=NULL,available_at=clock_timestamp()+interval '1 second' WHERE id=$1 AND lease_token=$2 AND status='running'", [claimed.id, claimed.lease, code === 'session_missing' ? 'cancelled' : retry ? 'queued' : 'failed', code]);
    }
    return true;
  }
  async function discoverStale(){
    if(now().getTime()<nextStaleDiscovery)return 0;nextStaleDiscovery=now().getTime()+30000;
    const result=await db.query(`WITH candidates AS MATERIALIZED (
      SELECT s.id FROM sessions s JOIN session_derivations r ON r.id=s.derived_run_id
      CROSS JOIN (SELECT retention_cutoff,recovery_id FROM data_identity WHERE singleton=true LIMIT 1) d
      LEFT JOIN jobs j ON j.dedupe_key='derive:'||s.id::text
      WHERE r.state='published' AND r.metric_version<>$1 AND d.recovery_id IS NULL
        AND s.last_at>=GREATEST(d.retention_cutoff,$2::timestamptz,$3::timestamptz) AND (j.id IS NULL OR j.status='succeeded')
      ORDER BY s.last_at DESC,s.id LIMIT 20
    ) INSERT INTO jobs(id,kind,dedupe_key,payload)
      SELECT gen_random_uuid(),'derive_session','derive:'||id::text,jsonb_build_object('session_id',id::text) FROM candidates
      ON CONFLICT(dedupe_key) DO UPDATE SET generation=jobs.generation+1,status='queued',attempt=0,error_code=NULL,available_at=clock_timestamp()
      WHERE jobs.status='succeeded' RETURNING id`,[SESSION_DERIVATION_VERSION,new Date(now().getTime()-365*86400000),options.minimumCutoff??null]);
    return result.rowCount??0;
  }
  // Trusted operator/maintenance seam. Any future HTTP adapter must add explicit
  // superadmin authorization and audit, rather than accepting arbitrary callers.
  async function enqueueRebuild(sessionId: string) {
    await db.transaction(async client => {
      const owner = (await client.query<{ user_id: string }>('SELECT user_id FROM sessions WHERE id=$1', [sessionId])).rows[0]; if (!owner) throw new DomainError('not_found', 404);
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner.user_id]);
      await client.query(`INSERT INTO jobs(id,kind,dedupe_key,payload) VALUES($1,'derive_session',$2,$3) ON CONFLICT(dedupe_key) DO UPDATE SET generation=jobs.generation+1,status=CASE WHEN jobs.status='running' THEN 'running' ELSE 'queued' END,attempt=0,error_code=NULL,available_at=clock_timestamp()`, [randomUUID(), `derive:${sessionId}`, { session_id: sessionId }]);
    });
  }
  async function pruneRetired(): Promise<boolean> {
    const result = await db.transaction(async client => {return client.query(`DELETE FROM session_derivations WHERE id IN(
      SELECT r.id FROM session_derivations r WHERE r.state IN('superseded','abandoned') AND r.retire_after<clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.derived_run_id=r.id)
      ORDER BY r.retire_after,r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1) RETURNING id`);});
    return Boolean(result?.rowCount);
  }
  return { runOne, enqueueRebuild, discoverStale, pruneRetired };
}
