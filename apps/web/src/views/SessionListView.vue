<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router';
import { useSession } from '../stores/session.js';
import { useSessionList } from '../composables/session-list.js';
import AnalysisPeriodFilter from '../components/AnalysisPeriodFilter.vue';
const route = useRoute(); const router = useRouter(); const session = useSession();
const { data, loading, error, notice, search, all, page, period, currentChannel, filters, refresh, changePeriod, next, previous, open } = useSessionList({
  route, owner: () => session.user?.user_id ?? '', push: target => router.push(target), replace: target => router.replace(target),
  scrollY: () => window.scrollY, scrollTo: top => window.scrollTo(0, top),
});
const channels = [{ value: 'all', label: '全部会话' }, { value: 'official', label: '有官方记录' }, { value: 'pending', label: '等待同步' }, { value: 'custom', label: '个人自配' }] as const;
const sourceNames:Record<string,string>={official:'有官方记录',pending:'等待同步',custom:'本人确认',mixed:'官方＋本人确认',unknown:'来源未知'};
const format = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
</script>
<template>
  <div class="page-heading">
    <div><h1>{{ all ? '全员Token使用分析' : '我的Token使用分析' }}</h1><p>{{ all ? '按所选期间的活动和本地部门查看会话；Token 仅包含该期间的已关联用量。' : '这里始终是本人的会话，与管理范围分开。' }}</p></div><ElButton
      :disabled="loading"
      @click="refresh"
    >
      刷新列表
    </ElButton>
  </div>
  <AnalysisPeriodFilter
    :period="period"
    :computed-at="undefined"
    :loading="loading"
    @change="changePeriod"
  />
  <div class="session-filter-row">
    <span class="session-filter-label">会话状态</span><div
      class="session-filter-buttons"
      role="radiogroup"
      aria-label="会话状态"
    >
      <button
        v-for="item in channels"
        :key="item.value"
        type="button"
        role="radio"
        :aria-checked="currentChannel === item.value"
        :disabled="loading || !data?.available_channels.includes(item.value)"
        @click="filters({ channel: item.value })"
      >
        {{ item.label }}
      </button>
    </div><span
      v-if="data && !data.channel_available"
      class="muted small-text"
    >官方筛选需要已配置来源及完整日期范围</span>
  </div>
  <p class="muted small-text">
    没有证据的会话在“全部会话”中保留为未知；个人自配依据本人对整个会话的确认，混合会话可同时出现在两类筛选中。
  </p>
  <p
    v-if="data?.snapshot"
    class="muted small-text session-freshness"
    role="status"
    data-testid="session-list-freshness"
  >
    <span>数据截至 <time :datetime="data.snapshot.as_of">{{ format(data.snapshot.as_of) }}</time>（北京时间）</span>
    <span v-if="data.snapshot.updating">数据更新中，当前显示截至上述时间的结果。</span>
    <span>翻页使用当前版本；刷新后可查看最新结果。</span>
  </p>
  <ElAlert
    v-if="error"
    :title="error"
    type="error"
    :closable="false"
    class="page-notice"
  >
    <ElButton
      link
      @click="refresh"
    >
      重试刷新
    </ElButton>
  </ElAlert>
  <ElAlert
    v-if="notice"
    :title="notice"
    type="info"
    :closable="false"
    class="page-notice"
  />
  <div class="page-toolbar">
    <form
      class="search-row"
      @submit.prevent="filters({ search: search.trim() })"
    >
      <ElInput
        v-model="search"
        aria-label="搜索会话"
        placeholder="搜索提示、会话标识或邮箱"
        clearable
        maxlength="128"
      /><ElButton
        native-type="submit"
        :disabled="loading"
      >
        查询
      </ElButton>
    </form><span class="muted">{{ data ? `共 ${data.total} 个会话` : loading ? '正在加载…' : '' }}</span>
  </div>
  <section
    class="data-panel"
    :aria-busy="loading"
  >
    <ElTable
      :data="data?.items ?? []"
      :empty-text="error ? '会话列表暂不可用' : loading ? '正在加载会话…' : '当前范围没有符合筛选条件的会话'"
    >
      <ElTableColumn
        label="会话"
        min-width="260"
      >
        <template #default="{ row }">
          <span class="session-title">{{ row.title }}</span><span class="secondary">{{ row.source_session_id }}</span>
        </template>
      </ElTableColumn><ElTableColumn
        v-if="all"
        label="人员"
        min-width="160"
      >
        <template #default="{ row }">
          {{ row.name }}<span class="secondary">{{ row.email }}</span>
        </template>
      </ElTableColumn><ElTableColumn
        label="最近观测"
        min-width="170"
      >
        <template #default="{ row }">
          {{ format(row.last_at) }}
        </template>
      </ElTableColumn><ElTableColumn
        prop="prompt_turns"
        label="提示轮次"
        width="90"
      /><ElTableColumn
        label="已关联官方 Token / 模型"
        min-width="220"
      >
        <template #default="{row}">
          {{ row.official_tokens===null?'—':BigInt(row.official_tokens).toLocaleString('zh-CN') }}<span class="secondary">{{ sourceNames[row.channel] }}</span>
          <span
            v-if="row.department_unassigned_records"
            class="secondary"
          >部门待归属 {{ row.department_unassigned_records }} 条（本地历史缺失或跨调岗，未计入部门）</span>
          <span
            v-if="(row.session_coverage?.state??'unknown')==='unknown'"
            class="secondary"
          >会话完整性未知</span>
          <span
            v-if="row.official_records && row.official_tokens===null"
            class="secondary"
          >官方记录缺少 Token 字段</span>
          <span
            v-if="row.model_count"
            class="secondary"
          >{{ row.model_count===1?row.model:`${row.model_count} 个官方模型` }}</span>
          <span
            v-if="row.personal_models.length"
            class="secondary session-model-summary"
            :title="`本人确认（会话级）：${row.personal_models.join('、')}`"
          >本人确认（会话级）：{{ row.personal_models.join('、') }}</span>
          <span
            v-if="row.attribution_conflicts"
            class="secondary"
          >{{ row.attribution_conflicts }} 个计费标识存在归因冲突</span>
        </template>
      </ElTableColumn><ElTableColumn
        label="操作"
        width="110"
      >
        <template #default="{ row }">
          <ElButton
            link
            type="primary"
            @click="open(row.id)"
          >
            查看详情
          </ElButton>
        </template>
      </ElTableColumn>
    </ElTable><div class="table-pager">
      <span>第 {{ page }} 页 · 每页 20 条</span><div>
        <ElButton
          :disabled="loading || page === 1"
          @click="previous"
        >
          上一页
        </ElButton><ElButton
          :disabled="loading || !data?.has_more"
          @click="next"
        >
          下一页
        </ElButton>
      </div>
    </div>
  </section>
</template>
<style scoped>
.session-filter-row { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 16px 0; margin-bottom: 8px; }
.session-filter-label { width: 64px; flex-shrink: 0; color: #a6b4c9; font-size: var(--ui-font-small); }
.session-filter-buttons { display: flex; gap: 2px; padding: 3px; border: 1px solid #2b3a50; border-radius: 7px; background: #0b1220; }
.session-filter-buttons button { border: 0; border-radius: 5px; background: transparent; color: #a6b4c9; padding: 8px 12px; font: inherit; font-size: var(--ui-font-small); cursor: pointer; }
.session-filter-buttons button[aria-checked='true'] { background: #1e3a5f; color: #93c5fd; }
.session-filter-buttons button:disabled { opacity: .5; cursor: not-allowed; }
.session-title { overflow-wrap: anywhere; }.secondary { overflow-wrap: anywhere; }
.session-model-summary { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.session-freshness { display: flex; flex-wrap: wrap; gap: 4px 12px; }
</style>
