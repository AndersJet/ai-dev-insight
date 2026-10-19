import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { effectScope, nextTick, reactive, ref } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import type { AllSessionQueryDto, SessionListDto, SessionListSnapshotDto } from '@adi/contracts';
import { useSessionList } from '../src/composables/session-list.js';
import { useSessionNavigation } from '../src/stores/session-navigation.js';
import { useAnalysisPeriod } from '../src/stores/analysis-period.js';
import { ApiFailure } from '../src/api/http.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const period = { from: '2026-09-22T16:00:00Z', to: '2026-09-24T16:00:00Z' };
function response(total: number, cursor: string | null = null, snapshot?:SessionListSnapshotDto): { data: SessionListDto } {
  return { data: { period, items: [], total, has_more: cursor !== null, next_cursor: cursor, channel_available: true, available_channels: ['all', 'official', 'pending', 'custom'],...(snapshot?{snapshot}:{}) } };
}
const snapshot:SessionListSnapshotDto={id:'complete-list-1',as_of:'2026-09-24T12:00:00Z',expires_at:'2026-09-24T12:05:00Z',updating:true};
async function settle() { await Promise.resolve(); await nextTick(); await Promise.resolve(); }
function fixture(t: TestContext, afterRender?: () => Promise<unknown>) {
  setActivePinia(createPinia());
  const owner = ref('first');
  const route = reactive({ path: '/my/sessions', fullPath: '/my/sessions', query: {} as Record<string, string> });
  const calls: { all: boolean; input: AllSessionQueryDto; reply: ReturnType<typeof deferred<{ data: SessionListDto }>> }[] = [];
  const pushed: RouteLocationRaw[] = [], replaced: RouteLocationRaw[] = [], scrolled: number[] = [];
  const navigation = useSessionNavigation(), periods = useAnalysisPeriod();
  const scope = effectScope();
  const list = scope.run(() => useSessionList({ route, owner: () => owner.value, push: target => pushed.push(target), replace: target => replaced.push(target), scrollY: () => 420, scrollTo: top => scrolled.push(top),
    read: (all, input) => { const reply = deferred<{ data: SessionListDto }>(); calls.push({ all, input, reply }); return reply.promise; },
    ...(afterRender ? { afterRender } : {}),
  }))!;
  t.after(() => scope.stop());
  return { owner, route, calls, pushed, replaced, scrolled, navigation, periods, scope, list, currentData:()=>list.data.value };
}

test('older list successes and errors cannot replace the latest route or release its loading state', async t => {
  const f = fixture(t);
  f.route.query = { search: 'second' }; f.route.fullPath = '/my/sessions?search=second'; await nextTick();
  f.route.query = { search: 'latest' }; f.route.fullPath = '/my/sessions?search=latest'; await nextTick();
  f.calls[0]!.reply.resolve(response(1)); f.calls[1]!.reply.reject(new Error('old failure')); await settle();
  assert.equal(f.list.data.value, null); assert.equal(f.list.error.value, ''); assert.equal(f.list.loading.value, true);
  assert.deepEqual(f.navigation.pages, {}); assert.equal(f.periods.period, null);
  f.calls[2]!.reply.resolve(response(3)); await settle();
  assert.deepEqual(f.list.data.value, response(3).data); assert.equal(f.list.loading.value, false); assert.equal(f.list.search.value, 'latest');
  assert.deepEqual(Object.values(f.navigation.pages), ['/my/sessions?search=latest']);
});

test('a route change while awaiting render cannot consume or restore the old list scroll', async t => {
  const render = deferred<void>(); const f = fixture(t, () => render.promise);
  f.navigation.open('first', '/my/sessions', 420);
  f.calls[0]!.reply.resolve(response(1)); await settle();
  f.route.query = { search: 'new' }; f.route.fullPath = '/my/sessions?search=new'; await nextTick();
  render.resolve(); await settle();
  assert.deepEqual(f.scrolled, []); assert.equal(f.navigation.restore, true); assert.equal(f.list.loading.value, true);
  f.calls[1]!.reply.resolve(response(2)); await settle();
  assert.deepEqual(f.scrolled, []); assert.equal(f.list.loading.value, false);
  f.route.query = {}; f.route.fullPath = '/my/sessions'; await nextTick(); f.calls[2]!.reply.resolve(response(3)); await settle();
  assert.deepEqual(f.scrolled, [420]); assert.equal(f.navigation.restore, false);
});

test('changing owners clears navigation and period memory and rejects the prior owner reply', async t => {
  const f = fixture(t);
  f.navigation.rememberPage('first', 'old-page', '/my/sessions?page=2'); f.navigation.open('first', '/my/sessions', 420);
  f.periods.remember(period); f.owner.value = 'second'; await nextTick();
  assert.equal(f.navigation.owner, 'second'); assert.deepEqual(f.navigation.pages, {}); assert.equal(f.navigation.list, '');
  assert.equal(f.periods.period, null); assert.equal(f.list.period.value, null);
  f.calls[0]!.reply.reject(new Error('previous owner denied')); await settle();
  assert.equal(f.list.loading.value, true); assert.equal(f.list.error.value, '');
  f.calls[1]!.reply.resolve(response(2)); await settle(); assert.equal(f.list.data.value?.total, 2); assert.deepEqual(f.scrolled, []);
  f.owner.value = ''; await nextTick(); assert.equal(f.list.data.value, null); assert.equal(f.list.loading.value, false); assert.equal(f.calls.length, 2);
});

test('session list actions retain filters, reset cursor on changes and restore the remembered prior page', async t => {
  const f = fixture(t); f.calls[0]!.reply.resolve(response(22, 'next-page')); await settle();
  f.list.next(); assert.deepEqual(f.pushed.at(-1), { path: '/my/sessions', query: { ...period, cursor: 'next-page', page: '2' } });
  f.route.query = { ...period, cursor: 'next-page', page: '2' }; f.route.fullPath = '/my/sessions?page=2&cursor=next-page'; await nextTick();
  f.calls[1]!.reply.resolve(response(22)); await settle(); f.list.previous(); assert.equal(f.pushed.at(-1), '/my/sessions');
  f.list.filters({ channel: 'official' }); assert.deepEqual(f.pushed.at(-1), { path: '/my/sessions', query: { ...period, cursor: undefined, page: undefined, channel: 'official' } });
  f.list.open('detail'); assert.deepEqual(f.pushed.at(-1), { path: '/my/sessions/detail', query: { ...f.route.query, return: f.route.fullPath } });
  assert.deepEqual(f.scrolled, [0]); assert.equal(f.navigation.returnTo('first', false, f.route.fullPath), f.route.fullPath);
  assert.equal(f.navigation.takeScroll('first', f.route.fullPath), 420); assert.equal(f.navigation.takeScroll('first', f.route.fullPath), null);
});

test('refresh keeps the displayed page and draft search while querying only the applied filters', async t => {
  const f = fixture(t); f.calls[0]!.reply.resolve(response(22, 'next-page')); await settle();
  f.route.query = { ...period, cursor: 'next-page', page: '2', search: 'applied' };
  f.route.fullPath = '/my/sessions?page=2&cursor=next-page&search=applied'; await nextTick();
  f.calls[1]!.reply.resolve(response(22)); await settle();
  f.list.search.value = 'unsubmitted draft';
  const refresh = f.list.refresh();
  assert.deepEqual(f.pushed, []);
  assert.equal(f.list.data.value?.total, 22);
  assert.equal(f.list.search.value, 'unsubmitted draft');
  assert.equal(f.calls[2]!.input.cursor, 'next-page');
  assert.equal(f.calls[2]!.input.search, 'applied');
  f.calls[2]!.reply.resolve(response(23)); await refresh;
  assert.equal(f.list.page.value, 2); assert.equal(f.list.data.value?.total, 23);
  assert.equal(f.list.search.value, 'unsubmitted draft');
  assert.deepEqual(f.scrolled, []);
});

for (const temporary of [true, false]) {
  test(`list refresh ${temporary ? 'keeps previous results on a temporary failure' : 'removes results when access is revoked'}`, async t => {
    const f = fixture(t); f.calls[0]!.reply.resolve(response(22)); await settle();
    const refresh = f.list.refresh();
    f.calls[1]!.reply.reject(temporary ? new ApiFailure(503, 'source_unavailable', '暂不可用') : new ApiFailure(403, 'forbidden', '无权查看'));
    await refresh;
    if (temporary) {
      assert.equal(f.list.data.value?.total, 22);
      assert.match(f.list.error.value, /刷新失败，当前为上次结果/);
    } else {
      assert.equal(f.list.data.value, null);
      assert.equal(f.list.error.value, '无权查看');
    }
  });
}

test('an invalid list cursor replaces only pagination, keeps the draft and explains the first-page fallback', async t => {
  const f = fixture(t); f.calls[0]!.reply.resolve(response(22, 'next')); await settle();
  f.route.query = { ...period, cursor: 'next', page: '2', search: 'applied' };
  f.route.fullPath = '/my/sessions?page=2&cursor=next&search=applied'; await nextTick();
  f.calls[1]!.reply.resolve(response(22)); await settle();
  f.list.search.value = 'draft'; const refresh = f.list.refresh();
  f.calls[2]!.reply.reject(new ApiFailure(400, 'invalid_cursor', '过期')); await refresh;
  assert.equal(f.list.data.value, null);
  assert.deepEqual(f.replaced, [{ path: '/my/sessions', query: { ...period, search: 'applied', cursor: undefined, page: undefined } }]);
  f.route.query = { ...period, search: 'applied' }; f.route.fullPath = '/my/sessions?search=applied'; await nextTick();
  assert.equal(f.list.search.value, 'draft'); assert.equal(f.calls[3]!.input.cursor, undefined);
  f.calls[3]!.reply.resolve(response(22)); await settle();
  assert.equal(f.list.page.value, 1); assert.match(f.list.notice.value, /分页.*更新/);
  assert.equal(f.list.error.value, ''); assert.deepEqual(f.scrolled, []);
});

test('list snapshot metadata belongs to the current owner and late metadata cannot revive an old owner result',async t=>{
 const f=fixture(t);f.calls[0]!.reply.resolve(response(22,'next',snapshot));await settle();
 assert.deepEqual(f.list.data.value?.snapshot,snapshot);
 const old=f.list.refresh();f.owner.value='second';await nextTick();
 assert.equal(f.list.data.value,null);
 f.calls[1]!.reply.resolve(response(99,'old-cursor',{...snapshot,id:'late-old'}));await old;await settle();
 assert.equal(f.list.data.value,null);assert.equal(f.list.loading.value,true);
 f.calls[2]!.reply.resolve(response(1,null,{...snapshot,id:'second-owner',updating:false}));await settle();
 assert.equal(f.currentData()?.snapshot?.id,'second-owner');assert.equal(f.currentData()?.snapshot?.updating,false);
});

test('expired snapshot pagination clears old rows and metadata, returns once to the first page and explains the expiry',async t=>{
 const f=fixture(t);f.calls[0]!.reply.resolve(response(22,'old',snapshot));await settle();
 f.route.query={...period,cursor:'old',page:'2',search:'applied'};f.route.fullPath='/my/sessions?page=2&cursor=old&search=applied';await nextTick();
 f.list.search.value='draft';f.calls[1]!.reply.reject(new ApiFailure(409,'session_snapshot_expired','当前列表版本已过期'));await settle();
 assert.equal(f.list.data.value,null);assert.match(f.list.notice.value,/版本已过期/);assert.equal(f.replaced.length,1);
 f.route.query={...period,search:'applied'};f.route.fullPath='/my/sessions?search=applied';await nextTick();
 assert.equal(f.list.search.value,'draft');assert.equal(f.calls[2]!.input.cursor,undefined);
 f.calls[2]!.reply.reject(new ApiFailure(409,'session_snapshot_expired','重新查询仍不可用'));await settle();
 assert.equal(f.replaced.length,1,'first-page failures must not cause an unbounded expiry recovery loop');
 assert.equal(f.list.data.value,null);assert.equal(f.list.error.value,'当前列表版本已过期，请刷新列表重新查询。');
});

test('explicit refresh of snapshot pagination queries the newest first page and preserves applied filters and draft text',async t=>{
 const f=fixture(t);f.calls[0]!.reply.resolve(response(22,'old-page',snapshot));await settle();
 f.route.query={...period,cursor:'old-page',page:'2',search:'applied',channel:'official'};f.route.fullPath='/my/sessions?page=2&cursor=old-page&search=applied&channel=official';await nextTick();
 f.calls[1]!.reply.resolve(response(22,'old-later',snapshot));await settle();f.list.search.value='draft';await f.list.refresh();
 assert.equal(f.list.data.value,null);assert.equal(f.calls.length,2,'refresh must not fetch the old signed page again');
 assert.deepEqual(f.replaced.at(-1),{path:'/my/sessions',query:{...period,cursor:undefined,page:undefined,search:'applied',channel:'official'}});
 f.route.query={...period,search:'applied',channel:'official'};f.route.fullPath='/my/sessions?search=applied&channel=official';await nextTick();
 assert.equal(f.list.search.value,'draft');assert.equal(f.calls[2]!.input.cursor,undefined);assert.equal(f.calls[2]!.input.channel,'official');
 f.calls[2]!.reply.resolve(response(23,'new-page',{...snapshot,id:'new-version',updating:false}));await settle();
 assert.equal(f.list.page.value,1);assert.equal(f.currentData()?.snapshot?.id,'new-version');assert.equal(f.currentData()?.total,23);
});

for(const code of ['forbidden','content_changed','recovery_quarantined','session_snapshot_expired','session_snapshot_pending'])test(`snapshot metadata and prior results are removed immediately on ${code}`,async t=>{
 const f=fixture(t);f.calls[0]!.reply.resolve(response(22,null,snapshot));await settle();
 const refresh=f.list.refresh();f.calls[1]!.reply.reject(new ApiFailure(code==='forbidden'?403:code==='session_snapshot_pending'?503:409,code,'当前结果不可继续使用'));await refresh;
 assert.equal(f.list.data.value,null);assert.equal(f.list.error.value,code==='session_snapshot_pending'?'会话列表正在更新，请稍后刷新。':code==='session_snapshot_expired'?'当前列表版本已过期，请刷新列表重新查询。':'当前结果不可继续使用');
});

test('a snapshot refresh failure cannot keep client-only stale results without a successful safety-checked response',async t=>{
 const f=fixture(t);f.calls[0]!.reply.resolve(response(22,null,snapshot));await settle();
 const refresh=f.list.refresh();f.calls[1]!.reply.reject(new ApiFailure(503,'source_unavailable','暂不可用'));await refresh;
 assert.equal(f.list.data.value,null);assert.equal(f.list.error.value,'暂不可用');
});

test('disposing the list while its request is pending prevents late state and navigation writes', async t => {
  const f = fixture(t); f.scope.stop(); f.calls[0]!.reply.resolve(response(1)); await settle();
  assert.equal(f.list.data.value, null); assert.deepEqual(f.navigation.pages, {}); assert.equal(f.periods.period, null); assert.deepEqual(f.scrolled, []);
});

test('session return paths stay in the selected workspace and navigation retains at most 100 pages', () => {
  setActivePinia(createPinia()); const navigation = useSessionNavigation();
  navigation.open('first', '/my/sessions?search=kept', 420);
  assert.equal(navigation.returnTo('first', false, '/my/sessions?search=kept'), '/my/sessions?search=kept'); assert.equal(navigation.restore, true);
  for (const value of ['https://outside.invalid', '//outside.invalid', '/all/sessions', '/my/sessions/other', '/my/sessions?bad=\\evil', ['my/sessions'], null]) {
    assert.equal(navigation.returnTo('first', false, value), '/my/sessions'); assert.equal(navigation.restore, false);
  }
  assert.equal(navigation.returnTo('first', true, '/all/sessions?dept=team'), '/all/sessions?dept=team');
  for (let index = 0; index < 101; index++) navigation.rememberPage('first', `key-${index}`, `/my/sessions?page=${index}`);
  assert.equal(Object.keys(navigation.pages).length, 100); assert.equal(navigation.previous('first', 'key-0'), undefined); assert.equal(navigation.previous('first', 'key-100'), '/my/sessions?page=100');
  navigation.returnTo('second', false, '/my/sessions?search=kept'); assert.deepEqual(navigation.pages, {}); assert.equal(navigation.list, ''); assert.equal(navigation.restore, false);
});
