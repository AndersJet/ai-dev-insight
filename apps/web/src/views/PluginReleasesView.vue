<script setup lang="ts">
import {onBeforeUnmount,ref,watch} from 'vue';
import {useRoute} from 'vue-router';
import {ElMessageBox} from 'element-plus';
import type {PluginReleaseRecordDto,PluginTesterDto} from '@adi/contracts';
import {request,ApiFailure,isTransientReadFailure} from '../api/http.js';
import {useSession} from '../stores/session.js';
import AppIcon from '../components/AppIcon.vue';
const session=useSession(),route=useRoute();
const items=ref<PluginReleaseRecordDto[]>([]),loading=ref(false),busy=ref(false),error=ref(''),notice=ref('');
const fileInput=ref<HTMLInputElement>(),selected=ref<PluginReleaseRecordDto|null>(null),userIds=ref<string[]>([]),testers=ref<PluginTesterDto[]>([]),testersLoading=ref(false);
let generation=0,read=0,testerRead=0,disposed=false,controller=new window.AbortController();
const scope=()=>JSON.stringify([session.user?.user_id,session.user?.roles,route.fullPath]);
const allowed=()=>session.user?.roles.includes('super')===true;
const active=(g:number,key:string)=>!disposed&&g===generation&&key===scope()&&allowed();
const time=(at:string|null)=>at?new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'尚未发布';
function reset(){generation++;read++;testerRead++;controller.abort();controller=new window.AbortController();items.value=[];selected.value=null;testers.value=[];userIds.value=[];testersLoading.value=false;loading.value=false;busy.value=false;error.value='';notice.value='';}
function readFailure(e:unknown,fallback:string){if(!isTransientReadFailure(e))reset();error.value=e instanceof Error?e.message:fallback;}
async function load(){if(!allowed())return;const g=generation,key=scope(),seq=++read;loading.value=true;try{const r=await request<{data:{items:PluginReleaseRecordDto[]}}>('/api/v1/system/plugin-releases','GET',undefined,{},controller.signal);if(active(g,key)&&seq===read)items.value=r.data.items;}catch(e){if(active(g,key)&&seq===read){items.value=[];readFailure(e,'版本列表读取失败');}}finally{if(active(g,key)&&seq===read)loading.value=false;}}
async function searchTesters(search=''){const g=generation,key=scope(),seq=++testerRead;testersLoading.value=true;try{const r=await request<{data:PluginTesterDto[]}>(`/api/v1/system/plugin-releases/testers?search=${encodeURIComponent(search)}${selected.value?`&release_id=${selected.value.id}`:''}`,'GET',undefined,{},controller.signal);if(active(g,key)&&seq===testerRead)testers.value=[...testers.value.filter(p=>userIds.value.includes(p.user_id)&&!r.data.some(other=>other.user_id===p.user_id)),...r.data];}catch(e){if(active(g,key)&&seq===testerRead){testers.value=[];readFailure(e,'试用人员读取失败');}}finally{if(active(g,key)&&seq===testerRead)testersLoading.value=false;}}
async function mutate(work:()=>Promise<unknown>,success:string){if(busy.value||!allowed())return;const g=generation,key=scope();busy.value=true;error.value='';notice.value='';try{await work();if(active(g,key)){notice.value=success;selected.value=null;await load();}}catch(e){if(active(g,key)){if(!isTransientReadFailure(e)){readFailure(e,'操作被拒绝，请重新读取版本。');if(!(e instanceof ApiFailure&&([401,403].includes(e.status)||e.code==='recovery_quarantined')))await load();}else{error.value=e instanceof ApiFailure?e.message:'操作结果暂未确认，请刷新列表核对后再试。';await load();}}}finally{if(active(g,key))busy.value=false;}}
async function upload(event:Event){const input=event.target as HTMLInputElement,file=input.files?.[0];input.value='';if(!file)return;if(!file.name.toLowerCase().endsWith('.vsix')||file.size>16*1024*1024){error.value='请选择不超过16 MiB的 VSIX 安装包。';return;}const data=new window.FormData();data.append('file',file);await mutate(()=>request('/api/v1/system/plugin-releases/upload','POST',data,{},controller.signal),'安装包已上传。正式发布前可以指定试用。');}
function pilot(item:PluginReleaseRecordDto){selected.value=item;userIds.value=[...item.pilot_user_ids];testers.value=[];void searchTesters();}
async function savePilot(){const item=selected.value;if(!item||!userIds.value.length)return;await mutate(()=>request(`/api/v1/system/plugin-releases/${item.id}/pilot`,'POST',{build_id:item.build_id,user_ids:userIds.value},{},controller.signal),'指定试用已保存；员工在插件中点击“试用更新”获取。');}
async function publish(item:PluginReleaseRecordDto){const g=generation,key=scope();try{await ElMessageBox.confirm(`将 ${item.version}（构建 ${item.sha256.slice(0,12)}）正式发布给全量使用者。此版本发布后不可覆盖或撤回，修复必须升版。`,'确认正式发布',{confirmButtonText:'确认发布',cancelButtonText:'取消',type:'warning'});}catch{return;}if(!active(g,key))return;await mutate(()=>request(`/api/v1/system/plugin-releases/${item.id}/publish`,'POST',{build_id:item.build_id},{},controller.signal),'正式版已发布。');}
watch(scope,()=>{reset();void load();},{immediate:true,flush:'sync'});onBeforeUnmount(()=>{disposed=true;reset();});
</script>
<template>
  <div class="page-heading">
    <div>
      <h1 class="section-icon-title">
        <AppIcon
          name="install"
          :size="24"
        />插件版本管理
      </h1><p>上传、指定试用及正式发布 · 仅系统超级管理员</p>
    </div>
    <ElButton
      :loading="loading"
      :disabled="busy"
      @click="load"
    >
      刷新列表
    </ElButton>
  </div>
  <ElAlert
    v-if="error"
    :title="error"
    type="error"
    :closable="false"
    class="page-notice"
  />
  <p
    v-if="notice"
    role="status"
    class="page-notice"
  >
    {{ notice }}
  </p>
  <div class="page-toolbar release-toolbar">
    <div>
      <ElButton
        :loading="busy"
        :disabled="loading"
        @click="fileInput?.click()"
      >
        上传 VSIX
      </ElButton><input
        ref="fileInput"
        class="file-input"
        type="file"
        accept=".vsix"
        aria-label="上传 VSIX 安装包"
        @change="upload"
      >
    </div>
  </div>
  <p class="muted small-text">
    试用包允许同版本覆盖；正式版本不可覆盖或撤回。请选择已验证的具体构建后发布。
  </p>
  <section
    class="data-panel"
    :aria-busy="loading||busy"
  >
    <div class="release-table">
      <ElTable
        :data="items"
        :empty-text="loading?'正在读取版本…':error?'版本列表暂不可用。':'尚未上传插件安装包。'"
      >
        <ElTableColumn
          label="版本 / 构建摘要"
          min-width="180"
        >
          <template #default="{row:item}">
            <strong>{{ item.version }}</strong><small :title="item.sha256">{{ item.sha256.slice(0,12) }}</small>
          </template>
        </ElTableColumn>
        <ElTableColumn
          label="状态"
          min-width="150"
        >
          <template #default="{row:item}">
            <ElTag :type="item.current_stable?'success':item.current_pilot?'warning':'info'">
              {{ item.current_stable?'当前正式版':item.current_pilot?'当前试用版':item.state==='released'?'历史正式版':item.state==='pilot'?'历史试用包':'未发布' }}
            </ElTag>
          </template>
        </ElTableColumn>
        <ElTableColumn
          label="上传 / 发布时间"
          min-width="220"
        >
          <template #default="{row:item}">
            {{ time(item.uploaded_at) }}<small>{{ time(item.published_at) }}</small>
          </template>
        </ElTableColumn>
        <ElTableColumn
          label="试用人员"
          min-width="100"
        >
          <template #default="{row:item}">
            {{ item.pilot_user_ids.length }} 人
          </template>
        </ElTableColumn>
        <ElTableColumn
          label="操作"
          min-width="180"
        >
          <template #default="{row:item}">
            <template v-if="item.state!=='released'">
              <ElButton
                link
                type="primary"
                :disabled="busy"
                @click="pilot(item)"
              >
                指定试用
              </ElButton><ElButton
                v-if="item.current_pilot"
                link
                type="primary"
                :disabled="busy"
                @click="publish(item)"
              >
                正式发布
              </ElButton>
            </template><span
              v-else
              class="muted"
            >已锁定</span>
          </template>
        </ElTableColumn>
      </ElTable>
    </div>
  </section>
  <ElDialog
    :model-value="!!selected"
    title="指定插件试用"
    width="min(560px,94vw)"
    @close="selected=null"
  >
    <template v-if="selected">
      <p>版本 {{ selected.version }} · 构建 {{ selected.sha256.slice(0,12) }}</p><p class="muted">
        同一账号的多台电脑具有相同试用资格；员工点击插件中的“试用更新”获取。
      </p><ElSelect
        v-model="userIds"
        aria-label="选择试用人员"
        multiple
        filterable
        remote
        placement="top-start"
        :remote-method="searchTesters"
        :loading="testersLoading"
        placeholder="搜索已注册人员姓名或邮箱"
        class="tester-select"
      >
        <ElOption
          v-for="person in testers"
          :key="person.user_id"
          :label="`${person.display_name} · ${person.email}`"
          :value="person.user_id"
        />
      </ElSelect>
    </template><template #footer>
      <ElButton
        :disabled="busy"
        @click="selected=null"
      >
        取消
      </ElButton><ElButton
        type="primary"
        :loading="busy"
        :disabled="!userIds.length"
        @click="savePilot"
      >
        保存指定试用
      </ElButton>
    </template>
  </ElDialog>
</template>
<style scoped>
.release-toolbar{margin:20px 0}.file-input{display:none}.release-table{overflow-x:auto}.release-table .el-table{min-width:820px}.release-table small{display:block;margin-top:7px;color:var(--el-text-color-secondary);font-size:var(--ui-font-small)}.tester-select{width:100%}.release-table .el-button+.el-button{margin-left:10px}@media(max-width:700px){.release-toolbar{gap:12px;flex-wrap:wrap}}
</style>
