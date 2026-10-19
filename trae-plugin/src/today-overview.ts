import {PluginHttpError} from './http-client.js';
export interface OfficialQuantity {tokens:string|null;known_tokens:string;missing_token_records:number}
export interface OfficialCounters extends OfficialQuantity {records:number;calls:string|null;known_calls:string;missing_call_records:number;token_breakdown:{input:OfficialQuantity;output:OfficialQuantity;cache_read:OfficialQuantity;cache_creation:OfficialQuantity}}
export interface Summary {official_chat_usage?:OfficialCounters;official_cue_usage?:OfficialCounters;business_date:string;as_of:string;official_chat_tokens:string|null;official_cue_tokens:string|null;hook_sessions:number;prompt_turns:number;cleanup_generation:number;[key:string]:unknown}
interface Cache {get(key:string):unknown;update(key:string,value:unknown):PromiseLike<void>}
const counter=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
const tokens=(value:unknown)=>typeof value==='string'&&/^\d{1,30}$/.test(value);
const nullableTokens=(value:unknown)=>value===null||tokens(value);
function validCounters(value:unknown):boolean {
  if(value===undefined)return true; // Older server/cache has only total quantities.
  if(!value||typeof value!=='object')return false;
  const row=value as OfficialCounters;
  const quantity=(metric:OfficialQuantity|undefined)=>!!metric&&nullableTokens(metric.tokens)&&tokens(metric.known_tokens)&&counter(metric.missing_token_records)&&metric.missing_token_records<=row.records&&(metric.missing_token_records===0||metric.tokens===null);
  return counter(row.records)&&quantity(row)&&quantity({tokens:row.calls,known_tokens:row.known_calls,missing_token_records:row.missing_call_records})&&!!row.token_breakdown&&['input','output','cache_read','cache_creation'].every(key=>quantity(row.token_breakdown[key as keyof OfficialCounters['token_breakdown']]));
}
function validSummary(value:Summary|undefined,businessDate:string):value is Summary {
  return !!value&&value.business_date===businessDate&&typeof value.as_of==='string'&&Number.isFinite(Date.parse(value.as_of))&&counter(value.cleanup_generation)&&[value.official_chat_tokens,value.official_cue_tokens].every(nullableTokens)&&counter(value.hook_sessions)&&counter(value.prompt_turns)&&validCounters(value.official_chat_usage)&&validCounters(value.official_cue_usage);
}
const day=(now:number)=>new Date(now+8*3600000).toISOString().slice(0,10);
export class TodayOverview {
  private epoch=0;private scope='';private data:Summary|null=null;private stale=false;private reason='';private writes:Promise<void>=Promise.resolve();private currentDay:string;
  constructor(private readonly cache:Cache,private readonly now=()=>Date.now()){this.currentDay=day(this.now());}
  snapshot(){const businessDate=day(this.now());if(businessDate!==this.currentDay){this.currentDay=businessDate;this.epoch++;this.data=null;this.stale=false;this.reason='';void this.persist(undefined,this.epoch);}return {data:this.data,stale:this.stale,reason:this.reason};}
  private persist(value:unknown,epoch:number){this.writes=this.writes.catch(()=>{}).then(async()=>{if(epoch===this.epoch)await this.cache.update('today-summary-v1',value);});return this.writes;}
  async clear(){this.epoch++;this.data=null;this.scope='';this.stale=false;this.reason='';await this.persist(undefined,this.epoch);}
  async refresh(scope:string,fetcher:()=>Promise<unknown>){
    this.snapshot();
    if(scope!==this.scope){const cached=this.cache.get('today-summary-v1') as {scope?:string;business_date?:string}|undefined;if(this.scope||cached?.scope!==scope||cached.business_date!==day(this.now()))await this.clear();this.scope=scope;}
    const epoch=++this.epoch,businessDate=day(this.now());
    try{
      const response=await fetcher();if(epoch!==this.epoch)return;
      const value=response as Summary;
      if(day(this.now())!==businessDate||!validSummary(value,businessDate))throw new Error('invalid_today_summary');
      this.data=value;this.stale=false;this.reason='';await this.persist({scope,business_date:businessDate,data:value},epoch);
    }catch(error){
      if(epoch!==this.epoch)return;
      if(error instanceof PluginHttpError&&([401,403].includes(error.status)||['content_changed','cleanup_in_progress','collection_disabled','collection_closed','collection_unavailable','recovery_quarantined'].includes(error.reason))){await this.clear();throw error;}
      const cached=this.cache.get('today-summary-v1') as {scope?:string;business_date?:string;data?:Summary}|undefined;
      this.data=cached?.scope===scope&&cached.business_date===businessDate&&day(this.now())===businessDate&&validSummary(cached.data,businessDate)?cached.data:null;this.stale=this.data!==null;this.reason='暂时无法连接平台';
    }
  }
}
