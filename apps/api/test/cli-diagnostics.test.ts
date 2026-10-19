import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cliDiagnostic} from '../src/cli-diagnostics.js';

test('missing public extensions are named with an actionable administrator hint, including wrapped migration errors',()=>{
 for(const extension of ['pg_trgm','btree_gist']){
  const cause=Object.assign(new Error(`public.${extension} must be preinstalled by the database administrator`),{code:'55000',detail:'synthetic-private-detail'});
  const diagnostic=cliDiagnostic(new Error('synthetic-private-wrapper',{cause}));
  assert.equal(diagnostic.error,'database_extension_required');assert.equal(diagnostic.extension,extension);assert.equal(diagnostic.sqlstate,'55000');
  assert.match(diagnostic.hint??'',/数据库管理员/);assert.doesNotMatch(JSON.stringify(diagnostic),/synthetic-private/);
 }
});
test('lookalike SQL guard messages and unknown errors expose only safe metadata',()=>{
 for(const code of ['55000','P0001']){
  const diagnostic=cliDiagnostic(Object.assign(new Error('public.pg_trgm must be preinstalled by the database administrator synthetic-private-sql'),{code}));
  assert.equal(diagnostic.error,'operation_failed');assert.equal(diagnostic.sqlstate,code);assert.doesNotMatch(JSON.stringify(diagnostic),/synthetic-private|public.pg_trgm/);
 }
 assert.equal(cliDiagnostic(new Error('postgres://private:secret@host/db')).error,'operation_failed');
 assert.equal(cliDiagnostic(Object.assign(new Error('secret'),{code:'EPERM'})).sqlstate,undefined);
});
test('known connection, migration and key failures use static descriptions and hide original details',()=>{
 for(const code of ['ECONNREFUSED','ETIMEDOUT','28P01','42501','55P03','migration_schema_not_empty']){
  const diagnostic=cliDiagnostic(Object.assign(new Error('synthetic-private-sql'),{code}));assert.equal(diagnostic.error,code);assert.doesNotMatch(JSON.stringify(diagnostic),/synthetic-private/);
 }
 const cause=Object.assign(new Error('migration_checksum_mismatch'),{code:'migration_checksum_mismatch'});
 assert.equal(cliDiagnostic(new Error('loader private detail',{cause})).error,'migration_checksum_mismatch');
 assert.equal(cliDiagnostic(new Error('installation_key_unavailable')).error,'installation_key_unavailable');
});
test('actual initialization CLI records run, action and failure stage without connecting or printing secrets',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'adi-cli-diagnostic-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const runId='00000000-0000-0000-0000-000000000001';
 const env={...process.env,ADI_DATABASE_URL:'postgres://fixture:synthetic-private-db-password@127.0.0.1:1/fixture',ADI_INSTALLATION_KEY_FILE:join(directory,'credential.key'),ADI_EMAIL_DOMAINS:'example.invalid',ADI_ADMIN_EMAIL:'synthetic-private@example.invalid',ADI_ADMIN_PASSWORD:'short',ADI_DEV_RUN_ID:runId};
 await assert.rejects(promisify(execFile)(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/cli.ts',import.meta.url)),'init'],{env}),error=>{
  assert.ok(error&&typeof error==='object'&&'stderr'in error&&'stdout'in error);
  const record=JSON.parse(String(error.stderr));assert.equal(record.event,'cli_failed');assert.equal(record.stage,'validate_administrator');assert.equal(record.action,'init');assert.equal(record.run_id,runId);assert.equal(record.error,'invalid_password');assert.ok(record.at);assert.ok(record.duration_ms>=0);
  assert.doesNotMatch(String(error.stdout)+String(error.stderr),/synthetic-private|postgres:\/\//);return true;
 });
});
