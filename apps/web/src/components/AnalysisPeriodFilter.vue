<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElTooltip } from 'element-plus';
import type { AnalysisPeriod } from '../stores/analysis-period.js';
const props = withDefaults(defineProps<{ period: AnalysisPeriod | null; computedAt: string | undefined; loading: boolean; basis?: 'hook' | 'official' }>(), { basis: 'hook' });
const emit = defineEmits<{ change: [period: AnalysisPeriod] }>();
const presets = [1, 7, 30, 45];
const dates = ref<[string, string]>(['', '']); const customOpen = ref(false); const error = ref(''); const clockOffset = ref(0); const day = 86_400_000; const offset = 8 * 3600_000;
const calendar = (time: number) => new Date(time + offset).toISOString().slice(0, 10);
function start() { return Math.floor((Date.now() + clockOffset.value + offset) / day) * day - offset; }
const selected = computed(() => props.period ? [1, 7, 30, 45].find(days => props.period!.from === new Date(start() - (days - 1) * day).toISOString() && props.period!.to === new Date(start() + day).toISOString()) ?? 0 : 7);
const description = computed(() => {
  if (!props.period) return '北京时间';
  const from = Date.parse(props.period.from); const to = Date.parse(props.period.to);
  if ((from + offset) % day === 0 && (to + offset) % day === 0) return `北京时间 · ${calendar(from)} 至 ${calendar(to - 1)}`;
  const formatted = (time: number) => new Date(time + offset).toISOString().slice(0, 16).replace('T', ' ');
  return `北京时间 · ${formatted(from)} 至 ${formatted(to)}（结束不含）`;
});
function choose(value: string | number | boolean | undefined) { const days = Number(value); if (![1, 7, 30, 45].includes(days)) return; emit('change', { from: new Date(start() - (days - 1) * day).toISOString(), to: new Date(start() + day).toISOString() }); }
function keyboard(event: Event, index: number) {
  if (!('key' in event) || typeof event.key !== 'string' || !(event.currentTarget instanceof window.HTMLButtonElement)) return;
  const next = ['ArrowRight', 'ArrowDown'].includes(event.key) ? (index + 1) % presets.length : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? (index + presets.length - 1) % presets.length : event.key === 'Home' ? 0 : event.key === 'End' ? presets.length - 1 : null;
  if (next === null) return; event.preventDefault(); event.currentTarget.parentElement?.querySelectorAll('button')[next]?.focus(); choose(presets[next]);
}
function custom() {
  const from = Date.parse(`${dates.value[0]}T00:00:00+08:00`); const to = Date.parse(`${dates.value[1]}T00:00:00+08:00`) + day;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || from < start() - 44 * day || to > start() + day) { error.value = '请选择最近45天内有效的起止日期'; return; }
  customOpen.value = false; emit('change', { from: new Date(from).toISOString(), to: new Date(to).toISOString() });
}
watch(() => props.computedAt, value => { if (value) clockOffset.value = Date.parse(value) - Date.now(); });
watch(() => props.period, value => { dates.value = value ? [calendar(Date.parse(value.from)), calendar(Date.parse(value.to) - 1)] : ['', '']; }, { immediate: true });
</script>
<template>
  <div class="analysis-filter-row">
    <span class="analysis-filter-label">日期范围</span>
    <div
      role="radiogroup"
      aria-label="日期范围"
      class="period-buttons"
    >
      <button
        v-for="(days, index) in presets"
        :key="days"
        type="button"
        role="radio"
        :aria-checked="selected === days"
        :tabindex="selected === days || (!selected && index === 0) ? 0 : -1"
        :disabled="loading"
        @click="choose(days)"
        @keydown="keyboard($event, index)"
      >
        {{ days === 1 ? '今日' : `近${days}天` }}
      </button>
    </div>
    <ElButton
      :disabled="loading"
      :class="{ 'custom-selected': selected === 0 }"
      @click="error = ''; customOpen = true"
    >
      自选范围
    </ElButton>
    <span
      class="muted small-text"
      data-testid="analysis-period-description"
    >{{ description }}</span>
    <ElTooltip
      :content="basis === 'official' ? '按北京时间业务日期统计官方查询结果。近期窗口包含今天和此前44个北京时间业务日；自选范围包含结束当天。' : '按上报记录的事件时间计算，可能受客户端时钟影响。近期窗口包含今天和此前44个北京时间业务日；自选范围包含结束当天。'"
      trigger="click"
    >
      <ElButton link>
        日期口径
      </ElButton>
    </ElTooltip>
  </div>
  <ElDialog
    v-model="customOpen"
    align-center
    title="自选日期范围"
    width="min(480px, 92vw)"
  >
    <ElForm
      label-position="top"
      @submit.prevent="custom"
    >
      <ElFormItem label="开始日期">
        <ElInput
          v-model="dates[0]"
          type="date"
          aria-label="开始日期"
          :min="calendar(start() - 44 * day)"
          :max="calendar(start())"
        />
      </ElFormItem>
      <ElFormItem label="结束日期（包含当天）">
        <ElInput
          v-model="dates[1]"
          type="date"
          aria-label="结束日期"
          :min="calendar(start() - 44 * day)"
          :max="calendar(start())"
        />
      </ElFormItem>
    </ElForm>
    <ElAlert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
    />
    <template #footer>
      <ElButton @click="customOpen = false">
        取消
      </ElButton><ElButton
        type="primary"
        @click="custom"
      >
        应用范围
      </ElButton>
    </template>
  </ElDialog>
</template>
<style scoped>
.analysis-filter-row { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; padding: 16px 0; margin-bottom: 8px; }
.analysis-filter-label { width: 64px; flex-shrink: 0; color: #a6b4c9; font-size: var(--ui-font-small); }
.period-buttons { display: flex; gap: 2px; padding: 3px; border: 1px solid #2b3a50; border-radius: 7px; background: #0b1220; }
.period-buttons button { border: 0; border-radius: 5px; background: transparent; color: #a6b4c9; padding: 8px 12px; font: inherit; font-size: var(--ui-font-small); cursor: pointer; }
.period-buttons button[aria-checked='true'] { background: #1e3a5f; color: #93c5fd; }
.period-buttons button:focus-visible { outline: 2px solid #60a5fa; outline-offset: 1px; }
.period-buttons button:disabled { cursor: wait; }
.custom-selected { background: #1e3a5f; color: #93c5fd; border-color: #2b3a50; }
</style>
