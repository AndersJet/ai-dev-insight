import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {uniqueRemoteRelay} from '../src/remote-presence.js';
test('Hook sender selects only one live private window and fails closed on peers or malformed state',async t=>{
 const base=await mkdtemp(join(tmpdir(),'adi-presence-'));t.after(()=>rm(base,{recursive:true,force:true}));
 const instance=randomUUID(),peer=randomUUID(),path=(id:string)=>join(base,`relay-${id}.json`),active={version:2,instance,boot:'boot',expires:15000,active:true,owner:'a'.repeat(64),port:10000,token:'x'.repeat(43)};
 const save=async(id:string,value:unknown)=>{await writeFile(path(id),JSON.stringify(value),{mode:0o600});};
 await save(instance,active);assert.equal(uniqueRemoteRelay(base,'boot',0)?.instance,instance);
 await save(peer,{...active,instance:peer,owner:'b'.repeat(64)});assert.equal(uniqueRemoteRelay(base,'boot',0),undefined);
 await save(peer,{version:2,instance:peer,boot:'boot',expires:15000,active:false,owner:null});assert.equal(uniqueRemoteRelay(base,'boot',0),undefined);
 await save(peer,{...active,instance:peer,expires:0});assert.equal(uniqueRemoteRelay(base,'boot',1)?.instance,instance);
 await save(peer,{...active,instance:peer,boot:'previous-boot'});assert.equal(uniqueRemoteRelay(base,'boot',0)?.instance,instance);
 await writeFile(path(peer),'malformed');assert.equal(uniqueRemoteRelay(base,'boot',0),undefined);await rm(path(peer));
 for(let n=0;n<128;n++){const stale=randomUUID();await save(stale,{...active,instance:stale,expires:0});}
 assert.equal(uniqueRemoteRelay(base,'boot',1)?.instance,instance,'expired crash remnants do not count as live windows');
 await chmod(path(instance),0o644);assert.equal(uniqueRemoteRelay(base,'boot',0),undefined);
});
