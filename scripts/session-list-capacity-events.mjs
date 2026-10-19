import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

/** A whole synthetic session has paired tools and a Stop after every prompt.
 * Extra positions for non-1-mod-4 counts are real notifications, not half tools. */
export function syntheticPayloadEvent(index,count,body,sessionTag){
 assert.ok(Number.isInteger(count)&&count>=5);
 assert.ok(Number.isInteger(index)&&index>=0&&index<count);
 assert.equal(typeof body,'string');assert.equal(typeof sessionTag,'string');
 if(index===0)return {event_type:'SessionStart',payload:{context:body}};
 const rounds=Math.floor((count-1)/4),notifications=count-1-rounds*4;
 if(index<=notifications)return {event_type:'Notification',payload:{notification_type:'synthetic_capacity',message:body}};
 const position=index-notifications-1,round=Math.floor(position/4),step=position%4;
 const tool_use_id=`${sessionTag}:tool:${round}`,tool_name='synthetic-tool';
 if(step===0)return {event_type:'UserPromptSubmit',payload:{prompt:body}};
 if(step===1)return {event_type:'PreToolUse',payload:{tool_use_id,tool_name,tool_input:{text:body}}};
 if(step===2)return {event_type:'PostToolUse',payload:{tool_use_id,tool_name,tool_response:body}};
 return {event_type:'Stop',payload:{last_assistant_message:body,loop_count:0,stop_hook_active:false}};
}

const billPrefix='synthetic-stop-bill-';
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/** A deterministic provider for isolated fixtures, backed by actual persisted
 * Stop facts. Direct Hook lookup is empty, member windows discover bill IDs,
 * and Session lookup supplies quantities. It does not discard real ambiguity. */
export function createSyntheticStopProvider(db,{providerAccount,onRequest=()=>{},clock=()=>new Date()}){
 assert.equal(typeof providerAccount,'string');assert.ok(providerAccount.length>0);
 const observed=()=>clock().toISOString();
 function item(row,bill,model=0){
  return {billing_session_id:bill,provider_user_id:row.provider_user_id,email:row.email_key,
   start_time:String(row.start_second),client:'ide',scene:'Chat',model_name:'Synthetic live model '+model%4,
   model_type:'Chat',model_source:'Trae',consumption_source:'basic',model_call_count:'1',departments:[],
   usage:{total_tokens:'100',prompt_tokens:'80',completion_tokens:'20',cache_creation_input_tokens:'0',cache_read_input_tokens:'0'},
   amount:'0.000000',amount_reason:null,currency:'CNY',quality:[],token_basis:'provider_reported'};
 }
 function response(items,endpoint,parameters,pagination=null){
  const response_hash=createHash('sha256').update(JSON.stringify({items,endpoint,parameters,pagination})).digest('hex');
  return {items,pagination,request_id:'synthetic-'+response_hash.slice(0,20),observed_at:observed(),response_hash,query:{endpoint,parameters}};
 }
 return {
  async getSessionUsage(id){
   onRequest('session_usage_detail');assert.equal(typeof id,'string');
   const parameters={session_ids:[id]};
   if(!id.startsWith(billPrefix)){
    const exists=await db.query('SELECT 1 FROM sessions WHERE source_session_id=$1',[id]);
    assert.ok(exists.rowCount,'Synthetic direct Hook session must exist');
    return response([],'session_usage_detail',parameters);
   }
   const session=id.slice(billPrefix.length);assert.match(session,uuid);
   const row=(await db.query(`SELECT s.id,s.user_id,u.email_key,p.provider_user_id,
    floor(extract(epoch FROM min(e.occurred_at)))::text AS start_second
    FROM sessions s JOIN users u ON u.id=s.user_id
    JOIN usage_provider_identities p ON p.user_id=s.user_id AND p.provider_account=$1
    JOIN hook_events e ON e.session_id=s.id AND e.event_type='Stop'
    WHERE s.id=$2 GROUP BY s.id,u.email_key,p.provider_user_id`,[providerAccount,session])).rows[0];
   assert.ok(row,'Synthetic bill must belong to a persisted Stop and verified provider owner');
   return response(Array.from({length:8},(_,n)=>item(row,id,n)),'session_usage_detail',parameters);
  },
  async getMemberUsage(parameters){
   onRequest('user_usage_detail');
   const {start_time,end_time,user_ids,page=1,page_size=200}=parameters;
   assert.ok(Number.isInteger(start_time)&&Number.isInteger(end_time)&&start_time<=end_time);
   assert.ok(Array.isArray(user_ids)&&user_ids.length>0);
   assert.ok(Number.isInteger(page)&&page>0&&Number.isInteger(page_size)&&page_size>0&&page_size<=200);
   const rows=(await db.query(`SELECT s.id,s.user_id,u.email_key,p.provider_user_id,
    floor(extract(epoch FROM e.occurred_at))::text AS start_second
    FROM hook_events e JOIN sessions s ON s.id=e.session_id JOIN users u ON u.id=s.user_id
    JOIN usage_provider_identities p ON p.user_id=s.user_id AND p.provider_account=$1
    WHERE e.event_type='Stop' AND p.provider_user_id=ANY($2::text[])
     AND e.occurred_at>=to_timestamp($3) AND e.occurred_at<to_timestamp($4+1)
    ORDER BY e.occurred_at,e.id`,[providerAccount,user_ids,start_time,end_time])).rows;
   const total=rows.length,selected=rows.slice((page-1)*page_size,page*page_size);
   return response(selected.map(row=>item(row,billPrefix+row.id)), 'user_usage_detail',parameters,
    {page,page_size,total,total_pages:Math.ceil(total/page_size)});
  },
 };
}
