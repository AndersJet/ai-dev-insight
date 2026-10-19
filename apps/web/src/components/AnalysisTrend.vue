<script setup lang="ts">
import { computed } from 'vue';
import type { AnalyticsTrendsDto } from '@adi/contracts';
import { useChartWidth } from '../composables/chart-width.js';
const props = defineProps<{ data: AnalyticsTrendsDto; personal: boolean }>();
const { chart, width } = useChartWidth();
const values = computed(() => props.data.items.map(item => props.personal ? item.prompt_turns : item.observed_users));
const ceiling = computed(() => Math.max(2, Math.ceil(Math.max(0, ...values.value) / 2) * 2));
const points = computed(() => values.value.map((value, index) => ({ x: 40 + index * Math.max(1, width.value - 56) / Math.max(1, values.value.length - 1), y: 145 - value / ceiling.value * 115, value, date: props.data.items[index]!.date })));
const line = computed(() => points.value.map(point => `${point.x},${point.y}`).join(' '));
</script>
<template>
  <svg
    ref="chart"
    class="analysis-chart"
    :viewBox="`0 0 ${width} 185`"
    role="img"
    :aria-label="personal ? '每日提示轮次趋势' : '每日观测人数趋势'"
  >
    <g
      v-for="fraction in [0, 0.5, 1]"
      :key="fraction"
    ><line
      x1="40"
      :y1="145 - fraction * 115"
      :x2="width - 16"
      :y2="145 - fraction * 115"
      stroke="#2b3a50"
      stroke-dasharray="3 4"
    /><text
      x="5"
      :y="149 - fraction * 115"
    >{{ ceiling * fraction }}</text></g>
    <polygon
      :points="`40,145 ${line} ${points.at(-1)?.x ?? 40},145`"
      fill="var(--ui-chart-observed)"
      fill-opacity="0.12"
    />
    <polyline
      :points="line"
      fill="none"
      stroke="var(--ui-chart-observed)"
      stroke-width="2.5"
      stroke-linejoin="round"
    />
    <circle
      v-for="point in points"
      :key="point.date"
      :cx="point.x"
      :cy="point.y"
      r="3"
      fill="var(--ui-surface)"
      stroke="var(--ui-chart-observed)"
      stroke-width="2"
      tabindex="0"
    ><title>{{ point.date }} · {{ point.value }} {{ personal ? '次提示' : '人' }}</title></circle>
    <text
      x="40"
      y="172"
    >{{ data.items[0]?.date.slice(5) }}</text><text
      :x="width - 16"
      text-anchor="end"
      y="172"
    >{{ data.items.at(-1)?.date.slice(5) }}</text>
  </svg>
  <p class="trend-explanation">
    {{ personal ? '交互量不代表工作时长或交付产出。' : '每天分别去重，不能把日人数累加为周期人数。' }}
  </p>
</template>
<style scoped>
.analysis-chart { width: 100%; height: 185px; display: block; }.analysis-chart text { fill: #a6b4c9; font-size: var(--ui-font-small); }.analysis-chart circle:focus { outline: none; stroke: #f1f5f9; stroke-width: 3; }
.trend-explanation { color: #8195b1; font-size: var(--ui-font-small); margin: 6px 0 0; }
</style>
