import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {connectionString} from '../../../storage/test/helpers.js';
import {stopUsageFixture} from '../helpers/stop-usage.js';

test('the real jobs main survives its first snapshot SQL failure and later publishes new derivation and list data',{timeout:25000},async t=>{
 const f=await stopUsageFixture(t);
 await f.db.query('ALTER TABLE session_list_snapshot_entries RENAME TO session_list_snapshot_entries_delayed');
 const worker=spawn(process.execPath,['--import','tsx','--max-old-space-size=256',fileURLToPath(new URL('../../../../apps/worker/src/main.ts',import.meta.url))],{
  cwd:fileURLToPath(new URL('../../../../',import.meta.url)),
  env:{PATH:process.env.PATH,LANG:process.env.LANG,ADI_DATABASE_URL:connectionString,ADI_DATABASE_SCHEMA:f.db.schema,ADI_EMAIL_DOMAINS:'example.invalid',ADI_USAGE_PROVIDER_ACCOUNT:'stop-test',ADI_USAGE_STOP_WINDOW_ENABLED:'true'},
  stdio:['ignore','pipe','pipe'],
 });
 let stdout='',stderr='';worker.stdout.on('data',value=>{stdout+=value;});worker.stderr.on('data',value=>{stderr+=value;});
 const ended=new Promise<void>(resolve=>worker.once('close',()=>resolve()));
 async function waitFor(predicate:()=>Promise<boolean>|boolean,budget:number){const until=Date.now()+budget;while(!await predicate()){assert.equal(worker.exitCode,null,'jobs worker must remain alive');if(Date.now()>=until)throw new Error('Synthetic jobs worker observation expired');await delay(50);}}
 try{
  await waitFor(()=>stdout.includes('jobs_ready')&&stderr.includes('job_poll_failed'),8000);
  assert.equal(worker.exitCode,null,'first publication failure must be handled in the polling loop');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM session_list_snapshots')).rows[0]!.n,0);
  await f.db.query('ALTER TABLE session_list_snapshot_entries_delayed RENAME TO session_list_snapshot_entries');
  const saved=await f.db.ingest({schema_version:2,installation_id:f.installation,client_event_id:randomUUID(),source_session_id:'synthetic-hook',event_type:'Notification',occurred_at:f.at.toISOString(),payload:{message:'After startup SQL failure'}},{admissionEpoch:1,receivedAt:f.at});
  assert.equal(saved.outcome,'committed');
  await waitFor(async()=>{
   const rows=await f.db.query(`SELECT 1 FROM session_list_snapshots snap JOIN session_list_snapshot_entries e ON e.id=(snap.owner_entries->>$1)::uuid
    JOIN sessions s ON s.id=$2 JOIN session_derivations r ON r.id=s.derived_run_id JOIN jobs j ON j.dedupe_key='derive:'||s.id::text
    WHERE snap.expires_at>clock_timestamp() AND jsonb_array_length(e.payload->'sessions'->0->'events')=3
     AND r.state='published' AND r.source_generation=j.generation AND r.summary->>'event_count'='3'`,[f.user,f.session]);
   return !!rows.rowCount;
  },12000);
  assert.equal(worker.exitCode,null);
  t.diagnostic('Real src+tsx jobs main at 256 MiB: initial 42P01 handled without exit; after relation repair, derivation and complete list publication both recover.');
 }finally{
  worker.kill('SIGTERM');const timer=setTimeout(()=>worker.kill('SIGKILL'),5000);
  try{await ended;}finally{clearTimeout(timer);}
 }
});
