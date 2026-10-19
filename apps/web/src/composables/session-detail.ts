import { computed, onScopeDispose, ref, shallowReadonly, watch, type Ref } from 'vue';
import type { SessionDetailDto, SessionTurnsDto, SessionFragmentsDto } from '@adi/contracts';
import * as sessions from '../api/sessions.js';
import { ApiFailure, isTransientReadFailure } from '../api/http.js';

type Reader = Pick<typeof sessions, 'detail' | 'turns' | 'fragments'>;
type Tab = 'trace' | 'usage' | 'raw' | 'info';
type PageSection = 'turns' | 'trace' | 'raw';

/** One reading lifetime per authenticated owner and session. Pagination cursors,
 * snapshot selection and response ordering belong here, not in the view. */
export function useSessionDetailReading(id: Readonly<Ref<string>>, owner: Readonly<Ref<string>>, reader: Reader = sessions) {
  const data = ref<SessionDetailDto | null>(null);
  const directory = ref<SessionTurnsDto | null>(null);
  const trace = ref<SessionFragmentsDto | null>(null);
  const raw = ref<SessionFragmentsDto | null>(null);
  const detailLoading = ref(false), turnsLoading = ref(false), traceLoading = ref(false), rawLoading = ref(false);
  const loading = computed(() => detailLoading.value || turnsLoading.value);
  const error = ref(''), notice = ref(''), tab = ref<Tab>('trace'), turn = ref<number>();
  const turnPage = ref(0), tracePage = ref(0), rawPage = ref(0), rawOpen = ref('');
  let turnCursors: (string | undefined)[] = [undefined];
  let traceCursors: (string | undefined)[] = [undefined];
  let rawCursors: (string | undefined)[] = [undefined];
  const generation = ref(0), traceRequest = ref(0), rawRequest = ref(0), display = ref(0);
  const readingLifetime = ref(0), traceDisplay = ref(0), rawDisplay = ref(0);
  let turnRequest = 0;
  let disposed = false;
  let pageError: { section: PageSection; message: string } | null = null;
  let rawWantedWhileBusy = false;

  function invalidate() { generation.value++; turnRequest++; traceRequest.value++; rawRequest.value++; }
  function current(scope: number) { return !disposed && scope === generation.value; }
  function clear() {
    readingLifetime.value++;
    pageError = null; rawWantedWhileBusy = false;
    data.value = null; directory.value = null; trace.value = null; raw.value = null;
    detailLoading.value = false; turnsLoading.value = false; traceLoading.value = false; rawLoading.value = false;
  }
  function fail(scope: number, reason: unknown) {
    if (!current(scope)) return;
    // Invalidate sibling reads too: a late success must not revive failed data.
    invalidate(); clear();
    notice.value = '';
    error.value = reason instanceof Error ? reason.message : '无法读取会话，请重新加载';
  }
  function clearPageError(section: PageSection) {
    if (pageError?.section !== section) return;
    if (error.value === pageError.message) error.value = '';
    pageError = null;
  }
  function reportPageError(section: PageSection, message: string) {
    pageError = { section, message }; error.value = message;
  }
  function temporaryPageError(section: PageSection, reason: unknown, retained: boolean) {
    const label = { turns: '轮次目录', trace: '轨迹', raw: '原始事件' }[section];
    reportPageError(section, `${label}读取失败${retained ? '，当前为上次结果' : ''}：${reason instanceof Error ? reason.message : '请稍后重试'}`);
  }
  async function loadTrace(reset = false, allowRecovery = true, targetPage = tracePage.value) {
    if (!data.value || disposed) return;
    const scope = generation.value, request = ++traceRequest.value, sessionId = id.value;
    clearPageError('trace');
    if (reset) { targetPage = 0; tracePage.value = 0; traceCursors = [undefined]; traceDisplay.value++; trace.value = null; }
    const cursor = traceCursors[targetPage], snapshot = directory.value?.snapshot;
    const input = { ...data.value.period, limit: 20, ...(turn.value ? { turn: turn.value } : {}), ...(snapshot ? { snapshot } : {}), ...(cursor ? { cursor } : {}) };
    traceLoading.value = true;
    try {
      const result = await reader.fragments(sessionId, input);
      if (!current(scope) || request !== traceRequest.value) return;
      if (allowRecovery && cursor && !result.data.items.length) {
        traceDisplay.value++; trace.value = null; tracePage.value = 0; traceCursors = [undefined];
        notice.value = '轨迹分页已更新，已回到该区块第一页。'; await loadTurns(true); return;
      }
      traceDisplay.value++; trace.value = result.data; tracePage.value = targetPage;
    } catch (reason) {
      if (!current(scope) || request !== traceRequest.value) return;
      if (reason instanceof ApiFailure && reason.code === 'invalid_cursor') {
        traceDisplay.value++; trace.value = null;
        if (allowRecovery) {
          tracePage.value = 0; traceCursors = [undefined];
          notice.value = '轨迹分页已更新，已回到该区块第一页。';
          await loadTurns(true);
        } else reportPageError('trace', '轨迹分页暂无法恢复，请重新加载。');
      } else if (isTransientReadFailure(reason)) temporaryPageError('trace', reason, !!trace.value);
      else fail(scope, reason);
    }
    finally { if (current(scope) && request === traceRequest.value) traceLoading.value = false; }
  }
  async function loadTurns(preserveTurn = false, targetPage = turnPage.value) {
    if (!data.value || disposed) return;
    const scope = generation.value, request = ++turnRequest, sessionId = id.value;
    const previousTurn = turn.value, previousVersion = directory.value?.snapshot_version;
    clearPageError('turns');
    let cursor = turnCursors[targetPage];
    const input = { ...data.value.period, limit: 20 };
    turnsLoading.value = true;
    // A previous trace cannot arrive while the next directory is being read.
    traceRequest.value++; traceLoading.value = false;
    try { for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await reader.turns(sessionId, { ...input, ...(cursor ? { cursor } : {}) });
        if (!current(scope) || request !== turnRequest) return;
        if (cursor && attempt === 0 && !result.data.items.length) {
          cursor = undefined; targetPage = 0; directory.value = null; turn.value = undefined; turnPage.value = 0; turnCursors = [undefined]; traceDisplay.value++; trace.value = null; tracePage.value = 0; traceCursors = [undefined];
          notice.value = '轮次目录与轨迹分页已更新，已回到对应区块第一页。'; continue;
        }
        const keepTurn = preserveTurn && !!previousVersion && previousVersion === result.data.snapshot_version && (previousTurn === undefined || result.data.items.some(item => item.turn_index === previousTurn));
        directory.value = result.data; turnPage.value = targetPage; turn.value = keepTurn ? previousTurn : result.data.items[0]?.turn_index;
        await loadTrace(true, false); return;
      } catch (reason) {
        if (!current(scope) || request !== turnRequest) return;
        if (reason instanceof ApiFailure && reason.code === 'invalid_cursor') {
          directory.value = null; turn.value = undefined; targetPage = 0; turnPage.value = 0; turnCursors = [undefined]; traceDisplay.value++; trace.value = null; tracePage.value = 0; traceCursors = [undefined];
          if (cursor && attempt === 0) {
            cursor = undefined; notice.value = '轮次目录与轨迹分页已更新，已回到对应区块第一页。'; continue;
          }
          reportPageError('turns', '轮次目录分页暂无法恢复，请重新加载。'); return;
        }
        if (isTransientReadFailure(reason)) temporaryPageError('turns', reason, !!directory.value);
        else fail(scope, reason);
        return;
      }
    } }
    finally { if (current(scope) && request === turnRequest) { turnsLoading.value = false; await readRequestedRaw(); } }
  }
  async function refreshCurrent(): Promise<void> {
    const previousData = data.value!, previousDirectory = directory.value;
    const previousTurn = turn.value, previousTurnPage = turnPage.value, previousTracePage = tracePage.value, previousRawPage = rawPage.value;
    if (tab.value === 'raw' && !raw.value) rawWantedWhileBusy = true;
    invalidate();
    const scope = generation.value, sessionId = id.value;
    error.value = ''; pageError = null; notice.value = '';
    detailLoading.value = true; turnsLoading.value = false; traceLoading.value = false; rawLoading.value = false;
    let recovering: 'trace' | 'raw' | null = null;
    let periodChanged = false;
    try {
      const nextData = (await reader.detail(sessionId)).data;
      if (!current(scope)) return;
      const samePeriod = nextData.period.from === previousData.period.from && nextData.period.to === previousData.period.to;
      if (!samePeriod) {
        periodChanged = true; readingLifetime.value++; traceDisplay.value++; rawDisplay.value++;
        data.value = nextData; directory.value = null; trace.value = null; raw.value = null; rawOpen.value = ''; turn.value = undefined;
        turnPage.value = 0; tracePage.value = 0; rawPage.value = 0;
        turnCursors = [undefined]; traceCursors = [undefined]; rawCursors = [undefined];
        notice.value = '会话可读取范围已更新，正在读取新范围内的内容。';
      }
      const firstDirectory = (await reader.turns(sessionId, { ...nextData.period, limit: 20 })).data;
      if (!current(scope)) return;
      let nextDirectory = firstDirectory, nextTurnPage = 0, nextTracePage = 0;
      let nextTurn = firstDirectory.items[0]?.turn_index;
      const withdrawDirectoryPage = () => {
        directory.value = null; traceDisplay.value++; trace.value = null;
        turnPage.value = 0; tracePage.value = 0; turnCursors = [undefined]; traceCursors = [undefined];
        recovering = 'trace';
        notice.value = '轮次目录与轨迹分页已更新，已从对应区块第一页重新读取。';
      };
      const sameSnapshot = samePeriod && !!firstDirectory.snapshot_version && firstDirectory.snapshot_version === previousDirectory?.snapshot_version;
      if (!sameSnapshot) withdrawDirectoryPage();
      if (sameSnapshot) {
        if (previousTurnPage > 0 && turnCursors[previousTurnPage]) {
          try {
            const page = (await reader.turns(sessionId, { ...nextData.period, limit: 20, cursor: turnCursors[previousTurnPage] })).data;
            if (!current(scope)) return;
            if (page.items.length && page.snapshot_version === firstDirectory.snapshot_version) { nextDirectory = page; nextTurnPage = previousTurnPage; }
            else withdrawDirectoryPage();
          } catch (reason) {
            if (!current(scope)) return;
            if (!(reason instanceof ApiFailure) || reason.code !== 'invalid_cursor') throw reason;
            withdrawDirectoryPage();
          }
        }
        if (previousTurn === undefined || nextDirectory.items.some(item => item.turn_index === previousTurn)) {
          nextTurn = previousTurn;
          if (previousTracePage > 0 && traceCursors[previousTracePage] && previousDirectory?.snapshot) {
            nextTracePage = previousTracePage;
          }
        }
      }
      const renewedSnapshot = nextDirectory.snapshot;
      if (nextTracePage && previousDirectory?.snapshot) nextDirectory = { ...nextDirectory, snapshot: previousDirectory.snapshot };
      const nextTraceCursor = nextTracePage ? traceCursors[nextTracePage] : undefined;
      async function restartTrace() {
        traceDisplay.value++; trace.value = null; tracePage.value = 0; traceCursors = [undefined];
        recovering = 'trace'; nextTracePage = 0; nextDirectory = { ...nextDirectory, snapshot: renewedSnapshot };
        notice.value = '轨迹分页已更新，已从该区块第一页重新读取。';
        return (await reader.fragments(sessionId, { ...nextData.period, limit: 20,
          ...(nextTurn ? { turn: nextTurn } : {}), ...(renewedSnapshot ? { snapshot: renewedSnapshot } : {}) })).data;
      }
      let nextTrace: SessionFragmentsDto;
      try {
        nextTrace = (await reader.fragments(sessionId, { ...nextData.period, limit: 20,
          ...(nextTurn ? { turn: nextTurn } : {}), ...(nextDirectory.snapshot ? { snapshot: nextDirectory.snapshot } : {}),
          ...(nextTraceCursor ? { cursor: nextTraceCursor } : {}) })).data;
      } catch (reason) {
        if (!current(scope)) return;
        if (!nextTraceCursor || !(reason instanceof ApiFailure) || reason.code !== 'invalid_cursor') throw reason;
        nextTrace = await restartTrace();
      }
      if (!current(scope)) return;
      if (nextTracePage && !nextTrace.items.length) { nextTrace = await restartTrace(); if (!current(scope)) return; }
      recovering = null;
      let nextRawPage = samePeriod ? previousRawPage : 0;
      let nextRaw: SessionFragmentsDto | null = null;
      async function restartRaw() {
        rawDisplay.value++; raw.value = null; rawOpen.value = ''; rawPage.value = 0; rawCursors = [undefined];
        recovering = 'raw'; nextRawPage = 0; notice.value = '原始事件分页已更新，已从该区块第一页重新读取。';
        return (await reader.fragments(sessionId, { ...nextData.period, mode: 'raw', limit: 20 })).data;
      }
      if (raw.value || tab.value === 'raw') {
        rawWantedWhileBusy = false;
        rawLoading.value = true;
        const nextRawCursor = nextRawPage ? rawCursors[nextRawPage] : undefined;
        try {
          nextRaw = (await reader.fragments(sessionId, { ...nextData.period, mode: 'raw', limit: 20,
            ...(nextRawCursor ? { cursor: nextRawCursor } : {}) })).data;
        } catch (reason) {
          if (!current(scope)) return;
          if (!nextRawPage || !(reason instanceof ApiFailure) || reason.code !== 'invalid_cursor') throw reason;
          nextRaw = await restartRaw();
        }
        if (!current(scope)) return;
        if (nextRawPage && !nextRaw.items.length) { nextRaw = await restartRaw(); if (!current(scope)) return; }
      }
      recovering = null;
      if (previousTurnPage !== nextTurnPage || previousTracePage !== nextTracePage || previousTurn !== nextTurn || previousRawPage !== nextRawPage) {
        notice.value = '会话分页已更新，已从相关区块第一页重新读取。';
      }
      traceDisplay.value++; rawDisplay.value++;
      data.value = nextData; directory.value = nextDirectory; trace.value = nextTrace; turn.value = nextTurn;
      raw.value = nextRaw; rawPage.value = nextRawPage;
      if (!nextRaw?.items.some(item => `${item.event_id}@${item.occurred_at}` === rawOpen.value)) rawOpen.value = '';
      turnPage.value = nextTurnPage; tracePage.value = nextTracePage;
      if (!nextTurnPage) turnCursors = [undefined];
      if (!nextTracePage) traceCursors = [undefined];
      if (!nextRawPage) rawCursors = [undefined];
    } catch (reason) {
      if (!current(scope)) return;
      if (recovering && reason instanceof ApiFailure && reason.code === 'invalid_cursor') {
        reportPageError(recovering, `${recovering === 'raw' ? '原始事件' : '轨迹'}分页暂无法恢复，请重新加载。`);
        return;
      }
      if (isTransientReadFailure(reason)) error.value = `${periodChanged ? '新范围内容暂未读完' : '刷新失败，当前为上次结果'}：${reason instanceof Error ? reason.message : '请稍后重试'}`;
      else fail(scope, reason);
    } finally {
      if (current(scope)) {
        detailLoading.value = false; rawLoading.value = false;
        await readRequestedRaw();
      }
    }
  }
  async function load() {
    if (disposed) return;
    if (data.value) return refreshCurrent();
    invalidate(); clear();
    error.value = ''; notice.value = ''; tab.value = 'trace'; turn.value = undefined; rawOpen.value = '';
    turnPage.value = 0; tracePage.value = 0; rawPage.value = 0;
    turnCursors = [undefined]; traceCursors = [undefined]; rawCursors = [undefined];
    if (!id.value || !owner.value) return;
    const scope = generation.value, sessionId = id.value;
    detailLoading.value = true;
    try {
      const result = await reader.detail(sessionId);
      if (!current(scope)) return;
      data.value = result.data; await loadTurns();
    } catch (reason) { fail(scope, reason); }
    finally { if (current(scope)) { detailLoading.value = false; await readRequestedRaw(); } }
  }
  async function loadRaw(targetPage = rawPage.value) {
    if (!data.value || disposed) return;
    rawWantedWhileBusy = false;
    const scope = generation.value, request = ++rawRequest.value, sessionId = id.value;
    clearPageError('raw');
    let cursor = rawCursors[targetPage];
    const input = { ...data.value.period, mode: 'raw' as const, limit: 20 };
    rawLoading.value = true;
    try { for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await reader.fragments(sessionId, { ...input, ...(cursor ? { cursor } : {}) });
        if (!current(scope) || request !== rawRequest.value) return;
        if (cursor && attempt === 0 && !result.data.items.length) {
          cursor = undefined; targetPage = 0; rawDisplay.value++; raw.value = null; rawOpen.value = ''; rawPage.value = 0; rawCursors = [undefined];
          notice.value = '原始事件分页已更新，已从该区块第一页重新读取。'; continue;
        }
        rawDisplay.value++; raw.value = result.data; rawPage.value = targetPage;
        if (!raw.value.items.some(item => `${item.event_id}@${item.occurred_at}` === rawOpen.value)) rawOpen.value = '';
        return;
      } catch (reason) {
        if (!current(scope) || request !== rawRequest.value) return;
        if (reason instanceof ApiFailure && reason.code === 'invalid_cursor') {
          rawDisplay.value++; raw.value = null; rawOpen.value = '';
          if (cursor && attempt === 0) {
            cursor = undefined; targetPage = 0; rawPage.value = 0; rawCursors = [undefined];
            notice.value = '原始事件分页已更新，已从该区块第一页重新读取。';
            continue;
          }
          reportPageError('raw', '原始事件分页暂无法恢复，请重新加载。'); return;
        }
        if (isTransientReadFailure(reason)) temporaryPageError('raw', reason, !!raw.value);
        else fail(scope, reason);
        return;
      }
    } } finally { if (current(scope) && request === rawRequest.value) rawLoading.value = false; }
  }
  async function readRequestedRaw() {
    if (loading.value || !rawWantedWhileBusy) return;
    rawWantedWhileBusy = false;
    if (tab.value === 'raw' && !raw.value && !rawLoading.value && data.value && !disposed) await loadRaw();
  }
  function toggleRaw(key: string, opened: boolean) {
    if (opened) rawOpen.value = key;
    else if (rawOpen.value === key) rawOpen.value = '';
  }
  // A refresh cancels old requests while their content remains visible. Keep
  // revocation bound to displayed content, not to the newer refresh request.
  const traceUnavailable = computed(() => {
    const lifetime = readingLifetime.value, content = traceDisplay.value, shown = display.value;
    return (reason: Error) => {
      if (!disposed && lifetime === readingLifetime.value && content === traceDisplay.value && shown === display.value && tab.value === 'trace' && trace.value) fail(generation.value, reason);
    };
  });
  const rawUnavailable = computed(() => {
    const lifetime = readingLifetime.value, content = rawDisplay.value, shown = display.value;
    return (reason: Error) => {
      if (!disposed && lifetime === readingLifetime.value && content === rawDisplay.value && shown === display.value && tab.value === 'raw' && raw.value) fail(generation.value, reason);
    };
  });
  async function changeTab(value: Tab) {
    if (tab.value !== value) { display.value++; tab.value = value; }
    if (value !== 'raw') rawWantedWhileBusy = false;
    else if (!raw.value && !rawLoading.value) {
      if (loading.value) rawWantedWhileBusy = true;
      else await loadRaw();
    }
  }
  async function selectTurn(value?: number) { if (loading.value) return; turn.value = value; await loadTrace(true); }
  async function pageTurns(direction: -1 | 1) {
    if (loading.value || (direction < 0 ? turnPage.value === 0 : !directory.value?.next_cursor)) return;
    if (direction > 0) turnCursors[turnPage.value + 1] = directory.value!.next_cursor!;
    await loadTurns(false, turnPage.value + direction);
  }
  async function pageTrace(direction: -1 | 1) {
    if (loading.value || traceLoading.value || (direction < 0 ? tracePage.value === 0 : !trace.value?.next_cursor)) return;
    if (direction > 0) traceCursors[tracePage.value + 1] = trace.value!.next_cursor!;
    await loadTrace(false, true, tracePage.value + direction);
  }
  async function pageRaw(direction: -1 | 1) {
    if (loading.value || rawLoading.value || !raw.value || (direction < 0 ? rawPage.value === 0 : !raw.value.next_cursor)) return;
    if (direction > 0) rawCursors[rawPage.value + 1] = raw.value.next_cursor!;
    await loadRaw(rawPage.value + direction);
  }
  watch([id, owner], () => { clear(); void load(); }, { immediate: true, flush: 'sync' });
  onScopeDispose(() => { disposed = true; invalidate(); });
  return {
    data: shallowReadonly(data), directory: shallowReadonly(directory), trace: shallowReadonly(trace), raw: shallowReadonly(raw),
    loading, traceLoading: shallowReadonly(traceLoading), rawLoading: shallowReadonly(rawLoading), error: shallowReadonly(error), notice: shallowReadonly(notice), tab: shallowReadonly(tab), turn: shallowReadonly(turn),
    turnPage: shallowReadonly(turnPage), tracePage: shallowReadonly(tracePage), rawPage: shallowReadonly(rawPage), rawOpen: shallowReadonly(rawOpen),
    load, changeTab, selectTurn, pageTurns, pageTrace, pageRaw, toggleRaw, traceUnavailable, rawUnavailable,
  };
}
