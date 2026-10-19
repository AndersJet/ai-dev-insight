<script setup lang="ts">
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import type {BillingSimulationDto,BillingSimulationQueryDto} from '@adi/contracts';
import {simulation} from '../api/sessions.js';
import {ApiFailure,isTransientReadFailure} from '../api/http.js';
const props=defineProps<{sessionId:string}>();const data=ref<BillingSimulationDto|null>(null),loading=ref(false),error=ref('');let generation=0;
const base=ref(''),model=ref(''),gap=ref(2000),overlap=ref(800),mutating=ref(800),batch=ref(6),shown=ref(20);
const resultQuery=ref<BillingSimulationQueryDto|null>(null);
const resultRevision=ref(0);
const query=computed<BillingSimulationQueryDto>(()=>({...(base.value.trim()?{base_tokens:base.value.trim()}:{}),...(model.value.trim()?{model:model.value.trim()}:{}),min_call_gap_ms:Number(gap.value),overlap_gap_ms:Number(overlap.value),mutating_gap_ms:Number(mutating.value),max_batch_steps:Number(batch.value)}));
const parametersChanged=computed(()=>!!data.value&&!!resultQuery.value&&JSON.stringify(query.value)!==JSON.stringify(resultQuery.value));
const format=(value:string|null|undefined)=>value===null||value===undefined?'暂不可用':BigInt(value).toLocaleString();
const sources={default:'默认假设',scenario_override:'本次假设',personal_model:'旧口径，待重新验证',model_mean:'旧口径，待重新验证'};
const reasons:Record<string,string>={projection_pending:'会话正在派生，完成后可重新模拟。',partial_history:'近期窗口或数据清理使上下文不完整，暂不生成完整模拟量。',simulation_limit:'会话超过单次模拟预算，请等待后续后台模拟能力。',unattributed_events:'有记录无法关联到提示轮次，暂不生成完整模拟量。',no_prompt_observations:'未观测到提示轮次，无法模拟。',missing_prompt_content:'提示内容缺失，无法完整模拟。'};
const warningNames:Record<string,string>={incomplete_tool_timing:'工具时间不完整，没有补造时间点；无法判断的间隔按同批次假设处理。',unknown_action_kind:'部分工具的状态变更性质未知，不据此推断读写切换。',scenario_model_override:'模型名称来自本次输入，仅作为情景假设，不确认实际使用模型。',multiple_hook_models_unresolved:'会话观测到多个模型字段，未选择其中一个代表整个会话。',model_identity_unverified:'Hook 模型字段尚未与官方模型来源核实，不能作为同模型校准依据。'};
const warnings=computed(()=>data.value?.warnings.filter(item=>warningNames[item]).map(item=>warningNames[item])??[]);
async function load(){
  if(loading.value)return;
  const current=++generation,input={...query.value};loading.value=true;error.value='';
  try{
    const result=await simulation(props.sessionId,input);
    if(current===generation){
      const sameSource=!!data.value?.source_version&&data.value.source_version===result.data.source_version&&data.value.period.from===result.data.period.from&&data.value.period.to===result.data.period.to;
      if(!sameSource){shown.value=20;resultRevision.value++;}
      data.value=result.data;resultQuery.value=input;
    }
  }catch(reason){
    if(current!==generation)return;
    const message=reason instanceof Error?reason.message:'模拟暂不可用';
    if(data.value&&reason instanceof ApiFailure&&reason.status===400&&reason.code==='invalid_request')error.value=`本次参数未通过校验，当前为上次结果：${message}`;
    else if(data.value&&isTransientReadFailure(reason))error.value=`模拟失败，当前为上次结果：${message}`;
    else{data.value=null;resultQuery.value=null;shown.value=20;error.value=message;}
  }finally{if(current===generation)loading.value=false;}
}
function reset(){if(loading.value)return;base.value='';model.value='';gap.value=2000;overlap.value=800;mutating.value=800;batch.value=6;void load();}
watch(()=>props.sessionId,()=>{generation++;loading.value=false;data.value=null;resultQuery.value=null;shown.value=20;reset();},{immediate:true,flush:'sync'});onBeforeUnmount(()=>{generation++;});
</script>
<template>
  <section
    class="simulation-panel"
    data-testid="billing-simulation"
  >
    <h3>计费用量模拟</h3><p class="muted">
      假设每个批次重发可见上下文，并加入固定底座。不生成官方用量或现金金额，也不与内容量估算相加。
    </p>
    <form @submit.prevent="load">
      <div class="simulation-inputs">
        <label>本次基线 Tokens<ElInput
          v-model="base"
          aria-label="本次基线 Tokens"
          placeholder="留空使用默认假设 24,000"
          :maxlength="7"
          :disabled="loading"
        /></label><label>本次模型假设<ElInput
          v-model="model"
          aria-label="本次模型假设"
          placeholder="留空展示唯一的 Hook 模型字段"
          :maxlength="256"
          :disabled="loading"
        /></label>
      </div>
      <details class="simulation-parameters">
        <summary>批次划分假设</summary><p class="muted">
          间隔是模拟参数，不证明发生了真实模型调用。满足：批次合并间隔 ≤ 读写切换间隔 ≤ 新批次间隔。
        </p><div class="simulation-inputs">
          <label>新批次间隔（毫秒）<input
            v-model.number="gap"
            type="number"
            min="0"
            max="60000"
            step="1"
            :disabled="loading"
          ></label><label>批次合并间隔（毫秒）<input
            v-model.number="overlap"
            type="number"
            min="0"
            max="60000"
            step="1"
            :disabled="loading"
          ></label><label>读写切换间隔（毫秒）<input
            v-model.number="mutating"
            type="number"
            min="0"
            max="60000"
            step="1"
            :disabled="loading"
          ></label><label>批次参考步骤上限<input
            v-model.number="batch"
            type="number"
            min="1"
            max="100"
            step="1"
            :disabled="loading"
          ></label>
        </div>
      </details><div class="simulation-actions">
        <ElButton
          native-type="submit"
          :loading="loading"
        >
          重新模拟
        </ElButton><ElButton
          :disabled="loading"
          @click="reset"
        >
          恢复默认假设
        </ElButton><span class="muted">仅用于本次查看，不保存为模型事实</span>
      </div>
    </form>
    <ElAlert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
    />
    <p
      v-if="loading"
      role="status"
    >
      {{ data ? '正在模拟，当前显示上次结果…' : '正在模拟…' }}
    </p>
    <template v-if="data">
      <p
        v-if="parametersChanged && !loading && !error"
        role="status"
        class="simulation-notice"
      >
        参数已修改，当前结果对应上次计算。
      </p>
      <p
        v-if="data.reason"
        role="status"
        class="simulation-notice"
      >
        {{ reasons[data.reason] ?? '当前无法生成完整模拟结果。' }}
      </p>
      <div class="simulation-metrics">
        <div><span>模拟输入 Tokens</span><strong data-testid="simulated-input">{{ format(data.simulated_input_tokens) }}</strong></div><div><span>假设调用批次</span><strong>{{ data.hypothetical_calls?.toLocaleString() ?? '暂不可用' }}</strong></div><div><span>重发上下文估算</span><strong>{{ format(data.context_tokens) }}</strong></div>
      </div>
      <p data-testid="simulation-baseline">
        基线：{{ format(data.baseline.tokens) }} Tokens / 假设批次 · {{ sources[data.baseline.source] }}<span v-if="data.baseline.model"> · {{ data.baseline.model }}</span>
      </p>
      <details data-testid="simulation-result-parameters">
        <summary>此结果的批次参数</summary>
        <p class="muted small-text">
          新批次间隔 {{ format(String(data.parameters.min_call_gap_ms)) }} 毫秒；批次合并间隔 {{ format(String(data.parameters.overlap_gap_ms)) }} 毫秒；读写切换间隔 {{ format(String(data.parameters.mutating_gap_ms)) }} 毫秒；批次参考步骤上限 {{ data.parameters.max_batch_steps }}。
        </p>
      </details>
      <p class="muted small-text">
        本次输入优先，留空使用默认 24,000 Tokens。固定底座和批次均为情景假设，不是实测系统提示开销或模型调用次数。
      </p>
      <p
        v-if="data.baseline.calibrated!==true"
        class="simulation-notice"
      >
        尚未校准：尚无满足完整归属和独立验证要求的会话样本。不能据此判断官方 Token 偏差。
      </p>
      <p
        v-for="warning in warnings"
        :key="warning"
        class="simulation-notice"
      >
        {{ warning }}
      </p>
      <details
        v-if="data.turns.length"
        :key="resultRevision"
      >
        <summary>查看各轮次模拟（{{ data.turns.length }} 轮）</summary><div class="simulation-table">
          <table>
            <thead><tr><th>轮次</th><th>假设批次</th><th>模拟输入 Tokens</th></tr></thead><tbody>
              <tr
                v-for="turn in data.turns.slice(0,shown)"
                :key="turn.turn_index"
              >
                <td>{{ turn.turn_index }}</td><td>{{ turn.hypothetical_calls }}</td><td>{{ format(turn.simulated_input_tokens) }}</td>
              </tr>
            </tbody>
          </table>
        </div><ElButton
          v-if="shown<data.turns.length"
          link
          @click="shown+=20"
        >
          再显示20轮
        </ElButton>
      </details>
      <p class="muted small-text">
        模拟算法：{{ data.metric_version }} · 基线规则：{{ data.baseline.version }}。范围为详情可见的近期上下文；未建模缓存、压缩或不可见调用。已观测回答内容估算为 {{ format(data.observed_output_tokens) }} Tokens，单列展示。
      </p>
      <p
        v-if="data.computed_at"
        class="muted small-text"
      >
        计算时间：{{ new Date(data.computed_at).toLocaleString() }}。相同来源和参数复用结果；调整假设或新增会话事件后重新计算。
      </p>
    </template>
  </section>
</template>
<style scoped>
.simulation-panel{border-top:1px solid var(--el-border-color);padding-top:22px;margin-top:26px}.simulation-inputs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:14px 0}.simulation-inputs label{display:grid;gap:8px;color:var(--el-text-color-secondary);font-size: var(--ui-font-body)}.simulation-inputs input{padding:8px 10px;background:var(--ui-control-bg);color:var(--el-text-color-primary);border:1px solid var(--ui-control-border);border-radius:var(--ui-control-radius);height:var(--ui-control-height);width:100%;box-sizing:border-box}.simulation-actions{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:16px 0}.simulation-actions span{font-size: var(--ui-font-small)}.simulation-parameters summary,details summary{cursor:pointer;padding:12px 0}.simulation-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:22px 0}.simulation-metrics>div{padding:16px;background:var(--el-fill-color-light);border-radius:6px}.simulation-metrics span{font-size: var(--ui-font-small);color:var(--el-text-color-secondary)}.simulation-metrics strong{display:block;margin-top:10px;font-size:var(--ui-font-metric);overflow-wrap:anywhere}.simulation-notice{color:#f4c77e;font-size: var(--ui-font-body)}.simulation-table{overflow:auto}.simulation-table table{width:100%;text-align:left;border-collapse:collapse}.simulation-table th,.simulation-table td{padding:10px;border-bottom:1px solid var(--el-border-color);font-size: var(--ui-font-body)}@media(max-width:800px){.simulation-inputs,.simulation-metrics{grid-template-columns:1fr}}
</style>
