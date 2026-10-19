import {test} from 'node:test';import assert from 'node:assert/strict';import {testDatabase} from '../../../../packages/storage/test/helpers.js';import {createApi} from '../../src/app.js';
test('a prepared closed dataset refuses public login, registration and plugin reads before serving business data',async t=>{
  const db=await testDatabase(t);await db.migrate();await db.query('UPDATE data_identity SET collection_enabled=false');
  const app=createApi(undefined,{plugin:{db,signingKey:Buffer.alloc(32,7)}});t.after(()=>app.close());
  for(const url of ['/api/v1/me','/api/v1/registration/setup','/api/v1/plugin/me']){
    const reply=await app.inject({url});assert.equal(reply.statusCode,503,reply.body);assert.equal(reply.json().error.code,'collection_disabled');
  }
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:'test@example.org',password:'SyntheticPasswordOnly123!'}});assert.equal(login.statusCode,503,login.body);
});
