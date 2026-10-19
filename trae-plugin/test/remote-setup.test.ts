import {test} from 'node:test';import assert from 'node:assert/strict';import {RemoteSetup} from '../src/remote-setup.js';
const build='a'.repeat(64),info={protocol:1,platform:'linux',build};
test('helper absence is detected without account authorization and installing uses the embedded package once',async()=>{
 let installed=false,installs=0,release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
 const setup=new RemoteSetup({build,execute:async<T>()=>{if(!installed)throw new Error('not found');return info as T;},install:async()=>{installs++;await gate;installed=true;},onChange(){}});
 await setup.check();assert.equal(setup.snapshot().phase,'missing');assert.equal(setup.snapshot().canInstall,true);
 const one=setup.install(),two=setup.install();await Promise.resolve();assert.equal(setup.snapshot().phase,'installing');assert.equal(setup.snapshot().canInstall,false);release();await Promise.all([one,two]);assert.equal(installs,1);assert.equal(setup.available(),true);
});
test('installed files do not claim running success until a matching SSH helper responds',async()=>{
 let runningBuild='b'.repeat(64);const setup=new RemoteSetup({build,execute:async<T>()=>({...info,build:runningBuild}) as T,install:async()=>{},onChange(){}});
 await setup.check();assert.equal(setup.snapshot().phase,'mismatch');await setup.install();assert.equal(setup.snapshot().phase,'reconnect');assert.equal(setup.snapshot().canInstall,false);assert.match(setup.snapshot().message,/重新连接/);await setup.check();assert.equal(setup.snapshot().phase,'reconnect');runningBuild=build;await setup.check();assert.equal(setup.snapshot().phase,'ready');
});
test('installation failure is actionable, sanitized and retryable',async()=>{
 let failed=true;const setup=new RemoteSetup({build,execute:async<T>()=>info as T,install:async()=>{if(failed)throw new Error('private token must not appear');},onChange(){}});
 await setup.install();assert.equal(setup.snapshot().phase,'failed');assert.doesNotMatch(setup.snapshot().message,/private|token/);failed=false;await setup.install();assert.equal(setup.available(),true);setup.dispose();
});


test('unsupported remote transports cannot install a helper or query its collection channel',async()=>{
 for(const remoteName of ['wsl','dev-container']){
  let calls=0;const setup=new RemoteSetup({build,remoteName,execute:async<T>()=>{calls++;return info as T;},install:async()=>{calls++;},onChange(){}});
  await setup.check();await setup.install();assert.equal(setup.snapshot().phase,'unsupported');assert.equal(setup.snapshot().canInstall,false);assert.equal(setup.available(),false);assert.equal(calls,0);
 }
});
