<script setup lang="ts">
import type { ContentEstimateDto } from '@adi/contracts';
defineProps<{ estimate: ContentEstimateDto; embedded?: boolean }>();
const number = (value: string | null) => value === null ? '—' : BigInt(value).toLocaleString('zh-CN');
const fields = [{ key: 'prompt', label: '用户提示' }, { key: 'tool_input', label: '工具输入' }, { key: 'tool_output', label: '工具结果' }, { key: 'assistant', label: '模型回答' }] as const;
</script>
<template>
  <section
    class="estimate-panel"
    :class="{ embedded }"
  >
    <div
      class="estimate-heading"
    >
      <h2 v-if="!embedded">
        内容量估算
      </h2><h3 v-else>
        估算 Tokens
      </h3><strong data-testid="content-estimate-tokens">{{ estimate.tokens === null ? '—' : `~${number(estimate.tokens)}` }}</strong>
    </div>
    <div class="estimate-components">
      <div
        v-for="field in fields"
        :key="field.key"
      >
        <span>{{ field.label }}</span><b>{{ number(estimate.components[field.key]) }}</b>
      </div>
    </div>
    <p
      v-if="estimate.reason === 'projection_pending'"
      class="estimate-pending"
    >
      {{ estimate.pending_sessions }} 个相关会话待计算，暂不展示可能过期的估算。
    </p>
    <p v-else-if="estimate.reason === 'no_observations'">
      当前范围没有可观测记录。
    </p>
    <p v-if="embedded">
      仅估算Hook已记录文本的规模，不代表实际消耗。
    </p>
    <p v-else>
      根据已观测内容启发式估算 Token 量级，不是实际计费用量；未包含不可见的系统提示、上下文重发和内部调用。工具输入按采用的源记录计一次。
    </p>
    <details
      v-if="embedded"
      class="estimate-method"
    >
      <summary>计算口径</summary>
      <p>按已观测文本启发式换算，不是模型 tokenizer。未包含不可见的系统提示、上下文重发和内部调用；工具输入按采用的源记录计一次。</p>
    </details>
    <div class="estimate-foot">
      <span v-if="!embedded">计费用量模拟在可访问的会话详情中单独展示</span><span v-if="estimate.as_of">最早计算 {{ new Date(estimate.as_of).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) }}</span>
    </div>
  </section>
</template>
<style scoped>
.estimate-panel { padding: 20px; border: 1px solid #2b3a50; background: #172338; border-radius: 9px; }.estimate-panel.embedded { border: 0; padding: 12px 0; }.estimate-heading { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }.estimate-heading h2, .estimate-heading h3 { font-size: var(--ui-font-section); margin: 0; }.estimate-heading strong { color: #93c5fd; font-size: var(--ui-font-metric); }.estimate-components { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 12px; }.estimate-components span { display: block; color: #8195b1; font-size: var(--ui-font-small); }.estimate-components b { display: block; font-size: var(--ui-font-subtitle); margin-top: 9px; overflow-wrap: anywhere; }.estimate-panel p { font-size: var(--ui-font-small); margin: 18px 0 0; }.estimate-foot { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 14px; font-size: var(--ui-font-small); color: #8195b1; }.estimate-pending { color: #fbbf24; }
.estimate-method { margin-top: 14px; font-size: var(--ui-font-small); }.estimate-method summary { cursor: pointer; }
@media (max-width: 700px) { .estimate-components { grid-template-columns: repeat(2,minmax(0,1fr)); } }
</style>
