import process from 'node:process';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {URL} from 'node:url';
import {createServer} from 'node:net';

const entry=fileURLToPath(new URL('../dev.mjs',import.meta.url));
const runId='00000000-0000-0000-0000-000000000001';
test('startup reports unreadable environment with stage, run and actionable text',async t=>{
 const root=await mkdtemp(join(tmpdir(),'adi-dev-log-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await assert.rejects(promisify(execFile)(process.execPath,[entry],{cwd:root,env:{ENV_FILE:join(root,'missing.env'),ADI_DEV_RUN_ID:runId}}),error=>{
  const record=JSON.parse(error.stderr);assert.equal(record.stage,'environment');assert.equal(record.run_id,runId);assert.equal(record.error,'environment_file_unreadable');assert.match(record.message,/ENV_FILE/);return true;
 });
});
test('occupied ports identify the service and port before build/init without exposing credentials',async t=>{
 const root=await mkdtemp(join(tmpdir(),'adi-dev-port-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const port=server.address().port;
 await writeFile(join(root,'.env'),`ADI_DATABASE_URL=postgres://fixture:synthetic-private-password@127.0.0.1/fixture\nADI_ADMIN_EMAIL=synthetic-private@example.invalid\nADI_ADMIN_PASSWORD=synthetic-private-password\nADI_API_PORT=${port}\n`);
 await assert.rejects(promisify(execFile)(process.execPath,[entry,'--background-token='+runId],{cwd:root,env:{ADI_DEV_RUN_ID:runId}}),error=>{
  const record=JSON.parse(error.stderr);assert.equal(record.stage,'ports');assert.equal(record.service,'api');assert.equal(record.port,port);assert.equal(record.system_code,'EADDRINUSE');assert.equal(record.error,'dev_port_in_use');assert.equal(record.run_id,runId);
  assert.doesNotMatch(error.stdout+error.stderr,/synthetic-private|postgres:\/\/|"stage":"build"|"stage":"initialize"/);return true;
 });
});
