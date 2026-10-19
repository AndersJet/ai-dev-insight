import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,symlink,readdir} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {request} from 'node:http';
import {RemoteRuntime} from '../src/remote-runtime.js';import {RemoteClient} from '../src/remote-client.js';import {REMOTE_COMMAND,FORWARD_COMMAND,type RemoteHook,type RemotePermit,type VerifiedRemoteHook} from '../src/remote-protocol.js';import {installRemoteHook} from '../src/remote-hook-install.js';
const build='a'.repeat(64),probe={state:'no_remote' as const,reason:null,git_root:'/remote/project',remotes:[]};
function post(config:{port:number;token:string},body:unknown){return new Promise<number>((resolve,reject)=>{const req=request({host:'127.0.0.1',port:config.port,path:'/hook',method:'POST',headers:{authorization:`Bearer ${config.token}`}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode!));});req.on('error',reject);req.end(JSON.stringify(body));});}
test('SSH relay executes Git at the workspace host, forwards Hook only to bound local owner, and revokes on pause/disconnect',async()=>{
 const root=await mkdtemp(join(tmpdir(),'adi-remote-runtime-'));const forwarded:VerifiedRemoteHook[]=[];let connected=true;let runtime:RemoteRuntime;let client:RemoteClient;
 try{
  client=new RemoteClient({build,execute:async<T>(command:string,input:unknown)=>{assert.equal(command,REMOTE_COMMAND);if(!connected)throw new Error('ssh_disconnected');return JSON.parse(JSON.stringify(await runtime.command(JSON.parse(JSON.stringify(input))))) as T;},forward:async event=>{forwarded.push(event);return null;}});
  runtime=new RemoteRuntime({build,roots:()=>[root],trusted:()=>true,sender:Buffer.from('test sender'),node:process.execPath,boot:'test-boot',probe:async workspace=>{assert.equal(workspace,root);return probe;},forward:input=>{assert.ok(input.session);return client.receive(JSON.parse(JSON.stringify(input)));}});
  assert.equal(await client.pulse('b'.repeat(64),true,{resume:true}),true);assert.deepEqual(client.roots(),[root]);
  await client.probe(root,new AbortController().signal);
  const relay=join(root,'.trae','adi-remote-collector',`relay-${runtime.instance}.json`),capability=JSON.parse(await readFile(relay,'utf8'));
  const payload={session_id:'synthetic-'+randomUUID(),hook_event_name:'UserPromptSubmit',cwd:root,prompt:'synthetic relay test'};
  assert.equal(await post({...capability,token:'wrong'},payload),403);assert.equal(forwarded.length,0);
  assert.equal(await post(capability,payload),204);assert.equal(forwarded.length,1);assert.equal(forwarded[0]!.workspace,root);assert.equal(forwarded[0]!.probe!.state,'no_remote');
  const stale=forwarded[0]!;await client.stop('b'.repeat(64));await assert.rejects(client.receive(stale),/remote_unauthorized/);assert.equal(JSON.parse(await readFile(relay,'utf8')).active,false);assert.equal(JSON.parse(await readFile(relay,'utf8')).token,undefined);
  await client.pulse('c'.repeat(64),true,{resume:true});await assert.rejects(client.receive(stale),/remote_invalid_event/);
  connected=false;await assert.rejects(client.pulse('c'.repeat(64),true),/remote_unavailable/);await assert.rejects(client.receive(stale),/remote_unauthorized/);
  connected=true;await assert.rejects(client.pulse('c'.repeat(64),true),/remote_revalidation_required/);
  await runtime.dispose();
 }finally{await rm(root,{recursive:true,force:true});}
});
test('managed project Hook installation preserves third-party entries and refuses manual modifications',async()=>{
 const root=await mkdtemp(join(tmpdir(),'adi-remote-install-'));try{
  await mkdir(join(root,'.trae'));const path=join(root,'.trae','hooks.json'),third={hooks:[{type:'command',command:'echo third-party'}]};await writeFile(path,JSON.stringify({version:1,hooks:{UserPromptSubmit:[third]},custom:'preserved'}));
  const sender=Buffer.from('owned sender');await installRemoteHook(root,sender,process.execPath);await installRemoteHook(root,sender,process.execPath);
  const hooks=JSON.parse(await readFile(path,'utf8'));assert.equal(hooks.custom,'preserved');assert.deepEqual(hooks.hooks.UserPromptSubmit[0],third);assert.equal(hooks.hooks.UserPromptSubmit.length,2);
  hooks.hooks.UserPromptSubmit[1].hooks[0].command='manual modification';await writeFile(path,JSON.stringify(hooks));const before=await readFile(path,'utf8');await assert.rejects(installRemoteHook(root,sender,process.execPath),/managed_hooks_modified/);assert.equal(await readFile(path,'utf8'),before);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('helper build mismatch and missing SSH channel cannot enable collection',async()=>{
 const client=new RemoteClient({build,execute:async<T>()=>({protocol:1,instance:randomUUID(),platform:'linux',build:'wrong',roots:['/remote']}) as T,forward:async()=>{throw new Error('must not forward');}});await assert.rejects(client.pulse('a'.repeat(64),true,{resume:true}),/remote_helper_mismatch/);assert.deepEqual(client.roots(),[]);await assert.rejects(client.receive({}),/remote_unauthorized/);assert.ok(FORWARD_COMMAND);
});

test('an independent second SSH window survives the first close without losing its owned relay',async()=>{
 const root=await mkdtemp(join(tmpdir(),'adi-remote-windows-'));let one:RemoteRuntime|undefined,two:RemoteRuntime|undefined;try{
  const host={build,roots:()=>[root],trusted:()=>true,sender:Buffer.from('multiwindow sender'),node:process.execPath,boot:'test',probe:async()=>probe,forward:async(input:RemoteHook|RemotePermit)=>'op'in input?{permit:'x'.repeat(43)}:null};one=new RemoteRuntime(host);two=new RemoteRuntime(host);
  const client=(runtime:RemoteRuntime)=>new RemoteClient({build,execute:async<T>(_command:string,input:unknown)=>await runtime.command(input) as T,forward:async input=>'op'in input?{permit:'x'.repeat(43)}:null});
  const a=client(one),b=client(two);await a.pulse('a'.repeat(64),true,{resume:true});await b.pulse('a'.repeat(64),true,{resume:true});await a.close('a'.repeat(64));await one.dispose();
  const config=JSON.parse(await readFile(join(root,'.trae','adi-remote-collector',`relay-${two.instance}.json`),'utf8'));assert.equal(await post(config,{session_id:'surviving-window',hook_event_name:'Stop',cwd:root}),204);assert.equal(await b.pulse('a'.repeat(64),true),true);
 }finally{await one?.dispose();await two?.dispose();await rm(root,{recursive:true,force:true});}
});

test('without a heartbeat the remote relay becomes inactive and an expired authorization needs a fresh start',{timeout:20000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'adi-remote-expiry-'));let runtime:RemoteRuntime|undefined;try{
  runtime=new RemoteRuntime({build,roots:()=>[root],trusted:()=>true,sender:Buffer.from('expiry sender'),node:process.execPath,boot:'test',probe:async()=>probe,forward:async input=>'op'in input?{permit:'x'.repeat(43)}:null});const active=runtime;
  const client=new RemoteClient({build,execute:async<T>(_command:string,input:unknown)=>await active.command(input) as T,forward:async input=>'op'in input?{permit:'x'.repeat(43)}:null});await client.pulse('a'.repeat(64),true,{resume:true});
  await new Promise(resolve=>setTimeout(resolve,16100));assert.equal(JSON.parse(await readFile(join(root,'.trae','adi-remote-collector',`relay-${runtime.instance}.json`),'utf8')).active,false);await assert.rejects(client.pulse('a'.repeat(64),true),/remote_revalidation_required/);await client.pulse('a'.repeat(64),true,{resume:true});
 }finally{await runtime?.dispose();await rm(root,{recursive:true,force:true});}
});

test('a delayed payload cannot use an expired or consumed one-shot local permit',async()=>{
 let session:{session:string;instance:string}|undefined,forwards=0;const instance=randomUUID();
 const client=new RemoteClient({build,execute:async<T>(_command:string,input:unknown)=>{const request=input as {op:string;session:string};if(request.op==='start')session={session:request.session,instance};return {protocol:1,instance,platform:'linux',build,roots:['/remote']} as T;},forward:async()=>{forwards++;return null;}});
 await client.pulse('a'.repeat(64),true,{resume:true});assert.ok(session);const id=randomUUID();
 const permit=await client.receive({op:'permit',...session,event_id:id}) as {permit:string};
 const event={...session,event_id:id,permit:permit.permit,occurred_at:new Date().toISOString(),payload:JSON.stringify({session_id:'synthetic-permit',hook_event_name:'Stop'}),workspace:'/remote',probe:null};
 await new Promise(resolve=>setTimeout(resolve,320));await assert.rejects(client.receive(event),/remote_invalid_event/);assert.equal(forwards,0);
 const fresh=await client.receive({op:'permit',...session,event_id:id}) as {permit:string};await client.receive({...event,permit:fresh.permit});assert.equal(forwards,1);await assert.rejects(client.receive({...event,permit:fresh.permit}),/remote_invalid_event/);await client.close('a'.repeat(64));
});


test('shared Hook refuses active, paused and unbound peer windows instead of choosing another account',async()=>{
 const root=await mkdtemp(join(tmpdir(),'adi-remote-owner-isolation-'));let one:RemoteRuntime|undefined,two:RemoteRuntime|undefined;let forwards=0;
 try{
  const host={build,roots:()=>[root],trusted:()=>true,sender:Buffer.from('isolation sender'),node:process.execPath,boot:'test',probe:async()=>probe,forward:async(input:RemoteHook|RemotePermit)=>{forwards++;return 'op'in input?{permit:'x'.repeat(43)}:null;}};
  one=new RemoteRuntime(host);const active=one,client=new RemoteClient({build,execute:async<T>(_command:string,input:unknown)=>await active.command(input) as T,forward:async()=>null});
  await client.pulse('a'.repeat(64),true,{resume:true});
  const relay=join(root,'.trae','adi-remote-collector',`relay-${one.instance}.json`),config=JSON.parse(await readFile(relay,'utf8')),payload={session_id:'owner-isolation',hook_event_name:'UserPromptSubmit',cwd:root,prompt:'must not cross accounts'};
  two=new RemoteRuntime(host);await two.command({op:'hello'});
  assert.equal(await post(config,payload),409);assert.equal(forwards,0);await client.pulse('a'.repeat(64),true);assert.equal(client.hookStatus().reason,'remote_hook_window_conflict');
  const peer=two,second=new RemoteClient({build,execute:async<T>(_command:string,input:unknown)=>await peer.command(input) as T,forward:async()=>null});
  await second.pulse('b'.repeat(64),true,{resume:true});assert.equal(await post(config,payload),409);assert.equal(forwards,0);
  await second.stop('b'.repeat(64));assert.equal(await post(config,payload),409);assert.equal(forwards,0);
  await two.dispose();await client.pulse('a'.repeat(64),true);assert.equal(client.hookStatus().state,'ready');assert.equal(await post(config,payload),204);assert.equal(forwards,2);
 }finally{await one?.dispose();await two?.dispose();await rm(root,{recursive:true,force:true});}
});


test('untrusted or symlinked workspaces cannot publish presence outside a managed directory',{skip:process.platform==='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'adi-presence-boundary-')),outside=await mkdtemp(join(tmpdir(),'adi-presence-outside-'));let runtime:RemoteRuntime|undefined;
 try{
  await mkdir(join(root,'.trae'));await writeFile(join(outside,'receipt.json'),'{}');await symlink(outside,join(root,'.trae','adi-remote-collector'));
  const host={build,roots:()=>[root],trusted:()=>false,sender:Buffer.from('boundary sender'),node:process.execPath,boot:'test',probe:async()=>probe,forward:async()=>null};
  runtime=new RemoteRuntime(host);await runtime.command({op:'hello'});await runtime.dispose();assert.deepEqual(await readdir(outside),['receipt.json']);
  runtime=new RemoteRuntime({...host,trusted:()=>true});await runtime.command({op:'hello'});await runtime.dispose();assert.deepEqual(await readdir(outside),['receipt.json']);
  await rm(join(root,'.trae','adi-remote-collector'));await mkdir(join(root,'.trae','adi-remote-collector'));await writeFile(join(root,'.trae','adi-remote-collector','receipt.json'),'{}');
  runtime=new RemoteRuntime(host);await runtime.command({op:'hello'});await runtime.dispose();assert.deepEqual(await readdir(join(root,'.trae','adi-remote-collector')),['receipt.json']);
 }finally{await runtime?.dispose();await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
