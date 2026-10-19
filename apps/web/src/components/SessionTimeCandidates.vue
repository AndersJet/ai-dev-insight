<script setup lang="ts">
import type {SessionOfficialUsageDto} from '@adi/contracts';
defineProps<{data:SessionOfficialUsageDto['time_candidates']}>();
const reasons:Record<string,string>={trace_pending:'轨迹尚未完成派生，暂不推断关联。',trace_partial:'可观测轨迹不完整，暂不推断关联。',no_prompt_windows:'没有可用的提示时间段，暂不推断关联。',candidate_limit:'当前范围较大，暂不生成时间候选。',official_source_unavailable:'尚无可用的官方来源记录。',official_source_incomplete:'相关日期的官方来源尚未完成核验。',official_source_unconfigured:'官方来源尚未配置。'};
const relationReasons:Record<string,string>={unique_observed_window:'当前观测时间段内的唯一候选',multiple_bills_in_window:'同一时间段存在多个计费标识',competing_hook_sessions:'与其他已观测会话的时间范围重叠'};
const tokens=(value:string|null)=>value===null?'未知':BigInt(value).toLocaleString('zh-CN');
const time=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
</script>
<template>
  <section
    class="time-candidates"
    data-testid="session-time-candidates"
  >
    <h3>内置模型的时间候选</h3>
    <p>时间推断关联与已核验关联分开展示，不计入上方官方 Token。秒级时间相符不代表官方确认，时钟差异也可能使候选缺失。</p>
    <p v-if="data.state==='unavailable'">
      {{ reasons[data.reason??'']??'当前条件不足，暂不生成候选。' }}
    </p>
    <p v-else-if="data.state==='none'">
      未找到时间候选；这不表示零使用，也不能据此判定个人自配模型。
    </p>
    <template v-else>
      <p>以下 Token 是账项在所示来源查询范围内的官方数量，不是该提示轮次或整个 Hook 会话的用量。存在歧义的记录保持待核验。</p>
      <div class="candidate-table">
        <table>
          <thead><tr><th>计费标识 / 模型</th><th>关联状态</th><th>账项 Token</th><th>来源查询范围</th></tr></thead>
          <tbody>
            <tr
              v-for="(item,index) in data.items"
              :key="`${item.business_date}:${item.billing_session_id}:${index}`"
            >
              <td><span>{{ item.billing_session_id }}</span><small>{{ item.model_name||'模型未标明' }} · TRAE 内置</small></td>
              <td><strong>{{ item.relation==='time_inferred'?'时间推断关联':'待核验' }}</strong><small>{{ relationReasons[item.reason]??'关联依据不足' }}</small></td>
              <td>{{ tokens(item.tokens) }}</td>
              <td><span>{{ time(item.scope_from) }} 至 {{ time(item.scope_to) }}（不含结束时刻）</span><small>该查询范围内的用量开始时间：{{ time(item.observed_start_at) }}</small></td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>
<style scoped>
.time-candidates{border-top:1px solid #2b3a50;margin-top:22px;padding-top:18px}.time-candidates p,.time-candidates small{color:#91a3be;font-size:var(--ui-font-small);line-height:1.7}.candidate-table{overflow-x:auto}.candidate-table table{width:100%;border-collapse:collapse}.candidate-table td,.candidate-table th{padding:12px;text-align:left;border-bottom:1px solid #2b3a50;min-width:120px;overflow-wrap:anywhere}.candidate-table small{display:block}.candidate-table strong{color:#e1bd6e}
</style>
