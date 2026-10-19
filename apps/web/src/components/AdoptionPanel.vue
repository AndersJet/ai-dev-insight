<script setup lang="ts">
import { ref, watch, onBeforeUnmount, computed } from 'vue';
import { useRouter } from 'vue-router';
import type { AdoptionDto } from '@adi/contracts';
import { request, isTransientReadFailure } from '../api/http.js';
import AppIcon from './AppIcon.vue';
const props=defineProps<{self?:boolean;departmentId?:string|undefined;revision?:number;manage?:boolean}>();
const data=ref<AdoptionDto|null>(null), error=ref(''), loading=ref(false);const router=useRouter();let generation=0;
async function refresh(){const current=++generation;loading.value=true;error.value='';try{const query=new window.URLSearchParams({scope:props.self?'self':'organization',...(props.departmentId?{department_id:props.departmentId}:{})});const result=await request<{data:AdoptionDto}>(`/api/v1/adoption?${query}`);if(current===generation)data.value=result.data;}catch(reason){if(current===generation){const message=reason instanceof Error?reason.message:'采纳统计暂不可用';if(data.value&&isTransientReadFailure(reason))error.value=`刷新失败，当前为上次结果：${message}`;else{data.value=null;error.value=message;}}}finally{if(current===generation)loading.value=false;}}
watch(()=>[props.self,props.departmentId],()=>{data.value=null;void refresh();},{immediate:true,flush:'sync'});watch(()=>props.revision,()=>{void refresh();});onBeforeUnmount(()=>{generation++;});
const ratio=computed(()=>data.value?.adoption_rate==null?'暂无数据':`${(data.value.adoption_rate*100).toFixed(1)}%`);
function members(key:'adoption'|'status',value:string){void router.push({path:`/organization-management/${props.departmentId??'all'}/members`,query:{[key]:value}});}
</script>
<template>
  <section
    class="adoption-panel"
    aria-label="采纳进度"
  >
    <div class="page-toolbar">
      <strong><AppIcon name="install" />{{ self?'我的采纳状态':'累计采纳进度' }}</strong><ElButton
        link
        :loading="loading"
        @click="refresh"
      >
        刷新采纳状态
      </ElButton>
    </div>
    <ElAlert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
    />
    <template v-if="data">
      <p v-if="self">
        <ElTag :type="data.adopted?'success':'info'">
          {{ !data.registered?'尚未完成员工注册':data.adopted?'已采纳':'待采纳' }}
        </ElTag> {{ data.adopted?'已保存正常 Hook 上报；不代表当前在线。':'完成注册和安装后，首条正常 Hook 保存成功将自动确认采纳。' }}
      </p>
      <div
        v-else
        class="adoption-counts"
      >
        <span>注册 <b>{{ data.registered }}</b></span><span>已采纳 <b>{{ data.adopted }}</b></span>
        <span>待采纳 <b>{{ data.pending }}</b></span>
        <span>累计采纳率 <b>{{ ratio }}</b></span>
        <ElButton
          v-if="manage&&data.suspended"
          link
          type="warning"
          @click="members('status','suspended')"
        >
          已停用 {{ data.suspended }} · 查看名单
        </ElButton>
        <ElButton
          v-if="manage&&data.deleted"
          link
          @click="members('status','deleted')"
        >
          已逻辑删除 {{ data.deleted }}
        </ElButton>
      </div>
      <p
        v-if="!self"
        class="muted small-text"
      >
        全部注册人员均计入，包括待采纳、停用和逻辑删除人员。此处为当前累计进度，不随使用报表的日期筛选变化。
      </p>
    </template>
  </section>
</template>
<style scoped>
.adoption-panel{border:1px solid var(--el-border-color);background:var(--el-bg-color);border-radius:10px;padding:16px 20px;margin-bottom:20px}.adoption-counts{display:flex;align-items:center;gap:24px;flex-wrap:wrap}.adoption-counts b{font-size:22px;margin-left:6px}.adoption-panel p{line-height:1.7}
</style>
