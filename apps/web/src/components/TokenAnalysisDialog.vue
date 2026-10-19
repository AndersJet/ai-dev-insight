<script setup lang="ts">
import {ref,onMounted,onBeforeUnmount,watch} from 'vue';
import type {SessionListDto} from '@adi/contracts';
import {ApiFailure} from '../api/http.js';
import * as api from '../api/sessions.js';
const props=defineProps<{sessionId:string;userId:string;all:boolean;title?:string}>();
const emit=defineEmits<{close:[];invalidated:[]}>();
const today=new Date(Date.now()+28800000).toISOString().slice(0,10);
const from=ref(new Date(Date.now()+28800000-44*86400000).toISOString().slice(0,10)),to=ref(today),search=ref('');
const associate=ref(false),selected=ref(new Set([props.sessionId])),items=ref<SessionListDto['items']>([]),cursor=ref<string|undefined>(),next=ref<string|null>(null);
const loading=ref(false),downloading=ref(false),error=ref('');let active=true,generation=0,abort=new window.AbortController();
watch(associate,value=>{if(!value)selected.value=new Set([props.sessionId]);});
onBeforeUnmount(()=>{active=false;generation++;abort.abort();});
const format=(date:string)=>new Date(date).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
function visibilityChanged(value:boolean){if(!value)emit('close');}
function toggle(id:string){if(id===props.sessionId)return;const copy=new Set(selected.value);if(copy.has(id))copy.delete(id);else copy.add(id);selected.value=copy;}
function invalidated(reason:unknown){
  if(reason instanceof ApiFailure&&['unauthenticated','unauthorized','forbidden','not_found','recovery_quarantined','content_changed'].includes(reason.code)){
    items.value=[];selected.value=new Set([props.sessionId]);emit('invalidated');
  }
}
async function load(reset=false){
  abort.abort();abort=new window.AbortController();const current=++generation;error.value='';items.value=[];loading.value=true;
  if(reset)cursor.value=undefined;
  try{
    const start=new Date(`${from.value}T00:00:00+08:00`),end=new Date(new Date(`${to.value}T00:00:00+08:00`).getTime()+86400000);
    const {data}=await api.list(props.all,{from:start.toISOString(),to:end.toISOString(),search:search.value,limit:20,...(props.all?{user_id:props.userId}:{}),...(cursor.value?{cursor:cursor.value}:{})},abort.signal);
    if(!active||current!==generation)return;items.value=data.items;next.value=data.next_cursor;
  }catch(reason){if(active&&current===generation){next.value=null;invalidated(reason);error.value=reason instanceof Error?reason.message:'读取失败，请重试';}}
  finally{if(active&&current===generation)loading.value=false;}
}
async function download(){
  error.value='';downloading.value=true;const current=generation;
  try{
    const blob=await api.downloadAnalysis([...selected.value],abort.signal);
    if(!active||current!==generation)return;
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='token-efficiency-analysis.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);emit('close');
  }catch(reason){if(active&&current===generation){invalidated(reason);error.value=reason instanceof Error?reason.message:'下载失败，请重试';}}
  finally{if(active)downloading.value=false;}
}
onMounted(()=>{void load();});
</script>
<template>
  <ElDialog
    :model-value="true"
    title="Token能效分析"
    width="min(1080px, 94vw)"
    align-center
    append-to-body
    :close-on-click-modal="false"
    @update:model-value="visibilityChanged"
  >
    <p class="analysis-intro">
      是否关联此人其他会话？同一任务可跨会话、跨天，由你选择。
    </p>
    <p class="muted small-text">
      当前会话已选中；导出各会话现存可读记录，最多最近45天，不受查找日期限制。
    </p>
    <ElCheckbox
      v-model="associate"
      :disabled="downloading"
    >
      关联其他会话
    </ElCheckbox>
    <div
      v-if="associate"
      class="analysis-picker"
    >
      <ElForm
        class="analysis-filters"
        label-position="top"
        @submit.prevent="load(true)"
      >
        <ElFormItem label="开始日期">
          <ElInput
            v-model="from"
            type="date"
            aria-label="开始日期"
            :max="today"
            :disabled="downloading"
          />
        </ElFormItem>
        <ElFormItem label="结束日期（包含当天）">
          <ElInput
            v-model="to"
            type="date"
            aria-label="结束日期"
            :max="today"
            :disabled="downloading"
          />
        </ElFormItem>
        <ElFormItem
          label="用户提示词"
          class="analysis-search"
        >
          <ElInput
            v-model="search"
            aria-label="用户提示词"
            maxlength="128"
            :disabled="downloading"
            placeholder="查找提示内容或会话ID"
            clearable
          />
        </ElFormItem>
        <ElButton
          native-type="submit"
          :disabled="loading || downloading"
        >
          查询
        </ElButton>
      </ElForm>
      <div
        class="data-panel analysis-results"
        :aria-busy="loading"
      >
        <ElTable
          :data="items"
          :max-height="'min(320px, 32vh)'"
          :empty-text="loading?'正在读取会话…':error?'会话列表暂不可用':'此查找范围未找到会话，已选会话仍保留'"
        >
          <ElTableColumn
            label="选择"
            width="60"
            align="center"
          >
            <template #default="{row}">
              <ElCheckbox
                :aria-label="`选择会话 ${row.title}`"
                :model-value="selected.has(row.id)"
                :disabled="row.id===sessionId || downloading"
                @change="toggle(row.id)"
              />
            </template>
          </ElTableColumn>
          <ElTableColumn
            label="用户提示词摘要"
            min-width="280"
          >
            <template #default="{row}">
              <span
                class="analysis-prompt"
                :title="row.title"
              >{{ row.title }}</span>
            </template>
          </ElTableColumn>
          <ElTableColumn
            label="会话产生时间"
            min-width="170"
          >
            <template #default="{row}">
              {{ format(row.first_at) }}
            </template>
          </ElTableColumn>
          <ElTableColumn
            prop="prompt_turns"
            label="提示轮次"
            width="88"
          />
          <ElTableColumn
            label="已关联官方 Token / 模型"
            min-width="245"
          >
            <template #default="{row}">
              <span class="analysis-tokens">{{ row.official_tokens===null?'—':BigInt(row.official_tokens).toLocaleString('zh-CN') }}</span>
              <span
                class="secondary analysis-model"
                :title="row.model??'模型未知'"
              >{{ row.model_count>1?`${row.model_count} 个官方模型`:row.model??'模型未知' }}</span>
            </template>
          </ElTableColumn>
        </ElTable>
        <div class="table-pager analysis-pager">
          <span>已选 {{ selected.size }} 个会话（跨页保留）</span>
          <div>
            <ElButton
              :disabled="loading || downloading"
              @click="load(true)"
            >
              回到第一页
            </ElButton>
            <ElButton
              :disabled="!next || loading || downloading"
              @click="cursor=next??undefined; load()"
            >
              下一页
            </ElButton>
          </div>
        </div>
      </div>
    </div>
    <ElAlert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      class="analysis-notice"
    />
    <ElAlert
      v-if="selected.size>20"
      title="每包最多选择20个会话，请减少选择。"
      type="warning"
      :closable="false"
      class="analysis-notice"
    />
    <p class="muted small-text analysis-help">
      下载后解压，在目录中让 Trae、opencode 等工具执行 prompt.md，生成分析结果.html。已关联量不代表完整会话成本。
    </p>
    <template #footer>
      <ElButton @click="emit('close')">
        取消
      </ElButton>
      <ElButton
        type="primary"
        :loading="downloading"
        :disabled="downloading || selected.size>20"
        @click="download"
      >
        {{ downloading?'正在打包…':'下载分析包' }}
      </ElButton>
    </template>
  </ElDialog>
</template>
<style scoped>
.analysis-intro { margin-bottom: 8px; }.analysis-picker { margin-top: 16px; }.analysis-filters { display: grid; grid-template-columns: 164px 164px minmax(180px,1fr) auto; gap: 16px; align-items: end; margin-bottom: 20px; }.analysis-filters :deep(.el-form-item) { margin-bottom: 0; min-width: 0; }.analysis-filters :deep(.el-input) { width: 100%; }.analysis-filters>.el-button { margin-bottom: 0; }.analysis-prompt,.analysis-model { overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }.analysis-tokens { font-variant-numeric: tabular-nums; }.analysis-pager { flex-wrap: wrap; gap: 12px; }.analysis-pager>div { display: flex; gap: 8px; }.analysis-pager :deep(.el-button+.el-button) { margin-left: 0; }.analysis-help { margin: 18px 0 0; }.analysis-notice { margin-top: 16px; }
@media(max-width:800px) { .analysis-filters { grid-template-columns: repeat(2,minmax(0,1fr)); }.analysis-search { grid-column: 1/-1; }.analysis-filters>.el-button { grid-column: 1/-1; justify-self: end; } }
</style>
