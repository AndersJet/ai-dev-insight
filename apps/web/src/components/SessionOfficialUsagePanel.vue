<script setup lang="ts">
import OfficialUsageQuantity from './OfficialUsageQuantity.vue';
import { sumOfficialQuantity, hasOfficialQuantity, inputCacheHitRate, type OfficialMetric } from '../lib/official-usage-quantities.js';
import SessionTimeCandidates from './SessionTimeCandidates.vue';
import AmountMissingReasons from './AmountMissingReasons.vue';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { SessionDetailDto, SessionOfficialUsageDto } from '@adi/contracts';
import { officialUsage } from '../api/sessions.js';
import { isTransientReadFailure } from '../api/http.js';
const props=defineProps<{sessionId:string;period:SessionDetailDto['period']}>();
const data=ref<SessionOfficialUsageDto|null>(null);const busy=ref(false);const error=ref('');let generation=0;
const primaryFields = [{key:'total',label:'官方总 Tokens'}, {key:'input',label:'输入 Tokens'}, {key:'output',label:'输出 Tokens'}, {key:'calls',label:'模型调用次数'}] as const;
const cacheFields = [{key:'cache_read',label:'缓存读取 Tokens'}, {key:'cache_creation',label:'缓存创建 Tokens'}] as const;
const breakdownFields = [...primaryFields.filter(field=>field.key==='input'||field.key==='output'), ...cacheFields];
const hasQuantity = (key: OfficialMetric) => hasOfficialQuantity(data.value?.groups ?? [], key);
const visiblePrimaryFields = computed(()=>primaryFields.filter(field=>hasQuantity(field.key)));
const visibleCacheFields = computed(()=>cacheFields.filter(field=>hasQuantity(field.key)));
const visibleBreakdownFields = computed(()=>breakdownFields.filter(field=>hasQuantity(field.key)));
const reportedRecords = computed(()=>data.value?.groups.reduce((sum,row)=>sum+row.records,0)??0);
const quantity = (key: OfficialMetric) => sumOfficialQuantity(data.value?.groups ?? [], key);
const cacheHitRate=computed(()=>inputCacheHitRate(data.value?.groups??[]));
const models=computed(()=>new Set(data.value?.groups.filter(row=>row.model_name).map(row=>`${row.model_source}:${row.model_name}`)).size);
const originNames:Record<string,string>={Trae:'TRAE 内置',Custom:'企业统一接入',unknown:'未知模型来源'};
const consumptionNames:Record<string,string>={basic:'基础额度',pay_go:'超额用量',mixed:'基础与超额混用',enterprise_builtin:'企业模型',unknown:'未知来源'};
const probeNames:Record<string,string>={not_queried:'尚未查询关联',running:'关联核验中',observed:'已观测关联',empty:'最近未返回可关联记录',failed:'最近关联核验失败'};
const date=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
async function load(){const current=++generation;busy.value=true;error.value='';try{const result=await officialUsage(props.sessionId,props.period);if(current===generation)data.value=result.data;}catch(reason){if(current===generation){const message=reason instanceof Error?reason.message:'官方用量暂不可用';if(data.value&&isTransientReadFailure(reason))error.value=`刷新失败，当前为上次结果：${message}`;else{data.value=null;error.value=message;}}}finally{if(current===generation)busy.value=false;}}
watch(()=>[props.sessionId,props.period.from,props.period.to],(scope,previous)=>{
  // Parent detail refresh replaces the period object even when its boundaries
  // are unchanged. Re-query it in place; only a different scope invalidates the
  // displayed evidence and its nested disclosures.
  if (!previous || scope.some((value,index)=>value!==previous[index])) data.value=null;
  void load();
},{immediate:true,flush:'sync'});onBeforeUnmount(()=>{generation++;});
</script>
<template>
  <section
    class="session-usage"
    data-testid="session-official-usage"
  >
    <div class="usage-heading">
      <p>来源：TRAE 官方用量接口的已同步记录；Hook 只提供执行轨迹。</p><ElButton
        :disabled="busy"
        @click="load"
      >
        刷新显示
      </ElButton>
    </div>
    <ElAlert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
    />
    <div
      v-if="visiblePrimaryFields.length"
      class="usage-kpis"
    >
      <div
        v-for="field in visiblePrimaryFields"
        :key="field.key"
      >
        <span>{{ field.label }}</span><b :data-testid="field.key==='total'?'session-official-tokens':`session-official-${field.key}`"><OfficialUsageQuantity
          :quantity="quantity(field.key)"
          :records="reportedRecords"
        /></b>
        <small v-if="field.key==='total'">已获取的问答用量，不含 CUE 补全；会话完整性见下方说明</small>
      </div>
    </div>
    <div
      v-if="visibleCacheFields.length"
      class="usage-cache"
    >
      <div
        v-for="field in visibleCacheFields"
        :key="field.key"
      >
        <span>{{ field.label }}</span><b :data-testid="`session-official-${field.key}`"><OfficialUsageQuantity
          :quantity="quantity(field.key)"
          :records="reportedRecords"
        /></b>
      </div>
      <div v-if="cacheHitRate!==undefined">
        <span>输入缓存命中率</span><b data-testid="session-official-cache-hit-rate">{{ cacheHitRate }}</b>
      </div>
      <p>输入缓存命中率 = 缓存读取 Tokens ÷ 输入 Tokens；按已报告范围计算，不代表请求命中次数比例。</p>
      <p>缓存是输入用量的明细，不再加入总 Tokens。官方记录模型：{{ models?`${models} 个`:'未知' }}。</p>
    </div>
    <p
      v-if="busy && !data"
      class="muted"
      role="status"
    >
      正在读取官方用量…
    </p>
    <p
      v-else-if="data && !data.configured"
      class="muted"
    >
      官方用量来源尚未配置，当前可查看 Hook 执行轨迹。
    </p>
    <template v-else-if="data?.configured">
      <p
        v-if="!visiblePrimaryFields.length && !visibleCacheFields.length"
        class="muted"
        data-testid="official-usage-unavailable"
      >
        当前没有可展示的官方用量数字；可继续查看 Hook 执行轨迹。
      </p>
      <div
        v-if="(data.session_coverage?.state??'unknown')==='unknown'"
        class="usage-evidence"
        data-testid="session-official-coverage"
      >
        <strong>会话完整性未知</strong>
        <p>上方数值仅为已关联部分，尚不能证明会话用量已列全。</p>
      </div>
      <div
        v-if="data.session_query"
        class="usage-evidence"
        data-testid="session-query-status"
      >
        <strong>{{ data.session_query.state==='ready' ? '官方用量已获取' : '用量待确认' }}</strong>
        <p>{{ data.session_query.billing_ids.length }} 个计费标识 · 最近获取 {{ date(data.session_query.observed_at) }}</p>
        <p v-if="data.session_query.state!=='ready'">
          存在尚未确认的用量；当前只显示可用部分，不能据此认定零使用。
        </p>
        <p v-if="data.session_query.reasons.includes('query_failed')">
          刷新失败，显示上次成功获取的数量。
        </p>
      </div>
      <div
        v-else
        class="usage-evidence"
      >
        <strong>{{ probeNames[data.attribution.probe_state] ?? '关联状态未知' }}</strong>
        <p>{{ data.attribution.linked_ids }} 个计费标识具有唯一有效关联；{{ data.attribution.conflicting_ids }} 个存在冲突；{{ data.attribution.unmatched_ids }} 个在当前范围尚未匹配到可用按日记录。</p>
        <p v-if="data.attribution.pending">
          关联任务已排队或正在执行；已有记录仍按当前有效版本展示。
        </p>
        <details class="usage-method">
          <summary>查看关联依据与时间</summary>
          <p>关联依据：单 Hook 查询。查询成功或账号日存在有效结果，都不能证明会话账项完整。</p>
          <p v-if="data.attribution.requested_at">
            最近发起查询 {{ date(data.attribution.requested_at) }} · 探查版本 {{ data.attribution.probe_revision }}。
          </p>
          <p v-if="data.attribution.observed_at">
            最近成功响应 {{ date(data.attribution.observed_at) }}，可能早于本次探查。
          </p>
          <p>模型来源以官方响应为准；Hook ID 能否查到不能用于判定模型类型。</p>
          <p>空响应或查询失败不等于零使用，也不说明使用了个人自配模型；最近查询状态与历史有效关联分别展示。</p>
          <p>报告金额不是最终现金支付。</p>
        </details>
      </div>
      <ElAlert
        v-if="!data.session_query && data.attribution.conflicting_ids"
        title="存在多会话归因冲突，相关用量暂不计入本会话。"
        type="warning"
        :closable="false"
      />
      <ElAlert
        v-if="!data.session_query && data.coverage.missing_days"
        :title="`相关账号日还有 ${data.coverage.missing_days} 天未完成核验，当前数值不代表完整会话总量。`"
        type="warning"
        :closable="false"
      />
      <ElAlert
        v-if="!data.session_query && data.coverage.invalidated_days"
        :title="`${data.coverage.invalidated_days} 天的来源范围已失效，相关旧值未计入，等待重新核验。`"
        type="warning"
        :closable="false"
      />
      <div class="data-panel usage-table">
        <ElTable
          :data="data.groups"
          empty-text="当前没有可可靠关联的官方记录，不能据此认定零使用。"
        >
          <ElTableColumn
            label="模型 / 来源"
            min-width="180"
          >
            <template #default="{row}">
              <span class="model-name">{{ row.model_name || '模型未标明' }}</span><span class="secondary">{{ originNames[row.model_source] }} · {{ row.client==='ide'?'IDE':'客户端未标明' }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn
            label="消耗类别"
            min-width="100"
          >
            <template #default="{row}">
              {{ consumptionNames[row.consumption_source] }}
            </template>
          </ElTableColumn>
          <ElTableColumn
            v-if="hasQuantity('total')"
            label="官方 Token"
            min-width="110"
          >
            <template #default="{row}">
              <OfficialUsageQuantity
                :quantity="{tokens:row.tokens,known_tokens:row.known_tokens,missing_token_records:row.missing_token_records}"
                :records="row.records"
              />
            </template>
          </ElTableColumn>
          <ElTableColumn
            v-for="field in visibleBreakdownFields"
            :key="field.key"
            :label="field.label"
            min-width="110"
          >
            <template #default="{row}">
              <OfficialUsageQuantity
                :quantity="row.token_breakdown?.[field.key]"
                :records="row.records"
              />
            </template>
          </ElTableColumn>
          <ElTableColumn
            v-if="hasQuantity('calls')"
            label="模型调用"
            min-width="90"
          >
            <template #default="{row}">
              <OfficialUsageQuantity
                :quantity="{tokens:row.calls,known_tokens:row.known_calls,missing_token_records:row.missing_call_records}"
                :records="row.records"
              />
            </template>
          </ElTableColumn>
          <ElTableColumn
            label="报告金额"
            min-width="150"
          >
            <template #default="{row}">
              {{ row.amount===null?'金额或币种未完整提供':`${row.amount} ${row.currency}` }}<span
                v-if="row.amount===null && row.known_amount!==null"
                class="secondary"
              >已知部分 {{ row.known_amount }} {{ row.currency }}</span><AmountMissingReasons :reasons="row.amount_missing_reasons" /><span
                v-if="row.quality_records"
                class="secondary"
              >{{ row.quality_records }} 条来源质量提示</span>
            </template>
          </ElTableColumn>
        </ElTable>
      </div>
      <p
        v-if="!data.session_query"
        class="usage-coverage"
      >
        来源采集 · 账号日核验 {{ data.coverage.verified_days }} / {{ data.coverage.expected_days }} 天，按 Hook 起止之间的日期及已关联记录日期计算；只反映查询范围核验，不代表会话完整。
      </p>
      <p
        v-if="!data.session_query && data.coverage.query_through_at"
        class="usage-coverage"
      >
        最近查询上界（不含）{{ date(data.coverage.query_through_at) }}<span v-if="data.coverage.oldest_verified_at"> · 最早核验 {{ date(data.coverage.oldest_verified_at) }}</span>。当前日可能尚未结束，后续记录会继续修订。
      </p>
      <SessionTimeCandidates
        v-if="!data.session_query && data.time_candidates"
        :data="data.time_candidates"
      />
      <details
        v-if="!data.session_query && data.coverage.revision"
        class="usage-coverage"
      >
        <summary>查看来源数据版本</summary>
        <span>{{ data.coverage.revision }}</span> · 来源核验版本可能因重查、修订或清理而变化，不代表 Token 数量一定改变。
      </details>
    </template>
  </section>
</template>
<style scoped>
.usage-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }.usage-heading p,.usage-evidence p,.usage-coverage { color: #91a3be; font-size: var(--ui-font-small); line-height: 1.7; }.usage-kpis { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 16px; margin: 20px 0; }.usage-kpis > div { padding: 18px; background: #111d31; border: 1px solid #2b3a50; border-radius: 8px; }.usage-kpis > div > span,.usage-kpis small { display: block; color: #91a3be; font-size: var(--ui-font-small); }.usage-kpis b { display: block; color: #f1f5f9; font-size: var(--ui-font-metric); margin: 10px 0; overflow-wrap: anywhere; }.usage-kpis small { font-size: var(--ui-font-small); }.usage-evidence { padding: 16px 18px; border: 1px solid #294269; border-radius: 8px; background: #122139; margin: 18px 0; }.usage-evidence strong { color: #93c5fd; font-size: var(--ui-font-small); }.usage-evidence p { margin: 7px 0 0; }.usage-table { margin: 18px 0; }.session-usage :deep(.el-alert) { margin: 12px 0; }.model-name { overflow-wrap: anywhere; white-space: normal; }
.usage-cache{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;padding:16px 18px;border:1px solid #294269;border-radius:8px}.usage-cache > div > span{color:#91a3be;font-size:var(--ui-font-small)}.usage-cache b{display:block;margin-top:8px;font-size:var(--ui-font-subtitle)}.usage-cache p{grid-column:1/-1;color:#91a3be;font-size:var(--ui-font-small);line-height:1.7;margin:0}.usage-method { margin-top: 10px; font-size: var(--ui-font-small); }.usage-method summary { cursor: pointer; }
@media(max-width:760px) { .usage-kpis { grid-template-columns: minmax(0,1fr); }.usage-heading { align-items: start; } }
</style>
