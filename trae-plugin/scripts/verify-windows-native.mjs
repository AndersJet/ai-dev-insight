// Host-side acceptance verifier. Reads only the isolated test API and fixture.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import console from 'node:console';
import process from 'node:process';
import {URLSearchParams} from 'node:url';

const {fetch,AbortSignal}=globalThis;

const directory=resolve('.run/plugin-acceptance');
const expected=JSON.parse(await readFile(resolve(directory,'windows-isolated-expected.json'),'utf8'));
const native=JSON.parse(await readFile(resolve(directory,'windows-native-workspace-result.json'),'utf8'));
const normalize=value=>value.replaceAll('\\','/').toLowerCase();
const fixtureRoot=process.env.ADI_WINDOWS_FIXTURE_ROOT;
assert.ok(fixtureRoot,'Set ADI_WINDOWS_FIXTURE_ROOT to the isolated Windows fixture root');
assert.equal(normalize(expected.root),normalize(fixtureRoot));
assert.equal(native.platform,'win32');assert.equal(native.completed,true);
assert.equal(native.git_setting_restored,true);assert.equal(native.elapsed_periods_wait_ms,3610000);
const base='http://127.0.0.1:4195';
const login=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'plugin-accept@example.invalid',password:'plugin-accept-synthetic-password'}),signal:AbortSignal.timeout(5000)});
assert.equal(login.status,200);
const cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
async function query(path,parameters){
  const response=await fetch(base+path+'?'+new URLSearchParams(parameters),{headers:{cookie},signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,200);return (await response.json()).data;
}
const parameters={nt_email:'windows.multi@example.org',from:native.started_at,to:native.finished_at,limit:'100'};
const projects=await query('/api/v1/plugin/projects',parameters);
assert.equal(projects.has_more,false);assert.equal(projects.total,5);
assert.deepEqual(projects.items.map(item=>normalize(item.workspace_path)).sort(),expected.roots.map(normalize).sort(),'exactly the five opened fixture roots must appear');
assert.equal(new Set(projects.items.map(item=>item.collector_id)).size,1,'one isolated instance must own all roots');
const remotes=[
  {address:'https://git.example.invalid/plugin/mirror.git'},
  {address:'https://git.example.invalid/plugin/multi.git'},
  {address:'ssh://git.example.invalid/plugin/multi-push.git'},
];
const periods=[];
for(const project of projects.items){
  const path=normalize(project.workspace_path),plain=path===normalize(expected.plain),empty=path===normalize(expected.empty);
  const state=plain?'not_git':empty?'no_remote':'repository';
  const root=plain?null:path===normalize(expected.sub)?normalize(expected.root):path;
  const history=await query('/api/v1/plugin/observations',{...parameters,collector_id:project.collector_id,workspace_key:project.workspace_key});
  assert.equal(history.has_more,false);assert.equal(history.items.length,1,'unchanged roots must retain only the initial observation across two thirty-minute probe periods');
  const records=history.items.sort((a,b)=>BigInt(a.sequence)<BigInt(b.sequence)?-1:1);
  for(const record of records){
    assert.equal(record.state,state);assert.equal(record.reason,null);
    assert.equal(record.git_root===null?null:normalize(record.git_root),root);
    assert.deepEqual(record.remotes.map(remote=>({address:remote.address})).sort((a,b)=>String(a.address).localeCompare(String(b.address))),state==='repository'?remotes:[]);
    assert.ok(!JSON.stringify(record).includes('synthetic-secret'));
  }
  const times=records.map(record=>Date.parse(record.observed_at));
  const intervals=times.slice(1).map((time,index)=>time-times[index]);
  assert.ok(Date.parse(native.finished_at)-Date.parse(native.started_at)>=3600000,'the host must remain open across two thirty-minute periods');assert.ok(times.at(-1)<Date.parse(native.finished_at));
  periods.push({workspace_path:project.workspace_path,records:records.length,sequences:records.map(record=>record.sequence),intervals_ms:intervals});
}
const evidence={completed:true,api_history_verified:true,observed_from:native.started_at,observed_to:native.finished_at,host_pid:native.host_pid,plugin_version:native.plugin_version,collector_id:projects.items[0].collector_id,projects:projects.items,periods,full_resource_gate_passed:false};
await writeFile(resolve(directory,'windows-native-workspace-api-evidence.json'),JSON.stringify(evidence,null,2));
console.log(JSON.stringify({completed:true,projects:5,periods:periods.map(item=>({records:item.records,intervals_ms:item.intervals_ms})),full_resource_gate_passed:false}));
process.exitCode=0;
