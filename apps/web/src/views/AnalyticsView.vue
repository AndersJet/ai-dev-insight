<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElTooltip } from 'element-plus';
import type { OfficialUsageDto, ContentEstimateDto, AnalyticsOverviewDto, AnalyticsTrendsDto, AnalyticsGroupsDto, AnalyticsPurposesDto, AnalyticsPageQueryDto } from '@adi/contracts';
import * as api from '../api/analytics.js';
import { ApiFailure, isTransientReadFailure } from '../api/http.js';
import {useDirectory} from '../composables/directory.js';
import {useMemberStatisticsNavigation} from '../stores/member-statistics-navigation.js';
import { useSession } from '../stores/session.js';
import { useAnalysisPeriod, type AnalysisPeriod } from '../stores/analysis-period.js';
import AdoptionPanel from '../components/AdoptionPanel.vue';
import AppIcon from '../components/AppIcon.vue';
import AnalysisPeriodFilter from '../components/AnalysisPeriodFilter.vue';
import OfficialUsagePanel from '../components/OfficialUsagePanel.vue';
import ContentEstimatePanel from '../components/ContentEstimatePanel.vue';
import AnalysisTrend from '../components/AnalysisTrend.vue';
import ModelAnalysisPanel from '../components/ModelAnalysisPanel.vue';
const route = useRoute(); const router = useRouter(); const session = useSession(); const periodStore = useAnalysisPeriod();
const navigation=useMemberStatisticsNavigation();const directory=useDirectory();
const memberId=computed(()=>typeof route.params.memberId==='string'?route.params.memberId:undefined);
const individual=computed(()=>personal.value||!!memberId.value);
const personal = computed(() => route.path.startsWith('/my/'));
const department = computed(() => typeof route.params.departmentId === 'string' ? route.params.departmentId : undefined);
const official=ref<OfficialUsageDto|null>(null);
const officialChat=computed(()=>{const groups=official.value?.groups.filter(row=>row.client==='ide'&&row.scene==='Chat');if(!groups?.length||groups.some(row=>row.tokens===null))return null;return groups.reduce((sum,row)=>sum+BigInt(row.tokens!),0n).toLocaleString('zh-CN');});
const estimate = ref<ContentEstimateDto | null>(null);
const summary = ref<AnalyticsOverviewDto | null>(null); const trend = ref<AnalyticsTrendsDto | null>(null); const purposes = ref<AnalyticsPurposesDto | null>(null); const groups = ref<AnalyticsGroupsDto | null>(null);
const loading = ref(false); const groupLoading = ref(false); const error = ref(''); const search = ref(''); const appliedSearch = ref(''); const page = ref(0); const cursors = ref<(string | undefined)[]>([undefined]);
const displayPeriod = ref<AnalysisPeriod | null>(null);
const refreshRevision = ref(0), groupNotice = ref('');
let generation = 0; let groupGeneration = 0;
const number = (value: number) => value.toLocaleString('zh-CN'); const percent = (value: number | null) => value === null ? '—' : `${Math.round(value * 1000) / 10}%`;
const purposeNames: Record<string, string> = { feature: '功能开发', bugfix: '问题修复', refactor: '代码重构', test: '测试验证', docs: '文档', ops: '工程运维', learning: '学习理解', chat: '一般交流', unknown: '未知 / 待计算' };
const heading = computed(() => memberId.value ? `${summary.value?.scope.member?.name ?? '成员'} · 使用统计` : personal.value ? '我的使用概览' : department.value ? `${summary.value?.scope.label ?? '部门'} · 使用分析` : summary.value?.scope.department_ids ? '我的管理范围 · 使用概览' : '组织 使用概览');
const subtitle = computed(() => memberId.value ? `${summary.value?.scope.member?.email ?? ''} · ${summary.value?.scope.label ?? '所选部门'} · 仅统计所选期间在该部门的观测，不提供会话原文。` : personal.value ? '回看自己的使用习惯与会话过程，让下一次协作更清晰。' : '理解团队如何使用 Trae，为推广和场景交流提供依据。');
const groupKind = computed(() => department.value ? 'members' : 'departments');
const purposeItems = computed(() => [...purposes.value?.items ?? []].sort((a, b) => b.sessions - a.sessions));
function baseQuery(): AnalyticsPageQueryDto {
  const from = route.query.from; const to = route.query.to;
  return { scope: personal.value ? 'self' : 'organization', ...(memberId.value ? {member_id:memberId.value}:{}), ...(department.value && !personal.value ? { department_id: department.value } : {}), ...(from !== undefined || to !== undefined ? { from: String(from ?? ''), to: String(to ?? '') } : periodStore.period ?? {}) };
}
function clearReadings() {
  official.value=null; estimate.value=null; summary.value=null; trend.value=null; purposes.value=null; groups.value=null;
}
function scopeUnavailable(reason: unknown) {
  return reason instanceof ApiFailure && ([401,403].includes(reason.status) || reason.code === 'recovery_quarantined');
}
async function failure(reason: unknown, retained = false, label = '统计') {
  const message = reason instanceof Error ? reason.message : '暂不可用，请重试';
  const detail = retained && isTransientReadFailure(reason) ? `${label}刷新失败，当前为上次结果：${message}` : `${label}：${message}`;
  error.value = error.value ? `${error.value}；${detail}` : detail;
  if (scopeUnavailable(reason)) { clearReadings(); generation++; groupGeneration++; loading.value=false; groupLoading.value=false; }
  if (reason instanceof ApiFailure && reason.status === 401) { await session.refresh(); if (!session.user) await router.replace('/login'); }
}
async function loadGroups(recovering = false): Promise<void> {
  if (!summary.value || individual.value) return;
  const current = ++groupGeneration; const scope = generation; groupLoading.value = true;
  groups.value = null; if (!recovering) groupNotice.value='';
  const cursor = cursors.value[page.value];
  try {
    const response = await api.groups(groupKind.value, { ...baseQuery(), ...summary.value.period, limit: 10, search: appliedSearch.value, ...(cursor ? { cursor } : {}) });
    if (scope === generation && current === groupGeneration) groups.value = response.data;
  } catch (reason) {
    if (scope === generation && current === groupGeneration) {
      if (cursor && reason instanceof ApiFailure && reason.code==='invalid_cursor') { await recoverGroups(); return; }
      await failure(reason);
    }
  }
  finally { if (scope === generation && current === groupGeneration) groupLoading.value = false; }
}
async function recoverGroups() {
  groups.value=null;page.value=0;cursors.value=[undefined];groupNotice.value='对比列表分页已更新，已回到第一页。';
  await loadGroups(true);
}
async function load(refreshing = false) {
  if (route.path !== '/my/overview' && !/^\/organization(?:\/[^/]+(?:\/members\/[^/]+)?)?$/.test(route.path)) { generation++; groupGeneration++; return; }
  const current = ++generation; groupGeneration++; error.value = ''; groupNotice.value=''; loading.value = true;
  if (!refreshing) { clearReadings(); page.value = 0; cursors.value = [undefined]; }
  groupLoading.value = false;
  periodStore.setOwner(session.user?.user_id ?? '');navigation.forOwner(session.user?.user_id??'');
  if (!refreshing && !(navigation.restore && navigation.path === route.fullPath) && route.query.from === undefined && route.query.to === undefined && periodStore.period) {
    await router.replace({ path: route.path, query: { ...route.query, ...periodStore.period } }); return;
  }
  let restoreScroll:number|undefined;
  if(!refreshing&&!memberId.value&&navigation.restore){
    if(navigation.path===route.fullPath){search.value=navigation.search;appliedSearch.value=navigation.appliedSearch;page.value=navigation.page;cursors.value=[...navigation.cursors];restoreScroll=navigation.scroll;}
    navigation.restore=false;
  }
  try {
    const query = baseQuery(); const response = memberId.value ? await api.member(memberId.value,query) : await api.overview(query); if (current !== generation) return;
    summary.value = response.data; displayPeriod.value = response.data.period; periodStore.remember(response.data.period);
    const fixed = { ...query, ...response.data.period };
    const cursor=cursors.value[page.value];
    const results = await Promise.allSettled([api.trends(fixed), api.purposes(fixed), memberId.value ? api.contentEstimate(fixed) : Promise.resolve(null), api.officialUsage(fixed), individual.value ? Promise.resolve(null) : api.groups(groupKind.value, { ...fixed, limit: 10, search: appliedSearch.value,...(cursor?{cursor}:{}) })]);
    if (current !== generation) return;
    const denied = results.find(result => result.status === 'rejected' && scopeUnavailable(result.reason));
    if (denied?.status === 'rejected') { await failure(denied.reason); return; }
    const [trendResult, purposeResult, estimateResult, officialResult, groupResult] = results;
    if (trendResult.status === 'fulfilled') trend.value = trendResult.value.data;
    else { if (!isTransientReadFailure(trendResult.reason)) trend.value=null; void failure(trendResult.reason,!!trend.value,'使用趋势'); }
    if (purposeResult.status === 'fulfilled') purposes.value = purposeResult.value.data;
    else { if (!isTransientReadFailure(purposeResult.reason)) purposes.value=null; void failure(purposeResult.reason,!!purposes.value,'工作用途'); }
    if (estimateResult.status === 'fulfilled') estimate.value = estimateResult.value?.data.estimate ?? null;
    else { if (!isTransientReadFailure(estimateResult.reason)) estimate.value=null; void failure(estimateResult.reason,!!estimate.value,'内容估算'); }
    if (officialResult.status === 'fulfilled') official.value=officialResult.value.data;
    else { if (!isTransientReadFailure(officialResult.reason)) official.value=null; void failure(officialResult.reason,!!official.value,'官方用量'); }
    if (groupResult.status === 'fulfilled') groups.value = groupResult.value?.data ?? null;
    else if(cursor && groupResult.reason instanceof ApiFailure && groupResult.reason.code==='invalid_cursor') await recoverGroups();
    else { if (!isTransientReadFailure(groupResult.reason)) groups.value=null; void failure(groupResult.reason,!!groups.value,'对比列表'); }
    if(current!==generation)return;
    if(refreshing)refreshRevision.value++;
    if(restoreScroll!==undefined&&current===generation){await nextTick();window.scrollTo(0,restoreScroll);}
  } catch (reason) { if (current === generation) { if (!isTransientReadFailure(reason)) clearReadings(); await failure(reason,!!summary.value); } }
  finally { if (current === generation) loading.value = false; }
}
function refreshAll(){void directory.refresh();void load(true);}
function changePeriod(value: AnalysisPeriod) { displayPeriod.value = value; void router.replace({ path: route.path, query: { ...route.query, ...value } }); }
function resetPeriod() {
  periodStore.clear(); displayPeriod.value = null;
  if (route.query.from === undefined && route.query.to === undefined) { void load(); return; }
  const query = { ...route.query }; delete query.from; delete query.to;
  void router.replace({ path: route.path, query });
}
function drill(id: string) { void router.push({ path: `/organization/${id}`, query: { ...summary.value?.period } }); }
function drillMember(id:string){
  if(!department.value)return;navigation.forOwner(session.user?.user_id??'');navigation.path=route.fullPath;navigation.search=search.value;navigation.appliedSearch=appliedSearch.value;navigation.page=page.value;navigation.cursors=[...cursors.value];navigation.scroll=window.scrollY;navigation.restore=true;
  void router.push({path:`/organization/${department.value}/members/${id}`,query:{...summary.value?.period,return:route.fullPath}});window.scrollTo(0,0);
}
function backToDepartment(){const fallback=`/organization/${department.value}`;const candidate=route.query.return;const target=typeof candidate==='string'&&candidate.split('?')[0]===fallback?candidate:fallback;navigation.restore=navigation.path===target;void router.push(target);}
function next(forward: boolean) {
  if (loading.value || groupLoading.value) return;
  if (forward) { if (!groups.value?.next_cursor) return; cursors.value[++page.value] = groups.value.next_cursor; } else page.value = Math.max(0, page.value - 1);
  void loadGroups();
}
function find() { appliedSearch.value = search.value.trim(); page.value = 0; cursors.value = [undefined]; void loadGroups(); }
watch([() => route.path, () => session.user?.user_id], () => { search.value = ''; appliedSearch.value = ''; }, { flush: 'sync' });
watch([() => route.path, () => route.query.from, () => route.query.to, () => session.user?.user_id], () => { void load(); }, { immediate: true, flush: 'sync' });
onBeforeUnmount(() => { generation++; groupGeneration++; });
</script>
<template>
  <div class="page-heading insight-heading">
    <div>
      <span class="brand-kicker">USAGE INTELLIGENCE</span>
      <ElButton
        v-if="memberId"
        class="member-back"
        @click="backToDepartment"
      >
        返回部门列表
      </ElButton><h1>{{ heading }}</h1><p>{{ subtitle }}</p>
    </div><ElButton
      :disabled="loading"
      @click="refreshAll"
    >
      刷新统计
    </ElButton>
  </div>
  <AdoptionPanel
    v-if="!memberId"
    :self="personal"
    :department-id="personal?undefined:department"
    :manage="!personal"
  />
  <p
    v-if="summary?.scope.member?.archived"
    class="muted small-text"
  >
    该账号当前已停用或删除；这里保留所选期间的部门统计。
  </p>
  <AnalysisPeriodFilter
    :period="displayPeriod"
    :computed-at="summary?.quality.computed_at"
    :loading="loading"
    @change="changePeriod"
  />
  <ElAlert
    v-if="error"
    :title="error"
    type="error"
    :closable="false"
    class="page-notice"
  >
    <ElButton
      link
      @click="resetPeriod"
    >
      恢复近7天
    </ElButton>
  </ElAlert>
  <div
    v-if="summary"
    class="analysis-metrics"
  >
    <section
      class="metric-card metric-observed"
      data-testid="metric-observed"
    >
      <span class="metric-emblem"><AppIcon
        name="manage"
        :size="20"
      /></span>
      <div class="metric-title">
        {{ individual ? '使用天数' : '观测到使用' }}<ElTooltip
          :content="individual ? '按北京时间日期去重，只表示观测到提示事件的天数。' : '人数按期间去重；使用覆盖率按已完成注册、且在对应组织归属期间内的人员与提示事件计算。累计采纳率见上方独立卡片。'"
          trigger="click"
        >
          <button
            aria-label="查看观测口径"
            class="metric-help"
          >
            ⓘ
          </button>
        </ElTooltip>
      </div><strong>{{ number(individual ? summary.active_days : summary.observed_users) }}<small>{{ individual ? '天' : '人' }}</small></strong><p>{{ individual ? '交互记录不等于工作时长' : `注册人员观测 ${summary.eligible_observed_users} / ${summary.eligible_users} 人 · ${percent(summary.coverage_ratio)}` }}</p>
    </section>
    <section
      class="metric-card metric-sessions"
      data-testid="metric-sessions"
    >
      <span class="metric-emblem"><AppIcon
        name="traces"
        :size="20"
      /></span>
      <div class="metric-title">
        会话数
      </div><strong>{{ number(summary.sessions) }}</strong><p>按会话标识去重，不等于模型调用次数</p>
    </section>
    <section
      class="metric-card metric-prompts"
      data-testid="metric-prompts"
    >
      <span class="metric-emblem"><AppIcon
        name="prompt"
        :size="20"
      /></span>
      <div class="metric-title">
        用户提示轮次
      </div><strong>{{ number(summary.prompt_turns) }}</strong><p>反映观测到的交互量，不代表交付产出</p>
    </section>
    <section class="metric-card metric-official">
      <span class="metric-emblem"><AppIcon
        name="database"
        :size="20"
      /></span>
      <div class="metric-title">
        官方问答用量
      </div><strong data-testid="official-chat-tokens">{{ officialChat ?? '—' }}</strong><p>已获取的 IDE / Chat 记录，不含补全与客户端未知记录</p>
    </section>
  </div>
  <p
    v-else-if="loading"
    class="muted"
    role="status"
  >
    正在读取统计…
  </p>
  <div
    v-if="summary"
    class="analysis-grid"
    :class="{ 'personal-analysis-grid': personal }"
  >
    <div class="analysis-stack">
      <section
        v-if="!individual"
        class="data-panel"
      >
        <div class="analysis-panel-heading">
          <h2><AppIcon name="manage" />{{ department ? '成员使用统计' : '一级部门对比' }}</h2><span>{{ department ? '仅汇总，不包含会话原文' : '点击部门下钻' }}</span>
        </div>
        <ElAlert
          v-if="groupNotice"
          :title="groupNotice"
          type="info"
          :closable="false"
        />
        <div class="analysis-search">
          <ElInput
            v-model="search"
            :placeholder="department ? '搜索姓名或邮箱' : '搜索部门'"
            :aria-label="department ? '搜索统计成员' : '搜索统计部门'"
            clearable
            :disabled="loading || groupLoading"
            @keyup.enter="find"
          /><ElButton
            :disabled="loading || groupLoading"
            @click="find"
          >
            查询
          </ElButton>
        </div>
        <ElTable
          v-if="groups"
          :data="groups.items"
          row-key="id"
          :empty-text="groupLoading ? '正在读取…' : '当前范围没有匹配的人员或部门'"
        >
          <ElTableColumn
            :label="department ? '成员' : '一级部门'"
            min-width="165"
          >
            <template #default="{ row }">
              <template v-if="department">
                <b>{{ row.name }}</b><span class="secondary">{{ row.email }}</span>
              </template><ElButton
                v-else
                link
                type="primary"
                @click="drill(row.id)"
              >
                {{ row.name }}{{ row.archived ? '（历史）' : '' }}
              </ElButton>
            </template>
          </ElTableColumn>
          <ElTableColumn
            v-if="!department"
            label="有效人员"
            width="84"
          >
            <template #default="{ row }">
              {{ row.eligible_users }}
            </template>
          </ElTableColumn>
          <ElTableColumn
            :label="department ? '观测状态' : '观测使用'"
            :width="department ? 112 : 84"
          >
            <template #default="{ row }">
              <ElTag
                v-if="department"
                :type="row.observed_users ? 'success' : 'info'"
              >
                {{ row.observed_users ? '观测到使用' : row.sessions ? '仅其他事件' : '未观测到' }}
              </ElTag><span v-else>{{ row.observed_users }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn
            v-if="!department"
            label="覆盖比例"
            width="94"
          >
            <template #default="{ row }">
              {{ percent(row.coverage_ratio) }}
            </template>
          </ElTableColumn>
          <ElTableColumn
            v-else
            label="使用天数"
            width="84"
          >
            <template #default="{ row }">
              {{ row.active_days }}
            </template>
          </ElTableColumn>
          <ElTableColumn
            label="会话"
            width="72"
          >
            <template #default="{ row }">
              {{ row.sessions }}
            </template>
          </ElTableColumn>
          <ElTableColumn
            :label="department ? '操作' : ''"
            width="92"
          >
            <template #default="{ row }">
              <ElButton
                link
                type="primary"
                @click="department ? drillMember(row.id) : drill(row.id)"
              >
                {{ department ? '查看统计' : '查看 →' }}
              </ElButton>
            </template>
          </ElTableColumn>
        </ElTable>
        <p
          v-else
          class="analysis-empty"
        >
          {{ loading || groupLoading ? '正在读取…' : '统计表暂不可用，请重试' }}
        </p>
        <div
          v-if="groups"
          class="table-pager"
        >
          <span>共 {{ groups.total }} {{ department ? '人' : '个部门' }} · 第 {{ page + 1 }} 页</span><div>
            <ElButton
              :disabled="page === 0 || loading || groupLoading"
              @click="next(false)"
            >
              上一页
            </ElButton><ElButton
              :disabled="!groups.has_more || loading || groupLoading"
              @click="next(true)"
            >
              下一页
            </ElButton>
          </div>
        </div>
        <div class="panel-footer">
          {{ department ? '按所选期间的历史归属统计，不等同于当前成员名单。搜索仅筛选此表。' : '调岗人员或跨部门会话可能出现在多行；事业部已独立去重，部门行不可直接相加。' }}
        </div>
      </section>
      <section
        v-else
        class="data-panel"
      >
        <div class="analysis-panel-heading">
          <h2><AppIcon name="my" />{{ memberId ? '成员使用概览' : '我的使用复盘' }}</h2><span>当前所选期间</span>
        </div><div class="personal-insights">
          <p>观测到 {{ summary.prompt_turns }} 次提示、{{ summary.tool_events }} 条工具返回事件。</p><p>{{ memberId ? '仅汇总该成员在当前部门与日期范围内的观测，不提供提示词、回复或执行原文。' : '通过自己已提供的 Hook 记录回顾使用情况；没有观测到事件，不代表没有使用 Trae。' }}</p><p>官方记录按来源与场景单列；未取得模型证据时保留未知，不把内容估算当作实际计费用量。</p>
        </div>
      </section>
      <ContentEstimatePanel
        v-if="memberId && estimate"
        :estimate="estimate"
      />
      <section
        v-if="memberId"
        class="analysis-quality"
      >
        <strong>如何理解这些数据</strong><p>观测到使用不等于完整采集；没有事件不自动等于未使用。覆盖分母不使用全部平台注册账号。</p><p v-if="summary.observed_outside_eligibility || summary.outside_eligibility_prompt_events">
          {{ summary.observed_outside_eligibility }} 位观测人员没有注册及归属期间内的提示；共有 {{ summary.outside_eligibility_prompt_events }} 条提示发生在注册或组织归属范围外。
        </p><p v-if="summary.quality.unassigned_events">
          {{ summary.quality.unassigned_events }} 条事件缺少发生时部门，保留为未归属，不回填到当前部门。
        </p><p v-if="summary.quality.pending_sessions">
          {{ summary.quality.pending_sessions }} 个相关会话的派生结果{{ summary.quality.state === 'rebuilding' ? '正在重建' : '待补齐' }}，用途可能暂显示未知。
        </p>
      </section>
    </div>
    <div class="analysis-stack">
      <section class="data-panel">
        <div class="analysis-panel-heading">
          <h2><AppIcon name="trend" />使用趋势</h2><span>{{ individual ? '每日提示轮次' : '每日观测人数' }}</span>
        </div><div class="analysis-panel-body">
          <AnalysisTrend
            v-if="trend"
            :data="trend"
            :personal="individual"
          /><p
            v-else
            class="muted small-text"
          >
            {{ loading ? '正在读取…' : '趋势暂不可用' }}
          </p>
        </div>
      </section>
      <section class="data-panel">
        <div class="analysis-panel-heading">
          <h2><AppIcon name="purpose" />工作用途</h2><span>所选范围内的场景线索</span>
        </div><div
          v-if="purposes"
          class="analysis-panel-body purpose-list"
          :role="personal ? 'region' : undefined"
          :aria-label="personal ? '工作用途分类列表' : undefined"
          :tabindex="personal ? 0 : undefined"
        >
          <p
            v-if="!purposes.total_sessions"
            class="muted small-text"
          >
            所选期间暂无会话记录。
          </p><div
            v-for="item in purposeItems"
            :key="item.purpose"
            class="purpose-row"
            :data-purpose="item.purpose"
          >
            <span>{{ purposeNames[item.purpose] ?? item.purpose }}</span><div class="purpose-track">
              <div :style="{ width: `${(item.ratio ?? 0) * 100}%` }" />
            </div><span>{{ item.sessions }}</span>
          </div>
        </div><p
          v-else
          class="analysis-empty"
        >
          {{ loading ? '正在计算…' : '用途暂不可用' }}
        </p><div class="panel-footer">
          规则与行为推断，仅用于场景交流，不构成工作性质的确定结论。
        </div>
      </section>
    </div>
  </div>
  <OfficialUsagePanel
    v-if="official"
    :data="official"
  />
  <ModelAnalysisPanel
    v-if="summary"
    :query="{...baseQuery(),...summary.period}"
    :revision="refreshRevision"
    @unavailable="failure"
  />
</template>
<style scoped>
.member-back{margin-bottom:14px}
.page-heading > div { min-width: 0; }.page-heading h1 { overflow-wrap: anywhere; }
.analysis-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin: 12px 0 24px; }.metric-card { padding: 20px; }.metric-title { display: flex; justify-content: space-between; color: #a6b4c9; font-size: var(--ui-font-small); }.metric-card strong { display: block; font-size: var(--ui-font-metric); line-height: 1.3; margin: 14px 0 10px; }.metric-card small { font-size: var(--ui-font-body); margin-left: 6px; font-weight: 400; }.metric-card p { font-size: var(--ui-font-small); color: #8195b1; margin: 0; line-height: 1.6; }.metric-help { border: 0; background: transparent; color: #8195b1; cursor: pointer; }
.analysis-grid { display: grid; grid-template-columns: minmax(0, 1.65fr) minmax(310px, 1fr); gap: 20px; }.analysis-stack { display: flex; flex-direction: column; gap: 20px; min-width: 0; }.analysis-panel-heading { padding: 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid #2b3a50; }.analysis-panel-heading h2 { margin: 0; font-size: var(--ui-font-section); font-weight: 700; }.analysis-panel-heading span { font-size: var(--ui-font-small); color: #8195b1; }.analysis-panel-body { padding: 20px; }.analysis-empty { padding: 20px; color: #a6b4c9; font-size: var(--ui-font-small); }.analysis-search { display: flex; padding: 12px 16px; gap: 8px; }.analysis-search .el-input { max-width: 250px; }
.analysis-quality { border: 1px solid #254066; background: #122139; border-radius: 9px; padding: 16px 20px; font-size: var(--ui-font-small); }.analysis-quality strong { color: #93c5fd; }.analysis-quality p { margin: 8px 0 0; color: #a6b4c9; line-height: 1.7; }.purpose-row { display: grid; grid-template-columns: 98px 1fr 22px; gap: 12px; align-items: center; font-size: var(--ui-font-small); color: #a6b4c9; margin: 0 0 14px; }.purpose-row:last-child { margin-bottom: 0; }.purpose-track { height: 6px; background: #233249; border-radius: 3px; overflow: hidden; }.purpose-track > div { height: 100%; background: #3b82f6; border-radius: 3px; }.personal-insights { padding: 12px 20px; color: #a6b4c9; font-size: var(--ui-font-body); line-height: 1.8; }.member-summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin: 24px 0; color: #a6b4c9; font-size: var(--ui-font-small); }.member-summary strong { display: block; color: #f1f5f9; font-size: var(--ui-font-metric); margin-top: 8px; }
.analysis-grid.personal-analysis-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.analysis-grid.personal-analysis-grid > .analysis-stack { display: contents; }
.personal-analysis-grid .data-panel { display: flex; flex-direction: column; min-width: 0; max-height: 360px; overflow: hidden; }
.personal-analysis-grid .analysis-panel-heading { align-items: flex-start; flex-direction: column; gap: 6px; flex-shrink: 0; }
.personal-analysis-grid .analysis-panel-body, .personal-analysis-grid .personal-insights { flex: 1; min-height: 0; overflow-y: auto; }
.personal-analysis-grid .purpose-list { scrollbar-gutter: stable; }
.personal-analysis-grid .purpose-list:focus-visible { outline: 2px solid var(--ui-chart-observed); outline-offset: -3px; }
.personal-analysis-grid .panel-footer { flex-shrink: 0; margin-top: auto; }
@media (max-width: 1200px) { .analysis-grid { grid-template-columns: minmax(0, 1fr); } .analysis-stack:last-child { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 1200px) { .analysis-grid.personal-analysis-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 850px) { .analysis-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .analysis-stack:last-child { display: flex; } }
@media (max-width: 480px) { .analysis-metrics { grid-template-columns: minmax(0, 1fr); }.member-summary { grid-template-columns: repeat(2, 1fr); } }
</style>
