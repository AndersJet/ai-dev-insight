import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {testDatabase} from '../../../../packages/storage/test/helpers.js';
import {createCleanupJournal} from '../../../../packages/storage/src/cleanup-journal.js';
import {createIdentityService} from '../../../../packages/domain/src/identity.js';
import {createRecoveryService} from '../../../../packages/domain/src/recovery.js';
import {createApi} from '../../src/app.js';
test('quarantine seals HTTP identity and login even for a previously authenticated superadmin',async t=>{
 const db=await testDatabase(t);await db.migrate();const identity=createIdentityService(db,{emailDomains:['example.invalid']});const seed=await identity.bootstrap({email:'restore-http@example.invalid',name:'隔离恢复验证'});const login=await identity.login('restore-http@example.invalid',seed.temporaryPassword),root=await identity.changePassword(login.token,seed.temporaryPassword,'restore-http-password');const app=createApi(undefined,{identity});t.after(()=>app.close());const headers={cookie:`adi_session=${root.token}`};assert.equal((await app.inject({url:'/api/v1/me',headers})).statusCode,200);
 const dataset=(await db.query<{dataset_id:string}>('SELECT dataset_id FROM data_identity')).rows[0]!.dataset_id;const directory=await mkdtemp(join(tmpdir(),'adi-recovery-http-'));t.after(()=>rm(directory,{recursive:true,force:true}));await createRecoveryService(db,createCleanupJournal(directory)).quarantine(dataset);await assert.rejects(db.assertNotRecovering(),{code:'recovery_quarantined'});
 const blocked=await app.inject({url:'/api/v1/me',headers});assert.equal(blocked.statusCode,503);assert.equal(blocked.json().error.code,'recovery_quarantined');const relogin=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:'restore-http@example.invalid',password:'restore-http-password'}});assert.equal(relogin.statusCode,503);assert.doesNotMatch(relogin.body,/token_hash|password_hash|temporaryPassword/);
});
