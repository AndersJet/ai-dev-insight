import {environment as e2eEnv,e2eArtifact} from './helpers/environment.mjs';
import {test,expect} from './helpers/browser.js';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../../packages/storage/src/index.js';
import {createUsageSnapshotStore} from '../../../packages/domain/src/usage-snapshots.js';

test('time-inferred bills remain separate from verified quantities and become ambiguous when another Hook overlaps',async({page})=>{
 test.setTimeout(60000);
 const fixture=JSON.parse(readFileSync(e2eArtifact('e2e-credentials.json'),'utf8'));
 const db=openDatabase({connectionString:e2eEnv.databaseURL,schema:e2eEnv.schema});
 const user=randomUUID(),installation=randomUUID(),email=`candidate-${user}@example.invalid`,at=Date.now()-60000,date=new Date(at+28800000).toISOString().slice(0,10);let sid='';
 try{
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)',[user,email,'时间候选合成账号']);
  await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'时间候选合成安装')",[installation,user,randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','')]);
  for(const [i,[event_type,payload]] of ([['UserPromptSubmit',{prompt:'TIME_CANDIDATE_E2E'}],['Stop',{last_assistant_message:'合成候选回答',loop_count:0,stop_hook_active:false}],['Notification',{notification_type:'idle_prompt'}]] as const).entries()){
   const saved=await db.ingest({schema_version:2,installation_id:installation,client_event_id:'candidate-'+i,source_session_id:'candidate-'+user,event_type,occurred_at:new Date(at+i*1000).toISOString(),payload},{admissionEpoch:1,receivedAt:new Date()});expect(saved.outcome).toBe('committed');if(saved.outcome==='committed')sid=saved.sessionId;
  }
  const store=createUsageSnapshotStore(db,{providerAccount:'e2e-official'});
  async function publish(tokens:string){const draft=await store.begin(user,date),query=draft.parts[0]!.query;
   await store.stage(draft,0,{items:[{billing_session_id:'E2E-CANDIDATE-BILL',provider_user_id:'candidate-owner-'+user,email,start_time:String(Math.floor(at/1000)),client:'ide',scene:'Chat',model_name:'MiniMax-M3',model_type:'Chat',model_source:'Trae',consumption_source:'basic',model_call_count:'1',departments:[],usage:{prompt_tokens:tokens,completion_tokens:'0',total_tokens:tokens,cache_creation_input_tokens:'0',cache_read_input_tokens:'0'},amount:null,amount_reason:'missing',currency:'CNY',quality:[],token_basis:'provider_reported'}],pagination:{page:1,page_size:200,total:1,total_pages:1},request_id:'synthetic-candidate',observed_at:new Date().toISOString(),response_hash:'c'.repeat(64),query:{endpoint:'user_usage_detail',parameters:query}});await store.publish(draft);
  }
  await publish('321');
  await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill(fixture.admin.email);await page.getByLabel('密码',{exact:true}).fill(fixture.admin.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'退出登录',exact:true}).waitFor();
  await expect.poll(async()=>{const r=await page.request.get(`/api/v1/sessions/${sid}/official-usage`);return (await r.json()).data?.time_candidates?.items[0]?.relation;},{timeout:15000}).toBe('time_inferred');
  await page.goto(`/all/sessions/${sid}`);await page.getByRole('tab',{name:'官方用量',exact:true}).click();const panel=page.getByTestId('session-time-candidates');await expect(panel).toContainText('时间推断关联');await expect(panel).toContainText('E2E-CANDIDATE-BILL');await expect(panel).toContainText('321');await expect(page.getByTestId('session-official-tokens')).not.toBeVisible();
  await publish('444');await page.getByRole('button',{name:'刷新显示',exact:true}).click();await expect(panel).toContainText('444');await expect(panel).not.toContainText('321');
  await db.ingest({schema_version:2,installation_id:installation,client_event_id:'competing',source_session_id:'other-candidate-'+user,event_type:'UserPromptSubmit',occurred_at:new Date(at).toISOString(),payload:{prompt:'OTHER_CANDIDATE_PRIVATE'}},{admissionEpoch:1,receivedAt:new Date()});
  await page.getByRole('button',{name:'刷新显示',exact:true}).click();await expect(panel.locator('tbody')).toContainText('待核验');await expect(panel).toContainText('与其他已观测会话的时间范围重叠');await expect(panel).not.toContainText('OTHER_CANDIDATE_PRIVATE');await expect(page.getByTestId('session-official-tokens')).not.toBeVisible();await panel.screenshot({path:'.run/time-candidates.png'});
 }finally{await db.close();}
});
