import { openDatabase, createRuntimeReporter } from '@adi/storage';
import { createIdentityService, createMemberImportService, createSessionDerivationService,createSessionTokenChecks,createSessionListSnapshotPublisher } from '@adi/domain';
import { setTimeout as delay } from 'node:timers/promises';
if (!process.env.ADI_DATABASE_URL) throw new Error('ADI_DATABASE_URL is required');
const db = openDatabase({ connectionString: process.env.ADI_DATABASE_URL, schema: process.env.ADI_DATABASE_SCHEMA ?? 'adi', maxConnections: 2 });
const reporter=createRuntimeReporter(db,'worker');
const identity = createIdentityService(db, { emailDomains: (process.env.ADI_EMAIL_DOMAINS ?? '').split(',') });
const imports = createMemberImportService(db, identity);
const derivations = createSessionDerivationService(db,{batchSize:16});
const stopWindow=process.env.ADI_USAGE_STOP_WINDOW_ENABLED??'false';if(!['true','false'].includes(stopWindow))throw new Error('Invalid usage configuration');
const snapshots=createSessionListSnapshotPublisher(db,{...(process.env.ADI_USAGE_PROVIDER_ACCOUNT?{providerAccount:process.env.ADI_USAGE_PROVIDER_ACCOUNT}:{}),stopWindowEnabled:stopWindow==='true'});

let stopping = false;
const tokenChecks=createSessionTokenChecks(db,{...(process.env.ADI_USAGE_PROVIDER_ACCOUNT?{providerAccount:process.env.ADI_USAGE_PROVIDER_ACCOUNT}:{}),stopping:()=>stopping});let tokenTurn=0;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { stopping = true; });
try {
  await db.assertNotRecovering();await reporter.flush();process.stdout.write(JSON.stringify({ event: 'jobs_ready' }) + '\n');
  while (!stopping) {
    try {
      await db.assertNotRecovering();
      const discovered = await derivations.discoverStale()+await tokenChecks.discoverRecent();
      const imported = await imports.runOne();
      const derived = await derivations.runOne();
      const pruned = await derivations.pruneRetired();
      const projected=await snapshots.runOne();
      const checked=(++tokenTurn%64===0||(!imported&&!derived&&!pruned))?await tokenChecks.runOne():false;
      reporter.success(Number(imported)+Number(derived)+Number(pruned)+Number(checked)+Number(projected));await reporter.flush();
      if (!discovered && !imported && !derived && !pruned && !checked&&!projected) await delay(300);
    }
    catch { reporter.failure();await reporter.flush();process.stderr.write(JSON.stringify({ level: 'error', code: 'job_poll_failed' }) + '\n'); await delay(1000); }
  }
} finally { await reporter.flush(true);await db.close(); }
