import {environment as e2eEnv,e2eArtifact} from './helpers/environment.mjs';
import {test,expect} from './helpers/browser.js';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../../../packages/storage/src/index.js';

test('legacy prerequisite API remains available without a deviation-check panel',async({page})=>{
 test.setTimeout(60000);
 // The fixture has more than 20 sessions; discovery may need its next 30-second batch.
 const fixture=JSON.parse(readFileSync(e2eArtifact('e2e-credentials.json'),'utf8'));
 await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill(fixture.analytics.managerEmail);await page.getByLabel('密码',{exact:true}).fill(fixture.analytics.managerPassword);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByRole('button',{name:'退出登录',exact:true})).toBeVisible();
 const list=await page.request.get('/api/v1/me/sessions?search=PRIVATE_BROWSER_A');const id=(await list.json()).data.items[0].id;
 await expect.poll(async()=>{const response=await page.request.get(`/api/v1/sessions/${id}/token-check`);return (await response.json()).data?.state;},{timeout:40000}).toBe('current');
 const checked=(await (await page.request.get(`/api/v1/sessions/${id}/token-check`)).json()).data;expect(checked.result.verdict).toBe('insufficient_data');expect(checked.result.eligible).toBe(false);expect(checked.checked_at).toBeTruthy();expect(checked.next_check_at).toBeTruthy();
 await page.goto(`/my/sessions/${id}`);await page.getByRole('tab',{name:'官方用量',exact:true}).click();await expect(page.getByTestId('token-check')).toHaveCount(0);await expect(page.getByTestId('session-official-tokens')).toBeVisible();
});


test('a resumed session retains legacy check compatibility without restoring the deviation UI',async({page})=>{
 test.setTimeout(60000);
 const fixture=JSON.parse(readFileSync(e2eArtifact('e2e-credentials.json'),'utf8'));
 const db=openDatabase({connectionString:e2eEnv.databaseURL,schema:e2eEnv.schema});
 const now=new Date(),old=new Date(now.getTime()-46*86400000),installation=randomUUID(),source='resumed-check-'+randomUUID();let sid='';
 try{
  await db.ensurePartitions(old,new Date(now.getTime()+86400000));
  await db.query("INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,'检查恢复合成安装')",[installation,fixture.admin.userId,randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','')]);
  const put=(id:string,at:Date)=>db.ingest({schema_version:2,installation_id:installation,client_event_id:id,source_session_id:source,occurred_at:at.toISOString(),event_type:'UserPromptSubmit',payload:{prompt:'E2E_RESUMED_CHECK'}},{admissionEpoch:1,receivedAt:at});
  const first=await put('old',old);expect(first.outcome).toBe('committed');if(first.outcome!=='committed')throw new Error('fixture failed');sid=first.sessionId;
  // This historical state is produced by the expiry integration regression.
  // Only new ingestion and production worker discovery may reactivate it here.
  await db.query("INSERT INTO jobs(id,kind,dedupe_key,payload,status,error_code) VALUES($1,'session_token_check',$2,$3,'cancelled','token_check_expired')",[randomUUID(),'token-check:e2e-official:'+sid,{session_id:sid,provider_account:'e2e-official'}]);
  const resumed=await put('resumed',now);expect(resumed.outcome).toBe('committed');if(resumed.outcome==='committed')expect(resumed.sessionId).toBe(sid);
  await page.goto('/login');await page.getByLabel('邮箱',{exact:true}).fill(fixture.admin.email);await page.getByLabel('密码',{exact:true}).fill(fixture.admin.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'退出登录',exact:true}).waitFor();
  await expect.poll(async()=>{const response=await page.request.get(`/api/v1/sessions/${sid}/token-check`);const value=(await response.json()).data;return value?.state==='current'&&!!value.next_check_at;},{timeout:40000}).toBe(true);
  const official=await page.request.get(`/api/v1/sessions/${sid}/official-usage`);expect(official.status()).toBe(200);expect((await official.json()).data.groups).toHaveLength(0);
  await page.goto(`/my/sessions/${sid}`);await page.getByRole('tab',{name:'官方用量',exact:true}).click();await expect(page.getByTestId('token-check')).toHaveCount(0);
  await expect(page.getByTestId('official-usage-unavailable')).toBeVisible();await expect(page.getByTestId('session-official-tokens')).toHaveCount(0);
 }finally{await db.close();}
});
