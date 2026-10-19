import { officialUsageCounters } from './official-token-breakdown.js';
import type {Database} from '@adi/storage';
import type {CurrentUser,PluginTodayDto} from '@adi/contracts';
import type {PluginCredentialService} from './plugin-credentials.js';
import {createAnalyticsService} from './analytics.js';
import {DomainError} from './errors.js';

/** Purpose-limited reader; no Web session or account management roles are created. */
export function createPluginTodayService(db:Database,access:PluginCredentialService,options:{clock?:()=>Date;providerAccount?:string}={}){
  const now=options.clock??(()=>new Date());
  const reader={async requireUser(token:string):Promise<CurrentUser>{const owner=await access.authorize(token);return {user_id:owner.id,email:owner.email_key,display_name:owner.display_name,registered:true,management_source:'system',roles:['employee'],managed_departments:[],allowed_actions:['self:read'],default_route:'/my/overview',must_change_password:false};}};
  const analytics=createAnalyticsService(db,reader,options);
  async function version(userId:string,start:number){const row=(await db.query<{cleanup_generation:number;baseline:Date|null;enabled:boolean;recovery_id:string|null;cleaned:boolean}>(`SELECT u.cleanup_generation,d.collection_baseline_at AS baseline,d.collection_enabled AS enabled,d.recovery_id,
    EXISTS(SELECT 1 FROM cleanup_tombstones t WHERE t.user_id=u.id AND t.from_at<$3 AND t.to_at>$2) AS cleaned
    FROM users u CROSS JOIN data_identity d WHERE u.id=$1`,[userId,new Date(start),new Date(start+86400000)])).rows[0];
    if(!row||row.recovery_id)throw new DomainError('recovery_quarantined',503);if(!row.enabled)throw new DomainError('collection_disabled',503);return row;}
  async function today(token:string):Promise<PluginTodayDto>{
    const actor=await access.authorize(token),at=now(),start=Math.floor((at.getTime()+28800000)/86400000)*86400000-28800000;
    const before=await version(actor.id,start),period={from:new Date(start).toISOString(),to:new Date(start+86400000).toISOString()};
    const query={...period,scope:'self' as const};
    const [overview,official]=await Promise.all([analytics.overview(token,query),analytics.officialUsage(token,query)]);
    await access.authorize(token);const after=await version(actor.id,start);
    if(before.cleanup_generation!==after.cleanup_generation||before.baseline?.getTime()!==after.baseline?.getTime())throw new DomainError('content_changed',409);
    const counters=(scene:'Chat'|'CUE')=>officialUsageCounters(official.configured?official.groups.filter(group=>group.client==='ide'&&group.scene===scene):[]);
    const chat=counters('Chat'),cue=counters('CUE');
    return {business_date:new Date(start+28800000).toISOString().slice(0,10),timezone:'Asia/Shanghai',period,as_of:at.toISOString(),today_in_progress:true,
      official_chat_tokens:chat.tokens,official_cue_tokens:cue.tokens,official_chat_usage:chat,official_cue_usage:cue,official_configured:official.configured,official_coverage:official.coverage,
      hook_sessions:overview.sessions,prompt_turns:overview.prompt_turns,content_estimate_tokens:null,content_estimate_reason:null,
      cleanup_generation:after.cleanup_generation,partial_history:after.cleaned||!!after.baseline&&after.baseline.getTime()>start||overview.quality.state!=='ready',baseline_at:after.baseline?.toISOString()??null};
  }
  return {today};
}
