import {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {testDatabase} from '../../../storage/test/helpers.js';
import {createIdentityService} from '../../src/identity.js';
import {createSessionReadService} from '../../src/session-reading.js';
import {createUsageAttributionJobs} from '../../src/usage-attribution-jobs.js';
import {createTraeUsageProvider} from '../../src/usage-provider.js';

type Fixture={baseUrl:string;db:Awaited<ReturnType<typeof testDatabase>>;identity:ReturnType<typeof createIdentityService>;login:Awaited<ReturnType<ReturnType<typeof createIdentityService>['changePassword']>>;user:string;installation:string;at:Date;start:Date;stop:Date;session:string;provider:ReturnType<typeof createTraeUsageProvider>;jobs:ReturnType<typeof createUsageAttributionJobs>;reader:ReturnType<typeof createSessionReadService>;run:()=>ReturnType<ReturnType<typeof createUsageAttributionJobs>['status']>;read:()=>ReturnType<ReturnType<typeof createSessionReadService>['officialUsage']>;requests:Array<{path:string;body:Record<string,unknown>}>;control:{client:string|null;ids:string[];tokens:number;owner:string;fail:boolean;windows:Map<number,string[]>;onSession:()=>Promise<void>}};
export async function stopUsageFixture(t:TestContext):Promise<Fixture>{
 const db=await testDatabase(t);await db.migrate();const at=new Date(),stop=new Date(at.getTime()-10000),start=new Date(stop.getTime()-60000);await db.ensurePartitions(start,at);
 const identity=createIdentityService(db,{emailDomains:['example.invalid']});const email=`stop-${randomUUID()}@example.invalid`;
 const seed=await identity.bootstrap({email,name:'Stop测试账号'}),initial=await identity.login(email,seed.temporaryPassword),login=await identity.changePassword(initial.token,seed.temporaryPassword,'stop-window-synthetic-password');
 const user=login.user.user_id,installation=randomUUID();await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'Stop实验安装')",[installation,user,'a'.repeat(64)]);
 let session='';for(const [i,[event_type,time]] of ([['UserPromptSubmit',start],['Stop',stop]] as const).entries()){const saved=await db.ingest({schema_version:2,installation_id:installation,client_event_id:'stop-'+i,source_session_id:'synthetic-hook',event_type,occurred_at:time.toISOString(),payload:event_type==='Stop'?{last_assistant_message:'测试完成'}:{prompt:'Stop用量测试'}},{admissionEpoch:1,receivedAt:at});assert.equal(saved.outcome,'committed');if(saved.outcome==='committed')session=saved.sessionId;}
 await db.query("INSERT INTO usage_provider_identities(provider_account,user_id,provider_user_id,verified_email) VALUES('stop-test',$1,'external-owner',$2)",[user,email]);
 const control={client:'ide' as string|null,ids:['official-bill'],tokens:176004,owner:'external-owner',fail:false,windows:new Map<number,string[]>(),onSession:async()=>{}};
 const requests:Array<{path:string;body:Record<string,unknown>}>=[];
 const raw=(tokens:number)=>({session_id:'official-bill',user_id:control.owner,email,start_time:Math.floor(stop.getTime()/1000),scene:'Chat',client:control.client,model_source:'Trae',model_name:'MiniMax-M3',model_type:'Chat',consumption_source:'basic',model_call_count:4,usage:{prompt_tokens:tokens-10,completion_tokens:10,total_tokens:tokens,cache_creation_input_tokens:0,cache_read_input_tokens:0},total_cost:'0.000000',total_cost_currency:'CNY'});
 const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);requests.push({path:req.url!,body});res.setHeader('Content-Type','application/json');const member=req.url?.endsWith('user_usage_detail'),memberIds=control.windows.get(body.start_time)??control.ids;
 if(control.fail&&!req.url?.endsWith('/auth/token')){res.writeHead(503);res.end('{}');return;}
 if(!member&&body.session_ids?.[0]!=='synthetic-hook'&&!req.url?.endsWith('/auth/token'))await control.onSession();
 res.end(JSON.stringify(req.url?.endsWith('/auth/token')?{code:0,data:{access_token:'synthetic-token',expire:7200}}:{code:0,data:{items:member?memberIds.map(id=>({...raw(31336),session_id:id,start_time:body.start_time+1})):body.session_ids[0]==='synthetic-hook'?[]:[{...raw(control.tokens),session_id:body.session_ids[0]}],...(member?{pagination:{page:body.page,page_size:200,total:memberIds.length,total_pages:memberIds.length?1:0}}:{})}}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));const address=server.address();assert.ok(address&&typeof address!=='string');
 const provider=createTraeUsageProvider({baseUrl:`http://127.0.0.1:${address.port}`,appId:'synthetic',appSecret:'synthetic'});
 const jobs=createUsageAttributionJobs(db,{providerAccount:'stop-test',provider});const reader=createSessionReadService(db,identity,{providerAccount:'stop-test',stopWindowEnabled:true});
 const run=async()=>{const job=await jobs.enqueue(session);for(let batch=0;batch<10000;batch++){const worked=await jobs.runOne(),status=await jobs.status(job);if(!worked||status.status==='succeeded'||status.status==='failed'||status.error_code)return status;}throw new Error('Stop fixture exceeded its background batch limit');};
 const read=()=>reader.officialUsage(login.token,session);
 return {baseUrl:`http://127.0.0.1:${address.port}`,db,identity,login,user,installation,at,start,stop,session,provider,jobs,reader,run,read,requests,control};
}
