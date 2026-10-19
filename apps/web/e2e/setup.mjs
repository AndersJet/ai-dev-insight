import { mkdir, writeFile, rm } from 'node:fs/promises';
import {environment,e2eArtifact} from './helpers/environment.mjs';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../../packages/storage/dist/index.js';
import { createIdentityService, createUsageSnapshotStore, createUsageMappingService, createUsageAttributionService, createUsageSyncService } from '../../../packages/domain/dist/index.js';

export default async function setup() {
  const connectionString=environment.databaseURL,journal=e2eArtifact('e2e-cleanup-journal');await rm(journal,{recursive:true,force:true});await mkdir(journal,{recursive:true,mode:0o700});
  const db = openDatabase({ connectionString, schema: environment.schema });
  try {
    // Fixed, owned synthetic schema; never accept a schema or database from the page.
    await db.query(`DROP SCHEMA IF EXISTS "${environment.schema}" CASCADE`);
    await db.migrate();
    const now = new Date(); await db.ensurePartitions(new Date(now.getTime() - 7 * 86_400_000), new Date(now.getTime() + 86_400_000));
    const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
    const adminEmail = 'e2e-root@example.invalid'; const adminPassword = 'e2e-admin-test-password';
    const root = await identity.bootstrap({ email: adminEmail, name: '端到端合成管理员' });
    const first = await identity.login(adminEmail, root.temporaryPassword);
    const admin = await identity.changePassword(first.token, root.temporaryPassword, adminPassword);
    await identity.syncConfigurationAdministrator({ email: 'e2e-config@example.invalid', name: '配置合成管理员', password: 'e2e-configuration-password' });
    const paginationInstallation = randomUUID();
    await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [paginationInstallation, root.userId, 'd'.repeat(64), '分页合成安装']);
    for (let index = 0; index < 22; index++) await db.ingest({ schema_version: 2, installation_id: paginationInstallation, client_event_id: `pagination-${index}`, occurred_at: new Date(now.getTime() - (index + 1) * 1000).toISOString(), event_type: 'UserPromptSubmit', source_session_id: `browser-pagination-${index + 1}`, payload: { prompt: `分页读取示例 ${index + 1}` } }, { admissionEpoch: 1, receivedAt: now });
    const referenceAt=new Date(now.getTime()-120000).toISOString().slice(0,19),firstAt=referenceAt+'.123456Z',secondAt=referenceAt+'.123457Z';
    const eventReference=await db.ingest({schema_version:2,installation_id:paginationInstallation,client_event_id:'composite-reference',occurred_at:firstAt,event_type:'UserPromptSubmit',source_session_id:'browser-composite-reference',payload:{prompt:'REFERENCE_FIRST'}},{admissionEpoch:1,receivedAt:now});
    if(eventReference.outcome!=='committed')throw new Error('Composite browser fixture failed');
    await db.query("INSERT INTO hook_events(id,occurred_at,user_id,installation_id,session_id,event_type,payload) VALUES($1,$2,$3,$4,$5,'UserPromptSubmit','{\"prompt\":\"REFERENCE_SECOND\"}')",[eventReference.eventId,secondAt,root.userId,paginationInstallation,eventReference.sessionId]);
    await db.query('UPDATE sessions SET last_at=$2 WHERE id=$1',[eventReference.sessionId,secondAt]);
    for (const [index, event_type, payload] of [
      [0, 'UserPromptSubmit', { prompt: 'MARKDOWN_WINDOW 大段内容阅读验收' }],
      [1, 'Stop', { last_assistant_message: '# 大段阅读标题\n\n```text\n' + 'CONTENT_WINDOW '.repeat(5000) + '\n```\nTAIL_WINDOW_MARKER' }],
    ]) await db.ingest({ schema_version: 2, installation_id: paginationInstallation, client_event_id: `markdown-window-${index}`, occurred_at: new Date(now.getTime() - 60000 + index * 1000).toISOString(), event_type, source_session_id: 'browser-markdown-window', payload }, { admissionEpoch: 1, receivedAt: now });
    const userId = randomUUID(); const email = 'onboarding@example.invalid';
    await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [userId, email, '端到端合成员工']);
    const issued = await identity.resetPassword(admin.token, userId, 1);
    const departmentA = randomUUID(); const departmentB = randomUUID(); const managerId = randomUUID(); const colleagueId = randomUUID();
    await db.query('INSERT INTO departments(id,name) VALUES($1,$2),($3,$4)', [departmentA, 'E2E统计A部门', departmentB, 'E2E统计B部门']);
    const today = Math.floor((now.getTime() + 8 * 3600_000) / 86_400_000) * 86_400_000 - 8 * 3600_000;
    const start = new Date(today - 7 * 86_400_000); const current = new Date(Math.min(now.getTime(), today + 12 * 3600_000));
    for (const [id, email, name, dept, tokenHash] of [[managerId, 'analytics-manager@example.invalid', '统计经理', departmentA, 'a'.repeat(64)], [colleagueId, 'analytics-colleague@example.invalid', '统计同事', departmentB, 'b'.repeat(64)]]) {
      await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [id, email, name]);
      await db.query('INSERT INTO membership_periods(user_id,department_id,valid_from) VALUES($1,$2,$3)', [id, dept, start]);
      await db.query('INSERT INTO eligibility_periods(user_id,included,valid_from) VALUES($1,true,$2)', [id, start]);
      const installation = randomUUID();
      await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)', [installation, id, tokenHash, '统计合成安装']);
      const instants = id === managerId ? [new Date(today - 12 * 3600_000), current] : [current];
      for (const [index, at] of instants.entries()) await db.ingest({ schema_version: 2, installation_id: installation, client_event_id: `analytics-${index}`, occurred_at: at.toISOString(), event_type: 'UserPromptSubmit', source_session_id: `analytics-${id}`, payload: { prompt: id === managerId ? '修复 PRIVATE_BROWSER_A' : '编写测试 PRIVATE_BROWSER_B' } }, { admissionEpoch: 1, receivedAt: now });
    }
    const traceInstallation = (await db.query('SELECT id FROM installations WHERE user_id=$1', [managerId])).rows[0].id;
    const traceStart = today - 12 * 3600_000;
    for (const [i, event_type, payload] of [
      [1, 'PreToolUse', { tool_use_id: 'browser-tool', tool_name: 'ReadFile', tool_input: { path: 'synthetic.ts' } }],
      [2, 'PostToolUse', { tool_use_id: 'browser-tool', tool_name: 'ReadFile', tool_response: { text: 'SYNTHETIC_TOOL_RESULT' } }],
      [3, 'Stop', { last_assistant_message: '# 排版验收标题\n\n**重点结论**\n\n|项目|结果|\n|---|---|\n|统计|已核对|\n\n```js\nconst example = "safe";\n```\n\n[文档](https://example.invalid/guide)\n\n![外部图片](https://example.invalid/tracking-pixel.png)\n\n[危险链接](javascript:alert(1))\n\n<script>window.__unsafeExecuted=true</script>\n' + '长回答内容😀'.repeat(1800) + '\nANSWER_END_MARKER', stop_hook_active: false }],
    ]) await db.ingest({ schema_version: 2, installation_id: traceInstallation, client_event_id: `trace-${i}`, occurred_at: new Date(traceStart + i * 1000).toISOString(), event_type, source_session_id: `analytics-${managerId}`, payload }, { admissionEpoch: 1, receivedAt: now });
    await db.query("INSERT INTO role_grants(user_id,role,scope_id,valid_from) VALUES($1,'department_admin',$2,$3)", [managerId, departmentA, start]);
    const managerCredential = await identity.resetPassword(admin.token, managerId, 1);
    const managerTemporary = await identity.login('analytics-manager@example.invalid', managerCredential.temporaryPassword);
    await identity.changePassword(managerTemporary.token, managerCredential.temporaryPassword, 'e2e-analytics-manager-password');
    // Dedicated navigation accounts do not depend on another test changing a password.
    const roleNavigation = {};
    for (const role of ['anc_admin', 'employee']) {
      const id = randomUUID(); const email = `navigation-${role}@example.invalid`; const password = `e2e-navigation-${role}-password`;
      await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [id, email, `导航验收 ${role}`]);
      if (role === 'anc_admin') await db.query("INSERT INTO role_grants(user_id,role,valid_from) VALUES($1,'anc_admin',$2)", [id, start]);
      const credential = await identity.resetPassword(admin.token, id, 1);
      const temporary = await identity.login(email, credential.temporaryPassword);
      await identity.changePassword(temporary.token, credential.temporaryPassword, password);
      roleNavigation[role] = { email, password };
    }
    const officialFrom = new Date(start.getTime() + 28800000).toISOString().slice(0, 10);
    const officialStore = createUsageSnapshotStore(db, { providerAccount: 'e2e-official' });
    for (const [person, email, dept, suffix, tokens] of [[managerId, 'analytics-manager@example.invalid', departmentA, 'a', 1000], [colleagueId, 'analytics-colleague@example.invalid', departmentB, 'b', 2000]]) {
      const associationRows=[];
      for (const dayOffset of person === managerId ? [1,0] : [0]) {
        const businessDate = new Date(today - dayOffset * 86400000 + 28800000).toISOString().slice(0,10);
        const draft = await officialStore.begin(person,businessDate); const query = draft.parts[0].query;
        const row = (id, count, source='basic', scene='Chat', client='ide', origin='Trae') => ({ billing_session_id:'synthetic-'+id,provider_user_id:'provider-'+person,email,start_time:String(Math.min(query.end_time,query.start_time+3600)),client,scene,model_name:'Synthetic Model',model_type:'Chat',model_source:origin,consumption_source:source,model_call_count:'1',departments:[{id:'e2e-source-'+suffix,name:'TRAE '+suffix.toUpperCase()+'部门',full_path:'企业/TRAE '+suffix.toUpperCase()+'部门'}],usage:{prompt_tokens:String(count),completion_tokens:'0',total_tokens:String(count),cache_creation_input_tokens:'0',cache_read_input_tokens:'0'},amount:origin==='Custom'?null:source==='pay_go'?'0.123456':'0.000000',amount_reason:origin==='Custom'?'not_priced':null,currency:'CNY',quality:[],token_basis:'provider_reported' });
        const rows=[row(suffix+'-'+dayOffset,dayOffset?500:tokens)];
        if(person===managerId&&dayOffset===0)rows.push(row('paygo',700,'pay_go'),row('cue',200,'basic','CUE'),row('enterprise',300,'enterprise_builtin','Chat','','Custom'));
        associationRows.push(...rows);
        await officialStore.stage(draft,0,{items:rows,pagination:{page:1,page_size:200,total:rows.length,total_pages:1},request_id:'synthetic-official',observed_at:now.toISOString(),response_hash:'e'.repeat(64),query:{endpoint:'user_usage_detail',parameters:query}});await officialStore.publish(draft);
      }
      const mappings=createUsageMappingService(db,identity,{providerAccount:'e2e-official'});const currentMapping=await mappings.list(admin.token,dept);
      await mappings.create(admin.token,{department_id:dept,external_department_id:'e2e-source-'+suffix,from_date:officialFrom,version:currentMapping.version});
      const session=(await db.query('SELECT id FROM sessions WHERE user_id=$1 AND source_session_id=$2',[person,'analytics-'+person])).rows[0];
      const attribution=createUsageAttributionService(db,{providerAccount:'e2e-official',provider:{getSessionUsage:async hook=>({items:associationRows,pagination:null,request_id:'synthetic-association',observed_at:now.toISOString(),response_hash:'a'.repeat(64),query:{endpoint:'session_usage_detail',parameters:{session_ids:[hook]}}})}});
      await attribution.probe(session.id);
    }
    await createUsageSyncService(db,{providerAccount:'e2e-official'}).retryBackfill(managerId);
    // Existing synthetic fixtures represent registered users; password registration is exercised separately.
    await db.query("UPDATE users SET registered_at=$1,adopted_at=(SELECT max(last_seen) FROM installations WHERE user_id=users.id) WHERE management_source='system'",[start]);
    await mkdir(environment.artifactRoot, { recursive: true, mode: 0o700 });
    await writeFile(e2eArtifact('e2e-credentials.json'), JSON.stringify({ roleNavigation, email, userId, temporaryPassword: issued.temporaryPassword, admin: { email: adminEmail, password: adminPassword, userId: root.userId }, official: { fromDate: officialFrom }, analytics: { departmentA, departmentB, managerEmail: 'analytics-manager@example.invalid', managerPassword: 'e2e-analytics-manager-password' } }), { mode: 0o600 });
  } finally { await db.close(); }
}
