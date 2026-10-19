import {environment as e2eEnv} from './environment.mjs';
// Opt-in real Windows producer in the existing local VM. Only fixture files,
// synthetic credentials and the isolated collector are reachable through here.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer,request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {isIP,type AddressInfo} from 'node:net';
const exec=promisify(execFile),cli='/Applications/Parallels Desktop.app/Contents/MacOS/prlctl';
const vm=process.env.ADI_TEST_PARALLELS_VM??'',hostIP=process.env.ADI_TEST_PARALLELS_HOST_IP??'',guestIP=process.env.ADI_TEST_PARALLELS_GUEST_IP??'';
function privateIPv4(value:string){const octets=value.split('.').map(Number);return isIP(value)===4&&(octets[0]===10||octets[0]===192&&octets[1]===168||octets[0]===172&&octets[1]!>=16&&octets[1]!<=31);}
function quote(value:string){return "'"+value.replaceAll("'","''")+"'";}
async function guest(program:string){
  const encoded=Buffer.from("$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';"+program,'utf16le').toString('base64');
  assert.ok(encoded.length<3500,'guest command must remain below the verified argument bound');
  try{return (await exec(cli,['exec',vm,'--current-user','powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',encoded],{timeout:30000,maxBuffer:65536})).stdout.trim();}
  catch{throw new Error('Windows fixture command failed; command and synthetic credentials omitted');}
}
export async function parallelsProjectClient(archive:string,runtimeOwner:string){
  assert.match(runtimeOwner,/^[a-f0-9]{64}$/);
  assert.equal(process.env.ADI_TEST_PARALLELS_WINDOWS,'1');assert.equal(process.platform,'darwin');
  assert.ok(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(vm),'Set ADI_TEST_PARALLELS_VM to the isolated VM UUID');
  assert.ok(privateIPv4(hostIP)&&privateIPv4(guestIP)&&hostIP!==guestIP,'Set distinct private host/guest relay addresses');
  const identity=await guest('$i=[Security.Principal.WindowsIdentity]::GetCurrent();$p=New-Object Security.Principal.WindowsPrincipal($i);[string]$i.IsSystem+","+[string]$p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)');
  assert.equal(identity,'False,False','Windows acceptance requires the ordinary user');
  const root=Buffer.from(await guest('$r=Join-Path ([IO.Path]::GetTempPath()) '+quote('adi-browser-'+randomUUID().slice(0,8))+';[void][IO.Directory]::CreateDirectory($r);[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($r))'),'base64').toString('utf8');
  assert.match(root,/^C:\\Users\\[^\\]+\\AppData\\Local\\Temp\\adi-browser-[a-f0-9]{8}$/);
  const nonce=randomUUID(),bytes=await readFile(archive),sha=createHash('sha256').update(bytes).digest('hex');
  let accepting=true;let forwarded=0;
  const server=createServer((incoming,outgoing)=>{
    if(incoming.socket.remoteAddress?.replace(/^::ffff:/,'')!==guestIP){outgoing.writeHead(403).end();return;}
    if(incoming.method==='GET'&&incoming.url==='/'+nonce+'/client.zip'){outgoing.writeHead(200,{'content-length':bytes.length});outgoing.end(bytes);return;}
    if(!accepting||incoming.method!=='POST'||incoming.url!=='/hooks'){outgoing.writeHead(404).end();return;}
    // Preserve the native wire and authorization; use only the pinned local
    // isolated collector. No data/headers or retries are logged or persisted.
    const request=httpRequest({host:'127.0.0.1',port:e2eEnv.portBase+3,path:'/hooks',method:'POST',headers:{'content-type':'application/json','content-length':incoming.headers['content-length'],'authorization':incoming.headers.authorization}},response=>{
      forwarded++;outgoing.writeHead(response.statusCode??502);response.pipe(outgoing);
    });
    request.setTimeout(1000,()=>request.destroy());request.on('error',()=>{if(!outgoing.headersSent)outgoing.writeHead(502);outgoing.end();});incoming.pipe(request);
  });
  server.listen(0,hostIP);await once(server,'listening');
  const port=(server.address() as AddressInfo).port,origin='http://'+hostIP+':'+port;
  const gitDirectory=process.env.ADI_TEST_WINDOWS_GIT_DIR??await guest('[IO.Path]::GetDirectoryName((Get-Command git.exe -ErrorAction Stop).Source)');
  const profile=root+'\\profile',workspace=root+'\\project',control=root+'\\.trae-cn\\adi-plugin-control\\control.json',generation=randomUUID(),lease=randomUUID();
  let writer:{pid:number;start:string}|undefined;
  async function dispose(){
    accepting=false;
    try{
      const stop='[IO.File]::WriteAllText('+quote(root+'\\lease.stop')+',"stop");';
      const joinWriter=writer?'try{$p=[Diagnostics.Process]::GetProcessById('+writer.pid+');try{if($p.StartTime.ToUniversalTime().Ticks.ToString() -ceq '+quote(writer.start)+'){if(!$p.WaitForExit(2500)){$p.Kill();[void]$p.WaitForExit(1500)}}}finally{$p.Dispose()}}catch{};':'';
      await guest(stop+joinWriter+'[IO.Directory]::Delete('+quote(root)+',$true)');
    }
    finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  }
  async function renew(){
    assert.ok(writer,'a live guest writer must own the fixture lease');
    await guest('$p=[Diagnostics.Process]::GetProcessById('+writer.pid+');try{if($p.HasExited -or $p.StartTime.ToUniversalTime().Ticks.ToString() -cne '+quote(writer.start)+'){throw "writer_lost"}}finally{$p.Dispose()};$c=ConvertFrom-Json ([IO.File]::ReadAllText('+quote(control)+'));if($c.version -ne 2 -or $c.clock_kind -cne "windows-qpc-v1" -or $c.generation -cne '+quote(generation)+'){throw "lease_not_ready"}');
  }
  try{
    // A short prlctl PowerShell command exits immediately and cannot own a live
    // process-scoped lease. Keep a controlled writer alive until fixture disposal.
    const writerScript=`$ErrorActionPreference='Stop';$target=${quote(control)};$root=${quote(root)};$d=[IO.Path]::GetDirectoryName($target);[void][IO.Directory]::CreateDirectory($d);$me=[Diagnostics.Process]::GetCurrentProcess();$scope='windows:'+$me.Id+':'+$me.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture);$utf8=New-Object Text.UTF8Encoding($false);try{while(!(Test-Path -LiteralPath (Join-Path $root 'lease.stop'))){$wall=[long]([DateTime]::UtcNow-[DateTime]::SpecifyKind([DateTime]'1970-01-01',[DateTimeKind]::Utc)).TotalMilliseconds;$mono=[long][Math]::Floor([Diagnostics.Stopwatch]::GetTimestamp()*1000.0/[Diagnostics.Stopwatch]::Frequency);$c=@{version=2;clock_kind='windows-qpc-v1';owner=${quote(runtimeOwner)};generation=${quote(generation)};enabled=$true;leases=@(@{id=${quote(lease)};clock_scope=$scope;issued_at=$wall;expires_at=$wall+20000;monotonic_issued_at=$mono;monotonic_expires_at=$mono+20000})};$temp=$target+'.tmp';[IO.File]::WriteAllText($temp,(ConvertTo-Json -Depth 4 -Compress $c),$utf8);if([IO.File]::Exists($target)){[IO.File]::Replace($temp,$target,$null)}else{[IO.File]::Move($temp,$target)};Start-Sleep -Milliseconds 500}}finally{$me.Dispose()}`;
    const encodedWriter=Buffer.from(writerScript,'utf8').toString('base64'),encodedPath=root+'\\lease-writer.b64',writerPath=root+'\\lease-writer.ps1';
    for(let offset=0;offset<encodedWriter.length;offset+=600)await guest('[IO.File]::AppendAllText('+quote(encodedPath)+','+quote(encodedWriter.slice(offset,offset+600))+')');
    const launched=await guest('[IO.File]::WriteAllBytes('+quote(writerPath)+',[Convert]::FromBase64String([IO.File]::ReadAllText('+quote(encodedPath)+')));$exe=Join-Path $env:SystemRoot "System32/WindowsPowerShell/v1.0/powershell.exe";$args=@("-NoProfile","-NonInteractive","-File",([char]34+'+quote(writerPath)+'+[char]34));$p=Start-Process -FilePath $exe -ArgumentList $args -WindowStyle Hidden -PassThru;try{ConvertTo-Json -Compress @{pid=$p.Id;start=$p.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)}}finally{$p.Dispose()}');
    const parsed=JSON.parse(launched) as {pid:unknown;start:unknown};assert.ok(Number.isSafeInteger(parsed.pid)&&Number(parsed.pid)>0&&typeof parsed.start==='string'&&/^[1-9][0-9]{0,18}$/.test(parsed.start));writer={pid:Number(parsed.pid),start:parsed.start};
    await guest('$until=[DateTime]::UtcNow.AddSeconds(10);while(!(Test-Path -LiteralPath '+quote(control)+')){if([DateTime]::UtcNow -ge $until){throw "lease_start_timeout"};Start-Sleep -Milliseconds 50}');await renew();
    await guest('$w=New-Object Net.WebClient;try{$w.DownloadFile('+quote(origin+'/'+nonce+'/client.zip')+','+quote(root+'\\client.zip')+')}finally{$w.Dispose()};if((Get-FileHash -LiteralPath '+quote(root+'\\client.zip')+').Hash.ToLowerInvariant() -cne '+quote(sha)+'){throw "checksum"};Expand-Archive -LiteralPath '+quote(root+'\\client.zip')+' -DestinationPath '+quote(root+'\\package')+';[IO.File]::WriteAllText('+quote(root+'\\empty.gitconfig')+',"")');
    // The personal archive contains only synthetic test-account credentials.
    // Override its endpoint to the ephemeral relay before invoking its actual
    // installer. Both relay destinations remain inside this fixture.
    await guest('$c=ConvertFrom-Json ([IO.File]::ReadAllText('+quote(root+'\\package\\adi-installation.json')+'));$c.endpoint='+quote(origin+'/hooks')+';$c | Add-Member -NotePropertyName protocol_version -NotePropertyValue 2 -Force;$c | Add-Member -NotePropertyName runtime_owner -NotePropertyValue '+quote(runtimeOwner)+' -Force;[IO.File]::WriteAllText('+quote(root+'\\package\\adi-installation.json')+',(ConvertTo-Json -Compress $c),(New-Object Text.UTF8Encoding($false))); & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '+quote(root+'\\package\\install-hook.ps1')+' install -TraeDir '+quote(profile)+' -Credentials '+quote(root+'\\package\\adi-installation.json')+';if($LASTEXITCODE){throw "install_failed"}');
    const git=gitDirectory+'\\git.exe';
    await guest('& '+quote(git)+' init --quiet --template= '+quote(workspace)+';if($LASTEXITCODE){throw "git_init"}; & '+quote(git)+' -C '+quote(workspace)+' remote add origin '+quote('https://synthetic-user:synthetic-secret@10.24.0.12/team/native.git?token=synthetic-secret')+'; & '+quote(git)+' -C '+quote(workspace)+' remote add mirror '+quote('https://native-personal.example.invalid/team/native.git'));
    return {
      workspace,dispose,forwarded:()=>forwarded,
      changeRemote:()=>guest('& '+quote(git)+' -C '+quote(workspace)+' remote set-url origin '+quote('https://not-yet-observed.example.invalid/changed.git')),
      send:async(session:string)=>{
        await renew();
        const raw=JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:session,cwd:workspace,prompt:'synthetic dialogue URL https://dialogue-only.example.invalid/ignore.git'});
        await guest('[IO.File]::WriteAllBytes('+quote(root+'\\event.json')+',[Convert]::FromBase64String('+quote(Buffer.from(raw).toString('base64'))+'))');
        await guest('$env:PATH='+quote(gitDirectory+';')+'+$env:PATH;$env:GIT_CONFIG_GLOBAL='+quote(root+'\\empty.gitconfig')+';$env:GIT_CONFIG_SYSTEM=$env:GIT_CONFIG_GLOBAL;$env:GIT_CONFIG_NOSYSTEM="1";$b='+quote(profile+'\\adi-native-collector')+';$m=ConvertFrom-Json ([IO.File]::ReadAllText((Join-Path $b "manifest.json")));$d=Join-Path $b $m.release;$i=New-Object Diagnostics.ProcessStartInfo;$i.FileName=Join-Path $d "adi-sender.exe";$i.Arguments=[char]34+(Join-Path $d "config.json")+[char]34;$i.UseShellExecute=$false;$i.EnvironmentVariables["USERPROFILE"]='+quote(root)+';$i.CreateNoWindow=$true;$i.RedirectStandardInput=$true;$i.RedirectStandardOutput=$true;$i.RedirectStandardError=$true;$p=New-Object Diagnostics.Process;$p.StartInfo=$i;$null=$p.Start();$bytes=[IO.File]::ReadAllBytes('+quote(root+'\\event.json')+');$p.StandardInput.BaseStream.Write($bytes,0,$bytes.Length);$p.StandardInput.Close();if(!$p.WaitForExit(2000)){$p.Kill();throw "native_timeout"};if($p.ExitCode -ne 0 -or $p.StandardOutput.ReadToEnd() -or $p.StandardError.ReadToEnd()){throw "native_not_silent"};$p.Dispose()');
      },
    };
  }catch(error){await dispose();throw error;}
}
