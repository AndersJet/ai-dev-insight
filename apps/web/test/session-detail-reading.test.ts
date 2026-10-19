import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { effectScope, ref, unref } from 'vue';
import type { SessionDetailDto, SessionTurnsDto, SessionFragmentsDto, SessionFragmentDto } from '@adi/contracts';
import { useSessionDetailReading } from '../src/composables/session-detail.js';
import { ApiFailure } from '../src/api/http.js';

const period = { from: '2026-09-22T16:00:00Z', to: '2026-09-23T16:00:00Z' };
function detail(id: string, owner = 'owner-a'): SessionDetailDto {
  return { id, user_id: owner, name: id, email: 'synthetic@example.invalid', source_session_id: id,
    first_at: period.from, last_at: period.to, prompt_turns: 2, period, partial_history: false,
    events: 4, tool_events: 0, status: 'completed', projection_ready: true, computed_at: period.to, quality: [],
    content_estimate: { source: 'trae_personal_hooks', kind: 'observed_content', metric_version: 'content-heuristic-v1', tokens: null,
      components: { prompt: null, tool_input: null, tool_output: null, assistant: null }, sessions: 1, pending_sessions: 0, as_of: null, reason: 'no_observations' } };
}
function turns(index = 1, snapshot = 'snapshot-a', next: string | null = 'turn-next', version = 'a'.repeat(64)): SessionTurnsDto {
  return { period, items: [{ turn_index: index, first_at: period.from, last_at: period.to, events: 2, prompt_preview: 'synthetic' }],
    snapshot, snapshot_version: version, projection_ready: true, has_more: next !== null, next_cursor: next };
}
function fragments(key = 'trace', next: string | null = 'fragment-next'): SessionFragmentsDto {
  const event: SessionFragmentDto = { event_id: key, occurred_at: period.from, kind: 'UserPromptSubmit', timestamp_source: 'client_observed',
    turn_index: 1, step_id: null, tool_name: null, status: null, duration_ms: null, input_ref: null, pre_ref: null, post_ref: null, stop: null };
  return { period, items: [event], projection_ready: true, has_more: next !== null, next_cursor: next };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
type Reader = NonNullable<Parameters<typeof useSessionDetailReading>[2]>;
function mount(t: TestContext, overrides: Partial<Reader> = {}) {
  const id = ref('session-a'), owner = ref('owner-a');
  const reader: Reader = { detail: async id => ({ data: detail(id) }), turns: async () => ({ data: turns() }), fragments: async () => ({ data: fragments() }), ...overrides };
  const scope = effectScope(); t.after(() => scope.stop());
  const reading = scope.run(() => useSessionDetailReading(id, owner, reader))!;
  return { id, owner, reading, scope };
}

for (const outcome of ['success', 'failure'] as const) {
  test(`late turn-page ${outcome} from a previous session cannot change the new session or its loading state`, async t => {
    const oldPage = deferred<{ data: SessionTurnsDto }>(), newSession = deferred<{ data: SessionDetailDto }>();
    const f = mount(t, { detail: async id => id === 'session-b' ? newSession.promise : { data: detail(id) },
      turns: async (_id, query) => query.cursor ? oldPage.promise : { data: turns() } });
    await settle(); assert.equal(f.reading.data.value?.id, 'session-a');
    const paging = f.reading.pageTurns(1); f.id.value = 'session-b';
    if (outcome === 'success') oldPage.resolve({ data: turns(21, 'old-snapshot') });
    else oldPage.reject(new Error('old-session-error'));
    await paging;
    assert.equal(f.reading.data.value, null); assert.equal(f.reading.loading.value, true); assert.equal(f.reading.error.value, '');
    newSession.resolve({ data: detail('session-b') }); await settle();
    assert.deepEqual(f.reading.data.value, detail('session-b')); assert.equal(f.reading.turn.value, 1); assert.equal(f.reading.turnPage.value, 0);
    assert.equal(f.reading.loading.value, false); assert.equal(f.reading.error.value, '');
  });
}

test('owner changes invalidate a read even when the session URL is unchanged; logout clears the view', async t => {
  const old = deferred<{ data: SessionDetailDto }>(); let calls = 0;
  const f = mount(t, { detail: async id => ++calls === 1 ? old.promise : { data: detail(id, 'owner-b') } });
  f.owner.value = 'owner-b'; await settle();
  old.resolve({ data: detail('session-a', 'owner-a') }); await settle();
  assert.equal(f.reading.data.value?.user_id, 'owner-b'); assert.equal(calls, 2);
  f.owner.value = ''; assert.equal(f.reading.data.value, null); assert.equal(f.reading.trace.value, null);
  assert.equal(f.reading.loading.value, false); assert.equal(calls, 2);
});

test('an unavailable event from an old rendered child cannot invalidate the next session before unmount', async t => {
  const next = deferred<{ data: SessionDetailDto }>();
  const f = mount(t, { detail: async id => id === 'session-b' ? next.promise : { data: detail(id) } });
  await settle();
  const oldChildHandler = unref(f.reading.traceUnavailable);
  f.id.value = 'session-b'; // Synchronous read invalidation precedes the DOM unmount.
  oldChildHandler(new Error('old-child-unavailable'));
  assert.equal(f.reading.error.value, ''); assert.equal(f.reading.loading.value, true);
  next.resolve({ data: detail('session-b') }); await settle();
  assert.deepEqual(f.reading.data.value, detail('session-b'));
  unref(f.reading.traceUnavailable)(new Error('current-content-revoked'));
  assert.equal(f.reading.data.value, null); assert.equal(f.reading.error.value, 'current-content-revoked');
});

test('child errors stay bound to their turn, raw page and displayed tab within the same session', async t => {
  const f = mount(t); await settle();
  const oldTrace = unref(f.reading.traceUnavailable);
  await f.reading.selectTurn(2); oldTrace(new Error('previous-turn'));
  assert.equal(f.reading.error.value, '');
  await f.reading.changeTab('raw'); const oldRaw = unref(f.reading.rawUnavailable);
  await f.reading.pageRaw(1); oldRaw(new Error('previous-raw-page'));
  assert.equal(f.reading.error.value, '');
  const previousDisplay = unref(f.reading.rawUnavailable);
  await f.reading.changeTab('info'); previousDisplay(new Error('hidden-raw'));
  assert.equal(f.reading.error.value, '');
  await f.reading.changeTab('raw'); previousDisplay(new Error('unmounted-raw'));
  assert.equal(f.reading.error.value, '');
  unref(f.reading.rawUnavailable)(new Error('current-raw'));
  assert.equal(f.reading.data.value, null); assert.equal(f.reading.error.value, 'current-raw');
});

test('rapid turn selection commits only the newest trace and binds the directory snapshot to each request', async t => {
  const older = deferred<{ data: SessionFragmentsDto }>(), newer = deferred<{ data: SessionFragmentsDto }>();
  const requests: { turn?: number; snapshot?: string }[] = [];
  const f = mount(t, { fragments: async (_id, query) => {
    requests.push(query);
    return query.turn === 2 ? older.promise : query.turn === 3 ? newer.promise : { data: fragments() };
  } });
  await settle(); const old = f.reading.selectTurn(2); const next = f.reading.selectTurn(3);
  newer.resolve({ data: fragments('newest') }); await next;
  older.reject(new Error('stale-trace-failure')); await old;
  assert.equal(f.reading.trace.value?.items[0]?.event_id, 'newest'); assert.equal(f.reading.error.value, '');
  assert.equal(f.reading.traceLoading.value, false);
  assert.deepEqual(requests.slice(-2).map(q => [q.turn, q.snapshot]), [[2, 'snapshot-a'], [3, 'snapshot-a']]);
});

test('refresh keeps the current tab and displayed detail until the new result is ready', async t => {
  const next = deferred<{ data: SessionDetailDto }>(); let reads = 0;
  const f = mount(t, { detail: async id => ++reads === 1 ? { data: detail(id) } : next.promise });
  t.after(() => next.resolve({ data: detail('session-a') }));
  await settle(); await f.reading.changeTab('info');
  const refresh = f.reading.load();
  assert.equal(f.reading.tab.value, 'info');
  assert.equal(f.reading.data.value?.name, 'session-a');
  assert.equal(f.reading.loading.value, true);
  next.resolve({ data: { ...detail('session-a'), name: 'refreshed name' } }); await refresh;
  assert.equal(f.reading.tab.value, 'info');
  assert.equal(f.reading.data.value?.name, 'refreshed name');
  assert.equal(f.reading.loading.value, false);
});

test('a temporary refresh failure keeps the last result and marks it stale until a successful retry', async t => {
  let unavailable = false;
  const f = mount(t, { detail: async id => {
    if (unavailable) throw new ApiFailure(503, 'source_unavailable', '暂时不可用');
    return { data: detail(id) };
  } });
  await settle(); await f.reading.changeTab('info'); unavailable = true;
  await f.reading.load();
  assert.equal(f.reading.data.value?.id, 'session-a');
  assert.equal(f.reading.tab.value, 'info');
  assert.match(f.reading.error.value, /刷新失败，当前为上次结果/);
  assert.equal(f.reading.loading.value, false);
  unavailable = false; await f.reading.load();
  assert.equal(f.reading.error.value, '');
  assert.equal(f.reading.tab.value, 'info');
});

test('a failed refreshed trace does not publish newer metadata or remove the displayed snapshot', async t => {
  let refreshing = false;
  const f = mount(t, {
    detail: async id => ({ data: { ...detail(id), name: refreshing ? 'new metadata' : 'old metadata' } }),
    fragments: async () => {
      if (refreshing) throw new ApiFailure(503, 'source_unavailable', '轨迹暂不可用');
      return { data: fragments('old-visible-trace') };
    },
  });
  await settle(); refreshing = true;
  await f.reading.load();
  assert.equal(f.reading.data.value?.name, 'old metadata');
  assert.equal(f.reading.trace.value?.items[0]?.event_id, 'old-visible-trace');
  assert.match(f.reading.error.value, /刷新失败，当前为上次结果/);
});

test('refresh preserves valid turn and trace pages when signed tokens renew for the same snapshot version', async t => {
  let token = 0; let traceCursorSnapshot: string | undefined;
  const f = mount(t, {
    turns: async (_id, query) => ({ data: turns(query.cursor ? 21 : 1, `signed-${++token}`) }),
    fragments: async (_id, query) => {
      if (query.cursor) {
        if (query.snapshot !== traceCursorSnapshot) throw new ApiFailure(400, 'invalid_cursor', 'cursor belongs to another signed snapshot');
        return { data: fragments('second-trace-page', null) };
      }
      traceCursorSnapshot = query.snapshot;
      return { data: fragments('first-trace-page') };
    },
  });
  await settle(); await f.reading.pageTurns(1); await f.reading.pageTrace(1);
  const snapshot = f.reading.directory.value?.snapshot;
  await f.reading.load();
  assert.equal(f.reading.turnPage.value, 1);
  assert.equal(f.reading.turn.value, 21);
  assert.equal(f.reading.tracePage.value, 1);
  assert.equal(f.reading.trace.value?.items[0]?.event_id, 'second-trace-page');
  assert.equal(f.reading.directory.value?.snapshot, snapshot);
});

test('an expired refresh cursor retries the current section from its first page without changing tabs', async t => {
  let expired = false;
  const f = mount(t, { fragments: async (_id, query) => {
    if (query.cursor && expired) throw new ApiFailure(400, 'invalid_cursor', '分页已过期');
    return { data: fragments(query.cursor ? 'second-page' : 'first-page') };
  } });
  await settle(); await f.reading.pageTrace(1); await f.reading.changeTab('usage');
  expired = true; await f.reading.load();
  assert.equal(f.reading.data.value?.id, 'session-a');
  assert.equal(f.reading.tab.value, 'usage');
  assert.equal(f.reading.tracePage.value, 0);
  assert.equal(f.reading.trace.value?.items[0]?.event_id, 'first-page');
  assert.match(f.reading.notice.value, /分页.*更新/);
  assert.equal(f.reading.error.value, '');
});

test('refresh revalidates the raw page while keeping its valid page and expanded event', async t => {
  let renewed = false;
  const f = mount(t, { fragments: async (_id, query) => ({ data: query.mode === 'raw'
    ? { ...fragments(query.cursor ? 'raw-second' : 'raw-first'), projection_ready: renewed }
    : fragments('trace') }) });
  await settle(); await f.reading.changeTab('raw'); await f.reading.pageRaw(1);
  const key = `raw-second@${period.from}`; f.reading.toggleRaw(key, true);
  renewed = true; await f.reading.load();
  assert.equal(f.reading.tab.value, 'raw');
  assert.equal(f.reading.rawPage.value, 1);
  assert.equal(f.reading.rawOpen.value, key);
  assert.equal(f.reading.raw.value?.projection_ready, true);
});

test('an expired raw refresh cursor does not reset the valid turn directory or trace page',async t=>{
  let expired=false;
  const f=mount(t,{
    turns:async(_id,query)=>({data:turns(query.cursor?21:1)}),
    fragments:async(_id,query)=>{
      if(expired&&query.mode==='raw'&&query.cursor)throw new ApiFailure(400,'invalid_cursor','原始事件分页已失效');
      return {data:fragments(`${query.mode==='raw'?'raw':'trace'}-${query.cursor?'second':'first'}`)};
    },
  });
  await settle();await f.reading.pageTurns(1);await f.reading.pageTrace(1);await f.reading.changeTab('raw');await f.reading.pageRaw(1);
  expired=true;await f.reading.load();
  assert.equal(f.reading.turnPage.value,1);assert.equal(f.reading.turn.value,21);assert.equal(f.reading.tracePage.value,1);assert.equal(f.reading.trace.value?.items[0]?.event_id,'trace-second');
  assert.equal(f.reading.tab.value,'raw');assert.equal(f.reading.rawPage.value,0);assert.equal(f.reading.raw.value?.items[0]?.event_id,'raw-first');assert.match(f.reading.notice.value,/分页.*更新/);assert.equal(f.reading.error.value,'');
});

test('an expired trace cursor renews its snapshot without resetting the valid directory and raw page',async t=>{
  let expired=false;let recoveredSnapshot:string|undefined;
  const f=mount(t,{
    turns:async(_id,query)=>({data:turns(query.cursor?21:1,`${expired?'renewed':'original'}-${query.cursor?'21':'1'}`)}),
    fragments:async(_id,query)=>{
      if(expired&&query.mode!=='raw'){
        if(query.cursor)throw new ApiFailure(400,'invalid_cursor','轨迹分页已失效');
        recoveredSnapshot=query.snapshot;
      }
      return {data:fragments(`${query.mode==='raw'?'raw':'trace'}-${query.cursor?'second':'first'}`)};
    },
  });
  await settle();await f.reading.pageTurns(1);await f.reading.pageTrace(1);await f.reading.changeTab('raw');await f.reading.pageRaw(1);
  const expanded=`raw-second@${period.from}`;f.reading.toggleRaw(expanded,true);expired=true;await f.reading.load();
  assert.equal(f.reading.turnPage.value,1);assert.equal(f.reading.turn.value,21);assert.equal(f.reading.tracePage.value,0);assert.equal(f.reading.trace.value?.items[0]?.event_id,'trace-first');assert.equal(recoveredSnapshot,'renewed-21');
  assert.equal(f.reading.directory.value?.snapshot,'renewed-21');assert.equal(f.reading.rawPage.value,1);assert.equal(f.reading.raw.value?.items[0]?.event_id,'raw-second');assert.equal(f.reading.rawOpen.value,expanded);assert.equal(f.reading.tab.value,'raw');assert.equal(f.reading.error.value,'');
});

test('an expired turn-directory cursor resets its dependent trace but preserves independent raw reading',async t=>{
  let expired=false;
  const f=mount(t,{
    turns:async(_id,query)=>{if(expired&&query.cursor)throw new ApiFailure(400,'invalid_cursor','目录分页已失效');return {data:turns(query.cursor?21:1)};},
    fragments:async(_id,query)=>({data:fragments(`${query.mode==='raw'?'raw':'trace'}-${query.cursor?'second':'first'}`)}),
  });
  await settle();await f.reading.pageTurns(1);await f.reading.pageTrace(1);await f.reading.changeTab('raw');await f.reading.pageRaw(1);
  const expanded=`raw-second@${period.from}`;f.reading.toggleRaw(expanded,true);expired=true;await f.reading.load();
  assert.equal(f.reading.rawPage.value,1);assert.equal(f.reading.rawOpen.value,expanded);assert.equal(f.reading.raw.value?.items[0]?.event_id,'raw-second');assert.equal(f.reading.tab.value,'raw');
  assert.equal(f.reading.turnPage.value,0);assert.equal(f.reading.turn.value,1);assert.equal(f.reading.tracePage.value,0);assert.equal(f.reading.trace.value?.items[0]?.event_id,'trace-first');assert.match(f.reading.notice.value,/分页.*更新/);
});

for(const section of ['trace','raw'] as const){
  test(`a second invalid ${section} recovery response stops locally without retrying or reviving old content`,async t=>{
    let expired=false,attempts=0;
    const f=mount(t,{
      turns:async(_id,query)=>({data:turns(query.cursor?21:1)}),
      fragments:async(_id,query)=>{
        const mode=query.mode==='raw'?'raw':'trace';
        if(expired&&mode===section){attempts++;throw new ApiFailure(400,'invalid_cursor','分页暂不可恢复');}
        return {data:fragments(`${mode}-${query.cursor?'second':'first'}`)};
      },
    });
    await settle();await f.reading.pageTurns(1);await f.reading.pageTrace(1);await f.reading.changeTab('raw');await f.reading.pageRaw(1);
    const expanded=`raw-second@${period.from}`;f.reading.toggleRaw(expanded,true);expired=true;await f.reading.load();
    assert.equal(f.reading.data.value?.id,'session-a');assert.equal(attempts,2);assert.equal(f.reading.turnPage.value,1);assert.equal(f.reading.turn.value,21);
    assert.equal(f.reading[section].value,null);assert.equal(f.reading[section==='raw'?'rawPage':'tracePage'].value,0);
    const other=section==='trace'?'raw':'trace';assert.equal(f.reading[other].value?.items[0]?.event_id,`${other}-second`);assert.equal(f.reading[section==='trace'?'rawPage':'tracePage'].value,1);
    if(section==='trace')assert.equal(f.reading.rawOpen.value,expanded);else assert.equal(f.reading.rawOpen.value,'');
    assert.match(f.reading.error.value,/分页.*恢复/);assert.equal(f.reading.loading.value,false);
    expired=false;await f.reading.load();assert.equal(f.reading.error.value,'');assert.equal(unref(f.reading[section])?.items[0]?.event_id,`${section}-first`);
  });
}

for(const section of ['turns','trace','raw'] as const){
  test(`an empty ${section} tail on refresh recovers only the affected reading pages`,async t=>{
    let emptied=false;
    const f=mount(t,{
      turns:async(_id,query)=>({data:emptied&&section==='turns'&&query.cursor?{...turns(),items:[],has_more:false,next_cursor:null}:turns(query.cursor?21:1)}),
      fragments:async(_id,query)=>{
        const mode=query.mode==='raw'?'raw':'trace';
        return {data:emptied&&section===mode&&query.cursor?{...fragments(),items:[],has_more:false,next_cursor:null}:fragments(`${mode}-${query.cursor?'second':'first'}`)};
      },
    });
    await settle();await f.reading.pageTurns(1);await f.reading.pageTrace(1);await f.reading.changeTab('raw');await f.reading.pageRaw(1);
    const expanded=`raw-second@${period.from}`;f.reading.toggleRaw(expanded,true);emptied=true;await f.reading.load();
    assert.equal(f.reading.turnPage.value,section==='turns'?0:1);assert.equal(f.reading.turn.value,section==='turns'?1:21);
    assert.equal(f.reading.tracePage.value,section==='raw'?1:0);assert.equal(f.reading.trace.value?.items[0]?.event_id,section==='raw'?'trace-second':'trace-first');
    assert.equal(f.reading.rawPage.value,section==='raw'?0:1);assert.equal(f.reading.raw.value?.items[0]?.event_id,section==='raw'?'raw-first':'raw-second');assert.equal(f.reading.rawOpen.value,section==='raw'?'':expanded);
    assert.equal(f.reading.tab.value,'raw');assert.match(f.reading.notice.value,/分页.*更新/);assert.equal(f.reading.error.value,'');
  });
}

test('revocation from content still displayed during refresh clears it and rejects the pending refresh', async t => {
  const next = deferred<{ data: SessionDetailDto }>(); let reads = 0;
  const f = mount(t, { detail: async id => ++reads === 1 ? { data: detail(id) } : next.promise });
  t.after(() => next.resolve({ data: detail('session-a') }));
  await settle();
  const displayedChild = unref(f.reading.traceUnavailable);
  const refresh = f.reading.load();
  displayedChild(new ApiFailure(404, 'not_found', '内容已不可读取'));
  assert.equal(f.reading.data.value, null);
  assert.equal(f.reading.trace.value, null);
  next.resolve({ data: detail('session-a') }); await refresh;
  assert.equal(f.reading.data.value, null);
  assert.equal(f.reading.error.value, '内容已不可读取');
});

test('a changed trace version resets unsafe paging and explains the fallback without changing the selected tab', async t => {
  let changed = false;
  const f = mount(t, { turns: async (_id, query) => ({ data: changed
    ? turns(1, 'new-snapshot', null, 'b'.repeat(64))
    : turns(query.cursor ? 21 : 1) }) });
  await settle(); await f.reading.pageTurns(1); await f.reading.pageTrace(1);
  await f.reading.changeTab('info'); changed = true; await f.reading.load();
  assert.equal(f.reading.tab.value, 'info');
  assert.equal(f.reading.turnPage.value, 0); assert.equal(f.reading.tracePage.value, 0);
  assert.equal(f.reading.turn.value, 1);
  assert.match(f.reading.notice.value, /分页.*更新/);
});

test('a newly confirmed trace version withdraws the old trace even when reading the replacement fails temporarily',async t=>{
  let changed=false;const replacement=deferred<{data:SessionFragmentsDto}>();
  const f=mount(t,{
    turns:async(_id,query)=>({data:changed?turns(1,'new-snapshot',null,'b'.repeat(64)):turns(query.cursor?21:1)}),
    fragments:async(_id,query)=>query.mode==='raw'?{data:fragments(query.cursor?'raw-second':'raw-first')}:changed?replacement.promise:{data:fragments('old-trace')},
  });
  await settle();await f.reading.changeTab('raw');await f.reading.pageRaw(1);await f.reading.changeTab('trace');changed=true;
  const refresh=f.reading.load();await settle();
  try{assert.equal(f.reading.trace.value,null);assert.equal(f.reading.directory.value,null);assert.equal(f.reading.raw.value?.items[0]?.event_id,'raw-second');}
  finally{replacement.reject(new ApiFailure(503,'source_unavailable','新轨迹暂不可用'));await refresh;}
  assert.equal(f.reading.trace.value,null);assert.equal(f.reading.rawPage.value,1);assert.equal(f.reading.raw.value?.items[0]?.event_id,'raw-second');assert.equal(f.reading.data.value?.id,'session-a');assert.match(f.reading.error.value,/新轨迹暂不可用/);
});

test('a changed readable period withdraws old trace and raw content before waiting on its new directory',async t=>{
  let changed=false;const replacement=deferred<{data:SessionTurnsDto}>(),nextPeriod={from:period.to,to:'2026-09-24T16:00:00Z'};
  const f=mount(t,{
    detail:async id=>({data:{...detail(id),period:changed?nextPeriod:period}}),
    turns:async()=>changed?replacement.promise:{data:turns()},
    fragments:async(_id,query)=>({data:fragments(query.mode==='raw'?'old-raw':'old-trace')}),
  });
  await settle();await f.reading.changeTab('raw');f.reading.toggleRaw(`old-raw@${period.from}`,true);const oldChild=unref(f.reading.rawUnavailable);changed=true;
  const refresh=f.reading.load();await settle();
  try{
    assert.equal(f.reading.trace.value,null);assert.equal(f.reading.raw.value,null);assert.equal(f.reading.rawOpen.value,'');assert.deepEqual(f.reading.data.value?.period,nextPeriod);
    oldChild(new Error('old-period-content'));assert.equal(f.reading.error.value,'');assert.equal(f.reading.loading.value,true);
  }finally{replacement.reject(new ApiFailure(503,'source_unavailable','新窗口目录暂不可用'));await refresh;}
  assert.equal(f.reading.trace.value,null);assert.equal(f.reading.raw.value,null);assert.equal(f.reading.tab.value,'raw');assert.match(f.reading.error.value,/新窗口目录暂不可用/);assert.doesNotMatch(f.reading.error.value,/上次结果/);
});

test('switching to an unread raw tab during a temporarily failed refresh still starts that requested read',async t=>{
  const pending=deferred<{data:SessionDetailDto}>();let reads=0;
  const f=mount(t,{
    detail:async id=>++reads===1?{data:detail(id)}:pending.promise,
    fragments:async(_id,query)=>({data:fragments(query.mode==='raw'?'requested-raw':'trace')}),
  });
  await settle();const refresh=f.reading.load();await f.reading.changeTab('raw');pending.reject(new ApiFailure(503,'source_unavailable','详情暂不可用'));await refresh;
  assert.equal(f.reading.tab.value,'raw');assert.equal(f.reading.raw.value?.items[0]?.event_id,'requested-raw');assert.equal(f.reading.data.value?.id,'session-a');assert.match(f.reading.error.value,/详情暂不可用/);assert.equal(f.reading.loading.value,false);
});

test('normal raw pagination recovers an expired cursor without withdrawing the valid trace',async t=>{
  let expired=false;
  const f=mount(t,{
    turns:async(_id,query)=>({data:turns(query.cursor?21:1)}),
    fragments:async(_id,query)=>{
      if(expired&&query.mode==='raw'&&query.cursor)throw new ApiFailure(400,'invalid_cursor','原始分页过期');
      return {data:fragments(`${query.mode==='raw'?'raw':'trace'}-${query.cursor?'second':'first'}`)};
    },
  });
  await settle();await f.reading.pageTurns(1);await f.reading.pageTrace(1);await f.reading.changeTab('raw');expired=true;await f.reading.pageRaw(1);
  assert.equal(f.reading.data.value?.id,'session-a');assert.equal(f.reading.turnPage.value,1);assert.equal(f.reading.tracePage.value,1);assert.equal(f.reading.trace.value?.items[0]?.event_id,'trace-second');
  assert.equal(f.reading.rawPage.value,0);assert.equal(f.reading.raw.value?.items[0]?.event_id,'raw-first');assert.match(f.reading.notice.value,/原始事件分页.*更新/);assert.equal(f.reading.error.value,'');
});

test('normal trace paging renews an expired signature while preserving its selected turn and independent raw page',async t=>{
  let expired=false;let renewedSnapshot:string|undefined;
  const f=mount(t,{
    turns:async(_id,query)=>{
      const value=turns(query.cursor?21:1,`${expired?'new':'old'}-${query.cursor?'21':'1'}`);
      if(query.cursor)value.items.push({...value.items[0]!,turn_index:22});return {data:value};
    },
    fragments:async(_id,query)=>{
      if(expired&&query.mode!=='raw'){
        if(query.snapshot?.startsWith('old'))throw new ApiFailure(400,'invalid_cursor','签名过期');
        renewedSnapshot=query.snapshot;
      }
      return {data:fragments(`${query.mode==='raw'?'raw':'trace'}-${query.cursor?'second':'first'}`)};
    },
  });
  await settle();await f.reading.pageTurns(1);await f.reading.selectTurn(22);await f.reading.changeTab('raw');await f.reading.pageRaw(1);const expanded=`raw-second@${period.from}`;f.reading.toggleRaw(expanded,true);await f.reading.changeTab('trace');
  expired=true;await f.reading.pageTrace(1);
  assert.equal(f.reading.data.value?.id,'session-a');assert.equal(f.reading.turnPage.value,1);assert.equal(f.reading.turn.value,22);assert.equal(f.reading.tracePage.value,0);assert.equal(renewedSnapshot,'new-21');assert.equal(f.reading.trace.value?.items[0]?.event_id,'trace-first');
  assert.equal(f.reading.rawPage.value,1);assert.equal(f.reading.rawOpen.value,expanded);assert.equal(f.reading.raw.value?.items[0]?.event_id,'raw-second');assert.match(f.reading.notice.value,/轨迹分页.*更新/);assert.equal(f.reading.error.value,'');
});

for(const trigger of ['directory','trace-recovery'] as const){
  test(`normal ${trigger} handles an expired directory cursor without resetting raw reading`,async t=>{
    let expired=false;
    const f=mount(t,{
      turns:async(_id,query)=>{if(expired&&query.cursor)throw new ApiFailure(400,'invalid_cursor','目录过期');return {data:turns(query.cursor?21:1,expired?'renewed':'old')};},
      fragments:async(_id,query)=>{if(expired&&query.mode!=='raw'&&query.snapshot==='old')throw new ApiFailure(400,'invalid_cursor','轨迹过期');return {data:fragments(`${query.mode==='raw'?'raw':'trace'}-${query.cursor?'second':'first'}`)};},
    });
    await settle();if(trigger==='trace-recovery')await f.reading.pageTurns(1);await f.reading.changeTab('raw');await f.reading.pageRaw(1);const expanded=`raw-second@${period.from}`;f.reading.toggleRaw(expanded,true);await f.reading.changeTab('trace');
    expired=true;if(trigger==='directory')await f.reading.pageTurns(1);else await f.reading.pageTrace(1);
    assert.equal(f.reading.data.value?.id,'session-a');assert.equal(f.reading.turnPage.value,0);assert.equal(f.reading.turn.value,1);assert.equal(f.reading.tracePage.value,0);assert.equal(f.reading.trace.value?.items[0]?.event_id,'trace-first');
    assert.equal(f.reading.rawPage.value,1);assert.equal(f.reading.rawOpen.value,expanded);assert.equal(f.reading.raw.value?.items[0]?.event_id,'raw-second');assert.match(f.reading.notice.value,/目录.*分页.*更新/);assert.equal(f.reading.error.value,'');
  });
}

for(const section of ['turns','trace','raw'] as const){
  test(`temporary ${section} paging failure retains the displayed page and a successful retry clears only its error`,async t=>{
    let unavailable=false;const pendingTurns=deferred<{data:SessionTurnsDto}>(),pendingContent=deferred<{data:SessionFragmentsDto}>();
    const f=mount(t,{
      turns:async(_id,query)=>unavailable&&section==='turns'&&query.cursor?pendingTurns.promise:{data:turns(query.cursor?21:1)},
      fragments:async(_id,query)=>{
        const mode=query.mode==='raw'?'raw':'trace';
        return unavailable&&section===mode&&query.cursor?pendingContent.promise:{data:fragments(`${mode}-${query.cursor?'second':'first'}`)};
      },
    });
    await settle();await f.reading.changeTab('raw');const expanded=`raw-first@${period.from}`;f.reading.toggleRaw(expanded,true);
    const advance=()=>section==='turns'?f.reading.pageTurns(1):section==='trace'?f.reading.pageTrace(1):f.reading.pageRaw(1);
    const pageIndex=()=>section==='turns'?f.reading.turnPage.value:section==='trace'?f.reading.tracePage.value:f.reading.rawPage.value;
    unavailable=true;const paging=advance();
    try{
      assert.equal(pageIndex(),0);assert.equal(f.reading.trace.value?.items[0]?.event_id,'trace-first');assert.equal(f.reading.raw.value?.items[0]?.event_id,'raw-first');assert.equal(f.reading.rawOpen.value,expanded);
    }finally{(section==='turns'?pendingTurns:pendingContent).reject(new ApiFailure(503,'source_unavailable','分页临时失败'));await paging;}
    assert.equal(f.reading.data.value?.id,'session-a');assert.equal(pageIndex(),0);assert.equal(f.reading.trace.value?.items[0]?.event_id,'trace-first');assert.equal(f.reading.raw.value?.items[0]?.event_id,'raw-first');assert.match(f.reading.error.value,/上次结果/);
    unavailable=false;await advance();assert.equal(pageIndex(),1);assert.equal(f.reading.error.value,'');
  });
}

for(const section of ['turns','trace','raw'] as const){
  test(`normal ${section} paging recovers an empty tail without resetting independent sections`,async t=>{
    let empty=false;
    const f=mount(t,{
      turns:async(_id,query)=>({data:empty&&section==='turns'&&query.cursor?{...turns(),items:[],has_more:false,next_cursor:null}:turns(query.cursor?21:1)}),
      fragments:async(_id,query)=>{const mode=query.mode==='raw'?'raw':'trace';return {data:empty&&section===mode&&query.cursor?{...fragments(),items:[],has_more:false,next_cursor:null}:fragments(`${mode}-${query.cursor?'second':'first'}`)};},
    });
    await settle();if(section!=='turns')await f.reading.pageTurns(1);if(section!=='trace')await f.reading.pageTrace(1);await f.reading.changeTab('raw');if(section!=='raw')await f.reading.pageRaw(1);
    empty=true;if(section==='turns')await f.reading.pageTurns(1);else if(section==='trace')await f.reading.pageTrace(1);else await f.reading.pageRaw(1);
    assert.equal(f.reading.turnPage.value,section==='turns'?0:1);assert.equal(f.reading.turn.value,section==='turns'?1:21);assert.equal(f.reading.tracePage.value,section==='raw'?1:0);assert.equal(f.reading.rawPage.value,section==='raw'?0:1);
    assert.equal(f.reading.trace.value?.items[0]?.event_id,section==='raw'?'trace-second':'trace-first');assert.equal(f.reading.raw.value?.items[0]?.event_id,section==='raw'?'raw-first':'raw-second');assert.match(f.reading.notice.value,/分页.*更新/);assert.equal(f.reading.error.value,'');
  });
}

test('switching away and back to a pending raw tab reuses the same read',async t=>{
  const pending=deferred<{data:SessionFragmentsDto}>();let requests=0;
  const f=mount(t,{fragments:async(_id,query)=>{if(query.mode==='raw'){requests++;return pending.promise;}return {data:fragments()};}});
  await settle();const first=f.reading.changeTab('raw');await f.reading.changeTab('info');const again=f.reading.changeTab('raw');
  try{assert.equal(requests,1);assert.equal(f.reading.rawLoading.value,true);}finally{pending.resolve({data:fragments('raw-result')});await Promise.all([first,again]);}
  assert.equal(f.reading.tab.value,'raw');assert.equal(f.reading.raw.value?.items[0]?.event_id,'raw-result');assert.equal(f.reading.rawLoading.value,false);
});

for(const phase of ['initial','directory-page'] as const){
  test(`a raw tab selected during ${phase} loading is read once the directory is ready`,async t=>{
    const pending=deferred<{data:SessionTurnsDto}>();let rawReads=0;
    const f=mount(t,{
      turns:async(_id,query)=>(phase==='initial'||query.cursor)?pending.promise:{data:turns()},
      fragments:async(_id,query)=>{if(query.mode==='raw')rawReads++;return {data:fragments(query.mode==='raw'?'requested-raw':'trace')};},
    });
    await settle();const paging=phase==='directory-page'?f.reading.pageTurns(1):Promise.resolve();await f.reading.changeTab('raw');assert.equal(rawReads,0);
    pending.resolve({data:turns(phase==='initial'?1:21)});await paging;await settle();
    assert.equal(f.reading.tab.value,'raw');assert.equal(rawReads,1);assert.equal(f.reading.raw.value?.items[0]?.event_id,'requested-raw');assert.equal(f.reading.loading.value,false);assert.equal(f.reading.rawLoading.value,false);
  });
}

test('a successful raw-tab retry clears the raw failure left by the main refresh',async t=>{
  let expired=false;
  const f=mount(t,{fragments:async(_id,query)=>{if(expired&&query.mode==='raw')throw new ApiFailure(400,'invalid_cursor','raw expired');return {data:fragments(query.mode==='raw'?'raw':'trace')};}});
  await settle();await f.reading.changeTab('raw');await f.reading.pageRaw(1);expired=true;await f.reading.load();assert.match(f.reading.error.value,/原始事件分页暂无法恢复/);
  expired=false;await f.reading.changeTab('info');await f.reading.changeTab('raw');assert.equal(f.reading.raw.value?.items[0]?.event_id,'raw');assert.equal(f.reading.error.value,'');
});

for(const section of ['turns','trace'] as const){
  test(`normal ${section} recovery stops after its first-page retry is invalid again`,async t=>{
    let expired=false,failures=0;
    const f=mount(t,{
      turns:async()=>{if(expired&&section==='turns'){failures++;throw new ApiFailure(400,'invalid_cursor','目录仍无效');}return {data:turns()};},
      fragments:async(_id,query)=>{if(expired&&section==='trace'&&query.mode!=='raw'){failures++;throw new ApiFailure(400,'invalid_cursor','轨迹仍无效');}return {data:fragments(query.mode==='raw'?'raw-visible':'trace-visible')};},
    });
    await settle();await f.reading.changeTab('raw');expired=true;if(section==='turns')await f.reading.pageTurns(1);else await f.reading.pageTrace(1);
    assert.equal(failures,2);assert.equal(f.reading.data.value?.id,'session-a');assert.equal(f.reading.raw.value?.items[0]?.event_id,'raw-visible');assert.equal(f.reading.trace.value,null);assert.match(f.reading.error.value,/分页暂无法恢复/);assert.equal(f.reading.loading.value,false);assert.equal(f.reading.traceLoading.value,false);
  });
}

for(const section of ['turns','trace','raw'] as const){
  test(`revocation of content retained during ${section} paging prevents its pending result from reviving the view`,async t=>{
    const pendingTurns=deferred<{data:SessionTurnsDto}>(),pendingContent=deferred<{data:SessionFragmentsDto}>();let waiting=false;
    const f=mount(t,{
      turns:async(_id,query)=>waiting&&section==='turns'&&query.cursor?pendingTurns.promise:{data:turns()},
      fragments:async(_id,query)=>waiting&&section===(query.mode==='raw'?'raw':'trace')&&query.cursor?pendingContent.promise:{data:fragments()},
    });
    await settle();if(section==='raw')await f.reading.changeTab('raw');const revoked=unref(section==='raw'?f.reading.rawUnavailable:f.reading.traceUnavailable);waiting=true;
    const paging=section==='turns'?f.reading.pageTurns(1):section==='trace'?f.reading.pageTrace(1):f.reading.pageRaw(1);
    revoked(new ApiFailure(403,'forbidden','已撤销读取权限'));
    if(section==='turns')pendingTurns.resolve({data:turns(21)});else pendingContent.resolve({data:fragments('late-page')});await paging;
    assert.equal(f.reading.data.value,null);assert.equal(f.reading.trace.value,null);assert.equal(f.reading.raw.value,null);assert.equal(f.reading.error.value,'已撤销读取权限');assert.equal(f.reading.loading.value,false);assert.equal(f.reading.rawLoading.value,false);assert.equal(f.reading.traceLoading.value,false);
  });
}

for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [404, 'not_found'], [409, 'content_changed'], [422, 'invalid_period'], [503, 'recovery_quarantined']] as const) {
  test(`refresh removes previous content on ${code} instead of treating it as temporary failure`, async t => {
    let revoked = false;
    const f = mount(t, { detail: async id => {
      if (revoked) throw new ApiFailure(status, code, code);
      return { data: detail(id) };
    } });
    await settle(); revoked = true; await f.reading.load();
    assert.equal(f.reading.data.value, null); assert.equal(f.reading.trace.value, null);
    assert.equal(f.reading.error.value, code);
  });
}

test('raw pages stay independent of turn selection and opening another session resets reading state', async t => {
  const requests: Parameters<Reader['fragments']>[1][] = [];
  const f = mount(t, { turns: async (_id, query) => ({ data: query.cursor ? turns(21, 'snapshot-b', null) : turns() }),
    fragments: async (_id, query) => { requests.push(query); return { data: fragments(query.mode ?? 'trace', query.cursor ? null : 'next') }; } });
  await settle(); await f.reading.pageTrace(1); assert.equal(f.reading.tracePage.value, 1);
  await f.reading.changeTab('raw'); await f.reading.pageRaw(1); f.reading.toggleRaw('raw', true);
  await f.reading.selectTurn(2); assert.equal(f.reading.tracePage.value, 0); assert.equal(f.reading.rawPage.value, 1); assert.equal(f.reading.rawOpen.value, 'raw');
  await f.reading.pageTurns(1);
  assert.equal(f.reading.turn.value, 21); assert.equal(requests.at(-1)?.snapshot, 'snapshot-b'); assert.equal(requests.at(-1)?.cursor, undefined);
  assert.ok(requests.filter(q => q.mode === 'raw').every(q => q.snapshot === undefined && q.turn === undefined));
  f.id.value = 'session-b'; await settle();
  assert.equal(f.reading.tab.value, 'trace'); assert.equal(f.reading.turnPage.value, 0); assert.equal(f.reading.tracePage.value, 0);
  assert.equal(f.reading.rawPage.value, 0); assert.equal(f.reading.raw.value, null); assert.equal(f.reading.rawOpen.value, '');
  await f.reading.pageTurns(-1); await f.reading.pageTrace(-1); assert.equal(f.reading.turnPage.value, 0); assert.equal(f.reading.tracePage.value, 0);
});

test('reading the next turn directory prevents navigation against the old trace snapshot', async t => {
  const next = deferred<{ data: SessionTurnsDto }>(); let reads = 0;
  const f = mount(t, { turns: async (_id, query) => query.cursor ? next.promise : { data: turns() },
    fragments: async () => { reads++; return { data: fragments() }; } });
  t.after(() => next.resolve({ data: turns(21, 'new-directory', null) }));
  await settle(); await f.reading.pageTrace(1);
  const count = reads, paging = f.reading.pageTurns(1);
  await f.reading.pageTrace(-1); await f.reading.selectTurn(2);
  assert.equal(reads, count, 'no request may reuse the old directory snapshot while loading another group');
  next.resolve({ data: turns(21, 'new-directory', null) }); await paging;
  assert.equal(f.reading.turn.value, 21); assert.equal(f.reading.tracePage.value, 0);
});

test('a current read failure invalidates sibling responses and a reload can recover', async t => {
  const raw = deferred<{ data: SessionFragmentsDto }>();
  const f = mount(t, { fragments: async (_id, query) => {
    if (query.mode === 'raw') return raw.promise;
    if (query.turn === 2) throw new Error('snapshot_expired');
    return { data: fragments() };
  } });
  await settle(); const pendingRaw = f.reading.changeTab('raw'); await f.reading.selectTurn(2);
  assert.equal(f.reading.data.value, null); assert.equal(f.reading.error.value, 'snapshot_expired');
  raw.resolve({ data: fragments('stale-raw') }); await pendingRaw;
  assert.equal(f.reading.raw.value, null); assert.equal(f.reading.loading.value, false); assert.equal(f.reading.traceLoading.value, false);
  await f.reading.load(); assert.deepEqual(f.reading.data.value, detail('session-a')); assert.equal(f.reading.error.value, '');
});

test('disposing a reading scope prevents late responses from starting further reads', async t => {
  const pending = deferred<{ data: SessionDetailDto }>(); let turnsCalls = 0;
  const f = mount(t, { detail: async () => pending.promise, turns: async () => { turnsCalls++; return { data: turns() }; } });
  f.scope.stop(); pending.resolve({ data: detail('session-a') }); await settle();
  assert.equal(f.reading.data.value, null); assert.equal(turnsCalls, 0);
  await f.reading.load(); assert.equal(turnsCalls, 0);
});
