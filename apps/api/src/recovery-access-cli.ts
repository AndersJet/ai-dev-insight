import {userInfo} from 'node:os';
import {createCleanupJournal,openDatabase,prepareRecoveryArtifact,readRecoveryArtifact,writeRecoveryArtifact,type Database} from '@adi/storage';
import {createCleanupCheckpoint,createRecoveryAccessService,type RecoveryCredential} from '@adi/domain';
let db:Database|undefined;
try{
 const [action,id,...args]=process.argv.slice(2),source=action==='export';
 const url=source?process.env.ADI_CLEANUP_CHECKPOINT_SOURCE_DATABASE_URL:process.env.ADI_RECOVERY_DATABASE_URL,schema=source?process.env.ADI_CLEANUP_CHECKPOINT_SOURCE_DATABASE_SCHEMA:process.env.ADI_RECOVERY_DATABASE_SCHEMA,directory=process.env.ADI_CLEANUP_JOURNAL_DIR;
 if(!url||!schema||!directory||!id||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)||!['export','review','apply','runtime','credential','release'].includes(action??''))throw Object.assign(new Error(),{code:'recovery_configuration_required'});
 if(source&&process.env.ADI_CLEANUP_WRITERS_STOPPED!=='1')throw Object.assign(new Error(),{code:'cleanup_writers_must_stop'});if(!source&&process.env.ADI_RECOVERY_ISOLATED!=='1')throw Object.assign(new Error(),{code:'isolated_restore_required'});
 db=openDatabase({connectionString:url,schema,maxConnections:2});const journal=createCleanupJournal(directory),access=createRecoveryAccessService(db,journal,{emailDomains:(process.env.ADI_EMAIL_DOMAINS??'').split(','),operatorLabel:process.env.ADI_RECOVERY_OPERATOR_LABEL??userInfo().username});
 const required=(value:string|undefined)=>{if(!value)throw Object.assign(new Error(),{code:'recovery_configuration_required'});return value;};
 if(action==='export'){
  const path=required(args[0]);await prepareRecoveryArtifact(path);const checkpoint=await createCleanupCheckpoint(db,journal,id),snapshot=await access.exportSnapshot(checkpoint),artifact=await writeRecoveryArtifact(path,snapshot);process.stdout.write(JSON.stringify({...artifact,checkpoint,users:snapshot.users.length,departments:snapshot.departments.length})+'\n');
 }else if(action==='review'){
  const [path,hash,email,output]=args;await prepareRecoveryArtifact(required(output));const snapshot=await readRecoveryArtifact(required(path),required(hash)),review=await access.review(id,snapshot,required(email)),artifact=await writeRecoveryArtifact(required(output),review,67108864);process.stdout.write(JSON.stringify({...artifact,review_id:review.review_id,expires_at:review.expires_at,counts:review.counts})+'\n');
 }else if(action==='apply'){
  const [reviewPath,reviewHash,snapshotPath,snapshotHash]=args,review=await readRecoveryArtifact(required(reviewPath),required(reviewHash),67108864);
  if(!review||typeof review!=='object'||!('review_id'in review)||typeof review.review_id!=='string'||!('snapshot_digest'in review)||review.snapshot_digest!==snapshotHash)throw Object.assign(new Error(),{code:'recovery_artifact_invalid'});
  const snapshot=await readRecoveryArtifact(required(snapshotPath),required(snapshotHash));process.stdout.write(JSON.stringify(await access.apply(id,review.review_id,snapshot))+'\n');
 }else if(action==='runtime'){
  let stopping=false,batches=0,more=true;for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopping=true;});while(!stopping&&more&&batches<5000){more=await access.resumeBackground(id);batches++;}process.stdout.write(JSON.stringify({more,batches})+'\n');
 }else if(action==='credential'){
  const [review,output]=args;await prepareRecoveryArtifact(required(output));const credential=await access.issueCredential(id,required(review));const artifact=await writeRecoveryArtifact(required(output),credential,16384);process.stdout.write(JSON.stringify({...artifact,expires_at:credential.expires_at})+'\n');
 }else{
  const [path,hash,email]=args,credential=await readRecoveryArtifact(required(path),required(hash),16384);process.stdout.write(JSON.stringify(await access.release(id,credential as RecoveryCredential,required(email)))+'\n');
 }
}catch(error){const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&/^(recovery_[a-z_]+|invalid_recovery_[a-z_]+|cleanup_checkpoint_[a-z_]+|cleanup_writers_[a-z_]+|isolated_restore_required|dataset_identity_changed|database_io_timeout|database_unavailable)$/.test(error.code)?error.code:'recovery_access_failed';process.stderr.write(JSON.stringify({error:code,operator:process.env.ADI_RECOVERY_OPERATOR_LABEL??userInfo().username})+'\n');process.exitCode=1;}
finally{await db?.close();}
