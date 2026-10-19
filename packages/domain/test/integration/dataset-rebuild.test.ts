import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readdir,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {testDatabase,connectionString} from '../../../storage/test/helpers.js';
import {migrateDatabase} from '../../../storage/src/migrate.js';
import {createIdentityService} from '../../src/identity.js';
import {createInstallationService} from '../../src/installations.js';
import {createDatasetRebuildService,previewDatasetRebuild} from '../../src/dataset-rebuild.js';

test('reviewed independent dataset transfer preserves stable management identity and credentials, excludes usage, and stays closed',async t=>{
  const source=await testDatabase(t),target=await testDatabase(t);await source.migrate();await target.migrate();
  const identity=createIdentityService(source,{emailDomains:['example.org']});
  await identity.syncConfigurationAdministrator({email:'rebuild@example.org',name:'合成管理员',password:'rebuild-synthetic-password'});
  const login=await identity.login('rebuild@example.org','rebuild-synthetic-password'),user=login.user.user_id,at=new Date();
  await source.query('UPDATE users SET registered_at=$2,adopted_at=$2 WHERE id=$1',[user,at]);
  const installation=createInstallationService(source,identity,{encryptionKey:Buffer.alloc(32,17)}),issued=await installation.credential(login.token);
  await source.query('UPDATE installations SET last_seen=$1',[at]);
  const department=randomUUID();await source.query("INSERT INTO departments(id,name) VALUES($1,'保留部门')",[department]);
  await source.query('INSERT INTO membership_periods(user_id,department_id,valid_from) VALUES($1,$2,$3)',[user,department,at]);
  await source.query("INSERT INTO repository_allowlist(kind,value,value_hash,created_by) VALUES('host','git.example.invalid',$1,$2)",[createHash('sha256').update('git.example.invalid').digest('hex'),user]);
  await source.query("INSERT INTO plugin_account_credentials(user_id,token_hash,credential_ciphertext) VALUES($1,$2,'synthetic-encrypted-token')",[user,'a'.repeat(64)]);
  await source.ensurePartitions(new Date(at.getTime()-86400000),new Date(at.getTime()+86400000));
  await source.ingest({schema_version:2,installation_id:issued.installation.id,client_event_id:randomUUID(),occurred_at:at.toISOString(),event_type:'UserPromptSubmit',source_session_id:'old-trial',payload:{prompt:'DO_NOT_TRANSFER_OLD_USAGE'}},{admissionEpoch:1,receivedAt:at});
  await source.query('UPDATE data_identity SET collection_enabled=false');await target.query('UPDATE data_identity SET collection_enabled=false');
  const baselineDate=new Date(Math.floor((at.getTime()+28800000)/86400000)*86400000+86400000).toISOString().slice(0,10);
  const rebuild=createDatasetRebuildService(source,target,{baselineDate,clock:()=>new Date(baselineDate+'T12:00:00+08:00')});
  const plan=await rebuild.plan();assert.equal(plan.table_counts.users,1);assert.equal(plan.table_counts.installations,1);assert.notEqual(plan.source_dataset,plan.target_dataset);
  assert.doesNotMatch(JSON.stringify(plan),/DO_NOT_TRANSFER_OLD_USAGE|synthetic-encrypted-token|rebuild-synthetic-password/);
  assert.ok(plan.table_columns.credentials!.includes('password_hash'),'reviewed manifest lists field names without their contents');
  const review={source_writers_stopped:true,network_isolated:true,backup_and_journal_verified:true,credential_key_verified:true};
  const imported=await rebuild.execute(plan,review);assert.equal(imported.collection_enabled,false);
  const status=await rebuild.status();assert.equal(status.usage_rows,0);assert.equal(status.registered_users,1);assert.equal(status.adopted_users,0);assert.equal(status.table_counts.repository_allowlist,1);assert.equal(status.table_counts.plugin_account_credentials,1);
  assert.equal((await rebuild.execute(plan,review)).registered_users,1);
  const verified=await rebuild.verify(plan);assert.equal(verified.usage_rows,0);assert.match(verified.validation_digest,/^[a-f0-9]{64}$/);
  await assert.rejects(rebuild.open(plan.digest,{validation_completed:true,validation_digest:'b'.repeat(64)}),{code:'rebuild_validation_changed'});
  const recovery=randomUUID();await target.query("INSERT INTO recovery_runs(id,dataset_id,state) VALUES($1,$2,'quarantined')",[recovery,plan.target_dataset]);await target.query('UPDATE data_identity SET recovery_id=$1',[recovery]);
  await assert.rejects(rebuild.open(plan.digest,{validation_completed:true,validation_digest:verified.validation_digest}),{code:'recovery_quarantined'});
  assert.equal((await rebuild.status()).collection_enabled,false);
  assert.equal((await target.query('SELECT 1 FROM dataset_rebuild_state WHERE opened_at IS NOT NULL')).rowCount,0);
  await target.query('UPDATE data_identity SET recovery_id=NULL');await target.query('DELETE FROM recovery_runs WHERE id=$1',[recovery]);
  const opened=await rebuild.open(plan.digest,{validation_completed:true,validation_digest:verified.validation_digest});assert.equal(opened.collection_enabled,true);
  const targetIdentity=createIdentityService(target,{emailDomains:['example.org']});
  assert.equal(await targetIdentity.resolve(login.token),null);
  const next=await targetIdentity.login('rebuild@example.org','rebuild-synthetic-password');assert.equal(next.user.user_id,user);
  const preserved=await createInstallationService(target,targetIdentity,{encryptionKey:Buffer.alloc(32,17)}).credential(next.token);
  assert.equal(preserved.token,issued.token);assert.equal(preserved.installation.last_seen,null);
});

test('old source ledger is read without upgrading it and minimal ordering survives without its old repository facts',async t=>{
  const source=await testDatabase(t),target=await testDatabase(t),directory=await mkdtemp(join(tmpdir(),'adi-rebuild-old-ledger-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const migrations=fileURLToPath(new URL('../../../storage/migrations/',import.meta.url));
  for(const name of await readdir(migrations))if(name.endsWith('.sql')&&name<'202610090001')await copyFile(join(migrations,name),join(directory,name));
  await migrateDatabase({connectionString},source.schema,directory);await target.migrate();await target.query('UPDATE data_identity SET collection_enabled=false');
  const user=randomUUID(),collector=randomUUID(),project=randomUUID(),id=randomUUID(),key=createHash('sha256').update('synthetic-old-workspace').digest('hex');
  await source.query("INSERT INTO users(id,email_key,display_name,registered_at,adopted_at) VALUES($1,'old-ledger@example.org','保留旧账号',clock_timestamp(),clock_timestamp())",[user]);
  await source.query('INSERT INTO project_streams(id,user_id,collector_id,workspace_key,latest_sequence,confirmed_sequence) VALUES($1,$2,$3,$4,$5,$5)',[project,user,collector,key,'9007199254740993']);
  await source.query(`INSERT INTO project_observations(user_id,collector_id,id,sequence,project_id,observed_at,received_at,source_event_id,source_event_at,cleanup_generation,payload_hash,state,evidence)
    VALUES($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp(),$6,clock_timestamp(),0,$7,'repository',$8)`,[user,collector,id,'9007199254740993',project,randomUUID(),'c'.repeat(64),{workspace:'/synthetic/old',platform:'macos',git_root:'/synthetic/old',remotes:[{name:'origin',direction:'fetch',address:'https://DO_NOT_COPY.invalid/old.git'}]}]);
  const ledger=(await source.query('SELECT name FROM pgmigrations ORDER BY id')).rows;
  await assert.rejects(source.migrate(),/independent_clean_dataset_required/);
  assert.equal((await source.query("SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='data_identity' AND column_name='collection_enabled'")).rowCount,0,'a populated old source cannot be upgraded in place and the rejected migration rolls back');
  const preview=await previewDatasetRebuild(source);assert.equal(preview.excluded_counts.project_observations,1);assert.equal(preview.source_modified,false);
  const rebuild=createDatasetRebuildService(source,target,{baselineDate:'2026-10-10'}),plan=await rebuild.plan();
  await rebuild.execute(plan,{source_writers_stopped:true,network_isolated:true,backup_and_journal_verified:true,credential_key_verified:true});
  assert.equal((await rebuild.verify(plan)).usage_rows,0);
  assert.deepEqual((await source.query('SELECT name FROM pgmigrations ORDER BY id')).rows,ledger,'reading and transferring an old source must never apply new migrations there');
  const stream=(await target.query<{barrier:string}>('SELECT barrier_sequence::text AS barrier FROM project_streams WHERE id=$1',[project])).rows[0]!;assert.equal(stream.barrier,'9007199254740993');
  const restored=(await target.query<{sequence:string;cleared:boolean;fact_id:string|null}>('SELECT sequence::text,cleared,fact_id FROM project_observation_keys WHERE observation_id=$1',[id])).rows[0]!;
  assert.equal(restored.sequence,'9007199254740993');assert.equal(restored.cleared,true);assert.equal(restored.fact_id,null);
  assert.equal((await target.query('SELECT 1 FROM project_observations')).rowCount,0);
});


test('dataset rebuild excludes both private snapshot tables and rejects dirty target copies before planning, verification and opening',async t=>{
  const source=await testDatabase(t),target=await testDatabase(t);await source.migrate();await target.migrate();
  const user=randomUUID();await source.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'snapshot-rebuild@example.invalid','合成快照保留身份')",[user]);
  await target.query('UPDATE data_identity SET collection_enabled=false');
  const putHeader=async(db:typeof source)=>db.query("INSERT INTO session_list_snapshots(config_key,as_of,expires_at,safety_fence,owner_entries) VALUES('synthetic-rebuild',clock_timestamp(),clock_timestamp()+interval '1 minute','{}','{}')");
  const putEntry=async(db:typeof source)=>db.query("INSERT INTO session_list_snapshot_entries(user_id,owner_revision,cleanup_generation,payload) VALUES($1,'synthetic-rebuild',0,$2)",[user,{private_prompt:'DO_NOT_TRANSFER_SNAPSHOT_BODY'}]);
  await putHeader(source);await putEntry(source);
  const preview=await previewDatasetRebuild(source);assert.equal(preview.excluded_counts.session_list_snapshots,1);assert.equal(preview.excluded_counts.session_list_snapshot_entries,1);assert.doesNotMatch(JSON.stringify(preview),/DO_NOT_TRANSFER_SNAPSHOT_BODY/);
  const rebuild=createDatasetRebuildService(source,target,{baselineDate:'2026-10-10'});
  await putHeader(target);assert.equal((await rebuild.status()).usage_rows,1);
  await assert.rejects(rebuild.plan(),{code:'target_not_clean'});await target.query('DELETE FROM session_list_snapshots');
  const plan=await rebuild.plan();await rebuild.execute(plan,{source_writers_stopped:true,network_isolated:true,backup_and_journal_verified:true,credential_key_verified:true});
  assert.equal((await rebuild.status()).usage_rows,0);
  const verified=await rebuild.verify(plan);
  for(const [table,put]of [['session_list_snapshots',putHeader],['session_list_snapshot_entries',putEntry]] as const){
    await put(target);assert.equal((await rebuild.status()).usage_rows,1,table+' contributes private usage');
    await assert.rejects(rebuild.verify(plan),{code:'rebuild_validation_failed'});
    await assert.rejects(rebuild.open(plan.digest,{validation_completed:true,validation_digest:verified.validation_digest}),{code:'rebuild_validation_changed'});
    assert.equal((await rebuild.status()).collection_enabled,false);assert.equal((await target.query('SELECT 1 FROM dataset_rebuild_state WHERE opened_at IS NOT NULL')).rowCount,0);
    await target.query('DELETE FROM '+table);
  }
  assert.equal((await rebuild.verify(plan)).usage_rows,0);
  assert.equal((await source.query('SELECT count(*)::int AS n FROM session_list_snapshots')).rows[0]!.n,1);assert.equal((await source.query('SELECT count(*)::int AS n FROM session_list_snapshot_entries')).rows[0]!.n,1,'source private copies remain untouched');
});

test('独立数据集保留插件发行物和当前发布指针，发行配置不作为使用事实清理',async t=>{
 const source=await testDatabase(t),target=await testDatabase(t);await source.migrate();await target.migrate();const identity=createIdentityService(source,{emailDomains:['example.org']});
 await identity.syncConfigurationAdministrator({email:'synthetic.release-rebuild@example.org',name:'合成发行管理员',password:'synthetic-release-rebuild-password'});const login=await identity.login('synthetic.release-rebuild@example.org','synthetic-release-rebuild-password');
 const {createOrganizationService}=await import('../../src/organization.js');const {createRegistrationService}=await import('../../src/registration.js');const department=await createOrganizationService(source,identity).createDepartment(login.token,'发行部门');await createRegistrationService(source,identity).activate(login.token,{department_id:department.id});
 const {createPluginReleaseService}=await import('../../src/plugin-releases.js');const releases=createPluginReleaseService(source,identity),r=await releases.upload(login.token,{version:'1.0.0',build_id:'f'.repeat(64),package:Buffer.from('synthetic release package')});await releases.setPilot(login.token,r.id,{build_id:r.build_id,user_ids:[login.user.user_id]});await releases.publish(login.token,r.id,r.build_id);
 await source.query('UPDATE data_identity SET collection_enabled=false');await target.query('UPDATE data_identity SET collection_enabled=false');
 const rebuild=createDatasetRebuildService(source,target,{baselineDate:'2026-10-13'}),plan=await rebuild.plan();assert.equal(plan.table_counts.plugin_releases,1);
 await rebuild.execute(plan,{source_writers_stopped:true,network_isolated:true,backup_and_journal_verified:true,credential_key_verified:true});await rebuild.verify(plan);
 const preserved=createPluginReleaseService(target,createIdentityService(target,{emailDomains:['example.org']}));assert.equal((await preserved.current())?.build_id,r.build_id);assert.equal((await preserved.download(r.build_id)).package.toString(),'synthetic release package');
});
