<script setup lang="ts">
import {computed} from 'vue';
import type {ModelCheckDto} from '@adi/contracts';
const props=defineProps<{data:ModelCheckDto}>();
const names={matched:'逐模型相等',cohort_matched:'仅来源合计相等',difference:'存在差异，待复核',not_comparable:'当前不可比',stale:'结果已失效',pending:'排队或执行中',failed:'核查失败',not_checked:'尚未核查'};
const totals=computed(()=>Object.entries(names).map(([state,label])=>({state,label,count:props.data.days.filter(day=>day.state===state).reduce((sum,day)=>sum+day.user_days,0)})).filter(row=>row.count));
const integer=(value:string|null)=>value===null?'未知':BigInt(value).toLocaleString('zh-CN');
const time=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未观测';
const source=(value:string)=>({Trae:'TRAE 内置',Custom:'企业统一接入',unknown:'来源未知'}[value]??value);
</script>
<template>
  <section
    class="model-check"
    data-testid="model-check-panel"
  >
    <h3>官方模型交叉核查</h3>
    <template v-if="data.availability==='department_scope_not_comparable'">
      <p class="model-notice">
        部门范围不可比：官方模型汇总覆盖一个人员的全部客户端和消耗通道，不能与该人员在所选部门的部分记录直接比较。此处不展示部门外数量。
      </p>
    </template>
    <template v-else>
      <p>用独立官方模型接口核对同一人员、同一查询时间段的输入与输出。包含全部客户端和消耗通道，与本页 IDE 用量的范围不同，两者不相加。</p>
      <div class="model-states">
        <span
          v-for="item in totals"
          :key="item.state"
          :class="['model-state',item.state]"
        >{{ item.label }} <strong>{{ item.count }}</strong> 人日</span>
      </div>
      <p class="model-notice">
        核查相等不证明会话归属完整；合计相等也可能存在逐模型差异。差异需要复核，不代表已确认多计 Token。缺失数量显示“未知”。
      </p>
      <div
        v-if="data.groups.length"
        class="model-table"
        data-testid="model-check-groups"
      >
        <table>
          <caption>有效核查范围内的输入与输出</caption>
          <thead><tr><th>模型来源 / 类型</th><th>参与人日</th><th>明细输入</th><th>汇总输入</th><th>明细输出</th><th>汇总输出</th><th>名称口径</th></tr></thead>
          <tbody>
            <tr
              v-for="row in data.groups"
              :key="`${row.model_source}:${row.model_type}`"
            >
              <td>{{ source(row.model_source) }} / {{ row.model_type }}</td><td>{{ row.user_days }}</td><td>{{ integer(row.detail_input_tokens) }}</td><td>{{ integer(row.official_input_tokens) }}</td><td>{{ integer(row.detail_output_tokens) }}</td><td>{{ integer(row.official_output_tokens) }}</td><td>{{ row.models_comparable?'支持逐模型比较':'名称不同，仅比较来源合计' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else>
        当前没有可展示的有效核查数量；失效、失败和执行中的结果不作为当前核查结果。
      </p>
      <p
        v-if="data.truncated"
        class="model-notice"
      >
        分组较多，当前仅展示部分分组；所有分组仍参与后台核查，当前表格不能代表完整数量。
      </p>
      <details class="model-details">
        <summary>按日查看状态与重查计划</summary>
        <div class="model-table">
          <table>
            <thead><tr><th>业务日</th><th>核查状态</th><th>人员数</th><th>最早核查时刻</th><th>最早可执行时间</th></tr></thead>
            <tbody>
              <tr
                v-for="day in data.days"
                :key="`${day.date}:${day.state}`"
              >
                <td>{{ day.date }}</td><td>{{ names[day.state] }}</td><td>{{ day.user_days }}</td><td>{{ time(day.oldest_checked_at) }}</td><td>{{ day.next_check_at?time(day.next_check_at):'尚无计划' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>仅核查已结束的业务日。可执行时间受队列、限流和退避约束，不是完成承诺。结果与源版本及账号身份绑定，修订或清理后须重新核查。</p>
      </details>
      <p>截至 {{ time(data.as_of) }}。刷新页面只读取本地结果，不触发官方查询。</p>
    </template>
  </section>
</template>
<style scoped>
.model-check { padding: 20px; border-top: 1px solid #2b3a50; }
.model-check h3 { margin: 0 0 12px; font-size: var(--ui-font-section); }
.model-check p { color: #91a3be; font-size: var(--ui-font-small); line-height: 1.7; }
.model-states { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0; }
.model-state { padding: 8px 12px; border: 1px solid #34445c; border-radius: 6px; color: #b0c1d7; font-size: var(--ui-font-small); }
.model-state strong { margin-left: 8px; }
.model-state.difference,.model-state.failed { color: #fbbf77; border-color: #795b34; }
.model-state.matched { color: #83d5ba; }
.model-notice { background: #152237; border-radius: 6px; padding: 12px; }
.model-table { max-width: 100%; overflow-x: auto; }
.model-table table { width: 100%; border-collapse: collapse; white-space: nowrap; font-size: var(--ui-font-small); }
.model-table th,.model-table td { padding: 10px; text-align: left; border-bottom: 1px solid #2b3a50; }
.model-table caption { text-align: left; padding: 8px 0; color: #b0c1d7; }
.model-details { margin-top: 16px; font-size: var(--ui-font-small); }
.model-details summary { cursor: pointer; color: #93c5fd; }
</style>
