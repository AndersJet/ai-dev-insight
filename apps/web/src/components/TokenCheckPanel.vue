<script setup lang="ts">
import {onBeforeUnmount,ref,watch} from 'vue';
import type {SessionTokenCheckDto} from '@adi/contracts';
import {tokenCheck} from '../api/sessions.js';
import {isTransientReadFailure} from '../api/http.js';
const props=defineProps<{sessionId:string;revision?:number}>();const data=ref<SessionTokenCheckDto|null>(null),error=ref(''),loading=ref(false);let generation=0;
const states={current:'数据不足，无法判断 Token 偏差',stale:'来源已变化，等待重新检查',pending:'等待后台检查',failed:'本次检查未完成',not_checked:'尚未检查'};
const reasons:Record<string,string>={official_source_unconfigured:'官方来源尚未配置',official_source_incomplete:'相关官方日范围尚不完整或已失效',session_coverage_unknown:'会话出账完整性尚未证明',prediction_not_validated:'预测尚未通过独立验证',trace_pending:'会话轨迹正在更新',trace_partial:'上下文受查询窗口、清理或留存限制',trace_quality_issues:'轨迹存在待核查的质量标记',model_identity_unverified:'模型身份与来源尚未核实',multiple_models_unresolved:'多个模型尚无法可靠拆分'};
const format=(s:string)=>new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
async function load(){const current=++generation;error.value='';loading.value=true;try{const response=await tokenCheck(props.sessionId);if(current===generation)data.value=response.data;}catch(e){if(current===generation){const message=e instanceof Error?e.message:'检查结果暂不可用';if(data.value&&isTransientReadFailure(e))error.value=`刷新失败，当前为上次结果：${message}`;else{data.value=null;error.value=message;}}}finally{if(current===generation)loading.value=false;}}
watch(()=>[props.sessionId,props.revision],(_value,old)=>{if(!old||old[0]!==props.sessionId)data.value=null;void load();},{immediate:true,flush:'sync'});onBeforeUnmount(()=>{generation++;});
</script>
<template>
  <section
    class="token-check"
    data-testid="token-check"
  >
    <h3>数据检查</h3>
    <ElButton
      :loading="loading"
      @click="load"
    >
      刷新检查结果
    </ElButton>
    <p
      v-if="error"
      role="alert"
    >
      {{ error }}
    </p>
    <template v-if="data">
      <p role="status">
        <strong>{{ states[data.state] }}</strong>
      </p>
      <details class="check-explanation">
        <summary>查看原因与核查明细</summary>
        <p class="muted">
          检查来源和适用条件；判断偏差还需要完整关系、同口径模型和独立验证结果。
        </p>
        <ul v-if="data.result">
          <li
            v-for="reason in data.result.reasons"
            :key="reason"
          >
            {{ reasons[reason] ?? '尚有未满足的检查条件' }}
          </li>
        </ul>
        <p
          v-if="data.checked_at"
          class="muted"
        >
          结果计算时间：{{ format(data.checked_at) }}。来源未变时复用结果。
        </p>
        <p
          v-if="data.next_check_at"
          class="muted"
        >
          下次检查计划：{{ format(data.next_check_at) }}，实际执行受队列影响。
        </p>
      </details>
    </template>
  </section>
</template>
<style scoped>
.token-check{border-top:1px solid var(--el-border-color);padding-top:22px;margin-top:26px}.token-check li{margin:8px 0}
.check-explanation summary { cursor: pointer; }.check-explanation { font-size: var(--ui-font-small); }
</style>
