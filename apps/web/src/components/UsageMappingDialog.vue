<script setup lang="ts">
import {ref,watch,onBeforeUnmount} from 'vue';import {ElMessageBox} from 'element-plus';import type {DepartmentDto,UsageMappingPageDto} from '@adi/contracts';import * as api from '../api/usage-mappings.js';
import {ApiFailure,isTransientReadFailure} from '../api/http.js';
const props=defineProps<{modelValue:boolean;department:DepartmentDto|null}>();const emit=defineEmits<{'update:modelValue':[value:boolean]}>();
const data=ref<UsageMappingPageDto|null>(null);const busy=ref(false);const error=ref('');const external=ref('');const from=ref('');const to=ref('');const search=ref('');let generation=0;
const appliedSearch=ref('');let mappingPages=1;let candidatePages=1;
const notice=ref('');
const date=(value:string)=>new Date(Date.parse(value)+28800000).toISOString().slice(0,10);
function failed(reason:unknown,fallback:string,read=false){
 error.value=reason instanceof Error?reason.message:fallback;
 if(reason instanceof ApiFailure&&([401,403,404,410].includes(reason.status)||reason.code==='recovery_quarantined')){
  generation++;data.value=null;busy.value=false;external.value='';from.value='';to.value='';notice.value='';mappingPages=1;candidatePages=1;
 }else if(read){
  if(isTransientReadFailure(reason)&&data.value)notice.value='刷新失败，当前显示上次关联结果。';
  else data.value=null;
 }
}
async function load(kind:'reset'|'refresh'|'candidates'|'mappings'='reset'){
 if(!props.department||!props.modelValue)return;const current=++generation;busy.value=true;error.value='';notice.value='';
 try{
  const old=data.value,input={department_id:props.department.id,search:appliedSearch.value,limit:50};
  const response=await api.list({...input,...(kind==='candidates'&&old?.next_cursor?{after:old.next_cursor}:{}),...(kind==='mappings'&&old?.next_mapping_cursor?{after_mapping:old.next_mapping_cursor}:{})});if(current!==generation)return;
  if(kind==='refresh'&&old){
   const next={...response.data,items:[...response.data.items],candidates:[...response.data.candidates]};let loadedMappings=1,loadedCandidates=1;
   for(;loadedMappings<mappingPages&&next.next_mapping_cursor;loadedMappings++){
    const page=await api.list({...input,after_mapping:next.next_mapping_cursor});if(current!==generation)return;
    if(page.data.version!==next.version)throw new ApiFailure(409,'mapping_changed','关联配置已更新');
    next.items.push(...page.data.items);next.next_mapping_cursor=page.data.next_mapping_cursor;
   }
   for(;loadedCandidates<candidatePages&&next.next_cursor;loadedCandidates++){
    const page=await api.list({...input,after:next.next_cursor});if(current!==generation)return;
    next.candidates.push(...page.data.candidates);next.next_cursor=page.data.next_cursor;
   }
   data.value=next;mappingPages=loadedMappings;candidatePages=loadedCandidates;
  }else{
   if(kind==='mappings'&&old&&response.data.version!==old.version)throw new ApiFailure(409,'mapping_changed','关联配置已更新');
   if(kind==='candidates'&&old&&response.data.version!==old.version){candidatePages++;throw new ApiFailure(409,'mapping_changed','关联配置已更新');}
   data.value=kind==='reset'||!old?response.data:kind==='candidates'?{...response.data,items:old.items,candidates:[...old.candidates,...response.data.candidates],next_mapping_cursor:old.next_mapping_cursor}:{...response.data,candidates:old.candidates,items:[...old.items,...response.data.items],next_cursor:old.next_cursor};
   if(kind==='reset'){mappingPages=1;candidatePages=1;}else if(kind==='mappings')mappingPages++;else if(kind==='candidates')candidatePages++;
  }
 }
 catch(reason){
  if(current===generation){
   if(reason instanceof ApiFailure&&reason.code==='mapping_changed'&&data.value&&(mappingPages>1||kind==='mappings'||kind==='candidates')){
    data.value={...data.value,items:[],next_mapping_cursor:null};mappingPages=1;const recovery=generation+1;await load('refresh');
    if(recovery===generation&&props.modelValue&&!error.value)notice.value='关联配置已更新，已恢复关联首页。';
   }else failed(reason,'无法读取关联',true);
  }
 }finally{if(current===generation)busy.value=false;}
}
function query(){appliedSearch.value=search.value;mappingPages=1;candidatePages=1;return load();}
async function add(){if(!props.department||!data.value||busy.value)return;const current=++generation;busy.value=true;error.value='';try{await api.create({department_id:props.department.id,external_department_id:external.value,from_date:from.value,...(to.value?{to_date:to.value}:{}),version:data.value.version});if(current!==generation)return;external.value='';await load('refresh');}catch(reason){if(current===generation)failed(reason,'关联失败');}finally{if(current===generation)busy.value=false;}}
async function remove(id:string){if(!data.value||busy.value)return;const current=++generation;const version=data.value.version;try{await ElMessageBox.confirm('此关联仅作历史配置保留，不参与当前部门统计；移除不会改写原始用量记录。','移除官方部门关联',{confirmButtonText:'确认移除',cancelButtonText:'取消',type:'warning',confirmButtonClass:'danger-confirm'});}catch{return;}if(current!==generation)return;busy.value=true;error.value='';try{await api.remove(id,version);if(current!==generation)return;await load('refresh');}catch(reason){if(current===generation)failed(reason,'移除失败');}finally{if(current===generation)busy.value=false;}}
watch(()=>[props.modelValue,props.department?.id],()=>{generation++;data.value=null;busy.value=false;error.value='';notice.value='';mappingPages=1;candidatePages=1;appliedSearch.value='';if(props.modelValue){search.value='';external.value='';from.value=new Date(Date.now()+28800000).toISOString().slice(0,10);to.value='';void load();}},{immediate:true});onBeforeUnmount(()=>{generation++;});
</script>
<template>
  <ElDialog
    align-center
    :model-value="modelValue"
    title="官方部门关联"
    width="760px"
    @update:model-value="emit('update:modelValue',$event)"
  >
    <p>{{ department?.name }} · 历史关联配置仅供查阅维护，不参与当前部门统计。用量按人员的本地部门历史归属，无需新增此关联。</p>
    <ElAlert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
    />
    <p
      v-if="notice"
      role="status"
    >
      {{ notice }}
    </p>
    <p
      v-if="data && !data.configured"
      class="muted"
    >
      尚未配置官方用量来源。
    </p>
    <p
      v-if="!data"
      class="muted"
    >
      {{ busy ? '正在读取官方关联…' : '官方关联尚未读取。' }}
    </p>
    <ElButton
      v-if="!data?.configured"
      :disabled="busy"
      @click="load('refresh')"
    >
      刷新
    </ElButton>
    <template v-if="data?.configured">
      <div class="mapping-search">
        <ElInput
          v-model="search"
          aria-label="搜索官方部门"
          placeholder="搜索已观测的官方部门名称或标识"
          @keyup.enter="query"
        /><ElButton
          :disabled="busy"
          @click="query"
        >
          查询
        </ElButton><ElButton
          :disabled="busy"
          @click="load('refresh')"
        >
          刷新
        </ElButton>
      </div>
      <ElTable
        :data="data.items"
        empty-text="暂无关联"
      >
        <ElTableColumn
          prop="external_department_id"
          label="官方部门标识"
          min-width="160"
        /><ElTableColumn
          label="生效范围"
          min-width="190"
        >
          <template #default="{row}">
            {{ date(row.valid_from) }} 至 {{ row.valid_to ? date(new Date(Date.parse(row.valid_to)-1).toISOString()) : '长期' }}
          </template>
        </ElTableColumn><ElTableColumn
          label="操作"
          width="110"
        >
          <template #default="{row}">
            <ElButton
              type="danger"
              link
              :disabled="busy"
              @click="remove(row.id)"
            >
              移除关联
            </ElButton>
          </template>
        </ElTableColumn>
      </ElTable>
      <ElButton
        v-if="data.next_mapping_cursor"
        :disabled="busy"
        @click="load('mappings')"
      >
        加载更多关联
      </ElButton>
      <ElForm
        label-position="top"
        class="mapping-form"
        @submit.prevent="add"
      >
        <ElFormItem label="官方部门">
          <ElSelect
            v-model="external"
            aria-label="官方部门"
            placeholder="选择已观测的官方部门"
            class="full-width"
          >
            <ElOption
              v-for="candidate in data.candidates"
              :key="candidate.external_department_id"
              :value="candidate.external_department_id"
              :label="`${candidate.name || candidate.external_department_id} · ${candidate.external_department_id}`"
            />
          </ElSelect><ElButton
            v-if="data.next_cursor"
            :disabled="busy"
            @click="load('candidates')"
          >
            加载更多来源部门
          </ElButton>
        </ElFormItem><div class="mapping-dates">
          <ElFormItem label="生效日期">
            <ElInput
              v-model="from"
              type="date"
              aria-label="生效日期"
            />
          </ElFormItem><ElFormItem label="结束日期（含当日，可留空）">
            <ElInput
              v-model="to"
              type="date"
              aria-label="结束日期"
            />
          </ElFormItem>
        </div><ElButton
          type="primary"
          native-type="submit"
          :disabled="busy || !external || !from"
        >
          添加关联
        </ElButton>
      </ElForm>
    </template>
  </ElDialog>
</template>
<style scoped>
.mapping-search { display: flex; gap: 10px; margin: 18px 0; }.mapping-form { margin-top: 24px; border-top: 1px solid #2b3a50; padding-top: 20px; }.mapping-dates { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }.mapping-form .full-width { margin-top: 0; }p { font-size: var(--ui-font-small); }
</style>
