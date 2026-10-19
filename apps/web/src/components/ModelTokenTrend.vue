<script setup lang="ts">
import {computed} from 'vue';import type {ModelsDto} from '@adi/contracts';
import { useChartWidth } from '../composables/chart-width.js';
const props=defineProps<{items:ModelsDto['trend'];metric:'tokens'|'calls'}>();
const { chart, width } = useChartWidth();
const label=computed(()=>props.metric==='tokens'?'Token':'调用次数');
const ceiling=computed(()=>{let max=1n;for(const row of props.items){const value=row[props.metric];if(value!==null&&BigInt(value)>max)max=BigInt(value);}return (max+1n)/2n*2n;});
const points=computed(()=>props.items.map((row,index)=>({...row,value:row[props.metric],x:80+index*Math.max(1,width.value-96)/Math.max(1,props.items.length-1),y:row[props.metric]===null?null:145-Number(BigInt(row[props.metric]!)*1000000n/ceiling.value)/1000000*115})));
const path=computed(()=>{let drawing=false;const chunks:string[]=[];for(const point of points.value){if(point.y===null){drawing=false;continue;}chunks.push(`${drawing?'L':'M'}${point.x},${point.y}`);drawing=true;}return chunks.join(' ');});
const compact=(value:bigint)=>{const s=value.toString();return s.length>7?`${s[0]}.${s.slice(1,3)}e${s.length-1}`:value.toLocaleString('zh-CN');};
</script>
<template>
  <svg
    v-if="points.some(point=>point.y!==null)"
    ref="chart"
    :viewBox="`0 0 ${width} 185`"
    class="model-trend"
    role="img"
    :aria-label="`官方模型 ${label} 日趋势`"
  >
    <g
      v-for="[value,y] in [[ceiling,30],[ceiling/2n,87.5],[0n,145]] as const"
      :key="String(value)"
    ><line
      x1="80"
      :y1="y"
      :x2="width - 16"
      :y2="y"
      stroke="#2b3a50"
      stroke-dasharray="3 4"
    /><text
      x="2"
      :y="y+4"
    >{{ compact(value) }}</text></g>
    <path
      :d="path"
      fill="none"
      stroke="var(--ui-chart-official)"
      stroke-width="2.5"
    />
    <template
      v-for="point in points"
      :key="point.date"
    ><circle
      v-if="point.y!==null"
      :cx="point.x"
      :cy="point.y"
      r="4"
      fill="var(--ui-surface)"
      stroke="var(--ui-chart-official)"
      stroke-width="2"
      tabindex="0"
    ><title>{{ point.date }} · {{ BigInt(point.value!).toLocaleString('zh-CN') }} {{ label }} · {{ point.records }} 条记录</title></circle></template>
    <text
      x="80"
      y="174"
    >{{ items[0]?.date.slice(5) }}</text><text
      :x="width - 16"
      text-anchor="end"
      y="174"
    >{{ items.at(-1)?.date.slice(5) }}</text>
  </svg>
  <p
    v-else
    class="empty-trend"
  >
    当前筛选没有可绘制的官方{{ label }}数值。
  </p>
  <p class="trend-note">
    只连接连续日期的已报告值；缺失日期或字段留空，不补零。较大轴刻度采用科学计数法，悬停可看精确数值。
  </p>
</template>
<style scoped>
.model-trend { width: 100%; height: 185px; display: block; }.model-trend text { fill: #a6b4c9; font-size: var(--ui-font-small); }.model-trend circle:focus { outline: none; stroke: #f1f5f9; }.empty-trend { color: #91a3be; padding: 46px 0; text-align: center; }.trend-note { font-size: var(--ui-font-small); color: #91a3be; line-height: 1.6; }
</style>
