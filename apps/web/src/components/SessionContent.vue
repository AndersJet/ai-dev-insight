<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { SessionContentQueryDto } from '@adi/contracts';
import { content } from '../api/sessions.js';
import { ApiFailure } from '../api/http.js';
import { renderSessionMarkdown } from '../lib/session-markdown.js';
const props = defineProps<{ sessionId: string; eventId: string; occurredAt:string; part: SessionContentQueryDto['part']; period: { from: string; to: string } }>();
const emit = defineEmits<{ unavailable: [reason: Error] }>();
const chunks = ref<string[]>([]); const next = ref<number | null>(null); const total = ref(0); const read = ref(0); const dropped = ref(false); const available = ref(true); const loading = ref(false); const error = ref(''); let generation = 0;
const mode = ref('formatted');
const modes = [{ value: 'formatted', label: '排版' }, { value: 'raw', label: '原文' }];
const canFormat = computed(() => ['prompt', 'response'].includes(props.part) && !dropped.value);
const formatted = computed(() => canFormat.value && mode.value === 'formatted');
const rendered = computed(() => formatted.value ? renderSessionMarkdown(chunks.value.join('')) : '');
function keyboard(event: Event, index: number) {
  if (!('key' in event) || typeof event.key !== 'string' || !(event.currentTarget instanceof window.HTMLButtonElement)) return;
  const next = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key) ? 1 - index : event.key === 'Home' ? 0 : event.key === 'End' ? 1 : null;
  if (next === null) return;
  event.preventDefault(); event.currentTarget.parentElement?.querySelectorAll('button')[next]?.focus(); mode.value = modes[next]!.value;
}
async function load(reset = false) {
  const current = ++generation; loading.value = true; error.value = '';
  if (reset) { chunks.value = []; dropped.value = false; read.value = 0; next.value = null; }
  try {
    const loadContent=content;
    const result = (await loadContent(props.sessionId, props.eventId, { ...props.period, occurred_at:props.occurredAt, part: props.part, offset: reset ? 0 : next.value ?? 0, limit: 8192 })).data;
    if (current !== generation) return;
    available.value = result.available; chunks.value.push(result.text); if (chunks.value.length > 8) { chunks.value.shift(); dropped.value = true; }
    next.value = result.next_offset; total.value = result.total_chars; read.value = result.offset + result.returned_chars;
  } catch (reason) {
    if (current !== generation) return; chunks.value = []; next.value = null; error.value = reason instanceof Error ? reason.message : '无法读取内容';
    if (reason instanceof ApiFailure && ([401, 403, 404, 409].includes(reason.status))) emit('unavailable', reason);
  } finally { if (current === generation) loading.value = false; }
}
watch(() => [props.sessionId, props.eventId, props.occurredAt, props.part, props.period.from, props.period.to], () => load(true), { immediate: true }); onBeforeUnmount(() => { generation++; });
</script>
<template>
  <div
    class="session-content"
    data-testid="session-content"
  >
    <div
      v-if="canFormat && chunks.length"
      role="radiogroup"
      aria-label="内容显示方式"
      class="content-mode"
    >
      <button
        v-for="(item, index) in modes"
        :key="item.value"
        type="button"
        role="radio"
        :aria-checked="mode === item.value"
        :tabindex="mode === item.value ? 0 : -1"
        @click="mode = item.value"
        @keydown="keyboard($event, index)"
      >
        {{ item.label }}
      </button>
    </div>
    <p
      v-if="formatted && next !== null"
      class="muted small-text"
    >
      当前为已读取片段，代码块和表格的排版可能尚不完整。
    </p>
    <p
      v-if="dropped"
      class="muted small-text"
    >
      仅保留最近读取的片段，以原文显示；从头读取可恢复完整前缀的排版。
    </p>
    <!-- Only session-markdown's HTML-disabled parser output reaches this sink. -->
    <!-- eslint-disable vue/no-v-html -->
    <div
      v-if="chunks.length && formatted"
      class="formatted-content"
      v-html="rendered"
    />
    <!-- eslint-enable vue/no-v-html -->
    <pre
      v-else-if="chunks.length"
      class="content-text"
    >{{ chunks.join('') }}</pre>
    <p
      v-if="!available"
      class="muted"
    >
      此记录未提供该内容
    </p>
    <p
      v-if="loading"
      role="status"
      class="muted small-text"
    >
      正在读取…
    </p>
    <p
      v-if="error"
      role="alert"
      class="error-text"
    >
      {{ error }} <ElButton
        link
        @click="load(true)"
      >
        重试
      </ElButton>
    </p>
    <div
      v-if="available && total"
      class="content-controls"
    >
      <span>已读取 {{ read.toLocaleString() }} / {{ total.toLocaleString() }} 字符</span><ElButton
        v-if="next !== null"
        size="small"
        :disabled="loading"
        @click="load()"
      >
        继续读取
      </ElButton><ElButton
        v-if="dropped"
        size="small"
        :disabled="loading"
        @click="load(true)"
      >
        从头读取
      </ElButton>
    </div>
  </div>
</template>
<style scoped>
.content-text { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; margin: 8px 0; font: var(--ui-font-body)/1.85 var(--ui-font-mono); color: #dbe7f8; max-height: 560px; overflow-y: auto; }
.content-controls { display: flex; align-items: center; gap: 12px; color: #8195b1; font-size: var(--ui-font-small); padding-top: 8px; }.session-content { min-width: 0; }
.content-mode { display: inline-flex; gap: 2px; padding: 3px; margin-top: 10px; border: 1px solid #2b3a50; border-radius: 7px; background: #0b1220; }
.content-mode button { border: 0; border-radius: 5px; background: transparent; color: #a6b4c9; padding: 5px 10px; font: inherit; font-size: var(--ui-font-small); cursor: pointer; }
.content-mode button[aria-checked='true'] { background: #1e3a5f; color: #93c5fd; }.content-mode button:focus-visible { outline: 2px solid #60a5fa; outline-offset: 1px; }
.formatted-content { max-height: 560px; overflow: auto; overflow-wrap: anywhere; color: #dbe7f8; font-size: var(--ui-font-body); line-height: 1.85; }
.formatted-content :deep(h1),.formatted-content :deep(h2),.formatted-content :deep(h3),.formatted-content :deep(h4),.formatted-content :deep(h5),.formatted-content :deep(h6) { color: #edf3ff; line-height: 1.5; margin: 20px 0 10px; }
.formatted-content :deep(h1) { font-size: 20px; }.formatted-content :deep(h2) { font-size: var(--ui-font-section); }.formatted-content :deep(h3) { font-size: var(--ui-font-subtitle); }
.formatted-content :deep(p) { color: inherit; margin: 10px 0; }.formatted-content :deep(ul),.formatted-content :deep(ol) { padding-left: 24px; }
.formatted-content :deep(pre) { padding: 14px 16px; border: 1px solid #2b3a50; border-radius: 6px; background: #0d1728; overflow-x: auto; white-space: pre; }
.formatted-content :deep(code) { font: var(--ui-font-small)/1.8 var(--ui-font-mono); background: #0d1728; padding: 2px 5px; border-radius: 3px; }
.formatted-content :deep(pre code) { padding: 0; background: transparent; }
.formatted-content :deep(blockquote) { border-left: 3px solid #4e7eb6; padding-left: 14px; margin: 12px 0; color: #a6b4c9; }
.formatted-content :deep(table) { border-collapse: collapse; display: block; max-width: 100%; overflow-x: auto; margin: 14px 0; }
.formatted-content :deep(th),.formatted-content :deep(td) { border: 1px solid #33465f; padding: 7px 12px; text-align: left; }.formatted-content :deep(th) { background: #20314c; }
.formatted-content :deep(a) { color: #7ab5ff; text-decoration: underline; }.formatted-content :deep(hr) { border: 0; border-top: 1px solid #33465f; margin: 18px 0; }
.formatted-content :deep(.markdown-image-note) { color: #91a3be; font-style: italic; }
</style>
