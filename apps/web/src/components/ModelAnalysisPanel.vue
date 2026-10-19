<script setup lang="ts">
import AmountMissingReasons from './AmountMissingReasons.vue';
import {ApiFailure,isTransientReadFailure} from '../api/http.js';
import {ref,watch,onBeforeUnmount} from 'vue';import {storeToRefs} from 'pinia';import type {AnalyticsQueryDto,ModelsDto,DeclaredModelsDto} from '@adi/contracts';import * as api from '../api/analytics.js';import ModelTokenTrend from './ModelTokenTrend.vue';import {useModelPreferences} from '../stores/model-preferences.js';import {useSession} from '../stores/session.js';
const emit=defineEmits<{unavailable:[reason:unknown]}>();
const notice=ref(''),declaredNotice=ref('');
const props=defineProps<{query:AnalyticsQueryDto;revision?:number}>();const official=ref<ModelsDto|null>(null);const declared=ref<DeclaredModelsDto|null>(null);const loading=ref(false);const declaredLoading=ref(false);const error=ref('');const declaredError=ref('');
const preferences=useModelPreferences();preferences.setOwner(useSession().user?.user_id??'');const {scene,client,metric}=storeToRefs(preferences);
const selected=ref('');const page=ref(0);const declaredPage=ref(0);const cursors=ref<(string|undefined)[]>([undefined]);const declaredCursors=ref<(string|undefined)[]>([undefined]);const search=ref('');const appliedSearch=ref('');let generation=0;let declaredGeneration=0;
const scenes=[{value:'Chat',label:'问答'},{value:'CUE',label:'CUE 补全'},{value:'other',label:'其他场景'}] as const;const clients=[{value:'ide',label:'IDE'},{value:'unspecified',label:'客户端未标明'}] as const;
const origin:Record<string,string>={Trae:'TRAE 内置',Custom:'企业统一接入',unknown:'来源未知'};const integer=(value:string|null)=>value===null?'未知':BigInt(value).toLocaleString('zh-CN');
const time=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
function readFailure(reason:unknown,kind:'official'|'declared') {
  const target=kind==='official'?official:declared, message=kind==='official'?error:declaredError;
  const detail=reason instanceof Error?reason.message:'模型统计暂不可用';
  if(target.value&&isTransientReadFailure(reason))message.value=`刷新失败，当前为上次结果：${detail}`;
  else{target.value=null;message.value=detail;}
  if(reason instanceof ApiFailure&&([401,403].includes(reason.status)||reason.code==='recovery_quarantined')){
    official.value=null;declared.value=null;generation++;declaredGeneration++;loading.value=false;declaredLoading.value=false;emit('unavailable',reason);
  }
}
async function loadOfficial(refreshing=false,recovering=false):Promise<void>{
  const current=++generation,cursor=cursors.value[page.value];loading.value=true;error.value='';
  if(!refreshing)official.value=null;if(!recovering)notice.value='';
  try{
    const result=await api.models({...props.query,scene:scene.value,client:client.value,limit:10,...(selected.value?{model_key:selected.value}:{}),...(cursor?{cursor}:{})});
    if(current===generation)official.value=result.data;
  }catch(reason){
    if(current!==generation)return;
    if(cursor&&reason instanceof ApiFailure&&reason.code==='invalid_cursor'){
      official.value=null;page.value=0;cursors.value=[undefined];notice.value='模型列表分页已更新，已回到第一页。';
      return loadOfficial(false,true);
    }
    readFailure(reason,'official');
  }finally{if(current===generation)loading.value=false;}
}
async function loadDeclared(refreshing=false,recovering=false):Promise<void>{
  const current=++declaredGeneration,cursor=declaredCursors.value[declaredPage.value];declaredLoading.value=true;declaredError.value='';
  if(!refreshing)declared.value=null;if(!recovering)declaredNotice.value='';
  try{
    const result=await api.declaredModels({...props.query,limit:10,search:appliedSearch.value,...(cursor?{cursor}:{})});
    if(current===declaredGeneration)declared.value=result.data;
  }catch(reason){
    if(current!==declaredGeneration)return;
    if(cursor&&reason instanceof ApiFailure&&reason.code==='invalid_cursor'){
      declared.value=null;declaredPage.value=0;declaredCursors.value=[undefined];declaredNotice.value='本人确认列表分页已更新，已回到第一页。';
      return loadDeclared(false,true);
    }
    readFailure(reason,'declared');
  }finally{if(current===declaredGeneration)declaredLoading.value=false;}
}
function resetOfficial(clearModel=true){page.value=0;cursors.value=[undefined];if(clearModel)selected.value='';void loadOfficial();}
function resetDeclared(){declaredPage.value=0;declaredCursors.value=[undefined];void loadDeclared();}
function refresh(){void loadOfficial(true);void loadDeclared(true);}
function selectScene(value:typeof scene.value){scene.value=value;resetOfficial();}function selectClient(value:typeof client.value){client.value=value;resetOfficial();}
function selectModel(key:string){selected.value=key;void loadOfficial();}
function nextOfficial(direction:number){if(direction>0){if(!official.value?.next_cursor)return;cursors.value[page.value+1]=official.value.next_cursor;}page.value+=direction;void loadOfficial();}
function nextDeclared(direction:number){if(direction>0){if(!declared.value?.next_cursor)return;declaredCursors.value[declaredPage.value+1]=declared.value.next_cursor;}declaredPage.value+=direction;void loadDeclared();}
function find(){appliedSearch.value=search.value.trim();resetDeclared();}
watch(()=>props.revision,refresh);
watch(()=>JSON.stringify(props.query),()=>{resetOfficial();resetDeclared();},{immediate:true});onBeforeUnmount(()=>{generation++;declaredGeneration++;});
</script>
<template>
  <section
    class="data-panel model-panel"
    data-testid="model-analysis"
  >
    <div class="model-heading">
      <div><h2>模型分布与趋势</h2><p>官方记录按模型来源与报告名称分组；报告金额不代表现金结算。</p></div><ElButton
        :disabled="loading || declaredLoading"
        @click="refresh"
      >
        刷新模型统计
      </ElButton>
    </div>
    <div class="model-filters">
      <span>官方场景</span><div
        class="segments"
        role="radiogroup"
        aria-label="模型场景"
      >
        <button
          v-for="choice in scenes"
          :key="choice.value"
          role="radio"
          :aria-checked="scene===choice.value"
          :disabled="loading"
          @click="selectScene(choice.value)"
        >
          {{ choice.label }}
        </button>
      </div><span>客户端</span><div
        class="segments"
        role="radiogroup"
        aria-label="模型客户端"
      >
        <button
          v-for="choice in clients"
          :key="choice.value"
          role="radio"
          :aria-checked="client===choice.value"
          :disabled="loading"
          @click="selectClient(choice.value)"
        >
          {{ choice.label }}
        </button>
      </div>
    </div>
    <div class="model-body">
      <ElAlert
        v-if="notice"
        :title="notice"
        type="info"
        :closable="false"
      />
      <ElAlert
        v-if="error"
        :title="error"
        type="error"
        :closable="false"
      >
        <ElButton
          link
          @click="resetOfficial()"
        >
          重置模型选择并重试
        </ElButton>
      </ElAlert>
      <p
        v-if="loading && !official"
        role="status"
        class="muted"
      >
        正在读取模型统计…
      </p>
      <p
        v-else-if="official && !official.configured"
        class="muted"
      >
        官方用量来源尚未配置，仍可查看下方本人确认。
      </p>
      <template v-else-if="official?.configured">
        <div class="model-trend-heading">
          <strong data-testid="selected-model">{{ official.selected_model ? `当前模型：${official.selected_model.name || '未标明模型'} · ${origin[official.selected_model.model_source]}` : '当前趋势：全部模型' }}</strong><ElButton
            v-if="selected"
            link
            type="primary"
            @click="selectModel('')"
          >
            全部模型
          </ElButton>
        </div>
        <div class="model-metric-filter">
          <span>趋势指标</span><div
            class="segments"
            role="radiogroup"
            aria-label="模型趋势指标"
          >
            <button
              role="radio"
              :aria-checked="metric==='tokens'"
              @click="metric='tokens'"
            >
              Token
            </button><button
              role="radio"
              :aria-checked="metric==='calls'"
              @click="metric='calls'"
            >
              调用次数
            </button>
          </div>
        </div>
        <ModelTokenTrend
          :items="official.trend"
          :metric="metric"
        />
        <details class="daily-model-data">
          <summary>查看每日报告数据</summary><ElTable
            :data="official.trend"
            data-testid="daily-model-data"
          >
            <ElTableColumn
              prop="date"
              label="日期"
              width="120"
            /><ElTableColumn
              label="官方 Token"
              min-width="140"
            >
              <template #default="{row}">
                {{ integer(row.tokens) }}<span
                  v-if="row.missing_token_records"
                  class="secondary"
                >已知部分 {{ integer(row.known_tokens) }}</span>
              </template>
            </ElTableColumn><ElTableColumn
              label="报告调用次数"
              width="140"
            >
              <template #default="{row}">
                {{ integer(row.calls) }}
              </template>
            </ElTableColumn><ElTableColumn
              prop="records"
              label="报告记录数"
              width="120"
            /><ElTableColumn
              label="账号日核验"
              min-width="140"
            >
              <template #default="{row}">
                {{ row.verified_users }} / {{ row.expected_users }}
              </template>
            </ElTableColumn>
          </ElTable>
        </details>
        <ElAlert
          v-if="official.coverage.missing_user_days"
          :title="`${official.coverage.missing_user_days} 个人员日尚未完成同步核验；当前用量不是完整期间总量。`"
          type="warning"
          :closable="false"
        />
        <ElTable
          :data="official.items"
          data-testid="official-model-table"
          empty-text="该范围尚未获取所选场景和客户端的模型记录。"
        >
          <ElTableColumn
            label="模型 / 来源"
            min-width="190"
          >
            <template #default="{row}">
              <span
                class="model-name"
                :title="row.name || '模型未标明'"
              >{{ row.name || '模型未标明' }}</span><span class="secondary">{{ origin[row.model_source] }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn
            label="官方 Token"
            min-width="130"
          >
            <template #default="{row}">
              {{ integer(row.tokens) }}<span
                v-if="row.missing_token_records"
                class="secondary"
              >已知部分 {{ integer(row.known_tokens) }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn
            label="调用次数"
            width="95"
          >
            <template #default="{row}">
              {{ integer(row.calls) }}
            </template>
          </ElTableColumn>
          <ElTableColumn
            prop="users"
            label="涉及账号"
            width="90"
          />
          <ElTableColumn
            label="报告金额（按币种）"
            min-width="170"
          >
            <template #default="{row}">
              <div
                v-for="cost in row.costs"
                :key="cost.currency || 'unknown'"
                class="model-cost"
              >
                {{ cost.amount===null?`金额未完整提供 · ${cost.currency || '币种未标明'}`:`${cost.amount} ${cost.currency}` }}<span
                  v-if="cost.amount===null && cost.known_amount!==null"
                  class="secondary"
                >已知部分 {{ cost.known_amount }} {{ cost.currency }}</span><AmountMissingReasons :reasons="cost.amount_missing_reasons" />
              </div><span
                v-if="row.quality_records"
                class="secondary"
              >{{ row.quality_records }} 条来源质量提示</span>
            </template>
          </ElTableColumn>
          <ElTableColumn
            label="趋势"
            width="95"
          >
            <template #default="{row}">
              <ElButton
                link
                type="primary"
                @click="selectModel(row.key)"
              >
                看趋势
              </ElButton>
            </template>
          </ElTableColumn>
        </ElTable>
        <div class="table-pager">
          <span>共 {{ official.total }} 个模型分组 · 第 {{ page+1 }} 页</span><div>
            <ElButton
              :disabled="loading || !page"
              @click="nextOfficial(-1)"
            >
              上一页
            </ElButton><ElButton
              :disabled="loading || !official.has_more"
              @click="nextOfficial(1)"
            >
              下一页
            </ElButton>
          </div>
        </div>
        <p class="model-note">
          涉及账号数只表示所选官方记录的账号，不是推广覆盖率。当前日仍会更新，不同币种不合计。
        </p>
        <p
          v-if="official.coverage.query_through_at"
          class="model-note"
        >
          当前范围最近查询边界（不含）{{ time(official.coverage.query_through_at) }}<span v-if="official.coverage.oldest_verified_at"> · 最早成功核验 {{ time(official.coverage.oldest_verified_at) }}</span>；不同账号可能更早，上游记录仍可能延迟或修订。
        </p>
        <p
          v-if="official.scope.department_ids"
          class="model-note"
        >
          部门数量采用官方报出部门的有效关联，与本地 Hook 成员统计的来源不同；无法可靠拆分的记录不归入部门。
        </p>
      </template>
      <div class="declared-heading">
        <h3>会话中的本人模型确认</h3><span>用户声明 · 不是官方用量</span>
      </div>
      <p class="model-note">
        统计所选日期和部门中出现过的会话所附确认，不能证明模型在该日期或部门被调用，不提供每日用量趋势。
      </p>
      <form
        class="declared-search"
        @submit.prevent="find"
      >
        <ElInput
          v-model="search"
          aria-label="搜索本人确认模型"
          placeholder="按声明名称筛选"
          maxlength="128"
        /><ElButton
          native-type="submit"
          :disabled="declaredLoading"
        >
          查询模型确认
        </ElButton>
      </form>
      <ElAlert
        v-if="declaredNotice"
        :title="declaredNotice"
        type="info"
        :closable="false"
      />
      <ElAlert
        v-if="declaredError"
        :title="declaredError"
        type="error"
        :closable="false"
      >
        <ElButton
          link
          @click="resetDeclared"
        >
          从第一页重试
        </ElButton>
      </ElAlert>
      <p
        v-if="declaredLoading && !declared"
        class="muted"
        role="status"
      >
        正在读取本人确认…
      </p>
      <template v-if="declared">
        <ElTable
          :data="declared.items"
          data-testid="declared-model-table"
          empty-text="当前范围没有本人确认记录，不能据此判断没有个人自配使用。"
        >
          <ElTableColumn
            label="本人确认的模型"
            min-width="230"
          >
            <template #default="{row}">
              <span class="model-name">{{ row.name }}</span>
            </template>
          </ElTableColumn><ElTableColumn
            prop="sessions"
            label="确认会话数"
            width="140"
          /><ElTableColumn
            prop="users"
            label="涉及账号数"
            width="140"
          />
        </ElTable>
        <div class="table-pager">
          <span>共 {{ declared.total }} 个名称 · 第 {{ declaredPage+1 }} 页</span><div>
            <ElButton
              :disabled="declaredLoading || !declaredPage"
              @click="nextDeclared(-1)"
            >
              上一页
            </ElButton><ElButton
              :disabled="declaredLoading || !declared.has_more"
              @click="nextDeclared(1)"
            >
              下一页
            </ElButton>
          </div>
        </div>
        <p class="model-note">
          整个范围共有 {{ declared.confirmed_sessions }} 个会话附有本人确认；名称搜索仅筛选表格。一个会话可确认多个模型，跨部门也可能重复出现，各行不可相加当作去重总数。
        </p>
      </template>
    </div>
  </section>
</template>
<style scoped>
.model-panel { margin-top: 24px; }.model-heading { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 20px; border-bottom: 1px solid #2b3a50; }.model-heading h2 { margin: 0; font-size: var(--ui-font-section); }.model-heading p,.model-note { color: #91a3be; font-size: var(--ui-font-small); line-height: 1.7; }.model-heading p { margin: 8px 0 0; }.model-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 18px 20px; color: #a6b4c9; font-size: var(--ui-font-small); }.segments { display: flex; padding: 3px; gap: 2px; border: 1px solid #2b3a50; border-radius: 7px; background: #0b1220; }.segments button { background: transparent; border: 0; border-radius: 5px; color: #a6b4c9; padding: 8px 12px; cursor: pointer; font: inherit; }.segments button[aria-checked='true'] { background: #1e3a5f; color: #93c5fd; }.segments button:disabled { opacity: .5; cursor: not-allowed; }.model-body { padding: 0 20px 20px; }.model-trend-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: var(--ui-font-body); }.model-body :deep(.el-alert) { margin: 16px 0; }.model-name { overflow-wrap: anywhere; }.model-cost+.model-cost { margin-top: 6px; }.declared-heading { border-top: 1px solid #2b3a50; padding-top: 22px; margin-top: 24px; display: flex; justify-content: space-between; align-items: center; gap: 12px; }.declared-heading h3 { font-size: var(--ui-font-subtitle); margin: 0; }.declared-heading span { font-size: var(--ui-font-small); color: #93c5fd; }.declared-search { display: flex; gap: 10px; max-width: 430px; margin: 16px 0; }
.model-metric-filter { display: flex; align-items: center; gap: 12px; margin: 14px 0 8px; font-size: var(--ui-font-small); color: #a6b4c9; }.model-trend-heading strong { min-width: 0; overflow-wrap: anywhere; }.model-name { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.daily-model-data { margin: 12px 0 18px; }.daily-model-data summary { cursor: pointer; color: #93c5fd; font-size: var(--ui-font-small); margin-bottom: 12px; }
</style>
