import { configuredServices } from './config.js';
import { createUsageSyncService, createUsageAttributionJobs, createSessionDerivationService } from '@adi/domain';
import {randomUUID} from 'node:crypto';
import {cliDiagnostic} from './cli-diagnostics.js';
let services: ReturnType<typeof configuredServices> = null;
const started=Date.now(),runId=/^[a-f0-9-]{36}$/.test(process.env.ADI_DEV_RUN_ID??'')?process.env.ADI_DEV_RUN_ID:randomUUID();
const action=['init','migrate','partitions','rebuild-session','queue-usage','queue-usage-backfill','queue-attribution'].includes(process.argv[2]??'')?process.argv[2]:'unknown';
let stage='configuration',stageStarted=started;
// Queue commands keep their single JSON result on stdout for existing callers.
function log(event:string,fields:Record<string,unknown>={}){if(['init','migrate','partitions'].includes(action??''))process.stdout.write(JSON.stringify({at:new Date().toISOString(),level:'info',component:'api-cli',run_id:runId,action,stage,event,...fields})+'\n');}
function enterStage(value:string){log('stage_completed',{duration_ms:Date.now()-stageStarted});stage=value;stageStarted=Date.now();log('stage_started');}
try {
  log('cli_started');
  services = configuredServices();
  if (!services) throw Object.assign(new Error('Configuration required'), { code: 'configuration_required' });
  if (action === 'init') {
    enterStage('validate_administrator');
    const email = process.env.ADI_ADMIN_EMAIL, password = process.env.ADI_ADMIN_PASSWORD;
    if (!email || !password) throw Object.assign(new Error('Configuration administrator required'), { code: 'configuration_required' });
    // Validate identity and password policy before touching a fresh database.
    services.identity.normalizeEmail(email);
    if (password.length < 12 || password.length > 128) throw Object.assign(new Error('Invalid administrator password'), { code: 'invalid_password' });
    enterStage('migrate');await services.db.migrate();
    const now = new Date();
    enterStage('partitions');
    await services.db.ensurePartitions(new Date(now.getTime() - 365 * 86_400_000), new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 1)));
    enterStage('sync_administrator');await services.identity.syncConfigurationAdministrator({ email, password, name: '系统管理员' });
    process.stdout.write('Database and configuration administrator initialized.\n');
  }
  else if (action === 'migrate') { enterStage('migrate');await services.db.migrate(); process.stdout.write('Database migrations applied.\n'); }
  else if (action === 'partitions') {
    enterStage('partitions');
    const now = new Date();
    await services.db.ensurePartitions(new Date(now.getTime() - 365 * 86_400_000), new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 1)));
    process.stdout.write('Hook partitions prepared for retained history, current and next month.\n');
  }
  else if (action === 'rebuild-session') {
    enterStage('rebuild_session');
    const id = process.argv[3]; if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('Session UUID required');
    await createSessionDerivationService(services.db).enqueueRebuild(id);
    process.stdout.write('Session reconstruction queued.\n');
  }
  else if (action === 'queue-usage') {
    enterStage('queue_usage');
    const account=process.env.ADI_USAGE_PROVIDER_ACCOUNT;const id=process.argv[3];const date=process.argv[4];
    if(!account||!id||!date)throw Object.assign(new Error('Usage: queue-usage USER_UUID YYYY-MM-DD'),{code:'configuration_required'});
    const job=await createUsageSyncService(services.db,{providerAccount:account}).enqueue(id,date);
    process.stdout.write(JSON.stringify({job_id:job})+'\n');
  }
  else if(action==='queue-usage-backfill'){
    enterStage('queue_usage_backfill');
    const account=process.env.ADI_USAGE_PROVIDER_ACCOUNT,id=process.argv[3];if(!account||!id)throw Object.assign(new Error('Backfill user required'),{code:'configuration_required'});
    process.stdout.write(JSON.stringify(await createUsageSyncService(services.db,{providerAccount:account}).retryBackfill(id))+'\n');
  }
  else if (action === 'queue-attribution') {
    enterStage('queue_attribution');
    const account=process.env.ADI_USAGE_PROVIDER_ACCOUNT;const id=process.argv[3];
    if(!account||!id)throw Object.assign(new Error('Usage: queue-attribution SESSION_UUID'),{code:'configuration_required'});
    const job=await createUsageAttributionJobs(services.db,{providerAccount:account}).enqueue(id);
    process.stdout.write(JSON.stringify({job_id:job})+'\n');
  }
  else throw new Error('Use init, migrate, partitions, rebuild-session, queue-usage, queue-usage-backfill or queue-attribution');
  log('stage_completed',{duration_ms:Date.now()-stageStarted});log('cli_completed',{duration_ms:Date.now()-started});
} catch (error) {
  process.stderr.write(JSON.stringify({at:new Date().toISOString(),level:'error',component:'api-cli',event:'cli_failed',run_id:runId,action,stage,duration_ms:Date.now()-started,stage_duration_ms:Date.now()-stageStarted,...cliDiagnostic(error)})+'\n');process.exitCode=1;
} finally { await services?.db.close(); }
