import {randomUUID} from 'node:crypto';
import type {PluginRegistration,PluginObservation} from '../../packages/contracts/src/plugin-tracking.js';
const PROJECT_PROBE_INTERVAL_MS=30*60*1000;
const validEmail=(email:string)=>email.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)&&!Array.from(email).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127);
export interface CollectorConfig {ntEmail:string;serverUrl:string}
export type ProbeResult=Pick<PluginObservation,'state'|'reason'|'git_root'|'remotes'>;
export interface RuntimeHost {
  random?:()=>number;
  clock?:{now():number;schedule(fn:()=>void,ms:number):()=>void};
  identity(config:CollectorConfig,signal:AbortSignal):Promise<{source_secret:string;source_config_id:string}>;
  nextSequence(signal:AbortSignal,sourceConfigId:string):Promise<string>;
  register(input:PluginRegistration,url:string,signal:AbortSignal):Promise<{collector_id:string;nt_email:string;token:string}>;
  probe(workspace:string,signal:AbortSignal):Promise<ProbeResult>;
  submit(input:PluginObservation,token:string,url:string,signal:AbortSignal):Promise<{outcome:'saved'|'duplicate';observation_id:string;received_at:string}>;
  version?:string;
  platform?:'macos'|'windows'|'linux';
  onStatus?():void;
  onAuthorizationRejected?(error:unknown):void;
}
export class ProjectCollector {
  private state='idle';private generation=0;private abort:AbortController|undefined;private saved:string|null=null;
  private owner='';private probed=new Map<string,number>();
  private cached:{source:{source_secret:string;source_config_id:string};issued:{collector_id:string;nt_email:string;token:string}}|undefined;
  private cancelPeriod:(()=>void)|undefined;
  private cancelRetry:(()=>void)|undefined;
  private pending=new Map<string,{event:PluginObservation;attempts:number;bytes:number}>();private dropped=0;private failures=0;private nextSend=0;
  private authorizationPaused=false;
  private working=false;private disposed=false;private desiredRoots:string[]=[];
  private activeRoot:string|undefined;
  private deferred:{config:CollectorConfig;roots:string[];trusted:boolean}|undefined;
  private ownerKey(config:CollectorConfig){try{const url=new URL(config.serverUrl),email=config.ntEmail.trim().toLowerCase();return validEmail(email)&&['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash?JSON.stringify([email,url.href.replace(/\/+$/,'')]):'';}catch{return '';}}
  private now(){return this.host?.clock?.now()??Date.now();}
  private schedule(fn:()=>void,ms:number){if(this.host?.clock)return this.host.clock.schedule(fn,ms);const timer=setTimeout(fn,Math.min(ms,2147483647));timer.unref();return ()=>clearTimeout(timer);}
  constructor(private readonly host?:RuntimeHost){}
  configure(config:CollectorConfig,roots:string[],trusted:boolean){
    if(this.disposed)return;this.desiredRoots=[...roots];
    for(const root of this.pending.keys())if(!roots.includes(root))this.pending.delete(root);
    for(const root of this.probed.keys())if(!roots.includes(root))this.probed.delete(root);
    if(this.working){
      this.deferred={config,roots:[...roots],trusted};
      const key=this.ownerKey(config);
      if(this.activeRoot&&!roots.includes(this.activeRoot))this.abort?.abort();
      if(!trusted||!key||key!==this.owner){this.abort?.abort();this.pending.clear();this.state=!key?'needs_configuration':!trusted?'awaiting_trust':'connecting';this.host?.onStatus?.();}
      return;
    }
    this.abort?.abort();this.cancelPeriod?.();this.cancelPeriod=undefined;this.cancelRetry?.();this.cancelRetry=undefined;const generation=++this.generation;
    const email=config.ntEmail.trim().toLowerCase();let url:URL;
    try{url=new URL(config.serverUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Invalid server');}
    catch{this.owner='';this.cached=undefined;this.probed.clear();this.pending.clear();this.state='needs_configuration';this.host?.onStatus?.();return;}
    if(!validEmail(email)){this.owner='';this.cached=undefined;this.probed.clear();this.pending.clear();this.state='needs_configuration';this.host?.onStatus?.();return;}
    if(!trusted){this.probed.clear();this.pending.clear();this.state='awaiting_trust';this.host?.onStatus?.();return;}
    if(!this.host){this.state='unavailable';return;}
    const target=url.href.replace(/\/+$/,''),owner=JSON.stringify([email,target]);
    if(owner!==this.owner){this.owner=owner;this.cached=undefined;this.probed.clear();this.pending.clear();this.saved=null;this.failures=0;this.nextSend=0;this.authorizationPaused=false;}
    if(this.authorizationPaused){this.state='paused';this.host.onStatus?.();return;}
    if((!this.cached||this.state==='unavailable')&&this.now()<this.nextSend){this.state='unavailable';this.cancelRetry=this.schedule(()=>this.configure(config,roots,trusted),this.nextSend-this.now());this.host.onStatus?.();return;}
    const eligible=[...new Set(roots)].filter(root=>{const last=this.probed.get(root);return last===undefined||this.now()-last>=PROJECT_PROBE_INTERVAL_MS;});
    this.abort=new AbortController();this.state='connecting';this.host.onStatus?.();
    this.working=true;
    void this.collect({...config,ntEmail:email,serverUrl:target},eligible,generation,this.abort.signal,()=>this.configure(config,roots,trusted)).finally(()=>{
      this.working=false;const next=this.deferred;this.deferred=undefined;
      if(next&&!this.disposed){this.configure(next.config,next.roots,next.trusted);return;}
      if(this.disposed||generation!==this.generation||this.abort?.signal.aborted||this.authorizationPaused)return;
      // Registration, filesystem work and sending take real time. Schedule from
      // each project's actual probe time so an early timer cannot skip a cycle.
      const due=roots.map(root=>(this.probed.get(root)??this.now())+PROJECT_PROBE_INTERVAL_MS);
      const projectDelay=due.length?Math.max(0,Math.min(...due)-this.now()):PROJECT_PROBE_INTERVAL_MS;
      const delay=this.state==='unavailable'?Math.max(projectDelay,this.nextSend-this.now()):projectDelay;
      this.cancelPeriod=this.schedule(()=>this.configure(config,roots,trusted),delay);
      if(this.pending.size>0&&this.nextSend>this.now()){
        this.cancelRetry?.();
        this.cancelRetry=this.schedule(()=>this.configure(config,roots,trusted),this.nextSend-this.now());
      }
    });
  }
  private async collect(config:CollectorConfig,roots:string[],generation:number,signal:AbortSignal,retry:()=>void){
    const host=this.host!;const current=()=>generation===this.generation&&!signal.aborted;
    let probeFailed=false;
    try{
      // Retire every due project's old pending result before any flush can
      // send another project's result from the preceding cycle.
      for(const workspace of roots)this.pending.delete(workspace);
      const version=host.version??'0.1.0',platform=host.platform??'macos';
      if(!this.cached){const source=await host.identity(config,signal);if(!current())return;const issued=await host.register({...source,nt_email:config.ntEmail,platform,plugin_version:version},config.serverUrl,signal);if(!current())return;this.cached={source,issued};}
      const {source,issued}=this.cached;
      if(issued.nt_email!==config.ntEmail)throw new Error('Unexpected source');
      for(const workspace of roots){
        if(!this.desiredRoots.includes(workspace))continue;
        const observed_at=new Date(this.now()).toISOString();
        this.probed.set(workspace,this.now());
        this.activeRoot=workspace;let result:ProbeResult;
        try{result=await host.probe(workspace,signal);}catch{if(!current())return;probeFailed=true;result={state:'failed',reason:'git_error',git_root:null,remotes:[]};}finally{this.activeRoot=undefined;}
        if(!current())return;
        if(!this.desiredRoots.includes(workspace))continue;
        if(result.state==='failed'||result.state==='unknown')probeFailed=true;
        let sequence:string;
        try{sequence=await host.nextSequence(signal,source.source_config_id);}catch(error){this.probed.delete(workspace);throw error;}
        const id=randomUUID();if(!current())return;
        const event:PluginObservation={schema_version:2,collector_id:issued.collector_id,nt_email:config.ntEmail,source_config_id:source.source_config_id,observation_id:id,sequence,platform,workspace_path:workspace,observed_at,plugin_version:version,...result};
        this.pending.delete(workspace);this.pending.set(workspace,{event,attempts:0,bytes:Buffer.byteLength(JSON.stringify(event))});
        while(this.pending.size>100||this.queuedBytes()>1048576){this.pending.delete(this.pending.keys().next().value!);this.dropped++;}
        if(this.now()>=this.nextSend)await this.flush(config,signal,current,retry);
      }
      if(current()&&this.now()>=this.nextSend)await this.flush(config,signal,current,retry);
      if(current())this.state=this.pending.size>0?'retrying':probeFailed?'unavailable':'active';
    }catch(e){if(current()){if(this.denied(e))this.pauseAuthorization(e);else{
      if(e instanceof Error&&['source_identity_changed','sequence_state_missing'].includes(e.message)){this.cached=undefined;this.probed.clear();this.dropped+=this.pending.size;this.pending.clear();this.saved=null;}
      this.state='unavailable';this.defer(retry,e);
    }}}
    finally{if(current())host.onStatus?.();}
  }
  private queuedBytes(){let sum=0;for(const item of this.pending.values())sum+=item.bytes;return sum;}
  private denied(error:unknown){return typeof error==='object'&&error!==null&&'status'in error&&[401,403].includes(Number(error.status));}
  private pauseAuthorization(error:unknown){this.authorizationPaused=true;this.state='paused';this.pending.clear();this.abort?.abort();this.cancelPeriod?.();this.cancelRetry?.();this.host?.onAuthorizationRejected?.(error);this.host?.onStatus?.();}
  private defer(retry:()=>void,error?:unknown){this.failures++;const base=[30000,60000,120000,300000][Math.min(this.failures-1,3)]!,random=this.host?.random?.()??Math.random(),local=Math.min(300000,base+Math.floor(base*.1*(Number.isFinite(random)?Math.max(0,Math.min(1,random)):0)));const server=typeof error==='object'&&error!==null&&'retryAfterMs'in error&&typeof error.retryAfterMs==='number'&&Number.isFinite(error.retryAfterMs)?Math.max(0,error.retryAfterMs):0;const wait=Math.max(local,server);this.nextSend=this.now()+wait;this.cancelRetry?.();this.cancelRetry=this.schedule(retry,wait);}
  private async flush(config:CollectorConfig,signal:AbortSignal,current:()=>boolean,retry:()=>void){
    if(!this.cached||!current()||this.now()<this.nextSend)return;
    for(const [workspace,item] of [...this.pending]){
      if(!current())return;item.attempts++;
      try{
        this.activeRoot=workspace;
        const receipt=await this.host!.submit(item.event,this.cached.issued.token,config.serverUrl,signal);if(!current())return;
        if(receipt.observation_id!==item.event.observation_id)throw new Error('Unexpected receipt');
        if(this.pending.get(workspace)===item)this.pending.delete(workspace);
        this.saved=receipt.received_at;this.failures=0;this.nextSend=0;
      }catch(e){
        if(!current())return;
        if(this.denied(e)){this.pauseAuthorization(e);return;}
        if(typeof e==='object'&&e!==null&&'status'in e&&[400,404,409,413,422].includes(Number(e.status))){if(this.pending.get(workspace)===item)this.pending.delete(workspace);this.dropped++;continue;}
        if(item.attempts>=3){this.pending.delete(workspace);this.dropped++;}
        this.state='retrying';this.defer(retry,e);return;
      }finally{this.activeRoot=undefined;}
    }
  }
  resumeAuthorization(){this.authorizationPaused=false;this.cached=undefined;this.probed.clear();}
  status(){return {state:this.state,lastSavedAt:this.saved,queued:this.pending.size,queuedBytes:this.queuedBytes(),dropped:this.dropped};}
  dispose(){this.disposed=true;this.deferred=undefined;this.generation++;this.abort?.abort();this.cancelPeriod?.();this.cancelPeriod=undefined;this.cancelRetry?.();this.cancelRetry=undefined;this.pending.clear();this.state='stopped';this.host?.onStatus?.();}
}
