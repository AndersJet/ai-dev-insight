import process from 'node:process';
import {createServer} from 'node:net';
import { runStartup as run } from './lib/startup-command.mjs';
import { mkdir, lstat } from 'node:fs/promises';
import { URL } from 'node:url';
import { loadEnvironment, environmentFor } from './lib/environment.mjs';
import {createDevLogger,devMessage} from './lib/dev-log.mjs';

const background=process.argv.some(arg=>arg.startsWith('--background-token='));
const logger=createDevLogger({component:'dev',runId:process.env.ADI_DEV_RUN_ID});
let stage='environment';const started=Date.now();let stageStarted=started;
function enterStage(name){stage=name;stageStarted=Date.now();logger.emit('stage_started',{stage});}
const runStage=async(name,command,args,env)=>{
 enterStage(name);
 await run(command,args,env,8000,{...(background?{detached:false}:{})});
 logger.emit('stage_completed',{stage,duration_ms:Date.now()-stageStarted});
};
try {
  logger.emit('startup_started',{stage,mode:process.argv.includes('--init-only')?'init':'dev'});
  const env = loadEnvironment(); env.NODE_ENV = 'development';
  env.ADI_DEV_RUN_ID=logger.runId;
  if (!env.ADI_DATABASE_URL || !env.ADI_ADMIN_EMAIL || !env.ADI_ADMIN_PASSWORD) throw new Error('database_and_administrator_configuration_required');
  try {
    const database = new URL(env.ADI_DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(database.protocol) || database.hash) throw new Error('invalid_database_url');
    decodeURIComponent(database.username); decodeURIComponent(database.password);
  } catch { throw new Error('invalid_database_url'); }

  if(background){
    enterStage('ports');
    for(const [service,port,host] of [['api',env.ADI_API_PORT,env.ADI_API_HOST??'127.0.0.1'],['collector',env.ADI_COLLECTOR_PORT,env.ADI_COLLECTOR_HOST??'127.0.0.1'],['web',env.ADI_WEB_PORT,'127.0.0.1']]){
      if(!Number.isInteger(Number(port))||Number(port)<1||Number(port)>65535)throw new Error('invalid_dev_port');
      await new Promise((resolvePort,reject)=>{const server=createServer();server.once('error',error=>reject(Object.assign(new Error(error.code==='EADDRINUSE'?'dev_port_in_use':'dev_port_unavailable'),{service,port:Number(port),systemCode:['EADDRINUSE','EACCES','EPERM','EADDRNOTAVAIL','ENOTFOUND'].includes(error.code)?error.code:undefined})));server.listen(Number(port),host,()=>server.close(resolvePort));});
    }
    logger.emit('stage_completed',{stage,duration_ms:Date.now()-stageStarted});
  }
  enterStage('cleanup_journal');
  await mkdir(env.ADI_CLEANUP_JOURNAL_DIR, { recursive: true, mode: 0o700 });
  const directory = await lstat(env.ADI_CLEANUP_JOURNAL_DIR);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) throw new Error('private_cleanup_journal_required');
  logger.emit('stage_completed',{stage,duration_ms:Date.now()-stageStarted});
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  await runStage('build',pnpm, ['--filter','@adi/api...','--filter','@adi/worker...','--filter','@adi/collector...','--filter','@adi/hook-client','build'], environmentFor(env, 'build'));
  await runStage('package_client',process.execPath, ['scripts/package-hook-client.mjs'], environmentFor(env, 'build'));
  await runStage('initialize',process.execPath, ['apps/api/dist/cli.js','init'], environmentFor(env, 'init'));
  if (process.argv.includes('--init-only')) logger.emit('initialization_completed',{stage,duration_ms:Date.now()-started,message:'数据库和配置管理员初始化完成。'});
  else {
    enterStage('applications');
    const { supervise } = await import('../apps/worker/dist/supervisor.js');
    const children = [
      { name: 'api', command: process.execPath, args: ['apps/api/dist/main.js'], env: environmentFor(env,'api') },
      { name: 'collector', command: process.execPath, args: ['apps/collector/dist/main.js'], env: environmentFor(env,'collector') },
      { name: 'worker', command: process.execPath, args: ['apps/worker/dist/supervisor-main.js'], env: {...environmentFor(env,'worker'),...(background?{ADI_DEV_INHERIT_GROUP:'true'}:{})} },
      { name: 'web', command: pnpm, args: ['--filter','@adi/web','dev'], env: environmentFor(env,'web') },
    ];
    let startedProcesses=0;
    process.exitCode = await supervise(children,{...(background?{detached:false}:{}),onEvent:event=>{
      logger.emit(event.event,{stage,...event});
      if(event.event==='process_started'&&++startedProcesses===children.length&&process.send)process.send({event:'dev_started'});
    }}).finished;
    logger.emit('applications_stopped',{stage,exit_code:process.exitCode,duration_ms:Date.now()-started});
  }
} catch (error) {
  const known = new Set(['dev_port_in_use','dev_port_unavailable','invalid_dev_port','invalid_database_url','environment_file_unreadable','database_and_administrator_configuration_required','private_cleanup_journal_required','startup_command_failed']);
  const code=known.has(error?.message)?error.message:'local_startup_failed';
  logger.emit('stage_failed',{level:'error',stage,error:code,message:devMessage(code),duration_ms:Date.now()-started,stage_duration_ms:Date.now()-stageStarted,...(error?.service?{service:error.service,port:error.port}:{}),...(error?.exitCode!==undefined?{exit_code:error.exitCode,signal:error.signal,cancelled:error.cancelled}:{}),...(error?.systemCode?{system_code:error.systemCode}:{})});
  if(process.send)process.send({event:'dev_start_failed',stage,error:code});
  process.exitCode = 1;
}
