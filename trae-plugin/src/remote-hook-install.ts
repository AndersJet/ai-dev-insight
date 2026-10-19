import {createHash,randomUUID} from 'node:crypto';
import {lstat,readFile,writeFile,rename,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {acquireDirectoryLock} from './directory-lock.js';
import {hookEvents} from './remote-protocol.js';
const digest=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
export async function safeRead(path:string,max=1048576):Promise<Buffer|undefined>{try{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max)throw new Error('managed_remote_file_unsafe');return await readFile(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}}
async function directory(path:string){await mkdir(path,{recursive:true,mode:0o700});const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('managed_remote_directory_unsafe');}
export async function safeRemoteDirectory(base:string){
  for(const path of [join(base,'..'),base]){
    try{const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink())return false;}catch{return false;}
  }
  return true;
}
export async function atomicRemoteFile(path:string,value:string|Uint8Array){const temp=path+'.'+randomUUID()+'.tmp';try{await writeFile(temp,value,{mode:0o600,flag:'wx'});await rename(temp,path);}finally{await rm(temp,{force:true});}}
const quote=(value:string)=>"'"+value.replace(/'/g,"'\\''")+"'";
interface Entry {event:string;group:{hooks:{type:string;command:string}[]}}
interface Receipt {version:1;sender_hash:string;wrapper_hash:string;entries:Entry[]}
const transactionNames=['sender.cjs','send.sh','receipt.json','hooks.json'] as const;
interface InstallFile {name:typeof transactionNames[number];before:string|null;after:string}
function transactionPath(base:string,name:InstallFile['name']){return name==='hooks.json'?join(base,'..','hooks.json'):join(base,name);}
function validateTransaction(files:InstallFile[]){
  if(!Array.isArray(files)||files.length!==transactionNames.length)throw new Error('invalid_remote_transaction');
  for(const [index,file]of files.entries())if(!file||file.name!==transactionNames[index]||file.before!==null&&!/^[a-f0-9]{64}$/.test(file.before)||typeof file.after!=='string'||file.after.length>1500000||Buffer.from(file.after,'base64').toString('base64')!==file.after||Buffer.from(file.after,'base64').length>1048576)throw new Error('invalid_remote_transaction');
}
async function applyTransaction(base:string,files:InstallFile[]){
  validateTransaction(files);
  const check=async(file:InstallFile)=>{
    const current=await safeRead(transactionPath(base,file.name)),hash=current?digest(current):null;
    if(hash!==file.before&&hash!==digest(Buffer.from(file.after,'base64')))throw new Error('managed_hooks_modified');return hash;
  };
  // Validate the whole transaction before resuming, then compare again directly
  // before each replacement. Unknown human edits are never overwritten.
  for(const file of files)await check(file);
  for(const file of files)if(await check(file)!==digest(Buffer.from(file.after,'base64')))await atomicRemoteFile(transactionPath(base,file.name),Buffer.from(file.after,'base64'));
}
/** Project scope is the Linux Hook location verified in Trae Remote SSH. */
export async function installRemoteHook(workspace:string,sender:Uint8Array,node:string){
  const profile=join(workspace,'.trae'),base=join(profile,'adi-remote-collector');await directory(profile);await directory(base);
  const release=await acquireDirectoryLock(base,'install.lock');
  try{
    const hooksPath=join(profile,'hooks.json'),receiptPath=join(base,'receipt.json'),pendingPath=join(base,'pending.json');
    const pending=await safeRead(pendingPath,4*1048576);
    if(pending){
      const transaction=JSON.parse(pending.toString());
      if(transaction.version===2){await applyTransaction(base,transaction.files);await rm(pendingPath);}
      else {
        // Complete a journal left by the unpublished 1.0.4 candidate.
        const hooksNow=await safeRead(hooksPath),receiptNow=await safeRead(receiptPath,16384);
        if(transaction.version!==1||typeof transaction.hooks!=='string'||typeof transaction.receipt!=='string'||![transaction.before_hooks,digest(transaction.hooks)].includes(hooksNow?digest(hooksNow):null)||![transaction.before_receipt,digest(transaction.receipt)].includes(receiptNow?digest(receiptNow):null))throw new Error('managed_hooks_modified');
        const next=JSON.parse(transaction.receipt),senderNow=await safeRead(join(base,'sender.cjs')),wrapperNow=await safeRead(join(base,'send.sh'));
        if(!senderNow||!wrapperNow||digest(senderNow)!==next.sender_hash||digest(wrapperNow)!==next.wrapper_hash)throw new Error('managed_hook_files_modified');
        await atomicRemoteFile(receiptPath,transaction.receipt);await atomicRemoteFile(hooksPath,transaction.hooks);await rm(pendingPath);
      }
    }
    const raw=await safeRead(hooksPath),prior=await safeRead(receiptPath,16384);
    const hooks=raw?.toString().trim()?JSON.parse(raw.toString()):{version:1,hooks:{}};
    if(!hooks||typeof hooks!=='object'||Array.isArray(hooks)||hooks.version!==undefined&&hooks.version!==1||!hooks.hooks||typeof hooks.hooks!=='object'||Array.isArray(hooks.hooks)||Object.values(hooks.hooks).some(v=>!Array.isArray(v)))throw new Error('unsupported_hooks_configuration');
    const wrapper=`#!/bin/bash\nexec 2>/dev/null\nset -m\n( set +m; exec ${quote(node)} ${quote(join(base,'sender.cjs'))} ) >/dev/null 2>&1 &\nchild=$!\n( sleep 0.75; kill -KILL -- "-$child" 2>/dev/null || : ) >/dev/null 2>&1 &\ntimer=$!\ntrap 'kill -KILL -- "-$child" "-$timer" 2>/dev/null || :; exit 0' HUP INT TERM EXIT\nwait "$child" 2>/dev/null || :\nkill -KILL -- "-$child" "-$timer" 2>/dev/null || :\nwait "$timer" 2>/dev/null || :\nexit 0\n`;
    const entries:Entry[]=hookEvents.map(event=>({event,group:{hooks:[{type:'command',command:'/bin/bash '+quote(join(base,'send.sh'))}]}}));
    let expectedSender:string|null=null,expectedWrapper:string|null=null;
    if(prior){const receipt=JSON.parse(prior.toString()) as Receipt;if(receipt.version!==1||!isDeepStrictEqual(receipt.entries,entries)||!/^[a-f0-9]{64}$/.test(receipt.sender_hash)||!/^[a-f0-9]{64}$/.test(receipt.wrapper_hash))throw new Error('invalid_remote_receipt');
      expectedSender=receipt.sender_hash;expectedWrapper=receipt.wrapper_hash;
      const oldSender=await safeRead(join(base,'sender.cjs')),oldWrapper=await safeRead(join(base,'send.sh'));
      if(!oldSender||digest(oldSender)!==receipt.sender_hash||!oldWrapper||digest(oldWrapper)!==receipt.wrapper_hash)throw new Error('managed_hook_files_modified');
      for(const entry of receipt.entries){const groups=hooks.hooks[entry.event];if(!Array.isArray(groups)||groups.filter(v=>isDeepStrictEqual(v,entry.group)).length!==1)throw new Error('managed_hooks_modified');hooks.hooks[entry.event]=groups.filter(v=>!isDeepStrictEqual(v,entry.group));}
    }else if(JSON.stringify(hooks).includes('adi-remote-collector')||await safeRead(join(base,'sender.cjs'))||await safeRead(join(base,'send.sh')))throw new Error('orphaned_managed_hooks');
    for(const entry of entries)hooks.hooks[entry.event]=[...(hooks.hooks[entry.event]??[]),entry.group];
    const nextReceipt=JSON.stringify({version:1,sender_hash:digest(sender),wrapper_hash:digest(wrapper),entries}),nextHooks=JSON.stringify(hooks,null,2)+'\n';
    const contents=[Buffer.from(sender),Buffer.from(wrapper),Buffer.from(nextReceipt),Buffer.from(nextHooks)],files:InstallFile[]=[];
    for(const [index,name]of transactionNames.entries()){
      const before=await safeRead(transactionPath(base,name));
      // Hooks may also be edited outside the install lock.
      if(name==='hooks.json'&&(before?digest(before):null)!==(raw?digest(raw):null)||name==='receipt.json'&&(before?digest(before):null)!==(prior?digest(prior):null))throw new Error('managed_hooks_modified');
      if(name==='sender.cjs'&&(before?digest(before):null)!==expectedSender||name==='send.sh'&&(before?digest(before):null)!==expectedWrapper)throw new Error('managed_hook_files_modified');
      files.push({name,before:before?digest(before):null,after:contents[index]!.toString('base64')});
    }
    // The write-ahead journal covers executable files as well as configuration.
    // Any process interruption can resume only from known before/after bytes.
    validateTransaction(files);
    await atomicRemoteFile(pendingPath,JSON.stringify({version:2,files}));
    await applyTransaction(base,files);await rm(pendingPath);return base;
  }finally{await release();}
}
