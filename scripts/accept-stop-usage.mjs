import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {loadEnvironment} from './lib/environment.mjs';
import {openDatabase} from '../packages/storage/src/index.ts';
import {testDatabase} from '../packages/storage/test/helpers.ts';
import {createIdentityService} from '../packages/domain/src/identity.ts';
import {createSessionReadService} from '../packages/domain/src/session-reading.ts';
import {createUsageAttributionJobs} from '../packages/domain/src/usage-attribution-jobs.ts';
import {createTraeUsageProvider} from '../packages/domain/src/usage-provider.ts';
const env=loadEnvironment(),source=openDatabase({connectionString:env.ADI_DATABASE_URL,schema:env.ADI_DATABASE_SCHEMA,maxConnections:1}),cleanup=[];
let local;
try{
 const target=(await source.query(`SELECT s.user_id,p.provider_user_id FROM sessions s JOIN usage_provider_identities p ON p.user_id=s.user_id AND p.provider_account=$2 WHERE s.source_session_id=$1`,['6ac1051c56aeddce1a26724f',env.ADI_USAGE_PROVIDER_ACCOUNT])).rows[0];if(!target)throw new Error('source_identity_missing');
 const hooks=['6ac0ffdf56aeddce1a267243','6ac1051c56aeddce1a26724f','6ac10a5056aeddce1a26727e','6ac10a7856aeddce1a26728a','6ac10a9856aeddce1a267296','6ac10b0656aeddce1a2672b0'];
 const events=(await source.query(`SELECT s.source_session_id,e.event_type,e.occurred_at FROM hook_events e JOIN sessions s ON s.id=e.session_id WHERE e.user_id=$1 AND s.source_session_id=ANY($2::text[]) ORDER BY e.occurred_at,e.id`,[target.user_id,hooks])).rows;
 await source.close();local=await testDatabase({after:callback=>cleanup.push(callback)});await local.migrate();const identity=createIdentityService(local,{emailDomains:['example.invalid']});const email='live-acceptance@example.invalid',seed=await identity.bootstrap({email,name:'只读官方API隔离验收'}),temp=await identity.login(email,seed.temporaryPassword),login=await identity.changePassword(temp.token,seed.temporaryPassword,'live-acceptance-synthetic-password'),user=login.user.user_id,installation=randomUUID();
 await local.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'隔离验收')",[installation,user,randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','')]);
 const account='live-acceptance';await local.query('INSERT INTO usage_provider_identities(provider_account,user_id,provider_user_id,verified_email) VALUES($1,$2,$3,$4)',[account,user,target.provider_user_id,email]);
 await local.ensurePartitions(new Date(Math.min(...events.map(e=>e.occurred_at.getTime()))),new Date());const sessions=new Map();
 for(const [i,e]of events.entries()){const put=await local.ingest({schema_version:2,installation_id:installation,client_event_id:'live-'+i,source_session_id:e.source_session_id,event_type:e.event_type,occurred_at:e.occurred_at.toISOString(),payload:e.event_type==='UserPromptSubmit'?{prompt:'合成验收输入'}:e.event_type==='Stop'?{last_assistant_message:'合成验收输出'}:{}},{admissionEpoch:1,receivedAt:new Date()});if(put.outcome==='committed')sessions.set(e.source_session_id,put.sessionId);}
 const provider=createTraeUsageProvider({baseUrl:env.TRAE_OPENAPI_BASE_URL??'https://console.enterprise.trae.cn',appId:env.TRAE_OPENAPI_APP_ID,appSecret:env.TRAE_OPENAPI_APP_SECRET,timeoutMs:15000,beforeRequest:async()=>{await delay(1500);}});
 const jobs=createUsageAttributionJobs(local,{providerAccount:account,provider}),reader=createSessionReadService(local,identity,{providerAccount:account,stopWindowEnabled:true});
 const pending=new Set(await Promise.all([...sessions.values()].map(id=>jobs.enqueue(id))));
 for(let batch=0;pending.size&&batch<10000;batch++){
  if(!await jobs.runOne())throw new Error('acceptance_background_query_not_ready');
  for(const id of pending){const status=await jobs.status(id);if(status.error_code||status.status==='failed')throw new Error('acceptance_background_query_failed');if(status.status==='succeeded')pending.delete(id);}
 }
 assert.equal(pending.size,0,'all experiment background queries must complete within their bounded batches');
 assert.equal(sessions.size,hooks.length,'all six experiment sessions must be present');
 for(const [hook,id]of sessions){const r=await reader.officialUsage(login.token,id);const collision=hook==='6ac10a7856aeddce1a26728a';assert.equal(r.session_query?.state,collision?'pending':'ready');if(collision){assert.ok(r.session_query.reasons.includes('multiple_candidates'));assert.deepEqual(r.groups,[]);}else{assert.ok(r.groups.length>0);assert.ok(r.groups.every(g=>g.tokens!==null&&BigInt(g.tokens)>0n));}console.log(JSON.stringify({hook,state:r.session_query?.state??'not_published',reasons:r.session_query?.reasons??[],billing_ids:r.session_query?.billing_ids??[],tokens:r.groups.map(g=>g.tokens)}));}
 console.log(JSON.stringify({verdict:'PASS',scenarios:sessions.size,scope:'official_api_with_isolated_database'}));
}catch(e){console.log(JSON.stringify({error:e.code??e.name,message:['source_identity_missing'].includes(e.message)?e.message:undefined}));process.exitCode=1;}finally{await source.close().catch(()=>{});for(const cb of cleanup.reverse())await cb();}
