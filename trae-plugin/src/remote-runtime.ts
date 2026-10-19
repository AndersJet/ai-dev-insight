import {createServer,type Server} from 'node:http';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile,rm,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {uptime} from 'node:os';
import {installRemoteHook,atomicRemoteFile,safeRemoteDirectory} from './remote-hook-install.js';
import {boundedCommand,REMOTE_PROTOCOL,validHook,type RemoteHook,type RemoteSession,type RemotePermit} from './remote-protocol.js';
import {remotePresences} from './remote-presence.js';
import type {ProbeResult} from './collector.js';
interface Host {build:string;roots():string[];trusted():boolean;sender:Uint8Array;node:string;boot:string;probe(root:string,signal:AbortSignal):Promise<ProbeResult>;forward(input:RemoteHook|RemotePermit):PromiseLike<unknown>}
export class RemoteRuntime {
  readonly instance=randomUUID();private session:RemoteSession|undefined;private server:Server|undefined;private token='';private until=0;private port=0;private presenceBases=new Set<string>();private conflicted=false;private presenceWork:Promise<void>|undefined;private closed=false;private revision=0;private inflight=0;
  private abort=new AbortController();private probes=new Map<string,ProbeResult&{observed_at:string}>();
  private timer=setInterval(()=>{if(this.session&&performance.now()>=this.until)void this.stop().catch(()=>{});else void this.presence().catch(()=>{});},1000);
  constructor(private readonly host:Host){this.timer.unref();void this.presence().catch(()=>{});}
  private allowed(input:RemoteSession){return !this.closed&&this.host.trusted()&&!!this.session&&input.session===this.session.session&&input.owner===this.session.owner&&input.client===this.session.client&&input.build===this.host.build&&performance.now()<this.until;}
  private info(){return {protocol:REMOTE_PROTOCOL,instance:this.instance,platform:'linux',build:this.host.build,roots:this.host.roots(),hook_conflict:this.conflicted};}
  async command(input:unknown):Promise<unknown>{
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('invalid_remote_request');
    const request=input as RemoteSession&{op:string;instance:string;workspace?:string};
    if(request.op==='hello'){await this.presence();return this.info();}
    if(request.instance!==this.instance||request.protocol!==REMOTE_PROTOCOL||!/^[-_A-Za-z0-9]{43}$/.test(request.session)||!/^[a-f0-9]{64}$/.test(request.owner)||!/^[a-f0-9-]{36}$/.test(request.client)||request.build!==this.host.build)throw new Error('remote_identity_mismatch');
    if(request.op==='start'){
      if(!this.host.trusted()||this.closed)throw new Error('remote_workspace_untrusted');
      await this.stop();const revision=this.revision;
      const roots=this.host.roots();if(!roots.length)throw new Error('remote_workspace_missing');
      const bases=[];for(const root of roots)bases.push(await installRemoteHook(root,this.host.sender,this.host.node));
      if(revision!==this.revision||!this.host.trusted())throw new Error('remote_cancelled');
      this.session={protocol:1,session:request.session,owner:request.owner,client:request.client,build:request.build};this.token=randomBytes(32).toString('base64url');for(const base of bases)this.presenceBases.add(base);this.abort=new AbortController();
      this.server=createServer((req,res)=>{
        const active=this.session,revision=this.revision;const done=(status:number)=>{if(!res.writableEnded){res.writeHead(status);res.end();}};
        if(!active||!this.allowed(active)||req.url!=='/hook'||req.method!=='POST'||req.headers.authorization!==`Bearer ${this.token}`||this.inflight>=4){done(403);req.resume();return;}
        this.inflight++;let bytes=0;const chunks:Buffer[]=[];const timer=setTimeout(()=>{done(504);req.destroy();},650);
        req.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>900000){done(413);req.destroy();}else chunks.push(chunk);});
        res.once('close',()=>{clearTimeout(timer);this.inflight--;});req.on('error',()=>done(400));
        req.on('end',()=>{void (async()=>{
          let payload:unknown;try{payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{done(400);return;}
          if(!validHook(payload)||revision!==this.revision||!this.allowed(active)){done(403);return;}
          const roots=this.host.roots(),cwd=typeof payload.cwd==='string'?payload.cwd:typeof payload.workspace==='string'?payload.workspace:null;
          const workspace=cwd?roots.filter(root=>cwd===root||cwd.startsWith(root+'/')).sort((a,b)=>b.length-a.length)[0]??null:roots.length===1?roots[0]!:null;
          await this.presence();if(this.conflicted){done(409);return;}
          const event_id=randomUUID();
          try{
            // A local one-shot permit prevents a delayed SSH command from
            // delivering event text after the Hook caller has already left.
            const reply=await boundedCommand(this.host.forward({op:'permit',session:active.session,instance:this.instance,event_id}),200,this.abort.signal) as {permit:string};
            if(!reply||!/^[-_A-Za-z0-9]{43}$/.test(reply.permit)||revision!==this.revision||!this.allowed(active)){done(403);return;}
            const message:RemoteHook={permit:reply.permit,session:active.session,instance:this.instance,event_id,occurred_at:new Date().toISOString(),payload:Buffer.concat(chunks).toString('utf8'),workspace,probe:workspace?this.probes.get(workspace)??null:null};
            await boundedCommand(this.host.forward(message),350,this.abort.signal);done(204);
          }catch{done(502);}

        })().catch(()=>done(500));});
      });
      this.server.maxConnections=8;this.server.headersTimeout=1000;this.server.requestTimeout=1000;
      const server=this.server;await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
      const address=server.address();if(!address||typeof address==='string')throw new Error('remote_relay_unavailable');this.port=address.port;
      if(revision!==this.revision){server.close();throw new Error('remote_cancelled');}await this.renew();return this.info();
    }
    if(request.op==='stop'){if(this.session&&request.session===this.session.session)await this.stop();return {stopped:true};}
    if(!this.allowed(request))throw new Error('remote_lease_expired');
    if(request.op==='pulse'){await this.renew();return this.info();}
    if(request.op==='probe'){
      const root=request.workspace;if(!root||!this.host.roots().includes(root))throw new Error('remote_workspace_mismatch');
      const observed_at=new Date().toISOString(),revision=this.revision,result=await this.host.probe(root,this.abort.signal);if(revision!==this.revision||!this.allowed(request))throw new Error('remote_cancelled');this.probes.set(root,{...result,observed_at});return result;
    }
    throw new Error('invalid_remote_operation');
  }
  private async renew(){
    this.until=performance.now()+15000;const revision=this.revision;
    await this.presence();if(revision!==this.revision)throw new Error('remote_cancelled');
  }
  private presence(){
    if(this.presenceWork)return this.presenceWork;
    this.presenceWork=this.publishPresence().finally(()=>{this.presenceWork=undefined;});return this.presenceWork;
  }
  private async publishPresence(){
    if(this.closed)return;
    const currentBases=new Set(this.host.roots().map(root=>join(root,'.trae','adi-remote-collector')));
    for(const base of this.presenceBases)if(!currentBases.has(base)){if(await safeRemoteDirectory(base))await rm(join(base,`relay-${this.instance}.json`),{force:true});this.presenceBases.delete(base);}
    if(this.host.trusted())for(const root of this.host.roots()){
      const base=join(root,'.trae','adi-remote-collector');
      try{if(!await safeRemoteDirectory(base))continue;const marker=await lstat(join(base,'receipt.json'));if(marker.isFile()&&!marker.isSymbolicLink()&&marker.size<=16384)this.presenceBases.add(base);}catch{/* An uninstalled workspace has no shared Hook to guard. */}
    }
    const active=!!this.session&&performance.now()<this.until&&this.host.trusted();
    const config=JSON.stringify({version:2,instance:this.instance,boot:this.host.boot,expires:Math.floor(uptime()*1000)+15000,active,owner:this.session?.owner??null,...(active?{port:this.port,token:this.token}:{})});
    let conflict=false;
    for(const base of this.presenceBases){
      if(this.closed)return;
      if(!await safeRemoteDirectory(base)){conflict=true;continue;}
      await atomicRemoteFile(join(base,`relay-${this.instance}.json`),config);
      const peers=remotePresences(base,this.host.boot,uptime()*1000);if(!peers||peers.length!==1)conflict=true;
    }
    this.conflicted=conflict;
  }
  async stop(){this.revision++;this.until=0;this.session=undefined;this.token='';this.abort.abort();this.probes.clear();this.server?.closeAllConnections();this.server?.close();this.server=undefined;await this.presenceWork?.catch(()=>{});await this.presence();}

  async dispose(){this.closed=true;clearInterval(this.timer);await this.stop();for(const base of this.presenceBases)if(await safeRemoteDirectory(base))await rm(join(base,`relay-${this.instance}.json`),{force:true});this.presenceBases.clear();}
}
export async function linuxBoot(){return (await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();}
