import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';

export interface LeaseClock {kind:'macos-continuous-v1'|'windows-qpc-v1'|'linux-boottime-v1';scope:string;monotonic_ms:number;active_scopes?:string[]}
const uuid='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
export function validClockScope(kind:string,scope:unknown):scope is string{return typeof scope==='string'&&(kind==='macos-continuous-v1'?new RegExp('^macos:'+uuid+'$').test(scope):kind==='linux-boottime-v1'?new RegExp('^linux:'+uuid+'$').test(scope):kind==='windows-qpc-v1'&&/^windows:[1-9][0-9]{0,9}:[1-9][0-9]{0,18}$/.test(scope));}
// Apple CLOCK_MONOTONIC_RAW is the continuous boot clock (including sleep).
// Do not substitute os.uptime(): libuv's Darwin uv_uptime uses wall time.
const macSample=`ObjC.import('Foundation');ObjC.bindFunction('clock_gettime_nsec_np',['uint64_t',['int']]);ObjC.bindFunction('sysctlbyname',['int',['char *','void *','unsigned long *','void *','unsigned long']]);var size=Ref();if($.sysctlbyname('kern.bootsessionuuid',null,size,null,0)!==0||Number(size[0])!==37)throw new Error('boot_clock_unavailable');var bytes=$.NSMutableData.dataWithLength(Number(size[0]));if($.sysctlbyname('kern.bootsessionuuid',bytes.mutableBytes,size,null,0)!==0)throw new Error('boot_clock_unavailable');JSON.stringify({kind:'macos-continuous-v1',scope:'macos:'+ObjC.unwrap($.NSString.alloc.initWithDataEncoding(bytes,$.NSUTF8StringEncoding)).split(String.fromCharCode(0))[0].toLowerCase(),monotonic_ms:Math.floor(Number($.clock_gettime_nsec_np(4))/1000000)});`;
let windowsScope:string|undefined,windowsInitializing:Promise<LeaseClock>|undefined;
const windowsQpc=()=>Number(process.hrtime.bigint()/1000000n);
function decodeClock(value:unknown):LeaseClock{
  const clock=value as Partial<LeaseClock>;
  if(!clock||!validClockScope(clock.kind??'',clock.scope)||!Number.isSafeInteger(clock.monotonic_ms)||clock.monotonic_ms!<0||clock.active_scopes!==undefined&&(!Array.isArray(clock.active_scopes)||clock.active_scopes.some(scope=>!validClockScope('windows-qpc-v1',scope))))throw new Error('runtime_clock_unavailable');
  return clock as LeaseClock;
}
async function windowsSample(scopes:readonly string[]):Promise<LeaseClock>{
  // Values interpolated below are validated decimal PID/start-time pairs,
  // never paths, credentials, scripts or caller-provided command text.
  const candidates=[...new Set(scopes)].map(scope=>"'"+scope+"'").join(','),script=`$ErrorActionPreference='Stop';$p=[Diagnostics.Process]::GetProcessById(${process.pid});$scope='windows:${process.pid}:'+$p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture);$active=@();foreach($s in @(${candidates})){try{$parts=$s.Split(':');$q=[Diagnostics.Process]::GetProcessById([int]$parts[1]);if(!$q.HasExited -and $q.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) -ceq $parts[2]){$active+=,$s}}catch{}};$tick=[Math]::Floor([Diagnostics.Stopwatch]::GetTimestamp()*1000.0/[Diagnostics.Stopwatch]::Frequency);[Console]::Write((ConvertTo-Json -Compress @{kind='windows-qpc-v1';scope=$scope;monotonic_ms=$tick;active_scopes=@($active)}))`;
  const executable=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),before=windowsQpc();
  const {stdout}=await promisify(execFile)(executable,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:15000,maxBuffer:16384,windowsHide:true});
  const after=windowsQpc(),clock=decodeClock(JSON.parse(stdout));
  // libuv hrtime and Stopwatch both use Windows QPC. Cache only this live
  // process's immutable creation identity after checking the clock origins.
  // An unfamiliar host keeps the original system-query path instead of guessing.
  if(clock.kind==='windows-qpc-v1'&&clock.scope.startsWith(`windows:${process.pid}:`)&&clock.monotonic_ms>=before-1&&clock.monotonic_ms<=after+1)windowsScope=clock.scope;
  return clock;
}
/** Read only fixed system clocks. UTC is never used as the monotonic origin.
 * QPC is comparable across processes, includes sleep, and is independent of UTC:
 * https://learn.microsoft.com/windows/win32/sysinfo/acquiring-high-resolution-time-stamps
 * Windows leases additionally bind a live writer PID and immutable process start
 * time, so a previous boot or PID reuse cannot admit the old lease.
 */
export async function readLeaseClock(scopes:readonly string[]=[]):Promise<LeaseClock>{
  let value:unknown;
  if(process.platform==='darwin'){
    const {stdout}=await promisify(execFile)('/usr/bin/osascript',['-l','JavaScript','-e',macSample],{timeout:2000,maxBuffer:16384,env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8'}});value=JSON.parse(stdout);
  }else if(process.platform==='win32'){
    if(scopes.length>128||scopes.some(scope=>!validClockScope('windows-qpc-v1',scope)))throw new Error('invalid_runtime_scope');
    if(!scopes.length&&windowsScope)return {kind:'windows-qpc-v1',scope:windowsScope,monotonic_ms:windowsQpc(),active_scopes:[]};
    if(!scopes.length&&windowsInitializing)return windowsInitializing;
    const work=windowsSample(scopes);if(scopes.length)return work;
    windowsInitializing=work;try{return await work;}finally{if(windowsInitializing===work)windowsInitializing=undefined;}
  }else if(process.platform==='linux'){
    // Existing reference Node sender and Linux CI use the kernel BOOTTIME
    // projection; this does not enable the Trae extension on Linux.
    const [uptime,boot]=await Promise.all([readFile('/proc/uptime','utf8'),readFile('/proc/sys/kernel/random/boot_id','utf8')]);
    value={kind:'linux-boottime-v1',scope:'linux:'+boot.trim().toLowerCase(),monotonic_ms:Math.floor(Number(uptime.split(' ')[0])*1000)};
  }else throw new Error('runtime_clock_unavailable');
  return decodeClock(value);
}

export function activeRuntimeLease(value:unknown,wall:number,clock:LeaseClock):boolean{
  const lease=value as Record<string,unknown>|null;if(!lease||typeof lease.id!=='string'||!new RegExp('^'+uuid+'$').test(lease.id)||!validClockScope(clock.kind,lease.clock_scope))return false;
  const issued=lease.issued_at,expires=lease.expires_at,monoIssued=lease.monotonic_issued_at,monoExpires=lease.monotonic_expires_at;
  if(![issued,expires,monoIssued,monoExpires].every(Number.isSafeInteger))return false;
  if(typeof issued!=='number'||typeof expires!=='number'||typeof monoIssued!=='number'||typeof monoExpires!=='number'||monoIssued<0)return false;
  const sameScope=clock.kind==='windows-qpc-v1'?(clock.active_scopes??[clock.scope]).includes(lease.clock_scope):lease.clock_scope===clock.scope;
  return sameScope&&issued<=wall&&expires>wall&&expires-issued<=30000&&expires-issued>0&&monoIssued<=clock.monotonic_ms&&monoExpires>clock.monotonic_ms&&monoExpires-monoIssued>0&&monoExpires-monoIssued<=30000;
}
