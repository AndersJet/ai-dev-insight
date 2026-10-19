import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createTraeUsageProvider } from '../../src/usage-provider.js';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { testDatabase } from '../../../storage/test/helpers.js';
import { createUsageSnapshotStore, type UsageDraft } from '../../src/usage-snapshots.js';
import type { ProviderUsageItem, ProviderUsagePage } from '../../src/usage-provider.js';
const clock = () => new Date('2026-09-24T12:00:00Z');
const date = '2026-09-23';
async function fixture(t: TestContext, options: { leaseMs?: number } = {}) {
  const db = await testDatabase(t); await db.migrate(); const userId = randomUUID();
  await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)', [userId,'scope@example.invalid','官方范围夹具']);
  const store = createUsageSnapshotStore(db, { providerAccount: 'synthetic-provider', clock, pageSize: 1, ...options });
  return { db, userId, store };
}
function item(id: string, tokens: string): ProviderUsageItem {
  return { billing_session_id: id, provider_user_id: 'provider-person', email: 'scope@example.invalid', start_time: String(Date.parse('2026-09-23T01:00:00Z') / 1000), client: 'ide', scene: 'Chat', model_name: 'synthetic-model', model_type: 'Chat', model_source: 'Trae', consumption_source: 'pay_go', model_call_count: '1', departments: [], usage: { prompt_tokens: tokens, completion_tokens: '0', total_tokens: tokens, cache_creation_input_tokens: '0', cache_read_input_tokens: '0' }, amount: '0.100000', amount_reason: null, currency: 'CNY', quality: [], token_basis: 'provider_reported' };
}
function page(draft: UsageDraft, number: number, items: ProviderUsageItem[], total: number, part = 0): ProviderUsagePage {
  return { items, pagination: { page: number, page_size: 1, total, total_pages: Math.max(1,total) }, request_id: `synthetic-page-${number}`, observed_at: clock().toISOString(), response_hash: createHash('sha256').update(JSON.stringify(items)).digest('hex'), query: { endpoint: 'user_usage_detail', parameters: { ...draft.parts[part]!.query, page: number } } };
}

test('only a complete fixed-day snapshot replaces the published set, without oscillation, accumulation or suppressing downward revisions', async t => {
  const { store, userId } = await fixture(t);
  const first = await store.begin(userId, date);
  assert.equal(new Date(first.parts[0]!.query.start_time * 1000).toISOString(), '2026-09-22T16:00:00.000Z');
  assert.equal(new Date(first.parts[0]!.query.end_time * 1000).toISOString(), '2026-09-23T15:59:59.000Z');
  await store.stage(first, 0, page(first,1,[item('A','100')],1)); await store.publish(first);
  const second = await store.begin(userId,date); await store.stage(second,0,page(second,1,[item('A','100')],2));
  await assert.rejects(store.publish(second), { code: 'usage_scope_incomplete' });
  assert.deepEqual((await store.readCurrent(userId,date)).items.map(row=>row.billing_session_id),['A']);
  await store.stage(second,0,page(second,2,[item('B','200')],2)); const published=await store.publish(second); assert.equal(published.changed,true);
  assert.deepEqual((await store.readCurrent(userId,date)).items.map(row=>row.billing_session_id),['A','B']);
  const repeated=await store.begin(userId,date);
  await store.stage(repeated,0,page(repeated,1,[item('B','200')],2)); await store.stage(repeated,0,page(repeated,2,[item('A','100')],2));
  const same=await store.publish(repeated);assert.equal(same.changed,false);assert.equal(same.revision,published.revision);
  const corrected=await store.begin(userId,date);
  await store.stage(corrected,0,page(corrected,1,[item('A','90')],2)); await store.stage(corrected,0,page(corrected,2,[item('B','180')],2));await store.publish(corrected);
  assert.deepEqual((await store.readCurrent(userId,date)).items.map(row=>row.usage.total_tokens),['90','180']);
});

test('replayed pages are idempotent and a changed page cannot publish over the last complete snapshot', async t => {
  const {store,userId}=await fixture(t);const prior=await store.begin(userId,date);await store.stage(prior,0,page(prior,1,[item('A','100')],1));await store.publish(prior);
  const draft=await store.begin(userId,date);await store.stage(draft,0,page(draft,1,[item('A','100')],2));
  const replay={...page(draft,1,[item('A','100')],2),request_id:'another-transport-id',response_hash:'f'.repeat(64)};
  assert.equal((await store.stage(draft,0,replay)).staged_rows,1);
  await assert.rejects(store.stage(draft,0,page(draft,1,[item('A','101')],2)),{code:'usage_page_changed'});
  await assert.rejects(store.publish(draft),{code:'stale_usage_lease'});
  assert.deepEqual((await store.readCurrent(userId,date)).items.map(row=>row.usage.total_tokens),['100']);
});

test('a cleanup fences old drafts and the replacement queries disjoint seconds without reviving a cleared microsecond',async t=>{
  const {store,userId,db}=await fixture(t);const prior=await store.begin(userId,date);await store.stage(prior,0,page(prior,1,[item('A','100')],1));await store.publish(prior);
  const stale=await store.begin(userId,date);
  await db.transaction(async client=>{
    await client.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1',[userId]);
    await client.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,1)',[userId,'2026-09-23T01:00:00.000001Z','2026-09-23T01:00:00.000002Z']);
  });
  await assert.rejects(store.stage(stale,0,page(stale,1,[item('A','100')],1)),{code:'usage_owner_changed'});
  assert.equal((await store.readCurrent(userId,date)).status,'invalidated');
  const replacement=await store.begin(userId,date);assert.equal(replacement.parts.length,2);
  assert.equal(new Date(replacement.parts[0]!.query.end_time*1000).toISOString(),'2026-09-23T00:59:59.000Z');
  assert.equal(new Date(replacement.parts[1]!.query.start_time*1000).toISOString(),'2026-09-23T01:00:01.000Z');
  await store.stage(replacement,0,page(replacement,1,[],0));
  await store.stage(replacement,1,page(replacement,1,[{...item('remaining','50'),start_time:String(Date.parse('2026-09-23T01:00:01Z')/1000)}],1,1));
  await store.publish(replacement);assert.deepEqual((await store.readCurrent(userId,date)).items.map(row=>row.billing_session_id),['remaining']);
  const observed=await store.readCurrent(userId,date);assert.equal(observed.coverage?.complete_business_day,false);assert.equal(observed.coverage?.queried_seconds,86399);assert.deepEqual(observed.coverage?.windows.map(window=>[new Date(window.from_second*1000).toISOString(),new Date(window.to_second*1000).toISOString()]),[['2026-09-22T16:00:00.000Z','2026-09-23T00:59:59.000Z'],['2026-09-23T01:00:01.000Z','2026-09-23T15:59:59.000Z']]);
  await db.transaction(async client=>{await client.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1',[userId]);await client.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,2)',[userId,'2026-09-20Z','2026-09-21Z']);});
  assert.equal((await store.readCurrent(userId,date)).status,'ready','an unrelated cleanup must not permanently hide this day');
});

test('provider identity bindings survive email correction but cannot bind the same provider person to another local user',async t=>{
  const {store,userId,db}=await fixture(t);const draft=await store.begin(userId,date);await store.stage(draft,0,page(draft,1,[item('A','100')],1));await store.publish(draft);
  await db.query('UPDATE users SET email_key=$2,version=version+1 WHERE id=$1',[userId,'corrected@example.invalid']);
  const corrected=await store.begin(userId,date);assert.deepEqual(corrected.parts[0]!.query.user_ids,['provider-person']);assert.equal(corrected.parts[0]!.query.emails,undefined);
  await store.stage(corrected,0,page(corrected,1,[item('A','100')],1));await store.publish(corrected);
  const other=randomUUID();await db.query('INSERT INTO users(id,email_key,display_name) VALUES($1,$2,$3)',[other,'other@example.invalid','另一个账号']);
  const conflict=await store.begin(other,date);await store.stage(conflict,0,page(conflict,1,[{...item('conflict','99'),email:'other@example.invalid'}],1));
  await assert.rejects(store.publish(conflict),{code:'usage_identity_conflict'});
  assert.equal((await store.readCurrent(other,date)).status,'missing');
});

test('a lease expiring during publication rolls back the pointer and a new draft can replace the abandoned attempt',async t=>{
  const {store,userId,db}=await fixture(t);const draft=await store.begin(userId,date);
  // Slow setup must not consume the lease before we reach the publication seam.
  await new Promise(resolve=>setTimeout(resolve,300));await store.stage(draft,0,page(draft,1,[item('A','100')],1));
  await db.query('CREATE SEQUENCE publication_expiration_hits');
  await db.query(`CREATE FUNCTION expire_during_usage_publish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    PERFORM nextval('publication_expiration_hits');
    UPDATE usage_snapshot_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=NEW.verified_run_id;
    RETURN NEW;
  END $$`);
  await db.query('CREATE TRIGGER expire_during_usage_publish BEFORE UPDATE OF published_run_id ON usage_scopes FOR EACH ROW EXECUTE FUNCTION expire_during_usage_publish()');
  await assert.rejects(store.publish(draft),{code:'stale_usage_lease'});
  // Sequence changes survive rollback, proving this reached the pointer update
  // rather than merely failing the initial stale-lease check.
  assert.deepEqual((await db.query('SELECT last_value::int AS hits,is_called FROM publication_expiration_hits')).rows[0],{hits:1,is_called:true});
  assert.deepEqual((await db.query('SELECT published_run_id,active_run_id,revision FROM usage_scopes WHERE id=$1',[draft.scopeId])).rows[0],{published_run_id:null,active_run_id:draft.runId,revision:0});
  assert.equal((await db.query('SELECT state FROM usage_snapshot_runs WHERE id=$1',[draft.runId])).rows[0]!.state,'building');
  assert.equal((await store.readCurrent(userId,date)).status,'missing');
  await db.query('DROP TRIGGER expire_during_usage_publish ON usage_scopes');
  // The injected expiry was also rolled back. Advance only this synthetic
  // abandoned draft to expiry before testing a new owner taking over.
  await db.query("UPDATE usage_snapshot_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[draft.runId]);
  const recovered=await store.begin(userId,date);await store.stage(recovered,0,page(recovered,1,[item('A','100')],1));await store.publish(recovered);
  assert.equal((await db.query('SELECT state FROM usage_snapshot_runs WHERE id=$1',[draft.runId])).rows[0]!.state,'abandoned');
  assert.equal((await store.readCurrent(userId,date)).total,1);
});

test('duplicate anonymous CUE observations survive and a changed published revision cannot silently shift a reader page',async t=>{
  const {store,userId}=await fixture(t);const draft=await store.begin(userId,date);const cue={...item('','5'),scene:'CUE',consumption_source:'basic',amount:'0.000000'};
  await store.stage(draft,0,page(draft,1,[cue],2));await store.stage(draft,0,page(draft,2,[cue],2));await store.publish(draft);
  const first=await store.readCurrent(userId,date,{limit:1});assert.equal(first.total,2);assert.equal(first.next_offset,1);
  const second=await store.readCurrent(userId,date,{limit:1,offset:1,revision:first.revision});assert.equal(second.items[0]?.billing_session_id,'');
  const next=await store.begin(userId,date);await store.stage(next,0,page(next,1,[item('new','20')],1));await store.publish(next);
  await assert.rejects(store.readCurrent(userId,date,{limit:1,offset:1,revision:first.revision}),{code:'content_changed'});
});

test('aborting a failed upstream attempt preserves the published data and transient row cleanup does not retain identical copies',async t=>{
  const {store,userId}=await fixture(t);const first=await store.begin(userId,date);await store.stage(first,0,page(first,1,[item('A','100')],1));await store.publish(first);
  const same=await store.begin(userId,date);await store.stage(same,0,page(same,1,[item('A','100')],1));await store.publish(same);
  const failed=await store.begin(userId,date);await store.stage(failed,0,page(failed,1,[item('A','100')],2));
  assert.equal(await store.abort(failed,'provider_timeout'),true);
  await assert.rejects(store.publish(failed),{code:'stale_usage_lease'});
  assert.equal(await store.pruneTransient(1),1);assert.equal(await store.pruneTransient(1),1);assert.equal(await store.pruneTransient(1),0);
  assert.deepEqual((await store.readCurrent(userId,date)).items.map(row=>row.billing_session_id),['A']);
  const retry=await store.begin(userId,date);assert.equal(await store.abort(retry,'cancelled'),true);
});

test('a query for another period or person cannot overwrite a complete scope and concurrent begins cannot own it twice',async t=>{
  const {store,userId}=await fixture(t);const first=await store.begin(userId,date);await store.stage(first,0,page(first,1,[item('A','100')],1));await store.publish(first);
  const draft=await store.begin(userId,date);await assert.rejects(store.begin(userId,date),{code:'usage_scope_busy'});
  const otherWindow=page(draft,1,[item('A','100')],1);if(!('start_time' in otherWindow.query.parameters))throw new Error('fixture shape');otherWindow.query.parameters.start_time++;
  await assert.rejects(store.stage(draft,0,otherWindow),{code:'usage_scope_mismatch'});
  const otherPerson=await store.begin(userId,date);await assert.rejects(store.stage(otherPerson,0,page(otherPerson,1,[{...item('foreign','999'),provider_user_id:'someone-else'}],1)),{code:'usage_identity_or_time_mismatch'});
  assert.deepEqual((await store.readCurrent(userId,date)).items.map(row=>row.usage.total_tokens),['100']);
});


test('real HTTP pages can be staged in PostgreSQL, and a failed second page leaves the previous complete result intact',async t=>{
  const {store,userId}=await fixture(t);const first=await store.begin(userId,date);await store.stage(first,0,page(first,1,[item('A','100')],1));await store.publish(first);
  let failSecond=true;
  const providerRows=['A','B'].map((id,index)=>({session_id:id,user_id:'provider-person',email:'scope@example.invalid',start_time:Date.parse('2026-09-23T01:00:00Z')/1000,client:'ide',scene:'Chat',model_name:'synthetic-model',model_type:'Chat',model_source:'Trae',consumption_source:'pay_go',model_call_count:1,departments:[],usage:{prompt_tokens:100*(index+1),completion_tokens:0,total_tokens:100*(index+1),cache_creation_input_tokens:0,cache_read_input_tokens:0},total_cost:'0.100000',total_cost_currency:'CNY'}));
  const upstream=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=JSON.parse(Buffer.concat(chunks).toString());
    if(req.url?.endsWith('/auth/token')){res.end(JSON.stringify({code:0,data:{access_token:'synthetic-token',expire:7200}}));return;}
    if(body.page===2&&failSecond){res.writeHead(503);res.end();return;}
    res.end(JSON.stringify({code:0,data:{items:[providerRows[body.page-1]],pagination:{page:body.page,page_size:1,total:2,total_pages:2}}}));
  });upstream.listen(0,'127.0.0.1');await once(upstream,'listening');t.after(()=>{upstream.closeAllConnections();upstream.close();});
  const provider=createTraeUsageProvider({baseUrl:`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,appId:'synthetic',appSecret:'synthetic-secret'});
  const failed=await store.begin(userId,date);await store.stage(failed,0,await provider.getMemberUsage(failed.parts[0]!.query));
  await assert.rejects(provider.getMemberUsage({...failed.parts[0]!.query,page:2}),{code:'provider_unavailable'});await store.abort(failed,'provider_unavailable');
  assert.deepEqual((await store.readCurrent(userId,date)).items.map(row=>row.billing_session_id),['A']);
  failSecond=false;const recovered=await store.begin(userId,date);
  for(const pageNumber of [1,2])await store.stage(recovered,0,await provider.getMemberUsage({...recovered.parts[0]!.query,page:pageNumber}));
  await store.publish(recovered);assert.deepEqual((await store.readCurrent(userId,date)).items.map(row=>row.billing_session_id),['A','B']);
});

test('identical quantities from changed query intervals receive new provenance instead of reusing an older wider window',async t=>{
 const {store,userId,db}=await fixture(t);const first=await store.begin(userId,date);await store.stage(first,0,page(first,1,[item('A','100')],1));await store.publish(first);
 await db.transaction(async client=>{await client.query('UPDATE users SET cleanup_generation=cleanup_generation+1 WHERE id=$1',[userId]);await client.query('INSERT INTO cleanup_tombstones(user_id,from_at,to_at,generation) VALUES($1,$2,$3,1)',[userId,'2026-09-23T05:00:00Z','2026-09-23T06:00:00Z']);});
 const narrower=await store.begin(userId,date);assert.equal(narrower.parts.length,2);await store.stage(narrower,0,page(narrower,1,[item('A','100')],1));await store.stage(narrower,1,page(narrower,1,[],0,1));
 assert.equal((await store.publish(narrower)).changed,true);assert.equal((await store.readCurrent(userId,date)).run_id,narrower.runId);
});
