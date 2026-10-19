import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile,mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawn} from 'node:child_process';import {performance} from 'node:perf_hooks';
import {RemoteRuntime,linuxBoot} from '../../src/remote-runtime.js';import {RemoteClient} from '../../src/remote-client.js';import type {VerifiedRemoteHook} from '../../src/remote-protocol.js';
test('actual Linux Hook process relays raw input, exits zero within budget, and cannot send after pause',async()=>{
 const root=await mkdtemp(join(tmpdir(),'adi-linux-native-')),forwarded:VerifiedRemoteHook[]=[];let runtime:RemoteRuntime|undefined;try{
 const build='a'.repeat(64),client=new RemoteClient({build,execute:async<T>(_command:string,input:unknown)=>await runtime!.command(JSON.parse(JSON.stringify(input))) as T,forward:async event=>{forwarded.push(event);return null;}});
 runtime=new RemoteRuntime({build,node:process.execPath,boot:await linuxBoot(),sender:await readFile(process.env.ADI_REMOTE_SENDER_PATH??join(process.cwd(),'dist','remote-hook-sender.cjs')),roots:()=>[root],trusted:()=>true,probe:async()=>({state:'not_git',reason:null,git_root:null,remotes:[]}),forward:input=>client.receive(JSON.parse(JSON.stringify(input)))});
 await client.pulse('b'.repeat(64),true,{resume:true});
 const run=async(raw:string|undefined)=>{const start=performance.now(),child=spawn('/bin/bash',[join(root,'.trae','adi-remote-collector','send.sh')],{stdio:['pipe','pipe','pipe']});let output=0;child.stdout.on('data',b=>output+=b.length);child.stderr.on('data',b=>output+=b.length);if(raw!==undefined)child.stdin.end(raw);const code=await new Promise<number|null>(resolve=>child.on('close',resolve));assert.equal(code,0);assert.equal(output,0);return performance.now()-start;};
 const raw='{"session_id":"synthetic-native-linux","hook_event_name":"UserPromptSubmit","prompt":"synthetic","exact_number":9007199254740993}';
 const active=await run(raw);assert.equal(forwarded.length,1);assert.equal(forwarded[0]!.raw,raw);
 const hung=await run(undefined);assert.ok(hung<1100,`bounded hard stop: ${hung}`);assert.equal(forwarded.length,1);
 await client.stop('b'.repeat(64));const paused=await run(raw);assert.equal(forwarded.length,1);const marker=JSON.parse(await readFile(join(root,'.trae','adi-remote-collector',`relay-${runtime.instance}.json`),'utf8'));assert.equal(marker.active,false);assert.equal(marker.token,undefined);
 assert.ok(active<1100);assert.ok(paused<1100);console.log(JSON.stringify({platform:process.platform,arch:process.arch,active_ms:Math.round(active),paused_ms:Math.round(paused),hung_input_ms:Math.round(hung),raw_preserved:true,no_spool:true}));
 }finally{await runtime?.dispose();await rm(root,{recursive:true,force:true});}
});
