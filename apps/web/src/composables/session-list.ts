import { computed, nextTick, onScopeDispose, ref, watch } from 'vue';
import type { RouteLocationNormalizedLoaded, RouteLocationRaw } from 'vue-router';
import type { AllSessionQueryDto, SessionListDto } from '@adi/contracts';
import * as api from '../api/sessions.js';
import { ApiFailure, isTransientReadFailure } from '../api/http.js';
import { useAnalysisPeriod, type AnalysisPeriod } from '../stores/analysis-period.js';
import { useSessionNavigation } from '../stores/session-navigation.js';

type ListRoute = Pick<RouteLocationNormalizedLoaded, 'path' | 'fullPath' | 'query'>;
type ListOptions = {
  route: ListRoute;
  owner: () => string;
  push: (target: RouteLocationRaw) => unknown;
  replace?: (target: RouteLocationRaw) => unknown;
  scrollY: () => number;
  scrollTo: (top: number) => void;
  read?: typeof api.list;
  afterRender?: () => Promise<unknown>;
};

/** Own the session-list request, pagination and return-position lifecycle. */
export function useSessionList(options: ListOptions) {
  const { route } = options;
  const periods = useAnalysisPeriod();
  const navigation = useSessionNavigation();
  const read = options.read ?? api.list;
  const afterRender = options.afterRender ?? nextTick;
  const data = ref<SessionListDto | null>(null);
  const loading = ref(false);
  const error = ref(''), notice = ref('');
  const search = ref('');
  const period = ref<AnalysisPeriod | null>(null);
  const all = computed(() => route.path.startsWith('/all/'));
  const page = computed(() => Math.max(1, Number(route.query.page) || 1));
  const currentChannel = computed(() => String(route.query.channel ?? 'all'));
  let generation = 0;
  let disposed = false;
  let shownOwner = '', shownPath = '';
  let repairScope: string | null = null;
  function filterScope() {
    return JSON.stringify([options.owner(), route.path, Object.entries(route.query).filter(([key]) => key !== 'cursor' && key !== 'page').sort(([a], [b]) => a.localeCompare(b))]);
  }

  function pageKey(index: number, selectedPeriod = period.value) {
    return JSON.stringify([route.path, selectedPeriod, route.query.search ?? '', route.query.channel ?? 'all', route.query.dept ?? 'all', index]);
  }

  async function load(refreshing = false, keepDraft = false) {
    if (disposed) return;
    const current = ++generation;
    const owner = options.owner();
    const fullPath = route.fullPath;
    const isCurrent = () => !disposed && current === generation && owner === options.owner() && fullPath === route.fullPath;
    const keepPrevious = refreshing && !!data.value && shownOwner === owner && shownPath === fullPath;
    if (navigation.owner !== owner) period.value = null;
    navigation.forOwner(owner);
    periods.setOwner(owner);
    if (!keepPrevious) { data.value = null; if (!keepDraft) search.value = String(route.query.search ?? ''); }
    if (!keepDraft) notice.value = '';
    error.value = '';
    loading.value = Boolean(owner);
    if (!owner) return;
    const { from, to, cursor, dept } = route.query;
    const input: AllSessionQueryDto = {
      ...(from !== undefined || to !== undefined ? { from: String(from ?? ''), to: String(to ?? '') } : (keepPrevious ? period.value : periods.period) ?? {}),
      limit: 20, search: String(route.query.search ?? ''), channel: currentChannel.value as NonNullable<AllSessionQueryDto['channel']>,
      ...(typeof cursor === 'string' ? { cursor } : {}),
      ...(all.value && typeof dept === 'string' && dept !== 'all' ? { department_id: dept } : {}),
    };
    try {
      const result = await read(all.value, input);
      if (!isCurrent()) return;
      data.value = result.data; period.value = result.data.period;
      shownOwner = owner; shownPath = fullPath;
      periods.remember(result.data.period);
      navigation.rememberPage(owner, pageKey(page.value, result.data.period), fullPath);
      await afterRender();
      if (!isCurrent()) return;
      if (!refreshing) {
        const top = navigation.takeScroll(owner, fullPath);
        if (top !== null) options.scrollTo(top);
      }
    } catch (reason) {
      if (isCurrent()) {
        const message = reason instanceof ApiFailure&&reason.code==='session_snapshot_pending'?'会话列表正在更新，请稍后刷新。':reason instanceof ApiFailure&&reason.code==='session_snapshot_expired'?'当前列表版本已过期，请刷新列表重新查询。':reason instanceof Error ? reason.message : '会话暂不可用';
        if (reason instanceof ApiFailure && ['invalid_cursor','session_snapshot_expired'].includes(reason.code) && typeof cursor === 'string') {
          data.value = null; repairScope = filterScope();
          notice.value = reason.code==='session_snapshot_expired'?'当前列表版本已过期，已回到第一页重新查询。':'列表分页已更新，已回到第一页。';
          try {
            await (options.replace ?? options.push)({ path: route.path, query: { ...route.query, cursor: undefined, page: undefined } });
          } catch {
            if (isCurrent()) { repairScope = null; notice.value = ''; error.value = '无法返回第一页，请重试。'; }
          }
        } else if (keepPrevious && !data.value?.snapshot && isTransientReadFailure(reason)) error.value = `刷新失败，当前为上次结果：${message}`;
        else { data.value = null; error.value = message; }
      }
    } finally {
      if (isCurrent()) loading.value = false;
    }
  }

  function filters(query: Record<string, string>) {
    return options.push({ path: route.path, query: { ...route.query, ...query, cursor: undefined, page: undefined } });
  }
  async function refresh() {
    if(disposed)return;
    if(data.value?.snapshot&&(typeof route.query.cursor==='string'||page.value>1)){
      const current=++generation,owner=options.owner(),fullPath=route.fullPath;
      repairScope=filterScope();data.value=null;loading.value=true;error.value='';notice.value='';
      try{await(options.replace??options.push)({path:route.path,query:{...route.query,cursor:undefined,page:undefined}});}
      catch{if(!disposed&&current===generation&&owner===options.owner()&&fullPath===route.fullPath){repairScope=null;loading.value=false;error.value='无法重新查询最新列表，请重试。';}}
      return;
    }
    return load(true);
  }
  function changePeriod(value: AnalysisPeriod) { periods.remember(value); return filters(value); }
  function next() {
    if (data.value?.next_cursor) return options.push({ path: route.path, query: { ...route.query, ...data.value.period, cursor: data.value.next_cursor, page: String(page.value + 1) } });
  }
  function previous() {
    const target = navigation.previous(options.owner(), pageKey(page.value - 1));
    return target ? options.push(target) : filters({});
  }
  function open(id: string) {
    navigation.open(options.owner(), route.fullPath, options.scrollY());
    const target = options.push({ path: `${all.value ? '/all' : '/my'}/sessions/${id}`, query: { ...route.query, return: route.fullPath } });
    options.scrollTo(0);
    return target;
  }

  watch([options.owner, () => route.fullPath], () => {
    const keepDraft = repairScope !== null && repairScope === filterScope();
    repairScope = null; void load(false, keepDraft);
  }, { immediate: true, flush: 'sync' });
  onScopeDispose(() => { disposed = true; generation++; });
  return { data, loading, error, notice, search, period, all, page, currentChannel, filters, refresh, changePeriod, next, previous, open };
}
