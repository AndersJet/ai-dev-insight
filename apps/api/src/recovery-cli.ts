import {userInfo} from 'node:os';
import {createCleanupJournal,openDatabase,type Database} from '@adi/storage';
import {createRecoveryService,createCleanupCheckpoint} from '@adi/domain';
let db:Database|undefined;
try {
 const action=process.argv[2],id=process.argv[3],checkpointId=process.argv[4],checkpointDigest=process.argv[5];
 const url=action==='checkpoint'?process.env.ADI_CLEANUP_CHECKPOINT_SOURCE_DATABASE_URL:process.env.ADI_RECOVERY_DATABASE_URL,schema=action==='checkpoint'?process.env.ADI_CLEANUP_CHECKPOINT_SOURCE_DATABASE_SCHEMA:process.env.ADI_RECOVERY_DATABASE_SCHEMA,directory=process.env.ADI_CLEANUP_JOURNAL_DIR;
 if(!url||!schema||!directory||!id||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)||!['checkpoint','quarantine','prepare','step','replay','status'].includes(action??''))throw Object.assign(new Error(),{code:'recovery_configuration_required'});
 if(action==='checkpoint'&&process.env.ADI_CLEANUP_WRITERS_STOPPED!=='1')throw Object.assign(new Error(),{code:'cleanup_writers_must_stop'});
 if(action!=='status'&&action!=='checkpoint'&&process.env.ADI_RECOVERY_ISOLATED!=='1')throw Object.assign(new Error(),{code:'isolated_restore_required'});
 db=openDatabase({connectionString:url,schema,maxConnections:2});
 const recovery=createRecoveryService(db,createCleanupJournal(directory),{operatorLabel:process.env.ADI_RECOVERY_OPERATOR_LABEL??userInfo().username});
 if(action==='checkpoint')process.stdout.write(JSON.stringify(await createCleanupCheckpoint(db,createCleanupJournal(directory),id))+'\n');
 else if(action==='quarantine')process.stdout.write(JSON.stringify(await recovery.quarantine(id))+'\n');
 else if(action==='prepare'){if(!checkpointId||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(checkpointId)||!checkpointDigest||!/^[0-9a-f]{64}$/.test(checkpointDigest))throw Object.assign(new Error(),{code:'recovery_checkpoint_required'});process.stdout.write(JSON.stringify(await recovery.prepare(id,{checkpoint_id:checkpointId,digest:checkpointDigest}))+'\n');}
 else if(action==='step'){const more=await recovery.step(id);process.stdout.write(JSON.stringify({...await recovery.status(id),more})+'\n');}
 else if(action==='replay'){
  let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopping=true;});
  let batches=0,more=true;while(!stopping&&more&&batches<5000){more=await recovery.step(id);batches++;}
  process.stdout.write(JSON.stringify({...await recovery.status(id),more,batches})+'\n');
 }else process.stdout.write(JSON.stringify(await recovery.status(id))+'\n');
}catch(error){
 const known=new Set(['recovery_quarantined','cleanup_writers_must_stop','cleanup_writers_active','cleanup_checkpoint_limit','cleanup_checkpoint_incomplete','recovery_checkpoint_mismatch','recovery_checkpoint_required','recovery_configuration_required','isolated_restore_required','invalid_dataset','dataset_identity_changed','recovery_context_changed','recovery_journal_conflict','recovery_subject_conflict','recovery_generation_conflict','recovery_not_prepared','recovery_preparation_changed','recovery_inventory_incomplete','recovery_inventory_changed','database_io_timeout','database_unavailable']);
 const code=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&known.has(error.code)?error.code:'recovery_failed';process.stderr.write(JSON.stringify({error:code})+'\n');process.exitCode=1;
}finally{await db?.close();}
