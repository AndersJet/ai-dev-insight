import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase, connectionString } from '../../../../packages/storage/test/helpers.js';
import { postgresFaultProxy } from '../../../../packages/storage/test/fixtures/pg-fault-proxy.js';
import { openDatabase } from '../../../../packages/storage/src/index.js';
import { createIdentityService } from '../../../../packages/domain/src/identity.js';
import { createApi } from '../../src/app.js';

function cookieHeader(setCookie: string | string[] | undefined) { return (Array.isArray(setCookie) ? setCookie : [setCookie ?? '']).map(value => value.split(';')[0]).join('; '); }
function csrf(cookie: string) { return /(?:^|; )adi_csrf=([^;]+)/.exec(cookie)?.[1] ?? ''; }
test('database network timeout returns a safe 503 and login works after recovery',{timeout:15000},async t=>{
  const baseline=await testDatabase(t);await baseline.migrate();const initial=await createIdentityService(baseline,{emailDomains:['example.invalid']}).bootstrap({email:'network@example.invalid',name:'网络故障验证'});
  const proxy=await postgresFaultProxy(connectionString);const db=openDatabase({connectionString:proxy.connectionString,schema:baseline.schema,maxConnections:1});await db.query('SELECT 1');
  const app=createApi(undefined,{identity:createIdentityService(db,{emailDomains:['example.invalid']})});
  try{
    proxy.setMode('drop-responses');const response=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:'network@example.invalid',password:initial.temporaryPassword}});
    assert.equal(response.statusCode,503);assert.equal(response.json().error.code,'database_io_timeout');assert.equal(response.headers['set-cookie'],undefined);assert.doesNotMatch(response.body,/postgres|adi_test|SELECT|Query read timeout/);
    proxy.setMode('healthy');assert.equal((await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{email:'network@example.invalid',password:initial.temporaryPassword}})).statusCode,200);
  }finally{await app.close();await proxy.close();await db.close();}
});
test('HTTP login uses secure cookies, requires first password change and validates CSRF on mutations', async t => {
  const db = await testDatabase(t); await db.migrate(); const identity = createIdentityService(db, { emailDomains: ['example.invalid'] });
  const initial = await identity.bootstrap({ email: 'http@example.invalid', name: 'HTTP验证' });
  const app = createApi(undefined, { identity, secureCookies: true, allowedOrigin: 'https://app.example.invalid' }); t.after(() => app.close());
  app.get('/api/v1/private-check', async () => ({ ok: true }));
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: 'http@example.invalid', password: initial.temporaryPassword } });
  assert.equal(login.statusCode, 200); assert.equal(login.json().data.must_change_password, true);
  const firstCookies = cookieHeader(login.headers['set-cookie']);
  assert.match(String(login.headers['set-cookie']), /HttpOnly/); assert.match(String(login.headers['set-cookie']), /Secure/);
  assert.equal((await app.inject({ url: '/api/v1/private-check', headers: { cookie: firstCookies } })).statusCode, 403);
  const changeRequest = { method: 'POST' as const, url: '/api/v1/auth/change-password', payload: { current_password: initial.temporaryPassword, new_password: 'http-new-strong-password' } };
  assert.equal((await app.inject({ ...changeRequest, headers: { cookie: firstCookies } })).statusCode, 403);
  const change = await app.inject({ ...changeRequest, headers: { cookie: firstCookies, 'x-csrf-token': csrf(firstCookies) } });
  assert.equal(change.statusCode, 200); assert.equal(change.json().data.must_change_password, false);
  const nextCookies = cookieHeader(change.headers['set-cookie']);
  assert.equal((await app.inject({ url: '/api/v1/me', headers: { cookie: firstCookies } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/v1/private-check', headers: { cookie: nextCookies } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: nextCookies, 'x-csrf-token': csrf(nextCookies) } })).statusCode, 204);
  assert.equal((await app.inject({ url: '/api/v1/me', headers: { cookie: nextCookies } })).statusCode, 401);
});
