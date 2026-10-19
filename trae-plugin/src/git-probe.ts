import {pluginTimeouts} from './timeouts.js';
import type {ProbeResult} from './collector.js';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {performance} from 'node:perf_hooks';
import {normalizeRepositoryAddresses} from '../../packages/contracts/src/repository-address.js';
const exec=promisify(execFile);
export async function probeProject(workspace:string,signal:AbortSignal,git='git'):Promise<ProbeResult>{
  const until=performance.now()+pluginTimeouts.gitProbe;
  const run=(args:string[])=>{
    const env:NodeJS.ProcessEnv={...process.env,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',LC_ALL:'C',LANG:'C'};
    for(const key of Object.keys(env))if(/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_.*|CONFIG_VALUE_.*|TRACE.*|CURL_VERBOSE)$/i.test(key))delete env[key];
    const argv=['-C',workspace,...args],remaining=Math.max(1,Math.floor(until-performance.now()));
    if(process.platform==='win32')return exec(git,argv,{signal,timeout:remaining,killSignal:'SIGKILL',windowsHide:true,maxBuffer:262144,env});
    // execFile does not forward detached. spawn owns a real process group so
    // timeout, cancellation and wrapper exit can also terminate descendants.
    return new Promise<{stdout:string;stderr:string}>((resolve,reject)=>{
      if(signal.aborted){reject(Object.assign(new Error('git_aborted'),{killed:true}));return;}
      const child=spawn(git,argv,{detached:true,windowsHide:true,env,stdio:['ignore','pipe','pipe']});
      const stdout:Buffer[]=[],stderr:Buffer[]=[];let bytes=0,error:Error|undefined;
      const kill=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{/* this owned group already exited */}};
      const stop=(cause:Error)=>{error??=cause;kill();};
      const abort=()=>stop(Object.assign(new Error('git_aborted'),{killed:true}));
      const timer=setTimeout(()=>stop(Object.assign(new Error('git_timeout'),{killed:true})),remaining);
      const capture=(chunks:Buffer[],chunk:Buffer)=>{if(error)return;bytes+=chunk.length;if(bytes>262144)stop(Object.assign(new Error('git_output_limit'),{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}));else chunks.push(chunk);};
      child.stdout.on('data',(chunk:Buffer)=>capture(stdout,chunk));child.stderr.on('data',(chunk:Buffer)=>capture(stderr,chunk));
      child.once('error',cause=>{error??=cause;});child.once('exit',kill);signal.addEventListener('abort',abort,{once:true});
      child.once('close',(code,exitSignal)=>{
        clearTimeout(timer);signal.removeEventListener('abort',abort);
        const output={stdout:Buffer.concat(stdout).toString('utf8'),stderr:Buffer.concat(stderr).toString('utf8')};
        if(error||code!==0||exitSignal)reject(Object.assign(error??new Error('git_failed'),{stderr:output.stderr}));else resolve(output);
      });
    });
  };
  try{
    const root=(await run(['rev-parse','--show-toplevel'])).stdout.trim();
    if(!root||root.length>4096||/[\r\n]/.test(root))return {state:'failed',reason:'invalid_git_output',git_root:null,remotes:[]};
    const raw=(await run(['remote','-v'])).stdout;
    const entries=new Map<string,{fetch:boolean;push:string[]}>();let lines=0;
    for(const line of raw.split(/\r?\n/).filter(Boolean)){
      const match=/^([^\s]+)[\t ]+(.+) \((fetch|push)\)$/.exec(line);
      if(!match||match[1]!.length>128)return {state:'failed',reason:'invalid_git_output',git_root:null,remotes:[]};
      if(++lines>64)return {state:'failed',reason:'output_limit',git_root:null,remotes:[]};
      const entry=entries.get(match[1]!)??{fetch:false,push:[]};entries.set(match[1]!,entry);
      if(match[3]==='fetch')entry.fetch=true;else entry.push.push(match[2]!);
    }
    const remotes:ProbeResult['remotes']=[];
    for(const [name,entry] of entries){
      // remote -v shows only the first fetch URL when a remote has multiple
      // URLs and a separate push URL. Query all fetch URLs without network I/O.
      const fetch=entry.fetch?(await run(['remote','get-url','--all','--',name])).stdout:'';
      if(entry.fetch&&!fetch.endsWith('\n'))return {state:'failed',reason:'invalid_git_output',git_root:null,remotes:[]};
      const addresses=[...(entry.fetch?fetch.replace(/\r?\n$/,'').split(/\r?\n/):[]),...entry.push];
      if(remotes.length+addresses.length>64)return {state:'failed',reason:'output_limit',git_root:null,remotes:[]};
      for(const address of addresses)remotes.push({address});
    }
    return {state:remotes.length?'repository':'no_remote',reason:null,git_root:root,remotes:normalizeRepositoryAddresses(remotes)};
  }catch(e){
    const error=e as {code?:string;killed?:boolean;stderr?:string};
    if(error.stderr?.includes('not a git repository'))return {state:'not_git',reason:null,git_root:null,remotes:[]};
    const reason=signal.aborted||error.killed||performance.now()>=until?'timeout':error.code==='ENOENT'?'git_missing':error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'?'output_limit':error.stderr?.includes('cannot change to')?'inaccessible':'git_error';
    return {state:'failed',reason,git_root:null,remotes:[]};
  }
}
