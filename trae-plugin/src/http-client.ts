import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
export class PluginHttpError extends Error {
  constructor(public readonly status:number,public readonly reason:string,public readonly retryAfterMs=0,public readonly transportCode=''){super(reason);}
}
const transportCodes=new Set(['ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','EHOSTUNREACH','ENETUNREACH','EACCES','EPERM','EPIPE','EAI_AGAIN','ERR_TLS_CERT_ALTNAME_INVALID','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','CERT_HAS_EXPIRED']);
export function requestFailure(error:unknown){const code=error&&typeof error==='object'&&'code' in error?error.code:undefined;return new PluginHttpError(0,'request_failed',0,typeof code==='string'&&transportCodes.has(code)?code:'');}
export function pluginFailureHint(error:unknown):string{
 if(!(error instanceof PluginHttpError))return '请求未完成';
 if(error.reason==='request_timeout')return '请求超时';
 if(error.reason==='invalid_response')return '服务响应格式不符合预期';
 if(error.reason==='response_failed')return '服务响应中断';
 if(error.status>=100&&error.status<=599)return `HTTP ${error.status}`;
 return error.transportCode&&transportCodes.has(error.transportCode)?`网络连接失败：${error.transportCode}`:'网络请求失败';
}
export async function pluginRequest(base:string,path:string,body:unknown,token:string|undefined,signal:AbortSignal,timeout=3000,allowEmpty=false,rawBody=false):Promise<unknown>{
  const endpoint=new URL(base.replace(/\/+$/,'')+path);
  if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password||endpoint.hash||endpoint.search)throw new PluginHttpError(400,'invalid_endpoint');
  const data=rawBody&&typeof body==='string'?body:JSON.stringify(body);if(Buffer.byteLength(data)>1048576)throw new PluginHttpError(413,'request_too_large');
  return new Promise((resolve,reject)=>{
    let finished=false;
    const finish=(error?:Error,value?:unknown)=>{if(finished)return;finished=true;clearTimeout(timer);signal.removeEventListener('abort',abort);if(error){request.destroy();reject(error);}else resolve(value);};
    const request=(endpoint.protocol==='https:'?httpsRequest:httpRequest)(endpoint,{method:'POST',agent:false,...(endpoint.protocol==='https:'?{rejectUnauthorized:true}:{}),headers:{'content-type':'application/json','content-length':Buffer.byteLength(data),...(token?{authorization:`Bearer ${token}`}:{})}},response=>{
      const chunks:Buffer[]=[];let bytes=0;
      response.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536){response.destroy();finish(new PluginHttpError(502,'response_too_large'));}else chunks.push(chunk);});
      response.on('error',()=>finish(new PluginHttpError(0,'response_failed')));
      response.on('end',()=>{
        if(finished)return;const status=response.statusCode??0;
        if(status<200||status>=300){
          const hint=response.headers['retry-after']?.trim()??'';
          const delay=/^[0-9]+$/.test(hint)?Number(hint)*1000:hint?Date.parse(hint)-Date.now():0;
          finish(new PluginHttpError(status,'http_failed',Number.isFinite(delay)&&delay>0?delay:0));return;
        }
        if(allowEmpty&&bytes===0){finish(undefined,null);return;}
        try{const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!parsed||typeof parsed!=='object'||!Object.hasOwn(parsed,'data'))throw new Error('Invalid response');finish(undefined,parsed.data);}catch{finish(new PluginHttpError(502,'invalid_response'));}
      });
    });
    const abort=()=>finish(new PluginHttpError(0,'aborted'));
    request.on('error',error=>finish(requestFailure(error)));
    const timer=setTimeout(()=>finish(new PluginHttpError(0,'request_timeout')),timeout);timer.unref();
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted){abort();return;}request.end(data);
  });
}
