import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {testDatabase} from './helpers.js';
test('old queued Hook JSON is refused at the durable boundary before it can create any usage fact',async t=>{
  const db=await testDatabase(t);await db.migrate();const now=new Date(),user=randomUUID(),installation=randomUUID();await db.ensurePartitions(new Date(now.getTime()-86400000),new Date(now.getTime()+86400000));
  await db.query('INSERT INTO users(id,email_key,display_name,registered_at) VALUES($1,$2,$3,$4)',[user,'legacy.synthetic@example.org','合成旧协议',now]);
  await db.query('INSERT INTO installations(id,user_id,token_hash,label) VALUES($1,$2,$3,$4)',[installation,user,'a'.repeat(64),'合成采集']);
  const event={schema_version:1,installation_id:installation,client_event_id:randomUUID(),occurred_at:now.toISOString(),event_type:'UserPromptSubmit',source_session_id:'synthetic-retired-queue',payload:{prompt:'synthetic only'}};
  assert.deepEqual(await db.ingestJson(JSON.stringify(event),{admissionEpoch:1,receivedAt:now}),{outcome:'rejected',reason:'unsupported_protocol'});
  assert.equal((await db.ingestJson(JSON.stringify({...event,schema_version:2}),{admissionEpoch:1,receivedAt:now})).outcome,'committed');
});
