import {environment as e2eEnv,e2eArtifact} from './helpers/environment.mjs';
import {test,expect} from './helpers/browser.js';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {openDatabase} from '../../../packages/storage/src/index.js';
import {createTraeUsageProvider} from '../../../packages/domain/src/usage-provider.js';
import {createUsageAttributionService} from '../../../packages/domain/src/usage-attribution.js';

test('two-step official quantities are shown without an intermediate candidate table and collisions become pending',async({page})=>{
 test.setTimeout(60000);const credentials=JSON.parse(readFileSync(e2eArtifact('e2e-credentials.json'),'utf8'));
 const db=openDatabase({connectionString:e2eEnv.databaseURL,schema:e2eEnv.schema});
 const user=randomUUID(),installation=randomUUID(),email=`stop-e2e-${user}@example.invalid`,owner='stop-e2e-'+user,at=new Date(Date.now()-10000),start=new Date(at.getTime()-60000);let session='',ids=['bill-'+user];
 const raw=(id:string,tokens:number)=>({session_id:id,user_id:owner,email,start_time:Math.floor(at.getTime()/1000),client:'ide',scene:'Chat',model_name:'MiniMax-M3',model_source:'Trae',model_type:'Chat',consumption_source:'basic',model_call_count:4,usage:{prompt_tokens:tokens-10,completion_tokens:10,total_tokens:tokens,cache_creation_input_tokens:0,cache_read_input_tokens:0},total_cost:'0.000000',total_cost_currency:'CNY'});
 const server=createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;const body=JSON.parse(text);res.setHeader('Content-Type','application/json');const member=req.url?.endsWith('user_usage_detail');res.end(JSON.stringify(req.url?.endsWith('/auth/token')?{code:0,data:{access_token:'synthetic-token',expire:7200}}:{code:0,data:{items:member?ids.map(id=>raw(id,31336)):body.session_ids[0]==='e2e-stop-'+user?[]:[raw(body.session_ids[0],176004)],...(member?{pagination:{page:1,page_size:200,total:ids.length,total_pages:1}}:{})}}));});
 try{
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const addr=server.address();if(!addr||typeof addr==='string')throw new Error('fixture_http_failed');
 await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)',[user,email,'两步用量E2E']);await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'合成安装')",[installation,user,randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','')]);
 for(const [i,[event_type,time]] of ([['UserPromptSubmit',start],['Stop',at]] as const).entries()){const saved=await db.ingest({schema_version:2,installation_id:installation,client_event_id:'e2e-stop-'+i,source_session_id:'e2e-stop-'+user,event_type,occurred_at:time.toISOString(),payload:event_type==='Stop'?{last_assistant_message:'完成'}:{prompt:'STOP_USAGE_E2E'}},{admissionEpoch:1,receivedAt:new Date()});expect(saved.outcome).toBe('committed');if(saved.outcome==='committed')session=saved.sessionId;}
 await db.query("INSERT INTO usage_provider_identities(provider_account,user_id,provider_user_id,verified_email) VALUES('e2e-official',$1,$2,$3)",[user,owner,email]);
 const provider=createTraeUsageProvider({baseUrl:`http://127.0.0.1:${addr.port}`,appId:'synthetic',appSecret:'synthetic'});const attribution=createUsageAttributionService(db,{providerAccount:'e2e-official',provider});const run=()=>attribution.probe(session);await run();
 await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill(credentials.admin.email);await page.getByLabel('密码',{exact:true}).fill(credentials.admin.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'退出登录',exact:true}).waitFor();
 await page.goto(`/all/sessions/${session}`);await page.getByRole('tab',{name:'官方用量',exact:true}).click();await expect(page.getByTestId('session-official-tokens')).toHaveText('176,004');await expect(page.getByTestId('session-time-candidates')).toHaveCount(0);await expect(page.getByTestId('session-official-usage')).not.toContainText('31336');
 ids=['bill-'+user,'other-'+user];await run();await page.getByRole('button',{name:'刷新显示',exact:true}).click();await expect(page.getByTestId('session-official-tokens')).not.toBeVisible();await expect(page.getByTestId('session-official-usage')).toContainText('用量待确认');await page.getByTestId('session-official-usage').screenshot({path:'.run/stop-usage-pending.png'});
 }finally{await db.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
