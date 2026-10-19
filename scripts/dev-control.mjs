import process from 'node:process';
import {fileURLToPath} from 'node:url';
import {startDev,stopDev,restartDev} from './lib/dev-process.mjs';
import {createDevLogger,devMessage} from './lib/dev-log.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const log=fileURLToPath(new URL('../.run/dev.log',import.meta.url));
const logger=createDevLogger({component:'dev-control',file:log});
const started=Date.now();let stage='command';
try{
 const action=process.argv[2];if(!['start','stop','kill','restart'].includes(action))throw new Error('usage_start_stop_kill_restart');
 stage=action==='restart'?'stop':action;
 logger.emit('command_started',{action,stage});
 const options={root,env:{...process.env,ADI_DEV_RUN_ID:logger.runId},onEvent:(event,fields)=>{stage=fields.stage;logger.emit(event,fields);}};
 const result=await (action==='restart'?restartDev(options):action==='start'?startDev(options):stopDev({...options,force:action==='kill'}));
 logger.emit('command_completed',{action,stage,...result,duration_ms:Date.now()-started,message:result.state==='started'?'后台应用进程已启动；服务就绪及后续错误见日志。':'后台进程检查与停止完成。'});
}catch(error){
 const code=/^[a-z_]+$/.test(error?.message??'')?error.message:'dev_control_failed';
 const fields={level:'error',stage:error?.stage??stage,error:code,log,duration_ms:Date.now()-started,message:devMessage(code),...(error?.startupError?{startup_error:error.startupError}:{}),...(error?.exitCode!==undefined?{exit_code:error.exitCode}:{}),...(error?.signal?{signal:error.signal}:{})};
 if(['EPERM','EACCES','ENOENT','EIO'].includes(error?.code))fields.system_code=error.code;
 if(error?.pid)Object.assign(fields,{pid:error.pid,pgid:error.pgid});
 if(error?.processes)fields.processes=error.processes;
 try{logger.emit('command_failed',fields);}catch{process.stderr.write(JSON.stringify({event:'command_failed',...fields})+'\n');}
 process.exitCode=1;
}
