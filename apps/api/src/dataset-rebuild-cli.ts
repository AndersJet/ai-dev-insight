import {constants,openSync,fstatSync,readFileSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {openDatabase,prepareRecoveryArtifact,writeRecoveryArtifact,readRecoveryArtifact,type Database} from '@adi/storage';
import {createDatasetRebuildService,previewDatasetRebuild,type DatasetRebuildPlan} from '@adi/domain';

let source:Database|undefined,target:Database|undefined;
const required=(name:string)=>{const value=process.env[name];if(!value)throw Object.assign(new Error(),{code:'rebuild_configuration_required'});return value;};
const confirm=(name:string)=>process.env[name]==='1';
function privateKeyDigest(path:string){
  const file=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const info=fstatSync(file);if(!info.isFile()||info.size!==32||(info.mode&0o077)!==0)throw Object.assign(new Error(),{code:'credential_key_unavailable'});return createHash('sha256').update(readFileSync(file)).digest('hex');}finally{closeSync(file);}
}
try{
  const [action,path]=process.argv.slice(2),from=required('ADI_REBUILD_SOURCE_DATABASE_SCHEMA');
  if(!['preview','prepare-target','plan','execute','verify','status','open'].includes(action??''))throw Object.assign(new Error(),{code:'invalid_rebuild_action'});
  source=openDatabase({connectionString:required('ADI_REBUILD_SOURCE_DATABASE_URL'),schema:from,maxConnections:1});
  if(action==='preview')process.stdout.write(JSON.stringify(await previewDatasetRebuild(source))+'\n');
  else {
   const to=required('ADI_REBUILD_TARGET_DATABASE_SCHEMA');
   if(from===to)throw Object.assign(new Error(),{code:'independent_target_required'});
   if(required('ADI_REBUILD_TARGET_CONFIRMED_SCHEMA')!==to)throw Object.assign(new Error(),{code:'rebuild_target_confirmation_required'});
   target=openDatabase({connectionString:required('ADI_REBUILD_TARGET_DATABASE_URL'),schema:to,maxConnections:1});
   if(action==='prepare-target'){
    if(!confirm('ADI_REBUILD_ISOLATION_REVIEWED'))throw Object.assign(new Error(),{code:'rebuild_review_required'});
    const existing=(await target.query<{present:boolean}>('SELECT to_regclass($1) IS NOT NULL AS present',['data_identity'])).rows[0]!.present;
    if(existing){const inventory=await previewDatasetRebuild(target);if(Object.values({...inventory.basis_counts,...inventory.excluded_counts}).some(n=>n>0))throw Object.assign(new Error(),{code:'target_not_clean'});}
    // The versioned migration rejects old populated usage. Never DROP/TRUNCATE.
    await target.migrate();
    const present=(await target.query<{users:string;events:string}>('SELECT (SELECT count(*)::text FROM users) AS users,(SELECT count(*)::text FROM hook_events) AS events')).rows[0]!;
    if(present.users!=='0'||present.events!=='0')throw Object.assign(new Error(),{code:'target_not_clean'});
    await target.query('UPDATE data_identity SET collection_enabled=false');
    process.stdout.write(JSON.stringify({target_schema:to,collection_enabled:false,source_modified:false})+'\n');
  }else{
    const rebuild=createDatasetRebuildService(source,target,{baselineDate:required('ADI_REBUILD_BASELINE_DATE')});
    if(action==='status')process.stdout.write(JSON.stringify(await rebuild.status())+'\n');
    else if(action==='plan'){
      if(!path)throw Object.assign(new Error(),{code:'rebuild_manifest_path_required'});
      await prepareRecoveryArtifact(path);const plan=await rebuild.plan(),artifact=await writeRecoveryArtifact(path,plan);
      process.stdout.write(JSON.stringify({...artifact,plan_digest:plan.digest,source_dataset:plan.source_dataset,target_dataset:plan.target_dataset,baseline_at:plan.baseline_at,table_counts:plan.table_counts,external_isolation_verified:false})+'\n');
    }else{
      if(!path)throw Object.assign(new Error(),{code:'rebuild_manifest_path_required'});
      const plan=await readRecoveryArtifact(path,required('ADI_REBUILD_ARTIFACT_DIGEST')) as DatasetRebuildPlan;
      if(action==='verify')process.stdout.write(JSON.stringify(await rebuild.verify(plan))+'\n');
      else if(action==='execute'){
        const matching=privateKeyDigest(required('ADI_REBUILD_SOURCE_KEY_FILE'))===privateKeyDigest(required('ADI_REBUILD_TARGET_KEY_FILE'));
        if(!matching)throw Object.assign(new Error(),{code:'credential_key_mismatch'});
        const result=await rebuild.execute(plan,{source_writers_stopped:confirm('ADI_REBUILD_WRITERS_STOPPED'),network_isolated:confirm('ADI_REBUILD_ISOLATION_REVIEWED'),backup_and_journal_verified:confirm('ADI_REBUILD_BACKUP_JOURNAL_VERIFIED'),credential_key_verified:matching});
        process.stdout.write(JSON.stringify({...result,source_modified:false,isolation_evidence:'operator_review_required'})+'\n');
      }else{
        const validation=required('ADI_REBUILD_VALIDATION_DIGEST'),fresh=await rebuild.verify(plan);
        if(fresh.validation_digest!==validation)throw Object.assign(new Error(),{code:'rebuild_validation_changed'});
        process.stdout.write(JSON.stringify(await rebuild.open(plan.digest,{validation_completed:confirm('ADI_REBUILD_VALIDATION_COMPLETED'),validation_digest:validation}))+'\n');
      }
    }
  }
  }
}catch(error){
  const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&/^[a-z][a-z0-9_]{2,63}$/.test(error.code)?error.code:'dataset_rebuild_failed';
  process.stderr.write(JSON.stringify({error:code})+'\n');process.exitCode=1;
}finally{await target?.close();await source?.close();}
