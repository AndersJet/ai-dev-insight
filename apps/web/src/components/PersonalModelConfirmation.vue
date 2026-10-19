<script setup lang="ts">
import { ref,watch,onBeforeUnmount } from 'vue';
import type { PersonalModelDto } from '@adi/contracts';
import * as api from '../api/sessions.js';
import {ApiFailure,isTransientReadFailure} from '../api/http.js';
const props=defineProps<{sessionId:string;revision?:number}>();const data=ref<PersonalModelDto|null>(null);const busy=ref(false);const error=ref('');const opened=ref(false);const draft=ref('');let generation=0;
async function load(){const current=++generation;busy.value=true;error.value='';try{const result=await api.personalModels(props.sessionId);if(current===generation)data.value=result.data;}catch(reason){if(current===generation){const message=reason instanceof Error?reason.message:'无法读取本人确认';if(data.value&&isTransientReadFailure(reason))error.value='刷新失败，当前显示上次本人确认结果：'+message;else{data.value=null;opened.value=false;draft.value='';error.value=message;}}}finally{if(current===generation)busy.value=false;}}
function edit(){if(!data.value?.can_edit||busy.value)return;draft.value=data.value.models.join('\n');error.value='';opened.value=true;}
async function save(models:string[]){if(!data.value?.can_edit||busy.value)return;const current=++generation;busy.value=true;error.value='';try{const result=await api.replacePersonalModels(props.sessionId,{version:data.value.version,cleanup_generation:data.value.cleanup_generation,models});if(current===generation){data.value=result.data;opened.value=false;}}catch(reason){if(current===generation){if(reason instanceof ApiFailure&&([401,403,404,410].includes(reason.status)||['recovery_quarantined','content_changed'].includes(reason.code))){data.value=null;opened.value=false;draft.value='';}error.value=reason instanceof Error?reason.message:'确认失败';}}finally{if(current===generation)busy.value=false;}}
const confirm=()=>save(draft.value.split(/\r?\n/).map(value=>value.trim()).filter(Boolean));
watch(()=>[props.sessionId,props.revision],(_value,old)=>{if(!old||old[0]!==props.sessionId){opened.value=false;draft.value='';data.value=null;}void load();},{immediate:true});onBeforeUnmount(()=>{generation++;});
</script>
<template>
  <section
    class="personal-model-panel"
    data-testid="personal-models-panel"
  >
    <div class="personal-model-heading">
      <div><h3>个人自配模型</h3><span>本人确认 · 会话级</span></div><div
        v-if="data?.can_edit"
        class="personal-model-actions"
      >
        <ElButton
          :disabled="busy"
          @click="edit"
        >
          {{ data.models.length?'修改本人确认':'确认个人自配模型' }}
        </ElButton><ElButton
          v-if="data.models.length"
          :disabled="busy"
          @click="save([])"
        >
          撤销本人确认
        </ElButton>
      </div>
    </div>
    <ElAlert
      v-if="error && !opened"
      :title="error"
      type="error"
      :closable="false"
    >
      <ElButton
        link
        :disabled="busy"
        @click="load"
      >
        重新读取
      </ElButton>
    </ElAlert>
    <p
      v-if="busy && !data"
      role="status"
    >
      正在读取确认信息…
    </p>
    <div
      v-else-if="data?.models.length"
      class="personal-model-tags"
    >
      <ElTag
        v-for="name in data.models"
        :key="name"
        effect="plain"
      >
        {{ name }}
      </ElTag>
    </div>
    <p v-else-if="data">
      尚无本人确认的个人自配模型，不能依据缺少账单推断。
    </p>
    <p v-else>
      本人确认尚未读取。
    </p>
    <p>确认表示本会话使用过这些模型，不定位到具体轮次或日期，也不生成官方 Token 或金额。混合会话可同时出现在官方和个人自配筛选中。</p>
    <p v-if="data && !data.can_edit">
      此信息只能由会话本人确认或撤销。
    </p>
    <ElDialog
      v-model="opened"
      align-center
      title="本人确认个人自配模型"
      width="min(620px, 92vw)"
    >
      <p>仅填写你确认在本会话中使用过的个人自配模型。不要把 Trae 企业统一接入模型当作个人自配。名称会进入有权限的组织汇总，其他人不能代替你修改。</p>
      <ElAlert
        v-if="error"
        :title="error"
        type="error"
        :closable="false"
      >
        <ElButton
          link
          :disabled="busy"
          @click="load"
        >
          重读本人确认
        </ElButton>
      </ElAlert>
      <ElForm
        label-position="top"
        @submit.prevent="confirm"
      >
        <ElFormItem label="模型名称">
          <ElInput
            v-model="draft"
            type="textarea"
            :rows="4"
            :maxlength="1210"
            aria-label="模型名称"
            aria-describedby="personal-model-help"
            placeholder="例如：DeepSeek-V3"
            :disabled="busy"
          />
          <p
            id="personal-model-help"
            class="field-help"
          >
            每行一个模型，最多 10 个；仅填写你确认使用过的个人自配模型。
          </p>
        </ElFormItem>
      </ElForm>
      <template #footer>
        <ElButton @click="opened=false">
          取消
        </ElButton><ElButton
          type="primary"
          :disabled="busy || !data?.can_edit || !draft.trim()"
          @click="confirm"
        >
          保存本人确认
        </ElButton>
      </template>
    </ElDialog>
  </section>
</template>
<style scoped>
.personal-model-panel { border-top: 1px solid #2b3a50; border-bottom: 1px solid #2b3a50; padding: 20px 0; margin: 24px 0; }.personal-model-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; }.personal-model-heading h3 { font-size: var(--ui-font-subtitle); margin: 0 0 6px; }.personal-model-heading span,.personal-model-panel p { color: #91a3be; font-size: var(--ui-font-small); line-height: 1.7; }.personal-model-tags { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 16px; }.personal-model-tags :deep(.el-tag) { height: auto; min-height: 26px; white-space: normal; max-width: 100%; overflow-wrap: anywhere; }.personal-model-actions { display: flex; gap: 8px; }.personal-model-actions :deep(.el-button+.el-button) { margin-left: 0; }
@media(max-width:650px) { .personal-model-heading { align-items: start; flex-direction: column; } }
</style>
