import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {stopUsageFixture} from '../../../../packages/domain/test/helpers/stop-usage.js';
import {createApi} from '../../src/app.js';

test('session API exposes full session quantities and pending conflicts without bypassing authentication or owner boundaries',async t=>{
 const f=await stopUsageFixture(t);await f.run();const api=createApi(undefined,{identity:f.identity,sessions:f.reader});t.after(()=>api.close());const url=`/api/v1/sessions/${f.session}/official-usage`;
 assert.equal((await api.inject(url)).statusCode,401);const headers={cookie:`adi_session=${f.login.token}`};const ready=await api.inject({url,headers});assert.equal(ready.statusCode,200,ready.body);assert.equal(ready.json().data.groups[0]?.tokens,'176004');assert.equal(ready.json().data.session_query?.state,'ready');assert.equal(ready.json().data.groups[0].token_breakdown.input.tokens,'175994');assert.equal(ready.json().data.groups[0].token_breakdown.output.tokens,'10');assert.equal(ready.json().data.groups[0].token_breakdown.cache_read.tokens,'0');assert.equal(ready.json().data.groups[0].calls,'4');assert.equal(ready.headers['cache-control'],'no-store');
 const outsider=randomUUID();await f.db.query("INSERT INTO users(id,email_key,display_name) VALUES($1,'stop-outsider@example.invalid','外部查看者')",[outsider]);const issued=await f.identity.resetPassword(f.login.token,outsider,1),temp=await f.identity.login('stop-outsider@example.invalid',issued.temporaryPassword),own=await f.identity.changePassword(temp.token,issued.temporaryPassword,'stop-outsider-synthetic-password');
 assert.equal((await api.inject({url,headers:{cookie:`adi_session=${own.token}`}})).statusCode,404);
 f.control.ids=['bill-a','bill-b'];await f.run();const pending=await api.inject({url,headers});assert.equal(pending.statusCode,200,pending.body);assert.equal(pending.json().data.session_query?.state,'pending');assert.deepEqual(pending.json().data.groups,[]);assert.ok(!pending.body.includes('synthetic-token'));
});

test('session-query quantities keep a missing cache value unknown without suppressing reported input or output',async t=>{
 const f=await stopUsageFixture(t);await f.run();
 await f.db.query("UPDATE session_usage_queries SET result=jsonb_set(result,'{bills,0,items,0,usage,cache_read_input_tokens}','null'::jsonb) WHERE session_id=$1",[f.session]);
 const api=createApi(undefined,{identity:f.identity,sessions:f.reader});t.after(()=>api.close());
 const reply=await api.inject({url:`/api/v1/sessions/${f.session}/official-usage`,headers:{cookie:`adi_session=${f.login.token}`}});assert.equal(reply.statusCode,200,reply.body);
 const group=reply.json().data.groups[0];assert.equal(group.tokens,'176004');assert.equal(group.token_breakdown.input.tokens,'175994');assert.equal(group.token_breakdown.output.tokens,'10');assert.deepEqual(group.token_breakdown.cache_read,{tokens:null,known_tokens:'0',missing_token_records:1});
});
