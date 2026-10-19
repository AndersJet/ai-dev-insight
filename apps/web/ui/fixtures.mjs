// Synthetic API responses for isolated browser UI checks and design specimens.
import { URL } from 'node:url';
import * as c from '../../../packages/contracts/dist/index.js';
export const ids={department:'11111111-1111-4111-8111-111111111111',user:'22222222-2222-4222-8222-222222222222',session:'33333333-3333-4333-8333-333333333333',second:'44444444-4444-4444-8444-444444444444'};
const now=new Date().toISOString();
const day=86400000;const midnight=Math.floor((Date.now()+28800000)/day)*day-28800000;
export const period={from:new Date(midnight-6*day).toISOString(),to:new Date(midnight+day).toISOString()};
export function sample(s,key=''){
 if(s.const!==undefined)return s.const;
 if(s.anyOf){if(s.anyOf.some(x=>x.type==='null'))return null;return sample(s.anyOf[0],key);}
 if(s.type==='object')return Object.fromEntries(Object.entries(s.properties??{}).map(([k,v])=>[k,sample(v,k)]));
 if(s.type==='array')return [];
 if(s.type==='null')return null;
 if(s.type==='boolean')return ['configured','projection_ready','available','eligible','channel_available','can_submit'].includes(key);
 if(s.type==='integer'||s.type==='number')return /pending|missing|conflict|outside|unassigned|invalidated|unknown|error|lag|offset/.test(key)?0:/ratio/.test(key)?0.75:key==='version'?1:Math.max(s.minimum??0,0);
 if(s.format==='uuid'||key==='user_id')return key==='department_id'?ids.department:ids.user;
 if(key==='from'||key==='to')return period[key];
 if(s.format==='date-time'||/(?:_at|as_of|cutoff)$/.test(key))return now;
 if(s.format==='email'||key==='email')return 'designer@example.invalid';
 if(s.format==='uri')return 'https://collector.example.invalid';
 if(key==='from'||key==='to')return period[key];
 if(/bytes|tokens|amount|calls/.test(key))return '12800';
 if(key==='display_name'||key==='name')return '示例成员';
 if(key==='label')return '组织';
 if(key==='version'||key==='metric_version')return 'v2.0.0';
 return '示例';
}
const routes=[c.meRoute,c.codeFlowRoute,c.billingSimulationRoute,c.adoptionRoute,c.sessionTokenCheckRoute,...Object.entries(c).filter(([k])=>k.endsWith('Routes')).flatMap(([,v])=>Object.values(v))];
const dept={id:ids.department,name:'平台研发部',version:1,member_count:3,pending_member_count:0,admins:[{user_id:ids.user,display_name:'林晓'}]};
const members=['林晓','陈宁','周悦'].map((name,i)=>({...sample(c.MemberSchema),user_id:i?ids.second.replace(/4$/,String(i)):ids.user,display_name:name,email:['lin.xiao','chen.ning','zhou.yue'][i]+'@example.invalid',department_id:ids.department,department_name:dept.name,primary_role:i?'employee':'super',eligible:true,version:1,registered_at:new Date(Date.now()-7*day).toISOString(),adopted_at:i<2?new Date(Date.now()-6*day).toISOString():null}));
const estimate={...sample(c.ContentEstimateSchema),tokens:'12800',components:{prompt:'2400',tool_input:'3600',tool_output:'4800',assistant:'2000'},sessions:8,pending_sessions:0,as_of:now,reason:null};
const session={id:ids.session,user_id:ids.user,name:'林晓',email:'lin.xiao@example.invalid',source_session_id:'demo-session-20260928',first_at:new Date(Date.now()-1800000).toISOString(),last_at:now,prompt_turns:1,title:'优化部门管理表单交互',channel:'mixed',model:'Claude Sonnet 4.5',model_count:1,official_tokens:'24680',official_records:3,session_coverage:{state:'unknown',reason:'billing_id_inventory_unavailable'},attribution_conflicts:0,personal_models:['Claude Sonnet 4.5']};
export function response(path,method='GET',mode='super',input,scenario={}){
 const u=new URL(path,'http://demo.local');const p=u.pathname;
 const route=routes.find(r=>r.method.toUpperCase()===method&&new RegExp('^'+r.path.replace(/:[^/]+/g,'[^/]+')+'$').test(p));
 if(!route)return {status:404,body:{error:{code:'mock_unmapped',message:'设计预览未配置此接口',request_id:'design'}}};
 const status=Number(Object.keys(route.response).find(k=>+k<300));const body=sample(route.response[status]);if(!body)return {status,body};const d=body.data;
 if(p==='/api/v1/me'||p.includes('/auth/')){
 if(mode==='anonymous'&&p==='/api/v1/me')return{status:401,body:{error:{code:'unauthorized',message:'请登录',request_id:'design'}}};
 Object.assign(d,{user_id:ids.user,display_name:'林晓',email:'lin.xiao@example.invalid',roles:[mode==='employee'?'employee':mode==='department_admin'?'department_admin':'super'],managed_departments:mode==='employee'?[]:[{id:ids.department,name:dept.name}],allowed_actions:[],default_route:mode==='employee'?'/my/overview':'/organization',must_change_password:mode==='change',management_source:'system',registered:true});
 }
 else if(p==='/api/v1/adoption')Object.assign(d,{as_of:now,registered:u.searchParams.get('scope')==='self'?1:u.searchParams.has('department_id')?3:24,adopted:u.searchParams.get('scope')==='self'?1:u.searchParams.has('department_id')?2:18,pending:u.searchParams.get('scope')==='self'?0:u.searchParams.has('department_id')?1:6,suspended:0,deleted:0,adoption_rate:u.searchParams.get('scope')==='self'?1:u.searchParams.has('department_id')?2/3:.75});
 else if(p==='/api/v1/registration/setup')Object.assign(d,{departments:[{id:ids.department,name:dept.name}]});
 else if(p==='/api/v1/departments'&&method==='GET')body.data=mode==='employee'?[]:mode==='department_admin'||scenario.noOtherDepartments?[dept]:[dept,{...dept,id:ids.second,name:'产品体验部',member_count:0,admins:[]}];
 else if(p.endsWith('/members')||p==='/api/v1/admin/users'){if(!p.includes('/analytics/'))Object.assign(d,{items:members.map(m=>m.user_id===ids.user?{...m,primary_role:mode==='super'?'super':mode}:m),total:3,has_more:false,next_cursor:null});}
 if(p.includes('/analytics/')){
 if(d.scope)Object.assign(d.scope,{kind:u.searchParams.get('scope')==='self'?'self':'organization',label:dept.name,department_ids:null,member:null});
 if(p.endsWith('/overview')||/\/analytics\/members\//.test(p)){Object.assign(d,{observed_users:18,eligible_users:24,eligible_observed_users:18,coverage_ratio:.75,sessions:86,prompt_turns:324,tool_events:658,active_days:7});if(/\/members\//.test(p))d.scope.member={id:ids.user,name:'林晓',email:'lin.xiao@example.invalid',archived:false};}
 if(p.endsWith('/content-estimate'))d.estimate=estimate;
 if(p.endsWith('/departments')||p.endsWith('/members')){const base=sample(route.response[200].properties.data.properties.items.items);d.items=[{...base,id:ids.department,name:dept.name,email:'lin.xiao@example.invalid',eligible_users:24,observed_users:18,coverage_ratio:.75,sessions:86,prompt_turns:324,active_days:7}];d.total=1;}
 if(p.endsWith('/trends')){const s=route.response[200].properties.data.properties.items.items;d.items=Array.from({length:7},(_,i)=>({...sample(s),date:new Date(Date.parse(period.from)+28800000+i*86400000).toISOString().slice(0,10),observed_users:8+i,prompt_turns:[30,35,40,45,50,60,64][i],sessions:[10,11,12,13,14,13,13][i]}));}
 if(p.endsWith('/purposes')){const s=route.response[200].properties.data.properties.items.items;d.items=['feature','bugfix','test'].map((purpose,i)=>({...sample(s),purpose,sessions:[48,26,12][i],ratio:[.56,.30,.14][i]}));d.total_sessions=86;}
 }
 if(p==='/api/v1/analytics/official-usage'||p==='/api/v1/system/usage-sync'){d.model_check={availability:p.includes('/system/')?'available':'department_scope_not_comparable',scope:'all_clients_all_consumption',as_of:now,days:[],groups:[],truncated:false};const bucket=(records,tokens)=>({records,tokens,known_tokens:tokens??'0',missing_token_records:0});d.reconciliation={as_of:now,days:[{date:period.from.slice(0,10),waiting_user_days:1,overdue_user_days:1,failed_user_days:0,known_gap_user_days:1,next_check_at:now}],scope:'chat_ide_or_unspecified',session_completeness:'unknown',total:bucket(12,'24680'),attributed:bucket(8,'10000'),unattributed:bucket(4,'14680'),conflicting:bucket(0,null)};}
 if(p.includes('/official-usage')){d.configured=true;if(d.attribution)Object.assign(d.attribution,{state:'linked',linked_ids:3,unmatched_ids:0,probe_state:'observed',pending:false});if(d.coverage)Object.assign(d.coverage,{expected_days:7,verified_days:7,missing_days:0,invalidated_days:0,oldest_verified_at:now,query_through_at:now});const s=route.response[200].properties.data.properties.groups?.items;if(s)d.groups=[{...sample(s),tokens:'24680',known_tokens:'24680',calls:'12',known_calls:'12',token_breakdown:{input:{tokens:'23000',known_tokens:'23000',missing_token_records:0},output:{tokens:'1680',known_tokens:'1680',missing_token_records:0},cache_read:{tokens:'18000',known_tokens:'18000',missing_token_records:0},cache_creation:{tokens:'0',known_tokens:'0',missing_token_records:0}},amount:'0.18',known_amount:'0.18',currency:'USD',model_name:'Claude Sonnet 4.5',amount_missing_reasons:[],records:12}];}
 // Trial evidence is opt-in; optional schema sampling must not change the
 // default legacy session scenario. Trial cases explicitly supply this field.
 if(/^\/api\/v1\/sessions\/[^/]+\/official-usage$/.test(p))delete d.session_query;
 if(p==='/api/v1/admin/sessions'||p==='/api/v1/me/sessions')Object.assign(d,{items:[session],total:1,available_channels:['all','official','pending','custom']});
 if(p===`/api/v1/sessions/${ids.session}`)Object.assign(d,session,{content_estimate:{...estimate,tokens:'48',components:{prompt:'48',tool_input:'0',tool_output:'0',assistant:'0'},sessions:1},events:1,tool_events:0,status:'ready',projection_ready:true,computed_at:now,quality:[]});
 if(p.endsWith('/turns')){d.items=[{turn_index:1,first_at:session.first_at,last_at:now,events:1,prompt_preview:'请统一部门表单样式，并检查窄屏显示。'}];d.snapshot='synthetic-snapshot';d.snapshot_version='e'.repeat(64);}
 if(p.endsWith('/fragments'))d.items=[{event_id:ids.second,occurred_at:session.first_at,kind:'UserPromptSubmit',timestamp_source:'client',turn_index:1,step_id:null,tool_name:null,status:null,duration_ms:null,input_ref:null,pre_ref:null,post_ref:null}];
 if(p.endsWith('/content'))Object.assign(d,{event_id:ids.second,available:true,text:'请统一部门表单样式，并检查窄屏显示。\n\n这是用于设计同步的示例内容。',returned_chars:43,total_chars:43,next_offset:null,offset:0});

 if(p.endsWith('/content')){d.part=u.searchParams.get('part')??'prompt';if(d.part==='payload')d.text=JSON.stringify({event:'UserPromptSubmit',prompt:'请统一部门表单样式，并检查窄屏显示。'},null,2);d.returned_chars=d.text.length;d.total_chars=d.text.length;}
 if(p.endsWith('/personal-models')){d.models=['Claude Sonnet 4.5'];d.version=1;d.can_edit=true;}
 if(p.endsWith('/billing-simulation'))Object.assign(d,{reason:null,simulated_input_tokens:'32800',hypothetical_calls:6,observed_output_tokens:'4800',context_tokens:'12800',warnings:[],turns:[{turn_index:1,hypothetical_calls:6,simulated_input_tokens:'32800'}],as_of:now});
 if(p.endsWith('/collection-install-command'))Object.assign(d,{authorization:'adi_dl_synthetic.'+'a'.repeat(43),installation_id:ids.second,expires_at:new Date(Date.now()+30*60*1000).toISOString()});
 if(p.endsWith('/collection-credential'))Object.assign(d,{installation:{...sample(c.InstallationSchema),id:ids.second,label:'账号共用采集凭据',enabled:true,created_at:now,last_seen:now,revoked_at:null},legacy_installations:0,reset_required:false,last_seen:now});
 if(p.endsWith('/collection-setup'))Object.assign(d,{collector_url:'https://collector.example.invalid/hooks',client:{version:'2.0.0',node_major:24,channel:'stable',file_name:'ai-dev-insight-client.zip',sha256:'0'.repeat(64),bytes:102400}});
 if(/^\/api\/v1\/admin\/users\/[^/]+$/.test(p))Object.assign(d,{id:ids.user,display_name:'林晓',email:'lin.xiao@example.invalid',version:1,credential_state:'ready',global_roles:['super'],department_ids:[ids.department]});
 if(p.endsWith('/reset-password'))Object.assign(d,{temporary_password:'DEMO-ONLY-NotARealPassword',version:2});
 if(p==='/api/v1/code-flow'){d.items=[{...sample(c.ProjectInventoryItemSchema),id:ids.session,user_id:ids.user,name:'林晓',email:'lin.xiao@example.invalid',account_status:'active',department_id:ids.department,department_name:dept.name,collector_id:ids.second,workspace:'/workspace/demo-project',platform:'macos',current_available:true,history_only:false,retained_observations:1,observation_id:ids.second,source_hook_session_id:session.source_session_id,confirmed_source_hook_session_id:session.source_session_id,state:'repository',reason:null,observed_at:now,confirmed_at:now,confirmed_state:'repository',unconfirmed:false,git_root:'/workspace/demo-project',remotes:[{name:'origin',direction:'fetch',address:'https://git.example.invalid/platform/demo-project.git',host:'git.example.invalid',source_tag:'department',reason:'allowlist'}],session_count:1,last_hook_at:now}];d.total=1;d.pending_hooks=0;}
 if(p.startsWith('/api/v1/code-flow/')&&p.endsWith('/sessions'))Object.assign(d,{project_id:ids.session,total:1,items:[{session_id:ids.session,hook_session_id:session.source_session_id,first_hook_at:session.first_at,last_hook_at:now,hook_events:1,readable:true,unavailable_reason:null}]});

 if(p.includes('/department-mappings')&&method==='GET')Object.assign(d,{configured:true,version:1,items:[{id:ids.second,external_department_id:'platform-rd',department_id:ids.department,valid_from:period.from,valid_to:null}],candidates:[{external_department_id:'platform-rd',name:'平台研发部',full_path:'组织 / 平台研发部'}]});
 if(p.endsWith('/cleanup/previews'))Object.assign(d,{can_submit:true,preview_id:ids.second,target:{id:ids.user,email:'lin.xiao@example.invalid',name:'林晓'},range:period,counts:{hook_events:120,sessions:8,declared_sessions:2,official_days:7}});
 if(p.includes('/member-imports')&&method==='POST'&&d?.rows)Object.assign(d,{id:ids.second,department_id:ids.department,source_name:'members-demo.csv',preview_hash:'b'.repeat(64),rows:[{row:2,email:'demo.member@example.invalid',display_name:'示例成员',eligible:true,eligibility_from:'2026-09-28',eligibility_to:null,action:'create',changes:[],errors:[],before:{display_name:'',eligible:null,department_id:null}}],counts:{create:1,update:0,skip:0,unchanged:0,error:0},status:'previewed',can_submit:true});
 if(p.endsWith('/cleanup/previews')){if(input?.from&&input?.to)d.range={from:input.from,to:input.to};}

 if(p.endsWith('/cleanup/previews')){scenario.cleanupRange=d.range;d.expires_at=new Date(Date.now()+15*60000).toISOString();}
 if(p==='/api/v1/admin/cleanup/jobs'&&method==='POST'){scenario.cleanupStatus='queued';d.job_id=ids.second;d.status='queued';}
 if(p===`/api/v1/jobs/${ids.second}`&&scenario.cleanupStatus){const status=scenario.cleanupStatus;body.data={job_id:ids.second,created_at:now,status,phase:status==='succeeded'?'complete':status==='failed'?'verify':'journal',error_code:status==='failed'?'storage_unavailable':null,user_id:ids.user,target_email:'lin.xiao@example.invalid',current_email:'lin.xiao@example.invalid',current_name:'林晓',from_at:scenario.cleanupRange?.from??period.from,to_at:scenario.cleanupRange?.to??period.to,progress:{deleted_events:status==='queued'?0:120}};}

 if(p.includes('/analytics/')&&d.coverage){Object.assign(d.coverage,{expected_user_days:21,verified_user_days:21,missing_user_days:0,invalidated_user_days:0,refreshing_user_days:0,oldest_verified_at:now,query_through_at:now,complete:true});}
 if(p.endsWith('/analytics/models')){const model={...sample(route.response[200].properties.data.properties.items.items),key:'a'.repeat(64),name:'Claude Sonnet 4.5',model_source:'Trae',records:12,users:3,tokens:'24680',known_tokens:'24680',calls:'12',known_calls:'12',costs:[{currency:'USD',amount:'0.18',known_amount:'0.18',unknown_amount_records:0,amount_missing_reasons:[]}]};d.items=[model];d.total=1;d.selected_model={key:model.key,name:model.name,model_source:model.model_source};d.trend=[3000,3200,3400,3600,3800,4000,3680].map((tokens,i)=>({date:new Date(Date.parse(period.from)+28800000+i*86400000).toISOString().slice(0,10),records:[1,2,1,2,2,2,2][i],tokens:String(tokens),known_tokens:String(tokens),calls:String([1,2,1,2,2,2,2][i]),missing_token_records:0,expected_users:3,verified_users:3}));}
 if(p.endsWith('/analytics/declared-models')){d.items=[{name:'DeepSeek-V3',sessions:2,users:1}];d.total=1;d.confirmed_sessions=2;}
 if(p==='/api/v1/member-imports/preview'&&method==='POST'){d.expires_at=new Date(Date.now()+15*60000).toISOString();if(scenario.importErrors){d.rows[0].email='invalid-address';d.rows[0].action='error';d.rows[0].errors=['invalid_email'];d.counts.create=0;d.counts.error=1;d.can_submit=false;}scenario.importBatch=globalThis.structuredClone(d);scenario.importStatus='previewed';}
 if(p.endsWith('/member-imports/'+ids.second+'/commit')){scenario.importStatus='queued';}
 if(p==='/api/v1/member-imports/'+ids.second&&scenario.importBatch){body.data={...scenario.importBatch,status:scenario.importStatus,can_submit:scenario.importStatus==='previewed'&&scenario.importBatch.can_submit,job:scenario.importStatus==='previewed'?null:{status:scenario.importStatus,error_code:scenario.importStatus==='failed'?'preview_stale':null,attempt:1,progress:scenario.importBatch.counts}};}
 if(p==='/api/v1/system/retention')Object.assign(d.policy,{recent_days:45,detail_days:365,cutoff:new Date(Date.now()-365*86400000).toISOString()});
 // Callers customize responses for individual cases. Never let a returned
 // department, period or nested array mutate the defaults of later tests.
 return{status,body:globalThis.structuredClone(body)};
}
export async function mockPage(page,mode='super',scenario={}){await page.route('**/api/v1/**',async r=>{const v=response(r.request().url(),r.request().method(),mode,r.request().headers()['content-type']?.includes('application/json')?r.request().postDataJSON():undefined,scenario);await r.fulfill({status:v.status,contentType:'application/json',body:JSON.stringify(v.body)});});}
