<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSessionDetailReading } from '../composables/session-detail.js';
import { useSession } from '../stores/session.js';
import { useSessionNavigation } from '../stores/session-navigation.js';
import TokenAnalysisDialog from '../components/TokenAnalysisDialog.vue';
const analysisOpen=ref(false);
import SessionContent from '../components/SessionContent.vue';
import SessionTraceEvent from '../components/SessionTraceEvent.vue';
import SessionOfficialUsagePanel from '../components/SessionOfficialUsagePanel.vue';
import PersonalModelConfirmation from '../components/PersonalModelConfirmation.vue';
const route = useRoute(); const router = useRouter(); const session = useSession(); const navigation = useSessionNavigation();
const id = computed(() => String(route.params.sessionId));
const owner = computed(() => session.user?.user_id ?? '');
const { data, directory, trace, raw, loading, traceLoading, rawLoading, error, tab, turn,
  turnPage, tracePage, rawPage, rawOpen, notice, load, changeTab, selectTurn, pageTurns,
  pageTrace, pageRaw, traceUnavailable, rawUnavailable, toggleRaw: setRawOpen } = useSessionDetailReading(id, owner);
watch([id,owner],()=>{analysisOpen.value=false;});
const detailRevision=ref(0);
watch(data,()=>{detailRevision.value++;},{flush:'sync'});
const tabs = [{ key: 'trace', name: '执行轨迹' }, { key: 'usage', name: '官方用量' }, { key: 'raw', name: '原始事件' }, { key: 'info', name: '会话信息' }] as const;
const traceQuality=computed(()=>{
  const labels:Record<string,string>={completion_unconfirmed:'有提示轮次的完成情况尚未确认；后续轮次完成不补齐这些缺口。',completion_association_inferred:'完成通知的轮次归属为推断，不证明模型调用链完整。',stop_reentry_count_missing:'部分Stop未提供重入计数，保持未知而非0。',stop_reentry_count_invalid:'部分Stop计数格式或范围无效，未作为次数使用。',stop_reentry_count_reset:'同一提示轮次内的Stop计数曾下降，保留原值，不据此新建轮次。',missing_prompt_text:'部分提示记录缺少正文，不能将缺失视为无输入。',missing_tool_identity:'部分工具缺少调用标识，无法可靠配对。',incomplete_tool_pairs:'部分工具缺少开始或返回记录，轨迹不完整。',clock_order_conflict:'部分开始与返回时间冲突，未补造耗时。',orphan_events:'部分事件无法归属提示轮次，可在全部事件中查看。',cross_turn_tool_response:'部分工具返回出现在后续提示之后，已按唯一调用标识归入原轮次。',tool_identity_conflict:'工具标识存在冲突，无法确定的返回未强行配对。',completion_association_ambiguous:'完成通知可能对应多轮，未将其标为当前轮次完成。',unpaired_completion_notification:'部分完成通知缺少可对应的停止记录，轮次归属未确定。'};
  return (data.value?.quality??[]).flatMap(code=>labels[code]?[labels[code]!]:[]);
});
const eventKey=(event:{event_id:string;occurred_at:string})=>`${event.event_id}@${event.occurred_at}`;
const visibleTrace = computed(() => (trace.value?.items ?? []).filter(event => event.kind !== 'PostToolUse' || !event.pre_ref || !trace.value?.items.some(other => other.event_id === event.pre_ref?.event_id&&other.occurred_at===event.pre_ref?.occurred_at)));
function toggleRaw(event: Event, eventId: string) {
  if (event.currentTarget instanceof window.HTMLDetailsElement) setRawOpen(eventId, event.currentTarget.open);
}
function back() {
  void router.push(navigation.returnTo(owner.value, route.path.startsWith('/all/'), route.query.return));
}
const format = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
</script>
<template>
  <TokenAnalysisDialog
    v-if="analysisOpen && data"
    :key="`${owner}:${id}`"
    :session-id="id"
    :user-id="data.user_id"
    :all="route.path.startsWith('/all/')"
    @close="analysisOpen=false"
    @invalidated="analysisOpen=false; load()"
  />
  <div class="detail-return-row">
    <ElButton @click="back">
      返回原列表
    </ElButton><span class="muted small-text">返回时保留日期、筛选和列表位置</span><div class="detail-return-actions">
      <ElButton
        :disabled="loading"
        :loading="loading"
        @click="load"
      >
        重新加载
      </ElButton><ElButton
        :disabled="!data"
        @click="analysisOpen=true"
      >
        Token能效分析
      </ElButton>
    </div>
  </div>
  <div class="page-heading">
    <div>
      <div class="detail-eyebrow">
        SESSION DETAIL
      </div><h1>会话详情</h1><p v-if="data">
        {{ data.name }} · {{ data.email }} · {{ data.user_id === session.user?.user_id ? '本人会话' : '正在查看他人会话' }}
      </p>
    </div>
  </div>
  <ElAlert
    v-if="error"
    :title="error"
    type="error"
    :closable="false"
  />
  <p
    v-if="loading && !data"
    role="status"
    class="muted"
  >
    正在读取会话…
  </p>
  <ElAlert
    v-if="notice"
    :title="notice"
    type="info"
    :closable="false"
  />
  <template v-if="data">
    <ElAlert
      v-if="data.partial_history"
      title="当前仅展示可读取的记录；近期窗口之外或已清理的内容不包含在内。"
      type="info"
      :closable="false"
      class="page-notice"
    /><div
      class="detail-tabs"
      role="tablist"
      aria-label="会话详情视图"
    >
      <button
        v-for="item in tabs"
        :key="item.key"
        type="button"
        role="tab"
        :aria-selected="tab === item.key"
        @click="changeTab(item.key)"
      >
        {{ item.name }}
      </button>
    </div>
    <ElAlert
      v-if="tab==='trace' && traceQuality.length"
      :title="traceQuality.join(' ')"
      type="info"
      :closable="false"
      class="page-notice"
      data-testid="trace-quality"
    />
    <div
      v-if="tab === 'trace'"
      class="reading-trace"
    >
      <aside
        class="turn-outline"
        aria-label="会话轮次"
      >
        <div class="muted small-text">
          会话轮次 · 近期 {{ data.prompt_turns }} 轮提示
        </div><button
          type="button"
          :class="{selected:turn===undefined}"
          :disabled="loading||traceLoading"
          @click="selectTurn()"
        >
          全部事件（含未归属）
        </button><button
          v-for="item in directory?.items ?? []"
          :key="item.turn_index"
          type="button"
          :class="{ selected: turn === item.turn_index }"
          :disabled="loading || traceLoading"
          @click="selectTurn(item.turn_index)"
        >
          <span>第 {{ item.turn_index }} 轮</span><small>{{ item.prompt_preview || '提示位于近期窗口之外' }}</small>
        </button><div class="turn-pager">
          <ElButton
            size="small"
            :disabled="loading || turnPage === 0"
            @click="pageTurns(-1)"
          >
            上一组
          </ElButton><ElButton
            size="small"
            :disabled="loading || !directory?.has_more"
            @click="pageTurns(1)"
          >
            下一组
          </ElButton>
        </div><p>定位轮次后阅读内容。工具步骤可以展开；原始事件独立分页。</p>
      </aside><section
        class="turn-stream"
        data-testid="session-trace"
      >
        <div class="turn-stream-heading">
          <h2>{{ turn ? `第 ${turn} 轮` : '已观测记录' }}</h2><span>{{ trace ? trace.projection_ready ? '轨迹已计算' : '派生待更新，可重新加载' : '轨迹尚未读取' }}</span>
        </div><p
          v-if="traceLoading || (loading && !trace)"
          class="muted trace-notice"
        >
          正在读取轨迹…
        </p><SessionTraceEvent
          v-for="event in visibleTrace"
          :key="`${id}:${eventKey(event)}`"
          :session-id="id"
          :event="event"
          :period="data.period"
          @unavailable="traceUnavailable"
        /><p
          v-if="!traceLoading && !loading && !trace"
          class="muted trace-notice"
        >
          轨迹尚未读取，可重新加载。
        </p><p
          v-else-if="!traceLoading && !loading && trace && !visibleTrace.length"
          class="muted trace-notice"
        >
          当前未观测到可展示的轨迹。
        </p><div class="table-pager">
          <span>轨迹第 {{ tracePage + 1 }} 页</span><div>
            <ElButton
              :disabled="loading || traceLoading || tracePage === 0"
              @click="pageTrace(-1)"
            >
              前段轨迹
            </ElButton><ElButton
              :disabled="loading || traceLoading || !trace?.has_more"
              @click="pageTrace(1)"
            >
              后段轨迹
            </ElButton>
          </div>
        </div><p class="trace-notice muted small-text">
          提示轮次依据可观测提交记录划分，不推断人工或自动来源；未关联记录可在全部事件与原始事件中查看，不等于完整模型调用链。
        </p>
      </section>
    </div>
    <section
      v-else-if="tab === 'usage'"
      class="detail-panel"
    >
      <h2>官方用量</h2><SessionOfficialUsagePanel
        :session-id="id"
        :period="data.period"
      /><PersonalModelConfirmation
        :session-id="id"
        :revision="detailRevision"
      />
    </section>
    <section
      v-else-if="tab === 'raw'"
      class="detail-panel"
    >
      <h2>原始事件</h2><p class="muted small-text">
        按需展开原始 JSON；数字保持原始精度，内容以纯文本显示。
      </p><details
        v-for="event in raw?.items ?? []"
        :key="eventKey(event)"
        class="raw-event"
        :open="rawOpen === eventKey(event)"
        @toggle="toggleRaw($event, eventKey(event))"
      >
        <summary>{{ event.kind }} <span>{{ format(event.occurred_at) }}</span></summary><SessionContent
          v-if="rawOpen === eventKey(event)"
          :session-id="id"
          :event-id="event.event_id"
          :occurred-at="event.occurred_at"
          part="payload"
          :period="data.period"
          @unavailable="rawUnavailable"
        />
      </details><p
        v-if="rawLoading || (loading && !raw)"
        class="muted"
      >
        正在读取事件…
      </p><p
        v-else-if="!raw"
        class="muted"
      >
        原始事件尚未读取，可重新加载。
      </p><p
        v-else-if="!raw.items.length"
        class="muted"
      >
        当前范围内没有可读取的原始事件。
      </p><div class="table-pager">
        <span>原始事件第 {{ rawPage + 1 }} 页</span><div>
          <ElButton
            :disabled="loading || rawLoading || !raw || rawPage === 0"
            @click="pageRaw(-1)"
          >
            上一页事件
          </ElButton><ElButton
            :disabled="loading || rawLoading || !raw?.has_more"
            @click="pageRaw(1)"
          >
            下一页事件
          </ElButton>
        </div>
      </div>
    </section>
    <section
      v-else
      class="detail-panel"
      data-testid="session-info"
    >
      <h2>会话信息</h2><dl><dt>会话标识</dt><dd>{{ data.source_session_id }}</dd><dt>工作邮箱</dt><dd>{{ data.email }}</dd><dt>首条观测</dt><dd>{{ format(data.first_at) }}</dd><dt>最近观测</dt><dd>{{ format(data.last_at) }}</dd><dt>近期原始事件</dt><dd>{{ data.events }}</dd><dt>可见时间范围</dt><dd>{{ format(data.period.from) }} 至 {{ format(data.period.to) }}（结束不含）</dd><dt>读取范围</dt><dd>{{ data.user_id === session.user?.user_id ? '本人会话' : '超级管理员查看他人会话' }}</dd><dt>轨迹计算时间</dt><dd>{{ data.computed_at ? format(data.computed_at) : '尚未计算' }}</dd></dl>
    </section>
  </template>
</template>
<style scoped>
.detail-return-actions { margin-left:auto;display:flex;gap:8px;align-items:center; }.detail-return-actions :deep(.el-button) { margin-left:0; }
.detail-return-row { display: flex; align-items: center; gap: 16px; margin-bottom: 28px; }.detail-return-row > :last-child { margin-left: auto; }.detail-eyebrow { color: #60a5fa; letter-spacing: .12em; font-size: var(--ui-font-small); margin-bottom: 10px; }
.usage-disclosure { border-top: 1px solid #2b3a50; padding: 18px 0; }.usage-disclosure > summary { cursor: pointer; font-size: var(--ui-font-body); }.usage-disclosure > summary small { margin-left: 12px; color: #91a3be; }
.detail-tabs { display: flex; gap: 24px; border-bottom: 1px solid #2b3a50; margin-bottom: 24px; }.detail-tabs button { border: 0; border-bottom: 2px solid transparent; padding: 12px 0; background: none; color: #a6b4c9; cursor: pointer; font: inherit; font-size: var(--ui-font-body); }.detail-tabs button[aria-selected='true'] { color: #60a5fa; border-bottom-color: #60a5fa; }
.reading-trace { display: grid; grid-template-columns: 210px minmax(0, 1fr); gap: 24px; }.turn-outline { align-self: start; position: sticky; top: 20px; max-height: calc(100vh - 40px); overflow-y: auto; }.turn-outline > button { display: block; width: 100%; background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 12px; margin: 10px 0; text-align: left; color: #a6b4c9; cursor: pointer; }.turn-outline > button.selected { background: #1a2c46; border-color: #2b3a50; color: #93c5fd; }.turn-outline small { display: block; margin-top: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.turn-outline p { font-size: var(--ui-font-small); }.turn-pager { display: flex; }
.turn-stream { background: #172338; border: 1px solid #2b3a50; border-radius: 9px; min-width: 0; }.turn-stream-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px 22px; border-bottom: 1px solid #2b3a50; }.turn-stream-heading h2 { font-size: var(--ui-font-section); margin: 0; }.turn-stream-heading span { font-size: var(--ui-font-small); color: #8195b1; }.trace-notice { padding: 0 22px; }
.detail-panel { padding: 24px; background: #172338; border: 1px solid #2b3a50; border-radius: 9px; }.detail-panel h2 { font-size: var(--ui-font-section); margin-top: 0; }.detail-panel dl { display: grid; grid-template-columns: 140px minmax(0,1fr); gap: 18px; font-size: var(--ui-font-body); }.detail-panel dt { color: #8195b1; }.detail-panel dd { margin: 0; overflow-wrap: anywhere; }.detail-kpis { display: grid; grid-template-columns: repeat(3,1fr); gap: 24px; padding: 20px 0; color: #a6b4c9; font-size: var(--ui-font-body); }.detail-kpis b { display: block; font-size: var(--ui-font-metric); color: #f1f5f9; margin: 12px 0; }.detail-kpis small { color: #8195b1; font-size: var(--ui-font-small); }.raw-event { border-top: 1px solid #2b3a50; padding: 16px 0; }.raw-event summary { cursor: pointer; font-size: var(--ui-font-body); }.raw-event summary span { margin-left: 18px; color: #8195b1; font-size: var(--ui-font-small); }
@media (max-width: 1000px) { .reading-trace { grid-template-columns: 1fr; }.turn-outline { position: static; max-height: 220px; }.detail-tabs { gap: 18px; } }
</style>
