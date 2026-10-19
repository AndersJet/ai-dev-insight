import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {PluginHttpError,requestFailure} from './http-client.js';
import {platformRequestTimeout} from './timeouts.js';
import {requestDiagnostic} from './diagnostics.js';

export function normalizeWebUrl(value:string):string {
  const url=new URL(value.trim());
  if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw new Error('invalid_web_url');
  return url.origin;
}
export interface RequestOptions {method?:'GET'|'POST';body?:unknown;headers?:Record<string,string>;maxBytes?:number;timeout?:number;binary?:boolean}
export async function platformRequest(origin:string,path:string,signal:AbortSignal,options:RequestOptions={}):Promise<{data:unknown;headers:import('node:http').IncomingHttpHeaders}> {
  origin=normalizeWebUrl(origin);
  if(!path.startsWith('/api/')||path.startsWith('//')||path.includes('#')||path.includes('?'))throw new Error('invalid_api_path');
  const endpoint=new URL(path,origin),payload=options.body===undefined?undefined:Buffer.from(JSON.stringify(options.body));
  if(payload&&payload.length>1048576)throw new PluginHttpError(413,'request_too_large');
  const complete=requestDiagnostic(path);let responseStatus=0;
  return new Promise((resolve,reject)=>{
    let done=false;const finish=(error?:Error,result?:{data:unknown;headers:import('node:http').IncomingHttpHeaders})=>{if(done)return;done=true;complete(error,responseStatus);clearTimeout(timer);signal.removeEventListener('abort',abort);if(error){req.destroy();reject(error);}else resolve(result!);};
    const req=(endpoint.protocol==='https:'?httpsRequest:httpRequest)(endpoint,{method:options.method??'GET',agent:false,...(endpoint.protocol==='https:'?{rejectUnauthorized:true}:{}),headers:{Accept:options.binary?'application/zip':'application/json',Origin:origin,...(payload?{'Content-Type':'application/json','Content-Length':payload.length}:{}),...options.headers}},res=>{
      responseStatus=res.statusCode??0;let bytes=0;const chunks:Buffer[]=[];
      res.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>(options.maxBytes??65536)){res.destroy();finish(new PluginHttpError(502,'response_too_large'));}else chunks.push(chunk);});
      res.on('error',()=>finish(new PluginHttpError(0,'response_failed')));
      res.on('end',()=>{
        if(done)return;const status=res.statusCode??0;responseStatus=status;const raw=Buffer.concat(chunks);let parsed:unknown;
        if(!options.binary||status<200||status>=300)try{parsed=JSON.parse(raw.toString('utf8'));}catch{/* Errors never include raw response content. */}
        if(status<200||status>=300){const code=(parsed as {error?:{code?:unknown}})?.error?.code,hint=res.headers['retry-after']?.trim()??'',delay=/^[0-9]+$/.test(hint)?Number(hint)*1000:hint?Date.parse(hint)-Date.now():0;finish(new PluginHttpError(status,typeof code==='string'&&/^[a-z_]{1,64}$/.test(code)?code:'http_failed',Number.isFinite(delay)&&delay>0?delay:0));return;}
        if(status===204&&path==='/api/v1/auth/logout'&&options.method==='POST'){finish(undefined,{data:null,headers:res.headers});return;}
        if(options.binary){finish(undefined,{data:raw,headers:res.headers});return;}
        if(!parsed||typeof parsed!=='object'||!Object.hasOwn(parsed,'data')){finish(new PluginHttpError(502,'invalid_response'));return;}
        finish(undefined,{data:(parsed as {data:unknown}).data,headers:res.headers});
      });
    });
    const abort=()=>finish(new PluginHttpError(0,'aborted'));
    const timer=setTimeout(()=>finish(new PluginHttpError(0,'request_timeout')),options.timeout??platformRequestTimeout(path));timer.unref();
    req.on('error',error=>finish(requestFailure(error)));signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();else req.end(payload);
  });
}
export interface LoginUser {user_id:string;email:string;name?:string;registered:boolean;must_change_password:boolean}
export interface PluginCredential {api_token:string;user_id:string;email:string;created_at?:string}
export class PlatformSession {
  readonly origin:string;private cookies=new Map<string,string>();
  constructor(origin:string){this.origin=normalizeWebUrl(origin);}
  private async request<T>(path:string,signal:AbortSignal,body?:unknown):Promise<T>{
    const response=await platformRequest(this.origin,path,signal,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{body}),headers:{...(this.cookies.size?{Cookie:[...this.cookies].map(([key,value])=>`${key}=${value}`).join('; ')}:{}),...(body===undefined?{}:{'X-CSRF-Token':this.cookies.get('adi_csrf')??''})}});
    for(const cookie of response.headers['set-cookie']??[]){const pair=cookie.split(';',1)[0]!,at=pair.indexOf('=');if(at<0)continue;const name=pair.slice(0,at),value=pair.slice(at+1);if(['adi_session','adi_csrf'].includes(name)&&value.length<=512&&!/[\r\n]/.test(value)){if(value)this.cookies.set(name,value);else this.cookies.delete(name);}}
    return response.data as T;
  }
  setup(signal:AbortSignal){return this.request<{departments:{id:string;name:string}[]}>('/api/v1/registration/setup',signal);}
  register(body:{email:string;password:string;display_name:string;department_id:string},signal:AbortSignal){return this.request('/api/v1/registration/complete',signal,body);}
  login(email:string,password:string,signal:AbortSignal){return this.request<LoginUser>('/api/v1/auth/login',signal,{email,password});}
  me(signal:AbortSignal){return this.request<LoginUser>('/api/v1/me',signal);}
  changePassword(current_password:string,new_password:string,signal:AbortSignal){return this.request<LoginUser>('/api/v1/auth/change-password',signal,{current_password,new_password});}
  activate(department_id:string,signal:AbortSignal){return this.request('/api/v1/registration/activate',signal,{department_id});}
  credential(signal:AbortSignal){return this.request<PluginCredential>('/api/v1/me/plugin-credential',signal,{});}
  async close(signal:AbortSignal){try{if(this.cookies.size)await this.request('/api/v1/auth/logout',signal,{});}finally{this.clear();}}
  clear(){this.cookies.clear();}
}
