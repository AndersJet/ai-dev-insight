import {setTimeout,clearTimeout} from 'node:timers';
import process from 'node:process';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {mkdirSync,openSync,closeSync,readFileSync,writeFileSync,unlinkSync,lstatSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const execute=promisify(execFile);
function paths(root){root=realpathSync(root);return {root,state:resolve(root,'.run/dev-process.json'),log:resolve(root,'.run/dev.log')};}
function regular(path){try{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink())throw new Error('unsafe_dev_state');}catch(e){if(e.code!=='ENOENT')throw e;}}
function read(files,entry){
 regular(files.state);
 let raw;try{raw=readFileSync(files.state,'utf8');}catch(e){if(e.code==='ENOENT')return null;throw e;}
 let state;try{state=JSON.parse(raw);}catch{throw new Error('invalid_dev_state');}
 if(state.version!==1||state.root!==files.root||state.entry!==entry||!Number.isSafeInteger(state.pid)||state.pid<=1||!/^[-a-f0-9]{36}$/.test(state.token))throw new Error('invalid_dev_state');
 return {state,raw};
}
function clear(files,record){let raw;try{raw=readFileSync(files.state,'utf8');}catch(e){if(e.code==='ENOENT')return;throw e;}if(raw!==record.raw)throw new Error('dev_state_changed');unlinkSync(files.state);}
function alive(pid){try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}}
async function owned(record){
 if(!alive(record.pid))return false;
 let stdout;try{({stdout}=await execute('ps',['-ww','-p',String(record.pid),'-o','pid=,pgid=,command=']));}catch(e){if(!alive(record.pid))return false;throw e;}
 const match=stdout.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/s);
 return !!match&&Number(match[1])===record.pid&&Number(match[2])===record.pid&&match[3].includes(record.entry)&&match[3].split(/\s+/).includes('--background-token='+record.token);
}
function supported(){if(process.platform==='win32')throw new Error('background_requires_posix_use_pnpm_dev');}
async function assertNoBackground(entry){
 const {stdout}=await execute('ps',['-ww','-axo','pid=,pgid=,command=']);
 const found=stdout.split('\n').map(line=>{
  const match=line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/s);
  return match&&match[3].includes(entry)&&match[3].split(/\s+/).some(arg=>/^--background-token=[-a-f0-9]{36}$/.test(arg))?{pid:Number(match[1]),pgid:Number(match[2])}:null;
 }).filter(Boolean);
 if(found.length)throw Object.assign(new Error('dev_background_process_untracked'),{processes:found});
}
/** The PID is only usable after verifying the exact launch token and process group. */
export async function stopDev({root,entry=resolve(root,'scripts/dev.mjs'),force=false,shutdownMs=20000}){
 supported();const files=paths(root);entry=resolve(entry);const record=read(files,entry);
 if(!record){await assertNoBackground(entry);return {state:'not_running',log:files.log};}
 if(!await owned(record.state)){
  // A dead leader can leave a live group. Never clear its evidence or signal
  // an unverified/reused process group just to make a restart succeed.
  if(alive(-record.state.pid))throw Object.assign(new Error('dev_process_group_unverified'),{pid:record.state.pid,pgid:record.state.pid});
  await assertNoBackground(entry);clear(files,record);return {state:'stale_state_removed',log:files.log};
 }
 const group=-record.state.pid;
 try{process.kill(group,force?'SIGKILL':'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}
 const until=Date.now()+(force?2000:shutdownMs);while(alive(group)&&Date.now()<until)await delay(50);
 let escalated=false;
 if(alive(group)){process.kill(group,'SIGKILL');escalated=!force;const deadline=Date.now()+2000;while(alive(group)&&Date.now()<deadline)await delay(50);}
 if(alive(group))throw Object.assign(new Error('dev_processes_still_exiting'),{pid:record.state.pid,pgid:record.state.pid});
 await assertNoBackground(entry);clear(files,record);return {state:force?'killed':'stopped',pid:record.state.pid,pgid:record.state.pid,escalated,log:files.log};
}
/** Stop must finish and verify absence before build/init or a new group starts. */
export async function restartDev(options){
 const emit=options.onEvent??(()=>{}),started=Date.now();
 emit('stop_started',{stage:'stop',message:'正在停止本目录后台服务。'});
 const stopped=await stopDev(options);
 emit('stop_completed',{stage:'stop',...stopped,duration_ms:Date.now()-started,message:'已确认旧后台进程组退出，可以启动。'});
 emit('start_started',{stage:'start',message:'正在构建、初始化并启动后台服务。'});
 return startDev(options);
}
export async function startDev({root,entry=resolve(root,'scripts/dev.mjs'),startupMs=180000,env=process.env}){
 supported();const files=paths(root);entry=resolve(entry);mkdirSync(resolve(files.root,'.run'),{recursive:true});
 const existing=read(files,entry);
 if(existing){if(await owned(existing.state))return {state:'already_running',pid:existing.state.pid,log:files.log};throw new Error('stale_dev_state_run_make_stop');}
 regular(files.log);let reservation;
 try{reservation=openSync(files.state,'wx',0o600);}catch(e){if(e.code==='EEXIST')throw new Error('dev_start_in_progress',{cause:e});throw e;}
 let log,child;
 try{
  log=openSync(files.log,'a',0o600);
  child=spawn(process.execPath,[entry,'--background-token='+randomUUID()],{cwd:files.root,env,detached:true,stdio:['ignore',log,log,'ipc']});
  child.once('error',()=>{});
  if(!child.pid)throw new Error('dev_spawn_failed');
  const token=child.spawnargs.at(-1).slice('--background-token='.length);
  writeFileSync(reservation,JSON.stringify({version:1,root:files.root,entry,pid:child.pid,token})+'\n');
 }catch(e){if(child?.pid){try{process.kill(-child.pid,'SIGKILL');}catch{/* exited */}}unlinkSync(files.state);throw e;}
 finally{if(log!==undefined)closeSync(log);closeSync(reservation);}
 await new Promise((resolveReady,reject)=>{
  const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{/* exited */}finish(new Error('dev_start_timeout'));},startupMs);
  const finish=error=>{clearTimeout(timer);child.removeListener('message',message);child.removeListener('exit',exit);child.removeListener('error',errorEvent);if(child.connected)child.disconnect();child.unref();if(error)reject(error);else resolveReady();};
  const message=value=>{if(value?.event==='dev_started')finish();else if(value?.event==='dev_start_failed')finish(Object.assign(new Error('dev_start_failed_see_log'),{stage:value.stage,startupError:value.error}));};
  const exit=()=>finish(new Error('dev_start_failed_see_log'));
  const errorEvent=()=>finish(new Error('dev_spawn_failed'));
  child.on('message',message);child.once('exit',exit);child.once('error',errorEvent);
 });
 return {state:'started',pid:child.pid,log:files.log};
}
