// Optional developer check. PowerShell 7 on macOS is NOT Windows 5.1 acceptance.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,URL} from 'node:url';
import {setTimeout,clearTimeout} from 'node:timers';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import process from 'node:process';
const executable=process.env.ADI_TEST_PWSH;if(!executable)throw new Error('Set ADI_TEST_PWSH to an existing PowerShell interpreter');
const source=fileURLToPath(new URL('../../apps/hook-client/native/',import.meta.url));
const directory=await mkdtemp(join(tmpdir(),'adi-powershell-check-'));let requests=0,body='',authorization='';let redirect=false;
const server=createServer((request,response)=>{requests++;authorization=request.headers.authorization??'';let value='';request.setEncoding('utf8');request.on('data',data=>{value+=data;});request.on('end',()=>{body=value;if(redirect)response.writeHead(302,{Location:`http://127.0.0.1:${server.address().port}/other`});response.end('not IDE output');});});
try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const token='adi_'+'a'.repeat(43),config=join(directory,'credentials.json');await writeFile(config,JSON.stringify({installation_id:'a163f758-49a9-4d19-b713-0680c1810f66',token,endpoint:`http://127.0.0.1:${server.address().port}/hooks`}),{mode:0o600});
  const parser=join(directory,'parse.ps1');await writeFile(parser,`param([string]$Root)\n$bad=0;Get-ChildItem -LiteralPath $Root -Filter *.ps1 | ForEach-Object {$tokens=$null;$issues=$null;$null=[System.Management.Automation.Language.Parser]::ParseFile($_.FullName,[ref]$tokens,[ref]$issues);if($issues.Count){$bad++;$issues | ForEach-Object {Write-Output ($_.Extent.StartLineNumber.ToString()+': '+$_.Message)}}};exit $bad\n`);
  await promisify(execFile)(executable,['-NoProfile','-NonInteractive','-File',parser,source],{timeout:10000});
  async function send(raw){const child=spawn(executable,['-NoProfile','-NonInteractive','-File',join(source,'send-worker.ps1'),'-Config',config]);let out='',err='';child.stdout.on('data',chunk=>{out+=chunk;});child.stderr.on('data',chunk=>{err+=chunk;});child.stdin.on('error',()=>{});const done=once(child,'exit'),timeout=setTimeout(()=>child.kill('SIGKILL'),10000);try{child.stdin.end(raw);const[code,signal]=await done;assert.equal(code,0);assert.equal(signal,null);assert.equal(out,'');assert.equal(err,'');}finally{clearTimeout(timeout);child.kill('SIGKILL');}}
  const raw='{"hook_event_name":"Stop","session_id":"powershell-synthetic","n":9007199254740993,"A":1,"a":2,"text":"中文"}';
  await send(raw);assert.equal(requests,1);assert.equal(authorization,`Bearer ${token}`);assert.ok(body.endsWith('"payload":'+raw+'}'));
  redirect=true;await send(raw);assert.equal(requests,2,'credentials must not follow redirects');await send('{');assert.equal(requests,2);
  process.stdout.write('PowerShell syntax and portable worker HTTP/payload/redirect checks passed. Windows host/ACL/wrapper not validated.\n');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
