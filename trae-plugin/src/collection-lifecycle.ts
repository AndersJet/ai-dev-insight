import {runtimeOwner} from './runtime-control.js';

export interface CollectionBinding {origin:string;user_id:string;email:string;api_token:string}
interface Identity {origin:string;binding:CollectionBinding|undefined}
interface RuntimeCheck {
  verify():Promise<{user_id:string;email:string;binding:CollectionBinding|undefined}>;
  pulse(owner:string,enabled:boolean,resume:boolean,initializing:boolean):Promise<boolean>;
}

/** Owns authorization generations and runtime admission for both runtime adapters. */
export class CollectionLifecycle {
  private identity:Identity={origin:'',binding:undefined};
  private revision=0;
  private controller=new AbortController();
  private authenticated=false;
  private allowed=false;
  private runtimeRevision=0;
  private resume=false;
  private attempts=0;
  private stopped=false;
  private collectionEnabled=true;
  private queued=false;
  private synchronization=Promise.resolve();

  constructor(private readonly readOrigin:()=>string,private readonly readEnabled:()=>boolean){}
  get binding(){return this.identity.binding;}
  get origin(){return this.identity.origin;}
  get generation(){return this.revision;}
  get signal(){return this.controller.signal;}
  get disposed(){return this.stopped;}
  get enabled(){return this.collectionEnabled;}
  get validated(){return this.authenticated;}
  get runtimeAllowed(){return this.allowed;}
  get settled(){return this.synchronization;}

  current(binding:CollectionBinding,generation:number){
    try{return !this.stopped&&generation===this.revision&&binding===this.binding&&this.origin===binding.origin&&this.readOrigin()===binding.origin;}catch{return false;}
  }
  matches(origin:string,binding:CollectionBinding|undefined){
    const active=this.binding;
    return origin===this.origin&&binding?.origin===active?.origin&&binding?.user_id===active?.user_id&&binding?.email===active?.email&&binding?.api_token===active?.api_token;
  }
  invalidate(identity?:Identity){
    this.revision++;
    this.controller.abort();
    this.controller=new AbortController();
    this.authenticated=false;
    this.pause(true);
    if(identity)this.identity=identity;
    return this.revision;
  }
  updateEnabled(){
    const enabled=this.readEnabled();
    if(enabled&&!this.collectionEnabled)this.requestResume();
    this.collectionEnabled=enabled;
  }
  requestResume(){this.resume=true;this.attempts=3;}
  pause(forgetResume=false){this.runtimeRevision++;this.allowed=false;if(forgetResume){this.resume=false;this.attempts=0;}}
  validate(binding:CollectionBinding,generation:number){
    if(!this.current(binding,generation))return false;
    this.authenticated=true;
    this.requestResume();
    return true;
  }
  permits(local:boolean,trusted:boolean,recovering=false){
    return !this.stopped&&!recovering&&local&&trusted&&this.enabled&&this.authenticated&&this.allowed&&!!this.binding;
  }
  async pulse(binding:CollectionBinding,generation:number,host:RuntimeCheck){
    if(!this.current(binding,generation)||!this.authenticated)return false;
    const runtimeRevision=this.runtimeRevision;
    const resume=this.resume&&this.attempts>0;
    try{
      if(resume){
        this.attempts--;
        const verified=await host.verify(),latest=verified.binding;
        if(!this.current(binding,generation)||runtimeRevision!==this.runtimeRevision)return false;
        if(!this.readEnabled()||!this.matches(this.origin,latest)||verified.user_id!==binding.user_id||verified.email!==binding.email){this.pause(true);return false;}
      }
      const allowed=await host.pulse(runtimeOwner(binding.user_id,binding.origin),this.enabled,resume,resume||!this.allowed);
      if(!this.current(binding,generation)||runtimeRevision!==this.runtimeRevision)return false;
      this.allowed=allowed;
      this.resume=resume&&!allowed&&this.attempts>0;
      return true;
    }catch(error){
      if(this.current(binding,generation)){this.allowed=false;this.resume=this.resume&&this.attempts>0;}
      throw error;
    }
  }
  beginRecovery(){
    this.controller.abort();this.controller=new AbortController();this.revision++;this.pause();
    return this.revision;
  }
  completeRecovery(binding:CollectionBinding,generation:number,allowed:boolean){
    if(!this.current(binding,generation))return false;
    this.authenticated=true;this.allowed=allowed&&this.readEnabled();
    return true;
  }
  synchronize(work:()=>Promise<void>){
    if(this.queued)return this.synchronization;
    this.queued=true;
    this.synchronization=this.synchronization.catch(()=>{}).then(async()=>{this.queued=false;if(!this.stopped)await work();});
    return this.synchronization;
  }
  dispose(){this.stopped=true;this.invalidate();this.controller.abort();}
}
