import {createHash} from 'node:crypto';
import {simulationBaseline} from './simulation-baseline.js';
import type {Database,Queryable} from '@adi/storage';
import {DomainError} from './errors.js';
import {SESSION_DERIVATION_VERSION} from './session-derivation.js';
export interface SimulationInput {base_tokens?:string;model?:string;min_call_gap_ms?:number;overlap_gap_ms?:number;mutating_gap_ms?:number;max_batch_steps?:number}
export interface SimulationBaseline {tokens:string;source:'default'|'scenario_override'|'personal_model'|'model_mean';model:string|null;samples:number;version:string;reason:string|null;training_before:string;calibrated:boolean}
export interface BillingSimulation {computed_at:string|null;source_version:string|null;kind:'billing_simulation';metric_version:string;period:{from:string;to:string};reason:string|null;baseline:SimulationBaseline;parameters:{min_call_gap_ms:number;overlap_gap_ms:number;mutating_gap_ms:number;max_batch_steps:number};simulated_input_tokens:string|null;hypothetical_calls:number|null;observed_output_tokens:string|null;context_tokens:string|null;amount:null;warnings:string[];turns:{turn_index:number;hypothetical_calls:number;simulated_input_tokens:string}[];as_of:string|null}
/** Authorized session read model. It emits a hypothetical input total, never a bill. */
export async function queryBillingSimulation(db:Database,id:string,userId:string,period:{from:string;to:string},input:SimulationInput,account?:string,computedAt=new Date()):Promise<BillingSimulation>{
 const parameters={min_call_gap_ms:input.min_call_gap_ms??2000,overlap_gap_ms:input.overlap_gap_ms??800,mutating_gap_ms:input.mutating_gap_ms??800,max_batch_steps:input.max_batch_steps??6};
 if(Object.values(parameters).some(v=>!Number.isInteger(v)||v<0||v>60000)||parameters.max_batch_steps<1||parameters.max_batch_steps>100||parameters.overlap_gap_ms>parameters.mutating_gap_ms||parameters.mutating_gap_ms>parameters.min_call_gap_ms||input.model!==undefined&&(!input.model.trim()||input.model.length>256)||input.base_tokens!==undefined&&(!/^(0|[1-9]\d{0,6})$/.test(input.base_tokens)||BigInt(input.base_tokens)>1000000n))throw new DomainError('invalid_request',400);
 const result:BillingSimulation={computed_at:null,source_version:null,kind:'billing_simulation',metric_version:'context-replay-simulation-v2',period,reason:null,baseline:simulationBaseline({period,model:input.model?.trim()??null,override:input.base_tokens,sourceConfigured:!!account}),parameters,simulated_input_tokens:null,hypothetical_calls:null,observed_output_tokens:null,context_tokens:null,amount:null,warnings:['hypothetical_calls_not_observed','full_context_replay_assumption','cache_and_compression_not_modeled'],turns:[],as_of:null};
 const read=async(sql:Queryable=db)=> (await sql.query<{dataset_id:string;recovery_id:string|null;retention_stale:boolean;run_id:string|null;first_at:Date;last_at:Date;computed_at:Date|null;source_generation:number|null;generation:number;cleanup_generation:number;quality:string[]|null;history_redacted:boolean;history_expired:boolean;cleared:boolean}>(`SELECT d.dataset_id,d.recovery_id,COALESCE(r.from_at<d.retention_cutoff,false) AS retention_stale,r.id AS run_id,s.first_at,s.last_at,s.history_redacted,s.history_expired,r.computed_at,r.source_generation,j.generation,u.cleanup_generation,r.summary->'quality' AS quality,
 EXISTS(SELECT 1 FROM cleanup_tombstones c WHERE c.user_id=u.id AND c.from_at<=s.last_at AND c.to_at>s.first_at) AS cleared
 FROM sessions s JOIN users u ON u.id=s.user_id CROSS JOIN (SELECT dataset_id,recovery_id,retention_cutoff FROM data_identity WHERE singleton=true LIMIT 1) d JOIN jobs j ON j.dedupe_key='derive:'||s.id::text AND j.kind='derive_session'
 LEFT JOIN session_derivations r ON r.id=s.derived_run_id AND r.user_id=u.id AND r.session_id=s.id AND r.state='published' AND r.cleanup_generation=u.cleanup_generation AND r.metric_version=$3
 WHERE s.id=$1 AND s.user_id=$2`,[id,userId,SESSION_DERIVATION_VERSION])).rows[0];
 const before=await read();if(before?.recovery_id)throw new DomainError('recovery_quarantined',503);if(!before?.run_id||before.source_generation!<before.generation){result.reason='projection_pending';return result;}
 result.as_of=before.computed_at?.toISOString()??null;
 if(before.first_at.getTime()<Date.parse(period.from)||before.last_at.getTime()>=Date.parse(period.to)||before.cleared||before.history_redacted||before.history_expired||before.retention_stale){result.reason='partial_history';return result;}
 if(before.quality?.includes('missing_prompt_text')){result.reason='missing_prompt_content';return result;}
 const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 result.source_version=digest([before.dataset_id,before.run_id,period]);
 const cacheKey=digest([result.source_version,result.metric_version,result.baseline.version,parameters,input.base_tokens??null,input.model?.trim()??null,!!account]);
 const cached=async(sql:Queryable=db)=>(await sql.query<{result:BillingSimulation}>('SELECT result FROM session_simulation_cache WHERE session_id=$1 AND user_id=$2 AND run_id=$3 AND cache_key=$4',[id,userId,before.run_id,cacheKey])).rows[0]?.result;
 const saved=await cached();if(saved){if(JSON.stringify(before)!==JSON.stringify(await read()))throw new DomainError('content_changed',409);return saved;}

 const turns=(await db.query<{turn_index:number;prompt:string;output:string}>(`SELECT t.turn_index,t.prompt_tokens_estimate::text AS prompt,COALESCE(sum(f.assistant_tokens_estimate),0)::text AS output
 FROM session_turns t LEFT JOIN session_fragments f ON f.run_id=t.run_id AND f.turn_index=t.turn_index AND f.occurred_at>=$2 AND f.occurred_at<$3
 WHERE t.run_id=$1 GROUP BY t.run_id,t.turn_index,t.prompt_tokens_estimate ORDER BY t.turn_index LIMIT 2001`,[before.run_id,period.from,period.to])).rows;
 if(turns.length>2000){result.reason='simulation_limit';return result;}
 const steps=(await db.query<{id:string;turn_index:number|null;pre_at:Date|null;post_at:Date|null;input:string;output:string;simulation_mutating:boolean|null}>(`SELECT id,turn_index,pre_at,post_at,input_tokens_estimate::text AS input,output_tokens_estimate::text AS output,simulation_mutating FROM session_steps WHERE run_id=$1 ORDER BY turn_index,COALESCE(pre_at,post_at),id LIMIT 10001`,[before.run_id])).rows;
 const replies=(await db.query<{turn_index:number|null;at:Date;tokens:string}>(`SELECT turn_index,occurred_at AS at,assistant_tokens_estimate::text AS tokens FROM session_fragments WHERE run_id=$1 AND occurred_at>=$2 AND occurred_at<$3 AND kind='Stop' ORDER BY occurred_at,ordinal LIMIT 10001`,[before.run_id,period.from,period.to])).rows;
 if(steps.length>10000||replies.length>10000){result.reason='simulation_limit';return result;}
 if(steps.some(step=>step.turn_index===null)||replies.some(reply=>reply.turn_index===null)){result.reason='unattributed_events';return result;}
 if(!turns.length){result.reason='no_prompt_observations';return result;}
 const modelRow=(await db.query<{model:string|null;models:number}>(`SELECT CASE WHEN count(DISTINCT hook_model)=1 THEN min(hook_model) END AS model,count(DISTINCT hook_model)::int AS models FROM session_fragments WHERE run_id=$1 AND occurred_at>=$2 AND occurred_at<$3`,[before.run_id,period.from,period.to])).rows[0]!;
 result.baseline=simulationBaseline({period,model:input.model?.trim()??modelRow.model,override:input.base_tokens,sourceConfigured:!!account});
 if(input.model!==undefined)result.warnings.push('scenario_model_override');
 if(modelRow.models>1){result.warnings.push('multiple_hook_models_unresolved');if(input.base_tokens===undefined)result.baseline.reason='multiple_hook_models_unresolved';}
 result.warnings.push('uncalibrated_scenario','model_identity_unverified');
 result.warnings.push('baseline_is_heuristic_not_measured_overhead');
 const stepGroups=new Map<number,typeof steps>();for(const step of steps){const list=stepGroups.get(step.turn_index!)??[];list.push(step);stepGroups.set(step.turn_index!,list);}
 const replyGroups=new Map<number,typeof replies>();for(const reply of replies){const list=replyGroups.get(reply.turn_index!)??[];list.push(reply);replyGroups.set(reply.turn_index!,list);}
 let carry=0n,total=0n,output=0n,context=0n,calls=0;const base=BigInt(result.baseline.tokens);const warn=(value:string)=>{if(!result.warnings.includes(value))result.warnings.push(value);};
 for(const turn of turns){
  carry+=BigInt(turn.prompt);const contexts=[carry];const tools=stepGroups.get(turn.turn_index)??[];const answers=replyGroups.get(turn.turn_index)??[];let answerIndex=0,end:number|null=null,batchSteps=0,previous:typeof tools[number]|undefined;
  for(const step of tools){
   const start=step.pre_at?.getTime()??null;const finish=step.post_at?.getTime()??null;
   if(start===null||finish===null||finish<start)warn('incomplete_tool_timing');if(step.simulation_mutating===null)warn('unknown_action_kind');
   while(answerIndex<answers.length&&start!==null&&answers[answerIndex]!.at.getTime()<start){carry+=BigInt(answers[answerIndex++]!.tokens);}
   const gap=start!==null&&end!==null?start-end:null;
   if(previous&&gap!==null&&gap>=parameters.overlap_gap_ms&&(gap>=parameters.min_call_gap_ms||(gap>=parameters.mutating_gap_ms&&previous.simulation_mutating===false&&step.simulation_mutating===true)||(batchSteps>=parameters.max_batch_steps&&gap>=1000))){contexts.push(carry);batchSteps=0;end=null;}
   carry+=BigInt(step.input)+BigInt(step.output);if(finish!==null)end=end===null?finish:Math.max(end,finish);else end=null;batchSteps++;previous=step;
  }
  if(tools.length)contexts.push(carry);
  const contextsTotal=contexts.reduce((sum,value)=>sum+value,0n),cost=base*BigInt(contexts.length)+contextsTotal;total+=cost;context+=contextsTotal;calls+=contexts.length;output+=BigInt(turn.output);
  while(answerIndex<answers.length)carry+=BigInt(answers[answerIndex++]!.tokens);
  result.turns.push({turn_index:turn.turn_index,hypothetical_calls:contexts.length,simulated_input_tokens:cost.toString()});
 }
 if(JSON.stringify(before)!==JSON.stringify(await read()))throw new DomainError('content_changed',409);
 result.simulated_input_tokens=total.toString();result.hypothetical_calls=calls;result.observed_output_tokens=output.toString();result.context_tokens=context.toString();result.computed_at=computedAt.toISOString();
 const cacheable=Buffer.byteLength(JSON.stringify(result))<=256*1024;
 return db.transaction(async sql=>{
  await sql.query('SELECT singleton FROM data_identity FOR SHARE');await sql.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);
  if(JSON.stringify(before)!==JSON.stringify(await read(sql)))throw new DomainError('content_changed',409);
  const existing=await cached(sql);if(existing)return existing;
  if(cacheable)await sql.query('INSERT INTO session_simulation_cache(session_id,user_id,run_id,cache_key,result) VALUES($1,$2,$3,$4,$5) ON CONFLICT(session_id) DO UPDATE SET user_id=excluded.user_id,run_id=excluded.run_id,cache_key=excluded.cache_key,result=excluded.result',[id,userId,before.run_id,cacheKey,result]);
  return result;
 });
}
