import {randomUUID} from 'node:crypto';
import {createSyntheticStopProvider} from './session-list-capacity-events.mjs';

/** Same provider substitute as the v9 serial diagnostic. Only scheduling moves
 * to a distinct usage process; returned IDs, records, quantities and Stop route
 * selection remain unchanged. No real provider can be reached from this file. */
export function createCapacityProvider(db,config,stats){
 const stopProvider=createSyntheticStopProvider(db,{providerAccount:config.provider_account,onRequest:endpoint=>{stats.provider_requests++;stats.provider_routes[endpoint]++;}});
 return {getMemberUsage:stopProvider.getMemberUsage,getSessionUsage:async hook=>{
  if(hook.startsWith('synthetic-stop-bill-')||hook.startsWith('synthetic-live-')&&Number(hook.split('-').at(-1))%10===0)return stopProvider.getSessionUsage(hook);
  stats.provider_requests++;stats.provider_routes.session_usage_detail++;
  const row=(await db.query('SELECT s.id,s.user_id,s.first_at FROM sessions s WHERE s.source_session_id=$1',[hook])).rows[0];
  if(!row)throw new Error('synthetic_provider_session_missing');
  const historical=hook.startsWith('synthetic-capacity-')?(config.history_records[row.id]??0):0;
  const items=Array.from({length:historical+8},(_,n)=>({billing_session_id:n<historical?'capacity-bill-'+row.id+'-'+(n+1):'live-capacity-'+row.id+'-'+(n-historical),provider_user_id:'capacity-provider-'+row.user_id,email:config.emails[row.user_id],start_time:String(Math.floor(row.first_at.getTime()/1000)),client:'ide',scene:'Chat',model_name:'Synthetic live model '+n%4,model_type:'Chat',model_source:'Trae',consumption_source:'basic',model_call_count:'1',departments:[],usage:{total_tokens:'100',prompt_tokens:'80',completion_tokens:'20',cache_creation_input_tokens:'0',cache_read_input_tokens:'0'},amount:'0.000000',amount_reason:null,currency:'CNY',quality:[],token_basis:'provider_reported'}));
  return {items,pagination:null,request_id:'synthetic-'+randomUUID(),observed_at:new Date().toISOString(),response_hash:'b'.repeat(64),query:{endpoint:'session_usage_detail',parameters:{session_ids:[hook]}}};
 }};
}
