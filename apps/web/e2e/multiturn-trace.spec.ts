import {environment as e2eEnv,e2eArtifact} from './helpers/environment.mjs';
import {test,expect} from './helpers/browser.js';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../../packages/storage/src/index.js';

test('real worker keeps late tool results in the first turn and exposes ambiguous notifications without losing Stop bodies',async({page})=>{
 test.setTimeout(60000);
 const fixture=JSON.parse(readFileSync(e2eArtifact('e2e-credentials.json'),'utf8'));
 const db=openDatabase({connectionString:e2eEnv.databaseURL,schema:e2eEnv.schema});
 const installation=randomUUID(),source='multiturn-'+randomUUID(),base=Date.now()-20000;let sid='';
 try{
  await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'多轮轨迹合成验证')",[installation,fixture.admin.userId,randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','')]);
  const events=[['UserPromptSubmit',{prompt:'E2E_FIRST_PROMPT'}],['PreToolUse',{tool_use_id:'late-first',tool_name:'Read',tool_input:{file:'FIRST_FILE'}}],['Stop',{last_assistant_message:'FIRST_STOP',loop_count:0}],['UserPromptSubmit',{prompt:'E2E_SECOND_PROMPT'}],['Stop',{last_assistant_message:'SECOND_STOP_SAME',loop_count:0}],['Stop',{last_assistant_message:'SECOND_STOP_SAME',loop_count:1}],['Stop',{last_assistant_message:'STOP_COUNT_UNKNOWN'}],['PostToolUse',{tool_use_id:'late-first',tool_name:'Read',tool_response:'LATE_FIRST_RESULT'}],['Notification',{notification_type:'idle_prompt'}]] as const;
  for(const [i,[event_type,payload]] of events.entries()){const saved=await db.ingest({schema_version:2,installation_id:installation,client_event_id:`trace-${i}`,event_type,source_session_id:source,occurred_at:new Date(base+i*1000).toISOString(),timestamp_source:'source_reported',payload},{admissionEpoch:1,receivedAt:new Date()});expect(saved.outcome).toBe('committed');if(saved.outcome==='committed')sid=saved.sessionId;}
  await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill(fixture.admin.email);await page.getByLabel('密码',{exact:true}).fill(fixture.admin.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'退出登录',exact:true}).waitFor();
  await expect.poll(async()=>{const response=await page.request.get(`/api/v1/sessions/${sid}`);return (await response.json()).data?.projection_ready;},{timeout:10000}).toBe(true);
  await page.goto(`/my/sessions/${sid}`);await expect(page.getByTestId('trace-quality')).toContainText('完成通知可能对应多轮');await expect(page.getByTestId('trace-quality')).toContainText('有提示轮次的完成情况尚未确认');await expect(page.getByTestId('trace-quality')).not.toContainText('未观测到结束记录');
  const trace=page.getByTestId('session-trace');await expect(trace).toContainText('E2E_FIRST_PROMPT');await expect(trace).toContainText('Stop 重入计数：0');await expect(trace).toContainText('不是模型调用次数');await trace.locator('summary').filter({hasText:'Read · 工具步骤'}).click();await expect(trace).toContainText('LATE_FIRST_RESULT');
  await page.getByRole('button',{name:/第 2 轮/}).click();await expect(trace).toContainText('E2E_SECOND_PROMPT');await expect(trace).not.toContainText('LATE_FIRST_RESULT');await expect(trace.getByText('SECOND_STOP_SAME',{exact:true})).toHaveCount(2);await expect(trace).toContainText('Stop 重入计数：1');await expect(trace).toContainText('Stop 重入计数：未提供');
  await page.getByRole('button',{name:'全部事件（含未归属）',exact:true}).click();await expect(trace).toContainText('轮次未确定');await page.screenshot({path:'.run/multiturn-trace.png',fullPage:true});
  const data=(await (await page.request.get(`/api/v1/sessions/${sid}`)).json()).data;expect(data.status).toBe('unknown');expect(data.prompt_turns).toBe(2);expect(data.events).toBe(9);
  await page.getByRole('tab',{name:'原始事件',exact:true}).click();await expect(page.locator('.raw-event')).toHaveCount(9);
  await db.query("UPDATE session_derivations SET metric_version='session-v7' WHERE id=(SELECT derived_run_id FROM sessions WHERE id=$1)",[sid]);expect((await (await page.request.get(`/api/v1/sessions/${sid}`)).json()).data.projection_ready).toBe(false);
  // The production discovery cadence is 30 seconds. Observe the real worker;
  // do not invoke the derivation service directly to bypass that integration.
  await expect.poll(async()=>((await (await page.request.get(`/api/v1/sessions/${sid}`)).json()).data.projection_ready),{timeout:35000}).toBe(true);
  await page.reload();await expect(trace).toContainText('E2E_FIRST_PROMPT');

 }finally{await db.close();}
});

test('an unfinished earlier turn remains visibly unconfirmed after a later turn finishes',async({page})=>{
 const fixture=JSON.parse(readFileSync(e2eArtifact('e2e-credentials.json'),'utf8'));
 const db=openDatabase({connectionString:e2eEnv.databaseURL,schema:e2eEnv.schema}),installation=randomUUID(),source='interrupted-'+randomUUID(),at=Date.now()-10000;let sid='';
 try{
  await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'中断续跑合成验证')",[installation,fixture.admin.userId,randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','')]);
  const events=[['UserPromptSubmit',{prompt:'E2E_INTERRUPTED_PROMPT'}],['UserPromptSubmit',{prompt:'E2E_RESUMED_PROMPT'}],['Stop',{last_assistant_message:'E2E_RESUMED_REPLY',loop_count:0,stop_hook_active:false}],['Notification',{notification_type:'idle_prompt'}]] as const;
  for(const [i,[event_type,payload]] of events.entries()){const r=await db.ingest({schema_version:2,installation_id:installation,client_event_id:`interrupted-${i}`,source_session_id:source,event_type,occurred_at:new Date(at+i*1000).toISOString(),timestamp_source:'source_reported',payload},{admissionEpoch:1,receivedAt:new Date()});expect(r.outcome).toBe('committed');if(r.outcome==='committed')sid=r.sessionId;}
  await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill(fixture.admin.email);await page.getByLabel('密码',{exact:true}).fill(fixture.admin.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'退出登录',exact:true}).waitFor();
  await expect.poll(async()=>((await (await page.request.get(`/api/v1/sessions/${sid}`)).json()).data?.projection_ready),{timeout:10000}).toBe(true);
  const data=(await (await page.request.get(`/api/v1/sessions/${sid}`)).json()).data;expect(data.quality).toContain('completion_unconfirmed');expect(data.quality).toContain('completion_association_inferred');
  await page.goto(`/my/sessions/${sid}`);await expect(page.getByTestId('trace-quality')).toContainText('有提示轮次的完成情况尚未确认');await expect(page.getByTestId('trace-quality')).toContainText('完成通知的轮次归属为推断');
  const trace=page.getByTestId('session-trace');await expect(trace).toContainText('E2E_INTERRUPTED_PROMPT');await expect(trace).not.toContainText('E2E_RESUMED_REPLY');await page.getByRole('button',{name:/第 2 轮/}).click();await expect(trace).toContainText('E2E_RESUMED_REPLY');await expect(page.getByTestId('trace-quality')).toContainText('后续轮次完成不补齐这些缺口');
 }finally{await db.close();}
});
