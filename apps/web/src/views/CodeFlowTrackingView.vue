<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import CodeFlowView from './CodeFlowView.vue';
import PluginCodeFlowView from './PluginCodeFlowView.vue';
import RepositoryAllowlistDialog from '../components/RepositoryAllowlistDialog.vue';
import {useSession} from '../stores/session.js';
const route=useRoute(),router=useRouter(),session=useSession();
const allowlistOpen=ref(false),activePanel=ref<{refresh:()=>Promise<void>;unavailable:(reason:Error)=>void}|null>(null);
const sources=[{key:'hook',label:'Hook采集'},{key:'plugin',label:'插件采集'}] as const;
const source=computed(()=>route.query.source==='plugin'?'plugin':'hook');
function unavailable(reason:Error){allowlistOpen.value=false;activePanel.value?.unavailable(reason);}
watch(()=>JSON.stringify([route.fullPath,session.user?.user_id,session.user?.roles]),()=>{allowlistOpen.value=false;},{flush:'sync'});
async function select(value:'hook'|'plugin'){
  if(value===source.value)return;
  await router.push({path:'/code-flow',query:{dept:route.query.dept,search:route.query.search,source:value}});
}
function move(event:{key:string;preventDefault():void},key:'hook'|'plugin'){
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();
  const next=event.key==='Home'?'hook':event.key==='End'?'plugin':key==='hook'?'plugin':'hook';
  void select(next).then(()=>window.document.getElementById(`code-flow-tab-${next}`)?.focus());
}
</script>
<template>
  <div class="page-heading">
    <div>
      <h1>代码流向追踪</h1>
      <p v-if="source==='hook'">
        查看个人Hook观测到的对话项目及Git关联。部门条件只筛选当前人员。
      </p>
      <p v-else>
        查看本人认证来源保存的项目Git状态变化。人员按平台账号展示，账号登录不代表已核验邮箱所有权或真实员工身份。
      </p>
    </div><ElButton
      v-if="session.user?.roles.includes('super')"
      @click="allowlistOpen=true"
    >
      部门仓库白名单
    </ElButton>
  </div>
  <div
    class="source-tabs"
    role="tablist"
    aria-label="采集来源"
  >
    <button
      v-for="item in sources"
      :id="`code-flow-tab-${item.key}`"
      :key="item.key"
      type="button"
      role="tab"
      :aria-selected="source===item.key"
      :aria-controls="`code-flow-panel-${item.key}`"
      :tabindex="source===item.key?0:-1"
      @click="select(item.key)"
      @keydown="move($event,item.key)"
    >
      {{ item.label }}
    </button>
  </div>
  <section
    :id="`code-flow-panel-${source}`"
    role="tabpanel"
    :aria-labelledby="`code-flow-tab-${source}`"
  >
    <CodeFlowView
      v-if="source==='hook'"
      ref="activePanel"
      @unavailable="allowlistOpen=false"
    />
    <PluginCodeFlowView
      v-else
      ref="activePanel"
      @open-allowlist="allowlistOpen=true"
      @unavailable="allowlistOpen=false"
    />
  </section>
  <RepositoryAllowlistDialog
    v-model="allowlistOpen"
    @changed="activePanel?.refresh()"
    @unavailable="unavailable"
  />
</template>
<style scoped>
.source-tabs { display: flex; gap: 24px; border-bottom: 1px solid var(--el-border-color); margin-bottom: 24px; }.source-tabs button { border: 0; border-bottom: 2px solid transparent; padding: 12px 0; background: none; color: var(--el-text-color-secondary); cursor: pointer; font: inherit; font-size: var(--ui-font-body); }.source-tabs button[aria-selected='true'] { color: var(--el-color-primary); border-bottom-color: var(--el-color-primary); }
</style>
