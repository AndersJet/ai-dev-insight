import {lstat,writeFile,mkdtemp,chmod,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {openDatabase,createCleanupJournal,verifyPostgresBackup,type Database} from '@adi/storage';import {createBackupService} from '@adi/domain';
let db:Database|undefined,passDirectory:string|undefined;
const abort=new AbortController();for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>abort.abort());
const configuration=()=>Object.assign(new Error('Explicit backup configuration required'),{code:'backup_configuration_required'});
try{
 const [action,...args]=process.argv.slice(2),maxBytes=process.env.ADI_BACKUP_MAX_BYTES;if(!maxBytes)throw configuration();
 if(action==='verify'){if(args.length!==2)throw configuration();process.stdout.write(JSON.stringify(await verifyPostgresBackup(args[0]!,args[1]!,maxBytes))+'\n');}
 else if(action==='create'){
  const connectionString=process.env.ADI_BACKUP_SOURCE_DATABASE_URL,schema=process.env.ADI_BACKUP_SOURCE_DATABASE_SCHEMA,directory=process.env.ADI_BACKUP_DIRECTORY,journal=process.env.ADI_CLEANUP_JOURNAL_DIR,maxDuration=Number(process.env.ADI_BACKUP_MAX_DURATION_MS);
  if(args.length!==1||process.env.ADI_BACKUP_SOURCE_CONFIRMED!=='1'||!connectionString||!schema||!directory||!journal||!Number.isSafeInteger(maxDuration)||maxDuration<1000)throw configuration();
  const url=new URL(connectionString);if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname||!url.username||url.search||url.hash||url.pathname.length<2)throw configuration();const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw configuration();
  const host=url.hostname.replace(/^\[|\]$/g,''),port=url.port||'5432',database=decodeURIComponent(url.pathname.slice(1)),user=decodeURIComponent(url.username),password=decodeURIComponent(url.password);const escape=(value:string)=>{if(/[\r\n]/.test(value))throw configuration();return value.replaceAll('\\','\\\\').replaceAll(':','\\:');};passDirectory=await mkdtemp(join(tmpdir(),'adi-pgpass-'));await chmod(passDirectory,0o700);const passfile=join(passDirectory,'pgpass');await writeFile(passfile,[host,port,database,user,password].map(escape).join(':')+'\n',{flag:'wx',mode:0o600});
  db=openDatabase({connectionString,schema,maxConnections:2});const dumpEnv:NodeJS.ProcessEnv={PATH:process.env.PATH,LANG:'C',PGHOST:host,PGPORT:port,PGDATABASE:database,PGUSER:user,PGPASSFILE:passfile,PGCONNECT_TIMEOUT:'5'};
  const service=createBackupService(db,createCleanupJournal(journal),{directory,dump:{file:process.env.ADI_PG_DUMP_PATH??'pg_dump',env:dumpEnv},maxBytes,maxDurationMs:maxDuration,signal:abort.signal});process.stdout.write(JSON.stringify(await service.create(args[0]!))+'\n');
 }else throw configuration();
}catch(error){const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&(/^(backup|cleanup_checkpoint)_[a-z_]+$/.test(error.code)||['dataset_identity_changed','invalid_dataset','recovery_quarantined','recovery_artifact_invalid'].includes(error.code))?error.code:'backup_failed';process.stderr.write(JSON.stringify({error:code})+'\n');process.exitCode=1;}
finally{await db?.close();if(passDirectory)await rm(passDirectory,{recursive:true,force:true});}
