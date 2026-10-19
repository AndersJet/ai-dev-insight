import {randomUUID} from 'node:crypto';
import {PluginHttpError,requestFailure} from './http-client.js';

export interface DiagnosticEvent {operation:string;stage:string;phase:'start'|'success'|'failed'|'skipped';elapsed_ms?:number;http_status?:number;code?:string;exit_code?:number;signal?:string}
let sink:((event:DiagnosticEvent)=>void)|undefined;
export function observeDiagnostics(next:(event:DiagnosticEvent)=>void){sink=next;return ()=>{if(sink===next)sink=undefined;};}
const reasons=new Set(['request_timeout','request_failed','invalid_response','response_failed','response_too_large','aborted','http_failed','hook_installation_busy','hook_installation_timeout','powershell_execution_policy','archive_integrity','archive_contents','endpoint_mismatch','invalid_hook_grant','invalid_hook_archive','managed_hooks_modified','orphaned_managed_hooks','managed_hook_files_modified','managed_hook_configuration_modified','incomplete_hook_installation','hook_verification_failed','hook_installation_failed','invalid_installer_result','unsafe_private_directory','directory_lock_busy','directory_lock_invalid','installation_cancelled','plugin_unauthorized','invalid_credentials','registration_not_allowed','password_length','department_unavailable','plugin_key_unavailable','collection_disabled','collection_closed','collection_unavailable','recovery_quarantined','runtime_unavailable','runtime_clock_unavailable','runtime_busy','runtime_coordination_requires_repair','unsafe_runtime_path','unsafe_runtime_file','invalid_runtime_file','invalid_runtime_owner','invalid_runtime_scope']);
export function safeDiagnosticFailure(error:unknown):Pick<DiagnosticEvent,'code'|'http_status'|'exit_code'|'signal'>{
  const value:Pick<DiagnosticEvent,'code'|'http_status'|'exit_code'|'signal'>={code:'unclassified'};
  if(error instanceof PluginHttpError){value.code=requestFailure({code:error.transportCode}).transportCode|| (reasons.has(error.reason)?error.reason:'http_failed');if(error.status>=100&&error.status<=599)value.http_status=error.status;}
  else if(error instanceof Error)value.code=reasons.has(error.message)?error.message:requestFailure(error).transportCode||'unclassified';
  if(error&&typeof error==='object'){
    const child=error as {code?:unknown;signal?:unknown;killed?:unknown};
    if(Number.isInteger(child.code)&&Number(child.code)>=0&&Number(child.code)<=255)value.exit_code=Number(child.code);
    if(['SIGTERM','SIGKILL','SIGABRT'].includes(String(child.signal)))value.signal=String(child.signal);
    if(child.killed===true)value.code='process_timeout';
  }return value;
}
/** A disabled observer costs no allocation or I/O. Never propagate a diagnostic failure. */
export function diagnosticOperation(stage:string,failuresOnly=false){
  const listener=sink;if(!listener)return ()=>{};
  const operation=randomUUID(),started=performance.now();
  if(!failuresOnly)try{listener({operation,stage,phase:'start'});}catch{/* best effort */}
  return (error?:unknown,status?:number)=>{if(failuresOnly&&!error)return;try{listener({operation,stage,phase:error?'failed':'success',elapsed_ms:Math.round(performance.now()-started),...(error?safeDiagnosticFailure(error):{}),...(status?{http_status:status}:{})});}catch{/* best effort */}};
}
const endpoints:Record<string,string>={'/api/v1/plugin/me':'account.verify','/api/v1/plugin/today':'statistics.query','/api/v1/plugin/collection-grant':'hook.grant','/api/v1/plugin/collection-client':'hook.download','/api/v1/plugin-releases/current':'version.query','/api/v1/plugin-releases/trial':'version.trial','/api/v1/auth/login':'account.login','/api/v1/auth/logout':'account.logout','/api/v1/auth/change-password':'account.password','/api/v1/registration/setup':'account.departments','/api/v1/registration/complete':'account.register','/api/v1/registration/activate':'account.activate','/api/v1/me':'account.profile','/api/v1/me/plugin-credential':'account.credential'};
export function requestDiagnostic(path:string){const stage=endpoints[path]??(/^\/api\/v1\/plugin-releases\/builds\/[a-f0-9]{64}$/.test(path)?'version.build':'');return stage?diagnosticOperation(stage):()=>{};}
