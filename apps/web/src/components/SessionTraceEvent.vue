<script setup lang="ts">
import { ref } from 'vue';
import type { SessionFragmentDto } from '@adi/contracts';
import SessionContent from './SessionContent.vue';
defineProps<{ sessionId: string; event: SessionFragmentDto; period: { from: string; to: string } }>();
const emit = defineEmits<{ unavailable: [reason: Error] }>();
const opened = ref(false); const statuses: Record<string, string> = { incomplete: '配对不完整', returned: '已返回 · 结果未明确', success: '明确成功', error: '明确失败' };
function toggle(event: Event) { opened.value = event.currentTarget instanceof window.HTMLDetailsElement && event.currentTarget.open; }
const time = (at: string) => new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
</script>
<template>
  <div
    v-if="event.kind === 'UserPromptSubmit' || event.kind === 'Stop'"
    class="reading-message"
  >
    <span
      class="speaker"
      :class="event.kind === 'Stop' ? 'assistant' : 'user'"
    >{{ event.kind === 'Stop' ? 'AI' : '提示' }}</span><div class="message-main">
      <div class="message-label">
        {{ event.kind === 'Stop' ? '模型回答 · 停止记录' : '提示提交记录' }}<span>{{ time(event.occurred_at) }}</span>
      </div><SessionContent
        :session-id="sessionId"
        :event-id="event.event_id"
        :occurred-at="event.occurred_at"
        :part="event.kind === 'Stop' ? 'response' : 'prompt'"
        :period="period"
        @unavailable="emit('unavailable', $event)"
      /><p
        v-if="event.kind === 'Stop'"
        class="muted small-text"
      >
        Stop 重入计数：{{ event.stop?.count_state === 'valid' ? event.stop.reentry_count : event.stop?.count_state === 'invalid' ? '无效值' : '未提供' }}（来源报告的阻断次数），不是模型调用次数。停止记录不代表已确认本轮最终完成。
      </p>
    </div>
  </div>
  <details
    v-else-if="['PreToolUse', 'PostToolUse'].includes(event.kind)"
    class="reading-tool"
    @toggle="toggle"
  >
    <summary>{{ event.tool_name || '未知工具' }} · 工具步骤 <small>{{ event.turn_index===null?'轮次未确定 · ':'' }}{{ statuses[event.status ?? ''] ?? '关联待计算' }}{{ event.duration_ms !== null ? ` · ${event.duration_ms} ms` : '' }}</small></summary><template v-if="opened">
      <h4>工具输入</h4><SessionContent
        :session-id="sessionId"
        :event-id="event.input_ref?.event_id ?? event.pre_ref?.event_id ?? event.event_id"
        :occurred-at="event.input_ref?.occurred_at ?? event.pre_ref?.occurred_at ?? event.occurred_at"
        part="tool_input"
        :period="period"
        @unavailable="emit('unavailable', $event)"
      /><h4>工具结果</h4><SessionContent
        v-if="event.post_ref || event.kind === 'PostToolUse'"
        :session-id="sessionId"
        :event-id="event.post_ref?.event_id ?? event.event_id"
        :occurred-at="event.post_ref?.occurred_at ?? event.occurred_at"
        part="tool_response"
        :period="period"
        @unavailable="emit('unavailable', $event)"
      /><p
        v-else
        class="muted small-text"
      >
        未观测到可关联的返回记录。
      </p>
    </template>
  </details>
  <div
    v-else
    class="trace-observation"
  >
    {{ event.kind==='Notification'?'通知':event.kind }}<span>{{ time(event.occurred_at) }}</span><small>{{ event.turn_index===null?'轮次未确定 · ':'' }}详情见原始事件</small>
  </div>
</template>
<style scoped>
.reading-message { display: flex; gap: 14px; padding: 22px; border-bottom: 1px solid #2b3a50; }.speaker { display: grid; place-items: center; align-self: flex-start; width: 32px; height: 32px; border-radius: 8px; flex-shrink: 0; font-size: var(--ui-font-small); }.user { background: #233f63; color: #93c5fd; }.assistant { background: #183e3b; color: #7dd3c8; }.message-main { flex: 1; min-width: 0; }.message-label { font-size: var(--ui-font-small); color: #a6b4c9; }.message-label span { margin-left: 14px; color: #8195b1; font-size: var(--ui-font-small); }
.reading-tool { margin: 14px 22px; padding: 14px 18px; border: 1px solid #2b3a50; border-radius: 7px; background: #111d2e; }.reading-tool summary { cursor: pointer; font-size: var(--ui-font-small); }.reading-tool small { color: #8195b1; margin-left: 12px; }.reading-tool h4 { font-size: var(--ui-font-small); color: #8195b1; }.trace-observation { display: flex; gap: 16px; padding: 16px 22px; color: #8195b1; font-size: var(--ui-font-small); }
</style>
