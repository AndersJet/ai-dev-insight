import {type ProjectContext} from '@adi/contracts';
import {normalizeProjectPath as pathKey} from './project-path.js';
import {persistProjectObservation,type ObservationOutcome} from './project-observation-store.js';
import type {Transaction} from './index.js';

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const safeText=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!Array.from(value).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127);
function valid(context:ProjectContext):boolean{
  if(!plain(context)||!uuid(context.collector_id)||!['macos','windows','linux'].includes(context.platform))return false;
  if(context.workspace===null)return ['missing_workspace','ambiguous_workspace','invalid_workspace'].includes(context.unresolved_reason??'')&&context.observation===null;
  if(!pathKey(context.workspace,context.platform)||context.unresolved_reason!==null)return false;
  const observation=context.observation;if(observation===null)return true;
  if(!plain(observation)||!uuid(observation.id)||typeof observation.sequence!=='string'||!/^[1-9][0-9]{0,18}$/.test(observation.sequence)||BigInt(observation.sequence)>9223372036854775807n||typeof observation.observed_at!=='string'||!Number.isFinite(Date.parse(observation.observed_at)))return false;
  if(!['repository','not_git','no_remote','failed','unknown'].includes(observation.state)||!Array.isArray(observation.remotes)||observation.remotes.length>64)return false;
  if(!observation.remotes.every(remote=>plain(remote)&&(remote.name===undefined||safeText(remote.name,128))&&(remote.direction===undefined||['fetch','push'].includes(remote.direction))&& (remote.address===null||safeText(remote.address,4096))))return false;
  if(['repository','no_remote'].includes(observation.state))return observation.reason===null&&!!pathKey(observation.git_root,context.platform)&&(observation.state==='repository'?observation.remotes.length>0:observation.remotes.length===0);
  if(observation.git_root!==null||observation.remotes.length)return false;
  return observation.state==='not_git'?observation.reason===null:['git_missing','inaccessible','timeout','invalid_git_output','output_limit','git_error'].includes(observation.reason??'');
}
export type ProjectIngestOutcome=ObservationOutcome|'pending';
export async function persistProjectContext(sql:Transaction,input:ProjectContext,source:{userId:string;eventId:string;eventAt:string;sessionId:string;receivedAt:Date;cleanupGeneration:number}):Promise<ProjectIngestOutcome>{
  if(!valid(input))return 'invalid';
  const collector=input.collector_id.toLowerCase();
  if(input.workspace===null||input.observation===null){
    await sql.query('INSERT INTO project_hook_links(event_id,occurred_at,user_id,collector_id,session_id,unresolved_reason,workspace,platform) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[source.eventId,source.eventAt,source.userId,collector,source.sessionId,input.unresolved_reason??'probe_pending',input.workspace,input.platform]);return 'pending';
  }
  const result=await persistProjectObservation(sql,{collector_id:collector,platform:input.platform,workspace:input.workspace,observation:input.observation},{...source,sourceKind:'hook'});
  await sql.query('INSERT INTO project_hook_links(event_id,occurred_at,user_id,collector_id,project_id,session_id,observation_id,workspace,platform) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[source.eventId,source.eventAt,source.userId,collector,result.projectId,source.sessionId,result.observationId,input.workspace,input.platform]);
  return result.outcome;
}
