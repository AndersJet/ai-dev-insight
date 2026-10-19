<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,ref,watch} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import type {CodeFlowDto} from '@adi/contracts';
import {request,ApiFailure,isTransientReadFailure} from '../api/http.js';
import {useSession} from '../stores/session.js';
import {useSessionNavigation} from '../stores/session-navigation.js';
import ProjectSessionsDialog from '../components/ProjectSessionsDialog.vue';
import {repositoryAddresses} from '../lib/repository-remotes.js';
const route=useRoute(),router=useRouter(),session=useSession(),navigation=useSessionNavigation();
const data=ref<CodeFlowDto|null>(null),loading=ref(false),error=ref(''),notice=ref(''),search=ref(''),revision=ref(0);
const emit=defineEmits<{unavailable:[]}>();
const department=computed(()=>typeof route.query.dept==='string'&&route.query.dept!=='all'?route.query.dept:undefined);
const page=computed(()=>Math.max(1,Number(route.query.page)||1));
const selected=computed(()=>data.value?.items.find(row=>row.id===route.query.project)??null);
const scope=()=>JSON.stringify([session.user?.user_id,session.user?.roles,route.path,route.query.source,route.query.dept,route.query.search,route.query.cursor]);
let generation=0,shown='',repair=false;
const status:Record<string,string>={repository:'已确认仓库',not_git:'非Git项目',no_remote:'Git无远端',failed:'探测失败',unknown:'未确认'};
const reasons:Record<string,string>={git_missing:'未找到Git',inaccessible:'目录或配置不可访问',timeout:'探测超时',invalid_git_output:'Git输出无法确认',output_limit:'Git输出超过采集预算',git_error:'Git探测未成功',latest_evidence_unavailable:'最近观测已清理或到期',current_evidence_unavailable:'最近证据已清理或不可用'};
const time=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'暂无有效观测';
const sourceTag=(remotes:CodeFlowDto['items'][number]['remotes'],address:string|null)=>remotes.find(remote=>remote.address===address)?.source_tag??null;
function pageKey(index:number){return JSON.stringify(['project-list','hook',department.value,route.query.search??'',index]);}
function listQuery(){const query={...route.query};delete query.from;delete query.to;delete query.project;delete query.assoc_cursor;delete query.assoc_page;return query;}
async function closeProject(){if(route.query.project)await router.replace({path:'/code-flow',query:listQuery()});}
async function recoverFirstPage(message='项目分页已更新，已回到第一页。'){
  data.value=null;repair=true;notice.value=message;
  await router.replace({path:'/code-flow',query:{...listQuery(),cursor:undefined,page:undefined}});
}
async function load(refreshing=false){
  const current=++generation,key=scope(),owner=session.user?.user_id??'';const currentRead=()=>current===generation&&key===scope();
  if(route.path!=='/code-flow'||route.query.source==='plugin')return;
  const keep=refreshing&&shown===key&&!!data.value;
  if(!keep)data.value=null;if(!refreshing&&!repair)search.value=String(route.query.search??'');if(!repair)notice.value='';repair=false;error.value='';
  if(!session.user?.roles.includes('super')){data.value=null;loading.value=false;error.value='当前没有查看项目清单的权限';emit('unavailable');return;}
  loading.value=true;
  try{
    if(route.query.from!==undefined||route.query.to!==undefined){const query={...route.query};delete query.from;delete query.to;await router.replace({path:'/code-flow',query});if(!currentRead())return;}
    const params=new window.URLSearchParams({limit:'20',search:String(route.query.search??'')});
    if(department.value)params.set('department_id',department.value);if(typeof route.query.cursor==='string')params.set('cursor',route.query.cursor);
    const response=await request<{data:CodeFlowDto}>(`/api/v1/code-flow?${params}`);if(!currentRead())return;
    if(route.query.cursor&&!response.data.items.length){await recoverFirstPage();return;}
    data.value=response.data;shown=key;revision.value++;
    navigation.rememberPage(owner,pageKey(page.value),router.resolve({path:'/code-flow',query:listQuery()}).fullPath);
    if(route.query.project&&!selected.value)await closeProject();
    await nextTick();if(currentRead()&&!refreshing){const top=navigation.takeScroll(owner,route.fullPath);if(top!==null)window.scrollTo(0,top);}
  }catch(reason){
    if(!currentRead())return;
    if(reason instanceof ApiFailure&&([401,403].includes(reason.status)||reason.code==='recovery_quarantined'))unavailable(reason);
    else if(reason instanceof ApiFailure&&reason.code==='invalid_cursor'&&route.query.cursor)await recoverFirstPage();
    else{const message=reason instanceof Error?reason.message:'项目清单暂不可用';if(keep&&isTransientReadFailure(reason))error.value=`刷新失败，当前为上次结果：${message}`;else{data.value=null;error.value=message;}}
  }finally{if(currentRead())loading.value=false;}
}
async function find(){
  const before=scope(),requestGeneration=generation;
  await router.replace({path:'/code-flow',query:{...listQuery(),search:search.value.trim()||undefined,cursor:undefined,page:undefined}});
  if(route.path==='/code-flow'&&scope()===before&&generation===requestGeneration)await load(true);
}
function next(){if(!data.value?.next_cursor||loading.value)return;return router.replace({path:'/code-flow',query:{...listQuery(),cursor:data.value.next_cursor,page:String(page.value+1)}});}
function previous(){const prior=navigation.previous(session.user?.user_id??'',pageKey(page.value-1));return router.replace(prior??{path:'/code-flow',query:{...listQuery(),cursor:undefined,page:undefined}});}
function openProject(id:string){return router.replace({path:'/code-flow',query:{...listQuery(),project:id}});}
function unavailable(reason:Error){
  if(route.path!=='/code-flow'||route.query.source==='plugin')return;
  generation++;loading.value=false;
  if(reason instanceof ApiFailure&&reason.status===404&&data.value){
    const id=route.query.project;data.value={...data.value,total:Math.max(0,data.value.total-1),items:data.value.items.filter(row=>row.id!==id)};
    error.value='';notice.value=reason.message;
    if(!data.value.items.length&&route.query.cursor)void recoverFirstPage(`${reason.message}；项目分页已更新，已回到第一页。`);
    else void closeProject();
  }else{data.value=null;notice.value='';error.value=reason.message;emit('unavailable');}
}
defineExpose({refresh:()=>load(true),unavailable});
watch(scope,()=>{void load();},{immediate:true,flush:'sync'});onBeforeUnmount(()=>{generation++;});
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
  <ElAlert
    v-if="notice"
    :title="notice"
    type="info"
    :closable="false"
    class="page-notice"
  />
  <p class="muted small-text">
    共 {{ data?.total??'—' }} 个Hook来源项目实例 · 观测保留365天 · 仅超管可见<span v-if="data"> · 读取于 {{ time(data.as_of) }}</span>
  </p>
  <p
    v-if="data?.pending_hooks"
    role="status"
  >
    当前人员范围内有 {{ data.pending_hooks }} 条Hook的项目待确认（路径不明、多根或探测未完成），未据此创建项目。
  </p>
  <section
    class="data-panel"
    :aria-busy="loading"
  >
    <div class="project-table">
      <table>
        <thead><tr><th>项目 / 采集端</th><th>Hook用户</th><th>Git关联</th><th>观测状态</th><th>时间</th><th>关联会话</th></tr></thead><tbody>
          <tr
            v-for="item in data?.items??[]"
            :key="item.id"
          >
            <td><strong class="project-path">{{ item.workspace }}</strong><small v-if="item.git_root">Git根目录：{{ item.git_root }}</small><small>{{ item.platform }} · <span :title="item.collector_id">{{ item.collector_id }}</span></small></td>
            <td>{{ item.name }}<small>{{ item.email }}</small><small>{{ item.department_name??'当前未分配部门' }}<span v-if="item.account_status!=='active'"> · {{ item.account_status==='suspended'?'已停用':'已删除' }}</span></small></td>
            <td>
              <div
                v-for="(address,index) in repositoryAddresses(item.remotes)"
                :key="index"
                class="remote"
              >
                <span class="project-path">{{ address??'地址未识别' }}</span><small><ElTag
                  v-if="sourceTag(item.remotes,address)"
                  :type="sourceTag(item.remotes,address)==='department'?'info':'warning'"
                  size="small"
                >{{ sourceTag(item.remotes,address)==='department'?'部门':'个人' }}</ElTag><span v-else>归类未知</span></small>
              </div><span v-if="!item.remotes.length">{{ item.confirmed_state==='not_git'?'非Git项目':item.confirmed_state==='no_remote'?'Git无远端':'暂无有效确认配置' }}</span>
            </td>
            <td>
              {{ item.current_available===false?'当前观测不可用':status[item.state]??'未确认' }}<small v-if="item.reason">{{ reasons[item.reason]??'尚未确认' }}</small><small v-if="item.history_only">仅保留历史<span v-if="item.retained_observations!==undefined"> · {{ item.retained_observations }} 条观测</span></small><small
                v-if="item.unconfirmed&&item.confirmed_at"
                class="prior-observation"
              >上次成功观测，本次未确认</small>
            </td>
            <td><small>Git探测</small>{{ time(item.observed_at) }}<small v-if="item.unconfirmed&&item.confirmed_at">上次确认：{{ time(item.confirmed_at) }}</small><small>最近Hook：{{ time(item.last_hook_at) }}</small></td>
            <td>
              <ElButton
                link
                type="primary"
                :disabled="!item.session_count"
                @click="openProject(item.id)"
              >
                关联会话
              </ElButton><small>{{ item.session_count }} 个Hook会话</small>
            </td>
          </tr>
          <tr v-if="!data?.items.length">
            <td
              colspan="6"
              class="project-empty"
            >
              {{ loading?'正在读取项目…':error?'当前结果不可用，请重试。':'当前范围没有新版项目观测。升级采集器后在项目中对话会建立记录；没有观测不代表未使用Trae。' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div><div class="table-pager">
      <span>第 {{ page }} 页 · 每页20个项目</span><div>
        <ElButton
          :disabled="loading||page===1"
          @click="previous"
        >
          上一页
        </ElButton><ElButton
          :disabled="loading||!data?.next_cursor"
          @click="next"
        >
          下一页
        </ElButton>
      </div>
    </div>
  </section>
  <p class="muted small-text">
    仓库标签按地址与白名单分类，不代表具体部门归属或代码已推送。最近Hook活动不等于重新探测Git，也不证明当前在线。
  </p>
  <ProjectSessionsDialog
    :project="selected"
    :department-id="department"
    :revision="revision"
    @close="closeProject"
    @unavailable="unavailable"
  />
</template>
<style scoped>
.project-table { overflow-x: auto; }.project-table table { width: 100%; min-width: 1160px; table-layout: fixed; border-collapse: collapse; text-align: left; font-size: var(--ui-font-body); }.project-table th,.project-table td { padding: 16px 12px; border-bottom: 1px solid var(--el-border-color); vertical-align: top; overflow-wrap: anywhere; }.project-table th { color: var(--el-text-color-secondary); }.project-table th:nth-child(1) { width: 22%; }.project-table th:nth-child(2) { width: 16%; }.project-table th:nth-child(3) { width: 25%; }.project-table th:nth-child(4) { width: 14%; }.project-table th:nth-child(5) { width: 15%; }.project-table th:nth-child(6) { width: 115px; }.project-table small { display: block; margin-top: 6px; color: var(--el-text-color-secondary); }.project-path { overflow-wrap: anywhere; }.remote+.remote { margin-top: 16px; }.project-empty { padding: 32px !important; }.prior-observation { color: #f4c77e !important; }
@media(max-width:800px){.page-toolbar { flex-wrap: wrap; gap: 12px; }.search-row { max-width: 100%; }}
</style>
