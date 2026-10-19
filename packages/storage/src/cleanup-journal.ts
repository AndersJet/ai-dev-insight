import {createHash,randomUUID} from 'node:crypto';import {constants} from 'node:fs';import {open,mkdir,lstat,link,unlink,opendir} from 'node:fs/promises';import {join,isAbsolute,dirname} from 'node:path';
export interface ProjectBarrier{source_kind?:'hook'|'plugin';platform?:'macos'|'windows'|'linux'|null;seen_sequence?:string;collector_id:string;workspace_key:string;latest_sequence:string;confirmed_sequence:string}
export interface ProjectDeletedKey{source_kind:'hook'|'plugin';collector_id:string;observation_id:string;sequence:string;workspace_key:string;payload_hash:string}
export interface ProjectBarrierManifest{parts:number;barriers:number;digest:string}
export interface CleanupRecord{version:1;dataset_id:string;operation_id:string;user_id:string;target_email:string;actor_id:string;from:string;to:string;cleanup_generation:number;created_at:string;project_barriers?:ProjectBarrierManifest;project_keys?:ProjectBarrierManifest}
interface Part{dataset_id:string;operation_id:string;index:number;session_ids:string[]}
interface ProjectPart{dataset_id:string;operation_id:string;index:number;barriers:ProjectBarrier[]}
interface ProjectKeyPart{dataset_id:string;operation_id:string;index:number;keys:ProjectDeletedKey[]}
interface Manifest{record:CleanupRecord;parts:number;sessions:number;parts_digest:string}
export interface CleanupCheckpointRef{checkpoint_id:string;digest:string}
interface CheckpointEntry{operation_id:string;accepted_digest:string|null;manifest_digest:string|null}
interface Checkpoint{version:1;dataset_id:string;checkpoint_id:string;created_at:string;source_digest:string;entries:CheckpointEntry[]}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');const failure=()=>new Error('Invalid or conflicting cleanup recovery record');
const canonical=(r:CleanupRecord):CleanupRecord=>({version:1,dataset_id:r.dataset_id,operation_id:r.operation_id,user_id:r.user_id,target_email:r.target_email,actor_id:r.actor_id,from:r.from,to:r.to,cleanup_generation:r.cleanup_generation,created_at:r.created_at,...(r.project_barriers?{project_barriers:{parts:r.project_barriers.parts,barriers:r.project_barriers.barriers,digest:r.project_barriers.digest}}:{}),...(r.project_keys?{project_keys:{parts:r.project_keys.parts,barriers:r.project_keys.barriers,digest:r.project_keys.digest}}:{})});
const missing=(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT';
function validate(record:CleanupRecord){
 if(!record||record.version!==1||![record.dataset_id,record.operation_id,record.user_id,record.actor_id].every(uuid)||typeof record.target_email!=='string'||record.target_email.length>254||record.target_email!==record.target_email.trim().toLowerCase()||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.target_email)||!Number.isSafeInteger(record.cleanup_generation)||record.cleanup_generation<1)throw failure();
 for(const value of [record.from,record.to,record.created_at])if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw failure();
 if(record.from>=record.to)throw failure();
 const keys=['version','dataset_id','operation_id','user_id','target_email','actor_id','from','to','cleanup_generation','created_at','project_barriers','project_keys'];if(Object.keys(record).some(key=>!keys.includes(key)))throw failure();
 for(const p of [record.project_barriers,record.project_keys])if(p!==undefined){if(!p||Object.keys(p).some(key=>!['parts','barriers','digest'].includes(key))||!Number.isSafeInteger(p.parts)||p.parts<0||p.parts>100000||!Number.isSafeInteger(p.barriers)||p.barriers<0||p.barriers>p.parts*500||!/^[a-f0-9]{64}$/.test(p.digest))throw failure();}
}
/** Immutable small parts and a final manifest. This directory must survive DB restores. */
export function createCleanupJournal(directory:string){
 if(!isAbsolute(directory)||process.platform==='win32')throw new Error('Cleanup recovery storage requires a configured absolute POSIX directory');
 async function syncDirectory(path:string){const file=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await file.sync();}finally{await file.close();}}
 async function privateDirectory(path:string){try{await mkdir(path,{mode:0o700});}catch(error){if(!(error&&typeof error==='object'&&'code' in error&&error.code==='EEXIST'))throw error;}const info=await lstat(path);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw new Error('Cleanup recovery directory must be private');await syncDirectory(path);await syncDirectory(dirname(path));}
 async function location(dataset:string,operation:string,create=false){if(!uuid(dataset)||!uuid(operation))throw failure();const datasetPath=join(directory,dataset),path=join(datasetPath,operation);if(create){await privateDirectory(directory);await privateDirectory(datasetPath);await privateDirectory(path);}else{for(const folder of [directory,datasetPath,path]){const info=await lstat(folder);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw failure();}}return path;}
 async function read<T>(path:string,limit=131072):Promise<{digest:string;data:T}>{
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const info=await file.stat();if(!info.isFile()||info.size>limit||(info.mode&0o077)!==0)throw failure();const parsed=JSON.parse(await file.readFile('utf8')) as {digest:string;data:T};if(typeof parsed.digest!=='string'||parsed.digest!==hash(JSON.stringify(parsed.data)))throw failure();return parsed;}finally{await file.close();}
 }
 async function save(path:string,name:string,data:unknown,limit=131072){
  const digest=hash(JSON.stringify(data)),encoded=JSON.stringify({digest,data})+'\n';if(Buffer.byteLength(encoded)>limit)throw failure();const destination=join(path,name),temporary=join(path,`.tmp-${randomUUID()}`);let file;
  try{file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await file.writeFile(encoded);await file.sync();await file.close();file=undefined;
   try{await link(temporary,destination);}catch(error){if(!(error&&typeof error==='object'&&'code' in error&&error.code==='EEXIST'))throw error;if((await read(destination,limit)).digest!==digest)throw failure();}
   const folder=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await folder.sync();}finally{await folder.close();}return digest;
  }finally{await file?.close();await unlink(temporary).catch(()=>{});}
 }
 function validatePart(part:Part,dataset:string,operation:string,index:number,prior:string){
  if(!part||part.dataset_id!==dataset||part.operation_id!==operation||part.index!==index||!Array.isArray(part.session_ids)||part.session_ids.length<1||part.session_ids.length>500||Object.keys(part).some(key=>!['dataset_id','operation_id','index','session_ids'].includes(key)))throw failure();
  for(const id of part.session_ids){if(!uuid(id)||id<=prior)throw failure();prior=id;}return prior;
 }
 const partName=(index:number)=>`part-${String(index).padStart(6,'0')}.json`;
 const projectPartName=(index:number)=>`project-part-${String(index).padStart(6,'0')}.json`;
 function validateProjectPart(part:ProjectPart,record:CleanupRecord,index:number,prior:string){
  if(!part||part.dataset_id!==record.dataset_id||part.operation_id!==record.operation_id||part.index!==index||!Array.isArray(part.barriers)||!part.barriers.length||part.barriers.length>500||Object.keys(part).some(key=>!['dataset_id','operation_id','index','barriers'].includes(key)))throw failure();
  for(const value of part.barriers){
   if(!value||!uuid(value.collector_id)||!/^[a-f0-9]{64}$/.test(value.workspace_key)||Object.keys(value).some(key=>!['source_kind','platform','seen_sequence','collector_id','workspace_key','latest_sequence','confirmed_sequence'].includes(key)))throw failure();
   if(value.source_kind!==undefined&&!['hook','plugin'].includes(value.source_kind)||value.platform!==undefined&&value.platform!==null&&!['macos','windows','linux'].includes(value.platform))throw failure();
   for(const seq of [value.latest_sequence,value.confirmed_sequence,...(value.seen_sequence===undefined?[]:[value.seen_sequence])])if(typeof seq!=='string'||!/^(?:0|[1-9][0-9]{0,18})$/.test(seq)||BigInt(seq)>9223372036854775807n)throw failure();
   if(BigInt(value.confirmed_sequence)>BigInt(value.latest_sequence))throw failure();
   if(value.seen_sequence!==undefined&&BigInt(value.seen_sequence)<BigInt(value.latest_sequence))throw failure();
   const key=`${value.source_kind===undefined?'':value.source_kind+':'}${value.collector_id}:${value.workspace_key}`;if(key<=prior)throw failure();prior=key;
  }return prior;
 }
 async function writeProjects(record:CleanupRecord,pages:AsyncIterable<ProjectBarrier[]>):Promise<ProjectBarrierManifest>{
  validate(record);const path=await location(record.dataset_id,record.operation_id,true);let chain=hash(''),index=0,count=0,prior='';
  for await(const barriers of pages){if(index>=100000)throw failure();const part={dataset_id:record.dataset_id,operation_id:record.operation_id,index,barriers};prior=validateProjectPart(part,record,index,prior);const digest=await save(path,projectPartName(index),part);chain=hash(`${chain}:${index}:${digest}`);count+=barriers.length;index++;}
  return {parts:index,barriers:count,digest:chain};
 }
 async function loadProjects(record:CleanupRecord){
  const meta=record.project_barriers;if(!meta)return async function*():AsyncGenerator<ProjectBarrier[]>{};
  const path=await location(record.dataset_id,record.operation_id),digests:string[]=[];let chain=hash(''),count=0,prior='';
  for(let index=0;index<meta.parts;index++){const part=await read<ProjectPart>(join(path,projectPartName(index)));prior=validateProjectPart(part.data,record,index,prior);digests.push(part.digest);chain=hash(`${chain}:${index}:${part.digest}`);count+=part.data.barriers.length;}
  if(count!==meta.barriers||chain!==meta.digest)throw failure();
  return async function*(){for(let index=0;index<meta.parts;index++){const part=await read<ProjectPart>(join(path,projectPartName(index)));if(part.digest!==digests[index])throw failure();yield part.data.barriers;}};
 }
 const projectKeyName=(index:number)=>`project-key-part-${String(index).padStart(6,'0')}.json`;
 function validateProjectKeys(part:ProjectKeyPart,record:CleanupRecord,index:number,prior:string){
  if(!part||part.dataset_id!==record.dataset_id||part.operation_id!==record.operation_id||part.index!==index||!Array.isArray(part.keys)||!part.keys.length||part.keys.length>200||Object.keys(part).some(k=>!['dataset_id','operation_id','index','keys'].includes(k)))throw failure();
  for(const k of part.keys){
   if(!k||!['hook','plugin'].includes(k.source_kind)||!uuid(k.collector_id)||!uuid(k.observation_id)||!/^[a-f0-9]{64}$/.test(k.workspace_key)||!/^[a-f0-9]{64}$/.test(k.payload_hash)||!/^[1-9][0-9]{0,18}$/.test(k.sequence)||BigInt(k.sequence)>9223372036854775807n||Object.keys(k).some(name=>!['source_kind','collector_id','observation_id','sequence','workspace_key','payload_hash'].includes(name)))throw failure();
   const key=`${k.source_kind}:${k.collector_id}:${k.observation_id}`;if(key<=prior)throw failure();prior=key;
  }return prior;
 }
 async function writeProjectKeys(record:CleanupRecord,pages:AsyncIterable<ProjectDeletedKey[]>):Promise<ProjectBarrierManifest>{
  validate(record);const path=await location(record.dataset_id,record.operation_id,true);let chain=hash(''),index=0,count=0,prior='';
  for await(const keys of pages){if(index>=100000)throw failure();const part={dataset_id:record.dataset_id,operation_id:record.operation_id,index,keys};prior=validateProjectKeys(part,record,index,prior);const digest=await save(path,projectKeyName(index),part);chain=hash(`${chain}:${index}:${digest}`);count+=keys.length;index++;}
  return {parts:index,barriers:count,digest:chain};
 }
 async function loadProjectKeys(record:CleanupRecord){
  const meta=record.project_keys;if(!meta)return async function*():AsyncGenerator<ProjectDeletedKey[]>{};
  const path=await location(record.dataset_id,record.operation_id),digests:string[]=[];let chain=hash(''),count=0,prior='';
  for(let index=0;index<meta.parts;index++){const part=await read<ProjectKeyPart>(join(path,projectKeyName(index)));prior=validateProjectKeys(part.data,record,index,prior);digests.push(part.digest);chain=hash(`${chain}:${index}:${part.digest}`);count+=part.data.keys.length;}
  if(count!==meta.barriers||chain!==meta.digest)throw failure();
  return async function*(){for(let index=0;index<meta.parts;index++){const part=await read<ProjectKeyPart>(join(path,projectKeyName(index)));if(part.digest!==digests[index])throw failure();yield part.data.keys;}};
 }
 async function readAccepted(dataset:string,operation:string){const saved=await read<CleanupRecord>(join(await location(dataset,operation),'accepted.json'));validate(saved.data);if(saved.data.dataset_id!==dataset||saved.data.operation_id!==operation)throw failure();return {record:saved.data,digest:saved.digest};}
 async function accept(record:CleanupRecord){
  validate(record);const path=await location(record.dataset_id,record.operation_id,true);
  await loadProjects(record);await loadProjectKeys(record);
  try{const manifest=await read<Manifest>(join(path,'manifest.json'));if(JSON.stringify(canonical(manifest.data.record))!==JSON.stringify(canonical(record)))throw failure();}catch(error){if(!missing(error))throw error;}
  return save(path,'accepted.json',canonical(record));
 }
 async function publish(record:CleanupRecord,pages:AsyncIterable<string[]>){
  validate(record);await accept(record);const path=await location(record.dataset_id,record.operation_id,true);let chain=hash(''),index=0,count=0,prior='';
  for await(const page of pages){if(index>=100000)throw failure();const part={dataset_id:record.dataset_id,operation_id:record.operation_id,index,session_ids:page};prior=validatePart(part,record.dataset_id,record.operation_id,index,prior);const digest=await save(path,partName(index),part);chain=hash(`${chain}:${index}:${digest}`);count+=page.length;index++;}
  const manifest:Manifest={record,parts:index,sessions:count,parts_digest:chain};const digest=await save(path,'manifest.json',manifest);return {digest,parts:index,sessions:count};
 }
 async function load(dataset:string,operation:string){
  const path=await location(dataset,operation);const stored=await read<Manifest>(join(path,'manifest.json')),manifest=stored.data;validate(manifest.record);
  if(manifest.record.dataset_id!==dataset||manifest.record.operation_id!==operation||!Number.isSafeInteger(manifest.parts)||manifest.parts<0||manifest.parts>100000||!Number.isSafeInteger(manifest.sessions)||manifest.sessions<0)throw failure();
  const digests:string[]=[];let chain=hash(''),prior='',count=0;
  for(let i=0;i<manifest.parts;i++){const part=await read<Part>(join(path,partName(i)));prior=validatePart(part.data,dataset,operation,i,prior);count+=part.data.session_ids.length;chain=hash(`${chain}:${i}:${part.digest}`);digests.push(part.digest);}
  if(count!==manifest.sessions||chain!==manifest.parts_digest)throw failure();
  return {record:manifest.record,digest:stored.digest,projects:await loadProjects(manifest.record),projectKeys:await loadProjectKeys(manifest.record),sessions:async function*(){for(let i=0;i<manifest.parts;i++){const part=await read<Part>(join(path,partName(i)));if(part.digest!==digests[i])throw failure();yield part.data.session_ids;}}};
 }
 async function writePart(record:CleanupRecord,index:number,ids:string[]){validate(record);if(!Number.isSafeInteger(index)||index<0||index>=100000)throw failure();const part={dataset_id:record.dataset_id,operation_id:record.operation_id,index,session_ids:ids};validatePart(part,record.dataset_id,record.operation_id,index,'');return save(await location(record.dataset_id,record.operation_id,true),partName(index),part);}
 async function readPart(dataset:string,operation:string,index:number){if(!Number.isSafeInteger(index)||index<0||index>=100000)throw failure();const part=await read<Part>(join(await location(dataset,operation),partName(index)));validatePart(part.data,dataset,operation,index,'');return {digest:part.digest,session_ids:part.data.session_ids};}
 async function seal(record:CleanupRecord,parts:number,sessions:number,parts_digest:string){validate(record);if(!Number.isSafeInteger(parts)||parts<0||parts>100000||!Number.isSafeInteger(sessions)||sessions<0||sessions>parts*500||!/^[0-9a-f]{64}$/.test(parts_digest))throw failure();await accept(record);return save(await location(record.dataset_id,record.operation_id,true),'manifest.json',{record,parts,sessions,parts_digest});}
 async function inspect(dataset:string,operation:string){const stored=await read<Manifest>(join(await location(dataset,operation),'manifest.json'));validate(stored.data.record);if(stored.data.record.dataset_id!==dataset||stored.data.record.operation_id!==operation||!Number.isSafeInteger(stored.data.parts)||stored.data.parts<0||stored.data.parts>100000||!Number.isSafeInteger(stored.data.sessions)||stored.data.sessions<0)throw failure();return stored;}
 async function proof(dataset:string,operation:string,verifyParts:boolean){
  const accepted=await readAccepted(dataset,operation).catch(error=>{if(missing(error))return null;throw error;});
  const manifest=await inspect(dataset,operation).catch(error=>{if(missing(error))return null;throw error;});
  if(!accepted&&!manifest)throw failure();
  if(accepted&&manifest&&JSON.stringify(canonical(accepted.record))!==JSON.stringify(canonical(manifest.data.record)))throw failure();
  const complete=manifest&&verifyParts?await load(dataset,operation):null;
  if(complete&&complete.digest!==manifest!.digest)throw failure();
  const accepted_digest=accepted?.digest??null,manifest_digest=manifest?.digest??null;
  const record=accepted?.record??manifest!.data.record;
  return {record,accepted_digest,manifest_digest,digest:hash(JSON.stringify({accepted_digest,manifest_digest})),projects:verifyParts?await loadProjects(record):(async function*():AsyncGenerator<ProjectBarrier[]>{}),projectKeys:verifyParts?await loadProjectKeys(record):(async function*():AsyncGenerator<ProjectDeletedKey[]>{}),sessions:complete?.sessions??(async function*():AsyncGenerator<string[]>{/* acceptance ranges need no session list */})};
 }
 async function inventory(dataset:string){
  if(!uuid(dataset))throw failure();const path=join(directory,dataset);
  for(const folder of [directory,path]){const info=await lstat(folder);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw failure();}
  const result:string[]=[];
  for await(const entry of await opendir(path)){if(!uuid(entry.name)||!entry.isDirectory()||entry.isSymbolicLink()||result.length>=10000)throw failure();result.push(entry.name);}
  return result.sort();
 }
 async function checkpointLocation(dataset:string,create=false){
  if(!uuid(dataset))throw failure();const path=join(directory,'checkpoints',dataset);
  for(const folder of [directory,join(directory,'checkpoints'),path]){if(create)await privateDirectory(folder);else{const info=await lstat(folder);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077)!==0)throw failure();}}
  return path;
 }
 async function proofInventory(dataset:string){const values=[];for(const operation of await inventory(dataset))values.push(await proof(dataset,operation,true));return values;}
 const entriesOf=(values:Awaited<ReturnType<typeof proofInventory>>):CheckpointEntry[]=>values.map(value=>({operation_id:value.record.operation_id,accepted_digest:value.accepted_digest,manifest_digest:value.manifest_digest}));
 async function createCheckpoint(dataset:string,sourceDigest:string){
  if(!uuid(dataset)||!/^[0-9a-f]{64}$/.test(sourceDigest))throw failure();await privateDirectory(directory);await privateDirectory(join(directory,dataset));const entries=entriesOf(await proofInventory(dataset));const id=randomUUID();
  const value:Checkpoint={version:1,dataset_id:dataset,checkpoint_id:id,created_at:new Date().toISOString(),source_digest:sourceDigest,entries};
  const digest=await save(await checkpointLocation(dataset,true),`${id}.json`,value,4194304);
  if(JSON.stringify(entriesOf(await proofInventory(dataset)))!==JSON.stringify(entries))throw failure();
  return {checkpoint_id:id,digest,operations:entries.length};
 }
 async function verifyCheckpoint(dataset:string,expected:CleanupCheckpointRef){
  if(!expected||!uuid(expected.checkpoint_id)||!/^[0-9a-f]{64}$/.test(expected.digest))throw failure();
  const stored=await read<Checkpoint>(join(await checkpointLocation(dataset),`${expected.checkpoint_id}.json`),4194304),value=stored.data;
  if(stored.digest!==expected.digest||value.version!==1||value.dataset_id!==dataset||value.checkpoint_id!==expected.checkpoint_id||!Array.isArray(value.entries)||value.entries.length>10000||!/^[0-9a-f]{64}$/.test(value.source_digest))throw failure();
  const current=await proofInventory(dataset);if(JSON.stringify(value.entries)!==JSON.stringify(entriesOf(current)))throw failure();return current;
 }
 return {publish,open:load,writePart,readPart,writeProjects,writeProjectKeys,seal,inspect,inventory,accept,readAccepted,openProof:(dataset:string,operation:string)=>proof(dataset,operation,true),inspectProof:(dataset:string,operation:string)=>proof(dataset,operation,false),createCheckpoint,verifyCheckpoint};
}
export type CleanupJournal=ReturnType<typeof createCleanupJournal>;
