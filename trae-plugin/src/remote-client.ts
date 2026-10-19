import {randomBytes,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {REMOTE_COMMAND,REMOTE_PROTOCOL,boundedCommand,validHook,type RemoteInfo,type RemoteSession,type RemoteHook,type VerifiedRemoteHook} from './remote-protocol.js';
import {pluginTimeouts} from './timeouts.js';
import type {ProbeResult} from './collector.js';
import type {HookStatus} from './hook-setup.js';
interface Host {build:string;execute<T>(command:string,input:unknown):PromiseLike<T>;forward(input:VerifiedRemoteHook,signal:AbortSignal):Promise<unknown>}
/** Local authorization gate. No platform address or credential crosses this API. */
export class RemoteClient {
  private session:RemoteSession|undefined;private info:RemoteInfo|undefined;private permits=new Map<string,{id:string;until:number}>();private inflight=0;private until=0;private revision=0;private abort=new AbortController();
  constructor(private readonly host:Host){}
  private async call<T>(input:unknown,ms=3000,signal?:AbortSignal){return boundedCommand(this.host.execute<T>(REMOTE_COMMAND,input),ms,signal);}
  private check(info:RemoteInfo){if(!info||info.protocol!==REMOTE_PROTOCOL||info.platform!=='linux'||info.build!==this.host.build||!/^[a-f0-9-]{36}$/.test(info.instance)||!Array.isArray(info.roots)||info.roots.length>100||info.roots.some(root=>typeof root!=='string'||!root.startsWith('/')||root.length>4096))throw new Error('remote_helper_mismatch');return info;}
  async pulse(owner:string,enabled:boolean,options:{resume?:boolean}={}){
    if(!enabled){await this.stop(owner);return false;}
    if(!options.resume&&(!this.session||performance.now()>=this.until))throw new Error('remote_revalidation_required');
    const revision=this.revision;
    try{
      if(options.resume){await this.stop(owner);const activeRevision=this.revision;
        const info=this.check(await this.call<RemoteInfo>({op:'hello'}));if(activeRevision!==this.revision)throw new Error('remote_cancelled');
        const session:RemoteSession={protocol:1,session:randomBytes(32).toString('base64url'),client:randomUUID(),owner,build:this.host.build};
        this.info=info;this.session=session;this.abort=new AbortController();
        const started=this.check(await this.call<RemoteInfo>({...session,instance:info.instance,op:'start'},10000,this.abort.signal));
        if(activeRevision!==this.revision||started.instance!==info.instance)throw new Error('remote_cancelled');this.info=started;
      }else{
        const info=this.check(await this.call<RemoteInfo>({...this.session,instance:this.info!.instance,op:'pulse'},3000,this.abort.signal));if(revision!==this.revision||info.instance!==this.info!.instance)throw new Error('remote_cancelled');this.info=info;
      }
      this.until=performance.now()+10000;return true;
    }catch(error){this.revoke();throw error;}
  }
  private revoke(){this.permits.clear();this.revision++;this.until=0;this.abort.abort();this.session=undefined;this.info=undefined;}
  async stop(_owner:string){const active=this.session,info=this.info;this.revoke();if(active&&info)await this.call({...active,instance:info.instance,op:'stop'},1000).catch(()=>{});}
  async close(owner:string){await this.stop(owner);}
  async probe(workspace:string,signal:AbortSignal):Promise<ProbeResult>{
    if(!this.session||performance.now()>=this.until||!this.info?.roots.includes(workspace))throw new Error('remote_unavailable');
    return this.call<ProbeResult>({...this.session,instance:this.info.instance,op:'probe',workspace},pluginTimeouts.gitProbe+1000,signal);
  }
  roots(){return this.info?.roots??[];}
  hookStatus():HookStatus{if(this.info?.hook_conflict)return {state:'failed',reason:'remote_hook_window_conflict',profile:'远端工作区 .trae/hooks.json'};return this.session&&performance.now()<this.until?{state:'ready',profile:'远端工作区 .trae/hooks.json'}:{state:'failed',reason:'remote_unavailable',profile:'远端工作区'};}
  async receive(input:unknown){
    const active=this.session,info=this.info,revision=this.revision;
    if(this.inflight>=4||!active||!info||performance.now()>=this.until||!input||typeof input!=='object'||Array.isArray(input))throw new Error('remote_unauthorized');
    const event=input as RemoteHook&{op?:unknown};
    if(event.op==='permit'){
      for(const [key,value]of this.permits)if(value.until<=performance.now())this.permits.delete(key);
      if(event.session!==active.session||event.instance!==info.instance||!/^[a-f0-9-]{36}$/.test(event.event_id)||this.permits.size+this.inflight>=4)throw new Error('remote_unauthorized');
      const permit=randomBytes(32).toString('base64url');this.permits.set(permit,{id:event.event_id,until:performance.now()+300});return {permit};
    }
    const permission=this.permits.get(event.permit);this.permits.delete(event.permit);
    if(!permission||permission.id!==event.event_id||permission.until<=performance.now())throw new Error('remote_invalid_event');
    let payload:unknown;try{if(typeof event.payload!=='string'||Buffer.byteLength(event.payload)>900000)throw new Error();payload=JSON.parse(event.payload);}catch{throw new Error('remote_invalid_event');}
    if(event.session!==active.session||event.instance!==info.instance||!validHook(payload)||Buffer.byteLength(JSON.stringify(event))>1900000||!/^[a-f0-9-]{36}$/.test(event.event_id)||!Number.isFinite(Date.parse(event.occurred_at))||event.workspace!==null&&!info.roots.includes(event.workspace))throw new Error('remote_invalid_event');
    this.inflight++;const controller=new AbortController(),abort=()=>controller.abort();this.abort.signal.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,300);
    try{const result=await this.host.forward({...event,payload,raw:event.payload},controller.signal);if(revision!==this.revision||controller.signal.aborted)throw new Error('remote_cancelled');return result;}
    finally{this.inflight--;clearTimeout(timer);this.abort.signal.removeEventListener('abort',abort);}
  }
}
