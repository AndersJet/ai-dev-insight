<script setup lang="ts">
import {computed} from 'vue';
import type {UsageReconciliationDto} from '@adi/contracts';
const props=defineProps<{data:UsageReconciliationDto}>();
const names={total:'已取得问答记录',attributed:'已归因',unattributed:'未归因',conflicting:'归因冲突'} as const;
const rows=computed(()=>(Object.keys(names) as (keyof typeof names)[]).map(key=>({key,label:names[key],...props.data[key]})));
const time=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未观测到计划';
const integer=(value:string|null)=>value===null?'—':BigInt(value).toLocaleString('zh-CN');
</script>
<template>
  <section
    class="reconciliation"
    data-testid="usage-reconciliation"
  >
    <h3>会话归因对账</h3>
    <p>仅核对已取得的问答记录（IDE 或客户端未标明），不含 CUE 和其他客户端。已归因、未归因与冲突互不重复。</p>
    <div class="reconciliation-grid">
      <div
        v-for="row in rows"
        :key="row.key"
        class="reconciliation-item"
      >
        <span>{{ row.label }}</span>
        <strong :data-testid="`reconciliation-${row.key}`">{{ integer(row.tokens) }}</strong>
        <small>{{ row.records }} 条记录</small>
        <small v-if="row.missing_token_records">{{ row.missing_token_records }} 条缺少 Token；已知部分 {{ integer(row.known_tokens) }}</small>
      </div>
    </div>
    <p class="reconciliation-limit">
      数量守恒不代表会话完整，仍可能存在尚未取得或无法可靠归属的账项。空值不表示零使用。
    </p>
    <details
      class="gap-details"
      data-testid="usage-gap-days"
    >
      <summary>查看按日缺口与重查计划</summary>
      <p>截至 {{ time(data.as_of) }}，以下按当前启用账号统计。等待从首次 Hook 接收或任务建立中较早的时间计时，不因迟到或后续对话顺延；两者均缺失时按业务日与账号接入时间推算。</p>
      <p>超过24小时仍未取得记录或完整关系证据列为待处理；核查失败、明确漏关联、字段缺失或范围失效会立即显示。这是本平台核查阈值，不是官方出账承诺。</p>
      <div class="gap-table">
        <table>
          <thead><tr><th>业务日</th><th>等待中（人）</th><th>超过24小时（人）</th><th>核查失败（人）</th><th>已知缺口（人）</th><th>最早可执行时间</th></tr></thead>
          <tbody>
            <tr
              v-for="day in data.days"
              :key="day.date"
            >
              <td>{{ day.date }}</td><td>{{ day.waiting_user_days }}</td><td>{{ day.overdue_user_days }}</td><td>{{ day.failed_user_days }}</td><td>{{ day.known_gap_user_days }}</td><td>{{ time(day.next_check_at) }}</td>
            </tr>
            <tr v-if="!data.days.length">
              <td colspan="6">
                当前范围没有启用账号的按日同步状态。
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>状态按核查失败、已知缺口、等待超时、等待中的顺序归类，不重复计数。可执行时间仍受队列和共享限流约束，不是完成时间。</p>
    </details>
  </section>
</template>
<style scoped>
.reconciliation { padding: 20px; border-top: 1px solid #2b3a50; }
.reconciliation h3 { margin: 0 0 10px; font-size: var(--ui-font-section); }
.reconciliation p { color: #91a3be; font-size: var(--ui-font-small); line-height: 1.7; }
.reconciliation-grid { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 12px; margin: 16px 0; }
.reconciliation-item { padding: 16px; border: 1px solid #2b3a50; border-radius: 8px; background: #111d31; }
.reconciliation-item span,.reconciliation-item small { display: block; color: #91a3be; font-size: var(--ui-font-small); }
.reconciliation-item strong { display: block; font-size: var(--ui-font-metric); margin: 10px 0; overflow-wrap: anywhere; }
.reconciliation-limit { margin-bottom: 0; }
.gap-details { margin-top: 18px; font-size: var(--ui-font-small); }
.gap-details summary { cursor: pointer; color: #93c5fd; }
.gap-table { overflow-x: auto; }
.gap-table table { width: 100%; border-collapse: collapse; white-space: nowrap; }
.gap-table th,.gap-table td { padding: 10px; text-align: left; border-bottom: 1px solid #2b3a50; }
@media(max-width:900px) { .reconciliation-grid { grid-template-columns: repeat(2,minmax(0,1fr)); } }
@media(max-width:540px) { .reconciliation-grid { grid-template-columns: minmax(0,1fr); } }
</style>
