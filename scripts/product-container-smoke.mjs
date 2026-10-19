import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

// Fixed local images and a fresh isolated database. Never consumes deployment env.
const args=process.argv.slice(2);
if(args.length>1||(args[0]&&!['--platform=linux/amd64','--platform=linux/arm64'].includes(args[0])))throw new Error('Use --platform=linux/amd64 or --platform=linux/arm64');
const platform=args[0]?.slice('--platform='.length),requestedArchitecture=platform?.split('/')[1];
const imageTag=requestedArchitecture?`${requestedArchitecture}-local`:'local';
const run = promisify(execFile), id = randomUUID(), project = `adi-smoke-${id.slice(0, 8)}`;
const directory = await mkdtemp(join(tmpdir(), 'adi-product-smoke-'));
const envFile = join(directory, 'candidate.env');
const compose = ['compose', '--env-file', envFile, '-p', project, '-f', resolve('deploy/product/compose.database.yml'), '-f', resolve('deploy/product/compose.candidate.yml')];
const override=join(directory,'isolated.json');
await writeFile(override,JSON.stringify({networks:{default:{name:project,external:false}},...(platform?{services:Object.fromEntries(['initialize','api','collector','worker','web'].map(name=>[name,{platform}]))}:{})}),{mode:0o600});compose.push('-f',override);
const cleanEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}), ...(process.env.DOCKER_CONTEXT ? { DOCKER_CONTEXT: process.env.DOCKER_CONTEXT } : {}) };
async function docker(args, step) {
  // Do not retain or print subprocess diagnostics: bootstrap stdout may contain a credential.
  const result = await run('docker', args, { env: cleanEnv, timeout: 180_000, maxBuffer: 2 * 1024 * 1024 }).then(
    value => ({ ok: true, stdout: value.stdout }),
    error => ({ ok: false, exit_code: typeof error.code === 'number' ? error.code : 'execution', diagnostics: String(error.stderr ?? '').slice(-8000) }),
  );
  if (!result.ok) {
    let diagnostic = result.diagnostics;
    for (const [key, value] of Object.entries(config)) if (/PASSWORD|SECRET|DATABASE_URL/.test(key) && value) diagnostic = diagnostic.replaceAll(value, '[redacted]');
    await writeFile(join(directory, 'docker-error.json'), JSON.stringify({ step, exit_code: result.exit_code, diagnostic })+'\n', { mode: 0o600 });
    throw new Error(`container_smoke_failed:${step}:${result.exit_code}`);
  }
  return result.stdout;
}
async function port() { const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const value = server.address().port; await new Promise(done => server.close(done)); return value; }
const webPort = await port(), collectorPort = await port();
await mkdir(join(directory, 'postgres'), { mode: 0o700 });
await mkdir(join(directory, 'cleanup'), { mode: 0o700 });
const password = randomBytes(24).toString('hex');
const config = {
  ADI_IMAGE_PREFIX: 'adi-product', ADI_IMAGE_TAG: imageTag, ADI_ADMIN_EMAIL: 'smoke.admin@example.org', ADI_ADMIN_PASSWORD: 'synthetic-container-smoke-password', ADI_PG_HOST_PORT: String(await port()),
  ADI_PG_DATA_DIR: join(directory, 'postgres'), ADI_CLEANUP_JOURNAL_HOST_DIR: join(directory, 'cleanup'), ADI_PG_ADMIN_PASSWORD: randomBytes(24).toString('hex'), ADI_APP_DB_PASSWORD: password,
  ADI_DATABASE_URL: `postgresql://adi_app:${password}@postgres:5432/adi`, ADI_DATABASE_SCHEMA: 'adi', ADI_EMAIL_DOMAINS: 'example.org',
  ADI_WEB_ORIGIN: 'https://candidate.example.invalid', ADI_PUBLIC_COLLECTOR_URL: 'https://collector.example.invalid/hooks',
  ADI_WEB_HOST_PORT: String(webPort), ADI_COLLECTOR_HOST_PORT: String(collectorPort), ADI_STORAGE_BUDGET_BYTES: '1000000000',
};
await writeFile(envFile, Object.entries(config).map(([key, value]) => `${key}=${value}`).join('\n')+'\n', { mode: 0o600, flag: 'wx' });
const report = { id, environment: 'local Docker synthetic only', production: false, tls: false, requested_platform:platform??'daemon default', daemon_architecture:'unknown', emulated:false, images: {}, checks: {}, resources: [] };
let localDaemonConfirmed=false;
const inApi = code => docker([...compose, 'exec', '-T', 'api', 'node', '--input-type=module', '-e', code], 'api-probe');
const probe = `import {configuredServices} from './apps/api/dist/config.js'; const s=configuredServices(); try { console.log(JSON.stringify({facts:Number((await s.db.query('SELECT count(*) AS n FROM hook_events')).rows[0].n),derived:Number((await s.db.query('SELECT count(*) AS n FROM sessions WHERE derived_run_id IS NOT NULL')).rows[0].n),superuser:(await s.db.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper})); } finally {await s.db.close();}`;
try {
  const endpoint=cleanEnv.DOCKER_HOST&&!cleanEnv.DOCKER_CONTEXT?cleanEnv.DOCKER_HOST:(await docker(['context','inspect','--format','{{.Endpoints.docker.Host}}'],'docker-context')).trim();
  if(!endpoint.startsWith('unix://')&&!endpoint.startsWith('npipe://'))throw new Error('Local Docker socket required for synthetic smoke tests');
  localDaemonConfirmed=true;
  const observedArchitecture=(await docker(['info','--format','{{.Architecture}}'],'daemon-architecture')).trim();
  const daemonArchitecture=({aarch64:'arm64',arm64:'arm64',x86_64:'amd64',amd64:'amd64'})[observedArchitecture];
  if(!daemonArchitecture)throw new Error('Unsupported Docker daemon architecture');
  const expectedArchitecture=requestedArchitecture??daemonArchitecture;
  report.daemon_architecture=daemonArchitecture;report.database_architecture=daemonArchitecture;report.emulated=expectedArchitecture!==daemonArchitecture;
  await docker([...compose, 'config', '--quiet'], 'compose-config');
  for (const name of ['api', 'collector', 'worker', 'web']) report.images[name] = (await docker(['image', 'inspect', `adi-product-${name}:${imageTag}`, '--format', '{{.Id}} {{.Architecture}} {{.Size}}'], 'image-identity')).trim();
  for(const identity of Object.values(report.images))assert.equal(identity.split(' ')[1],expectedArchitecture,'runtime image architecture must match the requested test');
  // Only this newly created scratch directory is changed, not any existing journal.
  await docker(['run', '--rm', ...(platform?['--platform',platform]:[]), '--user', '0', '-v', `${join(directory, 'cleanup')}:/journal`, `adi-product-api:${imageTag}`, 'node', '-e', "const fs=require('fs');fs.chownSync('/journal',1000,1000);fs.chmodSync('/journal',0o700)"], 'private-journal');
  await docker([...compose, 'up', '-d', '--wait', '--wait-timeout', '60', 'postgres'], 'postgres-start');
  await docker([...compose, 'up', '-d', '--wait', '--wait-timeout', '60'], 'runtime-start');
  const base = `http://127.0.0.1:${webPort}`;
  const html = await globalThis.fetch(base+'/my/sessions', {signal:globalThis.AbortSignal.timeout(2000)});
  assert.equal(html.status,200);assert.equal(html.headers.get('x-frame-options'),'DENY');assert.match(await html.text(),/type="module"/);report.checks.spa_history=true;
  const me=await globalThis.fetch(base+'/api/v1/me',{signal:globalThis.AbortSignal.timeout(2000)});
  assert.equal(me.status,401);assert.equal((await me.json()).error.code,'unauthenticated');report.checks.api_proxy=true;
  const missing=await globalThis.fetch(base+'/assets/not-a-real-asset.js',{signal:globalThis.AbortSignal.timeout(2000)});assert.equal(missing.status,404);await missing.body?.cancel();
  const chrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browser=await chromium.launch({headless:true,...(process.platform==='darwin'&&existsSync(chrome)?{executablePath:chrome}:{})});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:960}}),faults=[];
    page.on('pageerror',error=>faults.push(error.name));
    await page.goto(base+'/my/sessions');
    await page.getByRole('heading',{name:'登录工作空间',exact:true}).waitFor({timeout:10_000});
    assert.deepEqual(faults,[]);
    await page.screenshot({path:join(directory,'built-web-login.png')});
    report.checks.compiled_browser_boot=true;
  } finally {await browser.close();}
  const artifact=JSON.parse(await inApi("import fs from 'node:fs'; console.log(JSON.stringify({development:fs.readdirSync('/app/node_modules/.pnpm').filter(n=>/^(typescript@|tsx@|vite@|eslint@|@playwright\\+test@)/.test(n)),source:fs.existsSync('/app/apps/api/src'),tests:fs.existsSync('/app/packages/domain/test'),run:fs.existsSync('/app/.run')}));"));
  assert.deepEqual(artifact,{development:[],source:false,tests:false,run:false});report.checks.production_artifact_only=true;
  const release=JSON.parse(await inApi("import {loadClientDistribution} from './apps/api/dist/client-distribution.js'; const d=await loadClientDistribution({collectorUrl:process.env.ADI_PUBLIC_COLLECTOR_URL}); console.log(JSON.stringify({ready:!!d.release,endpoint:!!d.collectorUrl}));"));assert.deepEqual(release,{ready:true,endpoint:true});report.checks.client_archive=true;
  const seed=JSON.parse(await inApi(`import {configuredServices} from './apps/api/dist/config.js'; const s=configuredServices();try{const admin=await s.identity.login('smoke.admin@example.org','synthetic-container-smoke-password');if(admin.user.must_change_password||admin.user.management_source!=='environment')throw new Error('configuration-admin');const department=await s.organization.createDepartment(admin.token,'合成容器烟测部门');await s.registration.register({email:'smoke.employee@example.org',password:'synthetic-container-smoke-password',display_name:'合成容器烟测人员',department_id:department.id},'container-smoke');const a=await s.identity.login('smoke.employee@example.org','synthetic-container-smoke-password');const i=await s.installations.credential(a.token);console.log(JSON.stringify({id:i.installation.id,token:i.token}));}finally{await s.db.close();}`));
  // A policy refresh after issuing the installation must precede this one-shot Hook.
  await delay(2500);
  const ready=await globalThis.fetch(`http://127.0.0.1:${collectorPort}/readyz`);assert.equal(ready.status,200);await ready.body?.cancel();
  const body={schema_version:2,installation_id:seed.id,client_event_id:id,occurred_at:new Date().toISOString(),event_type:'UserPromptSubmit',source_session_id:'candidate-smoke',payload:{hook_event_name:'UserPromptSubmit',session_id:'candidate-smoke',prompt:'Synthetic image smoke only'}};
  const response=await globalThis.fetch(`http://127.0.0.1:${collectorPort}/hooks`,{method:'POST',headers:{authorization:`Bearer ${seed.token}`},body:JSON.stringify(body),signal:globalThis.AbortSignal.timeout(2000)});
  assert.equal(response.status,200);assert.equal(await response.text(),'');
  let state;
  for(let n=0;n<25;n++){state=JSON.parse(await inApi(probe));if(state.facts===1&&state.derived===1)break;await delay(300);}
  assert.deepEqual(state,{facts:1,derived:1,superuser:false});report.checks.non_superuser_migration_ingest_derivation=true;
  const ids=(await docker([...compose,'ps','-q'],'container-ids')).trim().split('\n');
  for(const container of ids){const raw=JSON.parse(await docker(['inspect',container],'runtime-limits'))[0];const architecture=(await docker(['image','inspect',raw.Image,'--format','{{.Architecture}}'],'container-architecture')).trim();report.resources.push({architecture,state:raw.State.Status,restarts:raw.RestartCount,service:raw.Config.Labels['com.docker.compose.service'],memory:raw.HostConfig.Memory,nano_cpus:raw.HostConfig.NanoCpus,read_only:raw.HostConfig.ReadonlyRootfs,user:raw.Config.User,ports:raw.HostConfig.PortBindings});}
  assert.equal(report.resources.length,5);
  // The independently supplied database uses the local daemon's native architecture.
  for(const item of report.resources){assert.equal(item.architecture,item.service==='postgres'?daemonArchitecture:expectedArchitecture);assert.equal(item.state,'running');assert.equal(item.restarts,0);assert.ok(item.memory>0&&item.nano_cpus>0);if(item.service!=='postgres'){assert.equal(item.read_only,true);assert.ok(['node','nginx'].includes(item.user));}for(const bindings of Object.values(item.ports??{}))for(const binding of bindings??[])assert.equal(binding.HostIp,'127.0.0.1');}
  report.checks.resource_limits_and_bindings=true;report.checks.platform_and_process_state=true;
  await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({passed:true,report:join(directory,'report.json'),checks:report.checks}));
} catch (error) {
  // Diagnostics stay private; never print potentially credential-bearing child output.
  const logs=localDaemonConfirmed?await run('docker',[...compose,'logs','--no-color'],{env:cleanEnv,timeout:10_000,maxBuffer:2*1024*1024}).then(value=>value.stdout+'\n'+value.stderr,()=> 'diagnostics unavailable'):'No local daemon confirmed; no Docker diagnostics requested';
  await writeFile(join(directory,'failure-logs.txt'),logs,{mode:0o600});
  console.error(JSON.stringify({passed:false,diagnostics:join(directory,'failure-logs.txt'),error:error.message}));
  process.exitCode=1;
} finally {
  // No -v and no host-file deletion: preserve this run's diagnostic evidence.
  if(localDaemonConfirmed)await docker([...compose,'--profile','*','down','--remove-orphans'],'isolated-teardown');
}
