<script setup lang="ts">
import {computed,ref,watch,onBeforeUnmount} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import type {PluginProject,PluginRecord,PluginPage} from '@adi/contracts';
import {request,ApiFailure,isTransientReadFailure} from '../api/http.js';
import {useSession} from '../stores/session.js';
import {repositoryAddresses} from '../lib/repository-remotes.js';
const route=useRoute(),router=useRouter(),session=useSession();
const data=ref<PluginPage<PluginProject>|null>(null),search=ref(''),loading=ref(false),error=ref('');
const emit=defineEmits<{openAllowlist:[];unavailable:[]}>();
const department=computed(()=>typeof route.query.dept==='string'&&route.query.dept!=='all'?route.query.dept:undefined);
const selected=ref<PluginProject|null>(null),history=ref<PluginPage<PluginRecord>|null>(null),historyLoading=ref(false),historyError=ref('');
let generation=0,historyGeneration=0,controller=new window.AbortController(),historyController=new window.AbortController();
const stateLabels:Record<string,string>={repository:'已确认仓库',not_git:'非Git项目',no_remote:'Git无远端',failed:'探测失败',unknown:'未确认'};
const reasons:Record<string,string>={git_missing:'未找到Git',timeout:'探测超时',inaccessible:'不可访问',output_limit:'输出超过预算',invalid_git_output:'输出未确认',git_error:'Git探测失败'};
const time=(at:string)=>new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const sourceTag=(remotes:PluginRecord['remotes'],address:string|null)=>remotes.find(remote=>remote.address===address)?.source_tag??null;
const scope=()=>JSON.stringify([route.fullPath,session.user?.user_id,session.user?.roles]);
async function load(refresh=false){
  if(route.path!=='/code-flow'||route.query.source!=='plugin')return;
  controller?.abort();controller=new window.AbortController();const current=++generation,key=scope(),currentRead=()=>current===generation&&key===scope(),keep=refresh&&data.value!==null;loading.value=true;error.value='';
  if(!keep)data.value=null;
  if(!session.user?.roles.includes('super')){data.value=null;closeHistory();loading.value=false;error.value='当前没有查看项目清单的权限';emit('unavailable');return;}
  if(!refresh)search.value=String(route.query.search??'');
  const query=new window.URLSearchParams({page:String(route.query.page??1),limit:'20',search:String(route.query.search??'')});
  if(department.value)query.set('department_id',department.value);
  try{const r=await request<{data:PluginPage<PluginProject>}>(`/api/v1/plugin/projects?${query}`,'GET',undefined,{},controller.signal);if(currentRead()){
    data.value=r.data;
    if(r.data.page>1&&!r.data.items.length)await page(Math.max(1,Math.ceil(r.data.total/r.data.limit)));
  }}
  catch(e){if(!currentRead())return;if(e instanceof ApiFailure&&([401,403].includes(e.status)||e.code==='recovery_quarantined')){unavailable(e);return;}error.value=e instanceof Error?e.message:'查询失败';if(!keep||!isTransientReadFailure(e)){data.value=null;closeHistory();}else error.value='刷新失败，当前显示上次结果：'+error.value;}
  finally{if(currentRead())loading.value=false;}
}
async function find(){
  const old=route.fullPath;await router.replace({path:'/code-flow',query:{source:'plugin',dept:route.query.dept,search:search.value.trim()||undefined}});if(old===route.fullPath)await load(true);
}
async function page(n:number){
  await router.replace({path:'/code-flow',query:{...route.query,page:String(n)}});
}
async function openHistory(project:PluginProject,n=1){
  if(route.path!=='/code-flow'||route.query.source!=='plugin'||!session.user?.roles.includes('super'))return;
  historyController?.abort();historyController=new window.AbortController();const current=++historyGeneration,key=scope(),currentRead=()=>current===historyGeneration&&key===scope();selected.value=project;history.value=null;historyLoading.value=true;historyError.value='';
  const query=new window.URLSearchParams({page:String(n),limit:'20'});
  if(project.project_id)query.set('project_id',project.project_id);
  else { query.set('collector_id',project.collector_id);query.set('nt_email',project.nt_email);query.set('workspace_key',project.workspace_key); }
  if(department.value)query.set('department_id',department.value);
  try{const r=await request<{data:PluginPage<PluginRecord>}>(`/api/v1/plugin/observations?${query}`,'GET',undefined,{},historyController.signal);if(currentRead())history.value=r.data;}
  catch(e){if(!currentRead())return;if(e instanceof ApiFailure&&([401,403].includes(e.status)||e.code==='recovery_quarantined')){unavailable(e);return;}historyError.value=e instanceof Error?e.message:'历史查询失败';}
  finally{if(currentRead())historyLoading.value=false;}
}
function closeHistory(){historyGeneration++;historyController?.abort();selected.value=null;history.value=null;historyLoading.value=false;historyError.value='';}
async function allowlistChanged(){const project=selected.value,n=history.value?.page??1;await Promise.all([load(true),project?openHistory(project,n):Promise.resolve()]);}
function unavailable(reason:Error){
  if(route.path!=='/code-flow'||route.query.source!=='plugin')return;
  generation++;controller?.abort();loading.value=false;data.value=null;closeHistory();error.value=reason.message;emit('unavailable');
  if(reason instanceof ApiFailure&&reason.status===401)void session.refresh();
}
defineExpose({refresh:allowlistChanged,unavailable});
watch(scope,()=>{closeHistory();void load();},{immediate:true,flush:'sync'});
onBeforeUnmount(()=>{generation++;historyGeneration++;controller?.abort();historyController?.abort();});
</script>
<template>
  <div class="page-toolbar">
    <form
      class="search-row"
      @submit.prevent="find"
    >
      <ElInput
        v-model="search"
        aria-label="搜索项目、用户或仓库"
        placeholder="搜索项目、用户或仓库"
        maxlength="128"
        clearable
      /><ElButton
        native-type="submit"
        :disabled="loading"
      >
        查询
      </ElButton>
    </form><ElButton
      :loading="loading"
      @click="load(true)"
    >
      刷新项目
    </ElButton>
  </div>
  <ElAlert
    v-if="error"
    :title="error"
    type="error"
    :closable="false"
    class="page-notice"
  />
  <p class="muted small-text">
    共 {{ data?.total??'—' }} 个插件来源项目实例 · 观测不自动过期 · 仅超管可见
  </p>
  <p class="muted small-text">
    观测历史展示本来源已保存状态变化，不代表每次检查均有记录。使用数据清理统一通过人员与时间范围预览和提交任务。
  </p>
  <section
    class="data-panel"
    :aria-busy="loading"
  >
    <div class="project-table">
      <table>
        <thead><tr><th>项目 / 采集端</th><th>平台人员（按NT邮箱关联）</th><th>Git关联</th><th>最近观测</th><th>操作</th></tr></thead><tbody>
          <tr
            v-for="item in data?.items??[]"
            :key="`${item.nt_email}:${item.collector_id}:${item.workspace_key}`"
          >
            <td><strong class="project-path">{{ item.workspace_path }}</strong><small v-if="item.confirmed?.git_root">Git根目录：{{ item.confirmed.git_root }}</small><small>{{ item.platform }} · <span :title="item.collector_id">{{ item.collector_id }}</span></small></td>
            <td>{{ item.linked_user?.name??'未关联用户' }}<small>{{ item.nt_email }}</small><small v-if="item.linked_user">{{ item.linked_user.department_name??'当前未分配部门' }}<span v-if="item.linked_user.account_status!=='active'"> · {{ item.linked_user.account_status==='suspended'?'已停用':'已删除' }}</span></small></td>
            <td>
              <div
                v-for="(address,i) in repositoryAddresses(item.confirmed?.remotes??[])"
                :key="i"
                class="remote"
              >
                <span class="project-path plugin-remote">{{ address??'地址未确认' }}</span><small><ElTag
                  v-if="sourceTag(item.confirmed?.remotes??[],address)"
                  :type="sourceTag(item.confirmed?.remotes??[],address)==='department'?'info':'warning'"
                  size="small"
                >{{ sourceTag(item.confirmed?.remotes??[],address)==='department'?'部门':'个人' }}</ElTag><span v-else>归类未知</span></small>
              </div><span v-if="!item.confirmed?.remotes.length">{{ item.confirmed?stateLabels[item.confirmed.state]:'暂无确认配置' }}</span><small
                v-if="item.confirmed&&item.confirmed.observation_id!==item.latest?.observation_id"
                class="prior-observation"
              >上次确认：{{ time(item.confirmed.observed_at) }}</small>
            </td>
            <td>
              <template v-if="item.latest && item.current_available!==false">
                {{ stateLabels[item.latest.state] }}<small v-if="item.latest.reason">{{ reasons[item.latest.reason]??item.latest.reason }}</small><small>Git探测：{{ time(item.latest.observed_at) }}</small><small>接收：{{ time(item.latest.received_at) }}</small>
              </template>
              <template v-else>
                当前观测不可用<small>最近证据已清理或不可用，不用旧观测补造当前状态。</small>
              </template>
              <small v-if="item.history_only">仅保留历史<span v-if="item.retained_observations!==undefined"> · {{ item.retained_observations }} 条观测</span></small>
            </td>
            <td class="project-actions">
              <ElButton
                link
                type="primary"
                @click="openHistory(item)"
              >
                观测历史
              </ElButton>
            </td>
          </tr><tr v-if="!data?.items.length">
            <td
              colspan="5"
              class="project-empty"
            >
              {{ loading?'正在读取项目…':error?'当前结果不可用，请重试。':'暂无插件观测记录。插件完成本人登录绑定后才能采集；没有观测不代表未使用Trae。' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div><div class="table-pager">
      <span>第 {{ data?.page??1 }} 页 · 每页20个项目</span><div>
        <ElButton
          :disabled="!data||data.page<=1||loading"
          @click="data&&page(data.page-1)"
        >
          上一页
        </ElButton><ElButton
          :disabled="!data?.has_more||loading"
          @click="data&&page(data.page+1)"
        >
          下一页
        </ElButton>
      </div>
    </div>
  </section>
  <p class="muted small-text">
    仓库标签按地址与白名单分类，不代表具体部门归属或代码已推送。插件观测不证明LLM使用或Hook采纳，也不证明当前在线。
  </p>
  <ElDialog
    :model-value="!!selected"
    title="插件观测历史"
    width="min(900px, 94vw)"
    @close="closeHistory"
  >
    <p class="muted small-text">
      本来源已保存状态变化；连续相同状态压缩，不表示每次探测或全部检查都有记录。
    </p>
    <p
      v-if="selected"
      class="project-path"
    >
      {{ selected.nt_email }} · {{ selected.workspace_path }}
    </p><ElAlert
      v-if="historyError"
      :title="historyError"
      type="error"
      :closable="false"
      class="page-notice"
    />
    <div
      class="project-table history-table"
      :aria-busy="historyLoading"
    >
      <table>
        <thead><tr><th>Git探测 / 接收时间</th><th>观测状态</th><th>Git关联</th></tr></thead><tbody>
          <tr
            v-for="item in history?.items??[]"
            :key="item.observation_id"
          >
            <td>{{ time(item.observed_at) }}<small>接收：{{ time(item.received_at) }}</small></td><td>{{ stateLabels[item.state] }}<small v-if="item.reason">{{ reasons[item.reason]??item.reason }}</small></td><td>
              <div
                v-for="(address,i) in repositoryAddresses(item.remotes)"
                :key="i"
                class="remote"
              >
                <span class="project-path plugin-remote">{{ address??'地址未确认' }}</span><small><ElTag
                  v-if="sourceTag(item.remotes,address)"
                  :type="sourceTag(item.remotes,address)==='department'?'info':'warning'"
                  size="small"
                >{{ sourceTag(item.remotes,address)==='department'?'部门':'个人' }}</ElTag><span v-else>归类未知</span></small>
              </div><span v-if="!item.remotes.length">{{ stateLabels[item.state] }}</span>
            </td>
          </tr><tr v-if="!history?.items.length">
            <td
              colspan="3"
              class="project-empty"
            >
              {{ historyLoading?'正在读取观测历史…':historyError?'当前结果不可用，请重试。':'暂无已保存的观测记录' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <template #footer>
      <div class="table-pager history-pager">
        <span v-if="history">共 {{ history.total }} 条 · 第 {{ history.page }} 页</span><div>
          <ElButton
            v-if="session.user?.roles.includes('super')"
            @click="emit('openAllowlist')"
          >
            部门仓库白名单
          </ElButton>
          <ElButton
            :disabled="!history||history.page<=1||historyLoading"
            @click="selected&&history&&openHistory(selected,history.page-1)"
          >
            上一页
          </ElButton><ElButton
            :disabled="!history?.has_more||historyLoading"
            @click="selected&&history&&openHistory(selected,history.page+1)"
          >
            下一页
          </ElButton><ElButton @click="closeHistory">
            关闭
          </ElButton>
        </div>
      </div>
    </template>
  </ElDialog>
</template>
<style scoped>
.project-actions .el-button { display: block; margin-left: 0; }.project-actions .el-button+.el-button { margin-top: 8px; }
.project-table { overflow-x: auto; }.project-table table { width: 100%; min-width: 1160px; table-layout: fixed; border-collapse: collapse; text-align: left; font-size: var(--ui-font-body); }.project-table th,.project-table td { padding: 16px 12px; border-bottom: 1px solid var(--el-border-color); vertical-align: top; overflow-wrap: anywhere; }.project-table th { color: var(--el-text-color-secondary); }.project-table th:nth-child(1) { width: 25%; }.project-table th:nth-child(2) { width: 19%; }.project-table th:nth-child(3) { width: 27%; }.project-table th:nth-child(4) { width: 21%; }.project-table th:nth-child(5) { width: 115px; }.project-table small { display: block; margin-top: 6px; color: var(--el-text-color-secondary); }.project-path { overflow-wrap: anywhere; }.remote+.remote { margin-top: 16px; }.project-empty { padding: 32px !important; }.prior-observation { color: #f4c77e !important; }
.history-table table { min-width: 720px; }.history-table th:nth-child(1) { width: 30%; }.history-table th:nth-child(2) { width: 20%; }.history-table th:nth-child(3) { width: 50%; }
.history-pager { flex-wrap: wrap; gap: 12px; }.history-pager>div { display: flex; flex-wrap: wrap; gap: 8px; }.history-pager .el-button+.el-button { margin-left: 0; }
@media(max-width:800px){.page-toolbar { flex-wrap: wrap; gap: 12px; }.search-row { max-width: 100%; }}
</style>
