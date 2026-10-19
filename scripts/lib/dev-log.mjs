import process from 'node:process';
import {randomUUID} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,writeSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

const messages={
 dev_port_in_use:'开发服务端口已被占用；检查对应服务和端口，释放后重试。',
 dev_port_unavailable:'开发服务无法绑定端口；检查监听地址和系统权限。',
 invalid_dev_port:'开发服务端口配置无效；端口应为 1–65535 的整数。',
 invalid_database_url:'ADI_DATABASE_URL 格式无效；只对用户名和密码中的特殊字符进行 URL 编码。',
 environment_file_unreadable:'无法读取环境文件；检查 ENV_FILE 指向的文件及读取权限。',
 database_and_administrator_configuration_required:'缺少数据库或管理员配置；检查 ADI_DATABASE_URL、ADI_ADMIN_EMAIL、ADI_ADMIN_PASSWORD。',
 private_cleanup_journal_required:'清理恢复日志目录必须是私有真实目录；检查目录类型及权限 0700。',
 startup_command_failed:'启动子命令失败；查看同一 run_id 下该阶段的前序日志。',
 dev_start_failed_see_log:'后台启动失败；查看同一 run_id 下的 stage_failed 或 cli_failed 日志。',
 dev_start_timeout:'后台启动超时，已终止启动进程组；查看阶段耗时和前序日志。',
 dev_processes_still_exiting:'旧后台进程组仍未退出，已中止本次启动；检查该进程组后重试。',
 dev_process_group_unverified:'记录对应的进程组仍存在，但无法验证归属；保留记录并中止启动，请人工核对。',
 dev_background_process_untracked:'发现本目录后台管理进程没有被当前记录安全停止；已中止启动，请检查运行记录。',
 invalid_dev_state:'后台进程记录无效或另一次启动正在写入；检查 .run/dev-process.json 后重试。',
 unsafe_dev_state:'运行记录或日志不是安全的普通文件；检查 .run 文件类型和权限。',
 dev_start_in_progress:'另一次后台启动正在进行；等待其完成后重试。',
 stale_dev_state_run_make_stop:'存在失效的后台启动记录；执行 make dev 自动停止并重新启动。',
 dev_spawn_failed:'无法创建后台进程；检查 Node 可执行文件和系统权限。',
 background_requires_posix_use_pnpm_dev:'后台命令需要 macOS/Linux；Windows 请使用 pnpm dev。',
};
export function devMessage(code){return messages[code]??'开发服务操作失败；根据阶段和错误码检查本地配置及运行权限。';}

/** Log only caller-selected metadata, never raw errors, argv or environment. */
export function createDevLogger({component,runId,file}={}){
 runId=/^[a-f0-9-]{36}$/.test(runId??'')?runId:randomUUID();
 const emit=(event,fields={})=>{
  const record={at:new Date().toISOString(),level:'info',run_id:runId,component,event,...fields};
  const line=JSON.stringify(record)+'\n';
  if(file){
   mkdirSync(dirname(file),{recursive:true,mode:0o700});
   const fd=openSync(file,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
   try{if(!fstatSync(fd).isFile())throw new Error('unsafe_dev_state');writeSync(fd,line);}finally{closeSync(fd);}
  }
  (record.level==='error'?process.stderr:process.stdout).write(line);
 };
 return {runId,emit};
}
