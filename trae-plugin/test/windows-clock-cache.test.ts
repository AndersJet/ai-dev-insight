import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {transform} from 'esbuild';

async function fixture(options:{failFirst?:boolean;foreignOrigin?:boolean}={}){
 const path=new URL('../../apps/hook-client/src/runtime-clock.ts',import.meta.url),actualRequire=createRequire(path);
 const {code}=await transform(await readFile(path,'utf8'),{loader:'ts',format:'cjs',target:'node22'});
 let tick=1000,calls=0;const scope='windows:1234:100',module={exports:{} as {readLeaseClock:(scopes?:string[])=>Promise<{scope:string;monotonic_ms:number;active_scopes:string[]}>}};
 runInNewContext(code,{module,exports:module.exports,Buffer,process:{platform:'win32',pid:1234,env:{},hrtime:{bigint:()=>BigInt(tick)*1000000n}},require:(name:string)=>name==='node:util'?{promisify:()=>async()=>{calls++;await Promise.resolve();if(options.failFirst&&calls===1)throw new Error('synthetic_startup_failed');tick+=4;return {stdout:JSON.stringify({kind:'windows-qpc-v1',scope,monotonic_ms:options.foreignOrigin?tick+100000:tick-2,active_scopes:[]})};}}:actualRequire(name)});
 return {read:module.exports.readLeaseClock,advance:(ms:number)=>{tick+=ms;},calls:()=>calls,scope};
}

test('Windows heartbeats share one identity lookup and keep sampling the same live QPC without subprocesses',async()=>{
 const f=await fixture(),initial=await Promise.all([f.read(),f.read()]);assert.equal(f.calls(),1);assert.equal(initial[0]!.scope,f.scope);
 const first=initial[0]!.monotonic_ms;f.advance(10000);const next=await f.read();assert.equal(next.scope,f.scope);assert.ok(next.monotonic_ms>=first+10000);assert.equal(f.calls(),1);
});

test('explicit peer liveness checks still query Windows and malformed scopes cannot use the cached clock',async()=>{
 const f=await fixture();await f.read();const peer=await f.read(['windows:999:200']);assert.equal(f.calls(),2);assert.equal(peer.active_scopes.length,0);
 await assert.rejects(f.read(['windows:999:200;invalid']),/invalid_runtime_scope/);assert.equal(f.calls(),2);
});

test('an unsuccessful initial identity query can recover without caching its failure',async()=>{
 const f=await fixture({failFirst:true});await assert.rejects(f.read(),/synthetic_startup_failed/);await f.read();f.advance(5000);await f.read();assert.equal(f.calls(),2);
});

test('an unmatched monotonic origin keeps the original system-query path',async()=>{
 const f=await fixture({foreignOrigin:true});await f.read();await f.read();assert.equal(f.calls(),2);
});
