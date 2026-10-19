import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Real Node fetch against the worker control endpoint. This checks the same
// transport as the load runner, including Fetch's restricted-port policy.
assert.equal(Number(process.versions.node.split('.')[0]),24,'Use the Node 24 acceptance runtime');
const config=JSON.parse(await readFile(new URL('../.run/session-list-capacity/config.json',import.meta.url),'utf8'));
assert.equal(config.synthetic,true);
const response=await globalThis.fetch('http://127.0.0.1:4192/capacity/state',{signal:globalThis.AbortSignal.timeout(5000)});
assert.equal(response.status,200);
const state=await response.json();assert.equal(state.mode,'worker');assert.equal(state.tool_version,9);assert.equal(state.schema,config.schema);assert.equal(state.snapshot_ready,true);
console.log(JSON.stringify({ready:true,transport:'Node 24 fetch',port:4192,mode:state.mode,tool_version:state.tool_version,snapshot_ready:state.snapshot_ready,schema:state.schema}));
