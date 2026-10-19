<script setup lang="ts">
import {computed,onBeforeUnmount,ref,watch} from 'vue';
import {useRoute,useRouter} from 'vue-router';
import type {CodeFlowDto,ProjectSessionsDto} from '@adi/contracts';
import {request,ApiFailure,isTransientReadFailure} from '../api/http.js';
import {useSession} from '../stores/session.js';
import {useSessionNavigation} from '../stores/session-navigation.js';
const props=defineProps<{project:CodeFlowDto['items'][number]|null;departmentId?:string|undefined;revision:number}>(),emit=defineEmits<{close:[];unavailable:[reason:Error]}>();
const route=useRoute(),router=useRouter(),session=useSession(),navigation=useSessionNavigation();
const data=ref<ProjectSessionsDto|null>(null),loading=ref(false),error=ref(''),notice=ref('');let generation=0,shown='',repair=false;
const page=computed(()=>Math.max(1,Number(route.query.assoc_page)||1));
const scope=()=>JSON.stringify([session.user?.user_id,props.project?.id,props.departmentId,route.query.assoc_cursor]);
const key=(index:number)=>JSON.stringify(['project-sessions',props.project?.id,props.departmentId,index]);
const time=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
async function firstPage(){
  data.value=null;repair=true;notice.value='关联会话分页已更新，已回到第一页。';
  await router.replace({path:'/code-flow',query:{...route.query,assoc_cursor:undefined,assoc_page:undefined}});
}
async function load(preserve=false,recovering=false){
  const current=++generation,currentScope=scope(),id=props.project?.id;const valid=()=>current===generation&&currentScope===scope();
  if(!id){data.value=null;error.value='';loading.value=false;return;}
  const keep=preserve&&shown===currentScope&&!!data.value;if(!keep)data.value=null;error.value='';if(!recovering)notice.value='';loading.value=true;
  try{
    const query=new window.URLSearchParams({limit:'20'});if(props.departmentId)query.set('department_id',props.departmentId);if(typeof route.query.assoc_cursor==='string')query.set('cursor',route.query.assoc_cursor);
    const result=await request<{data:ProjectSessionsDto}>(`/api/v1/code-flow/${id}/sessions?${query}`);if(!valid())return;
    if(route.query.assoc_cursor&&!result.data.items.length){await firstPage();return;}
    data.value=result.data;shown=currentScope;navigation.rememberPage(session.user?.user_id??'',key(page.value),route.fullPath);
  }catch(reason){
    if(!valid())return;
    if(reason instanceof ApiFailure&&reason.code==='invalid_cursor'&&route.query.assoc_cursor)await firstPage();
    else{const message=reason instanceof Error?reason.message:'关联会话暂不可用';if(keep&&isTransientReadFailure(reason))error.value=`刷新失败，当前为上次结果：${message}`;else{data.value=null;error.value=message;if(reason instanceof ApiFailure&&([401,403,404,409,422].includes(reason.status)||reason.code==='recovery_quarantined'))emit('unavailable',reason);}}
  }finally{if(valid())loading.value=false;}
}
function next(){if(data.value?.next_cursor)return router.replace({path:'/code-flow',query:{...route.query,assoc_cursor:data.value.next_cursor,assoc_page:String(page.value+1)}});}
function previous(){const prior=navigation.previous(session.user?.user_id??'',key(page.value-1));return router.replace(prior??{path:'/code-flow',query:{...route.query,assoc_cursor:undefined,assoc_page:undefined}});}
function visibilityChanged(value:boolean){if(!value)emit('close');}
function remember(){navigation.open(session.user?.user_id??'',route.fullPath,window.scrollY);}
watch(scope,()=>{const recovering=repair;repair=false;void load(false,recovering);},{immediate:true,flush:'sync'});watch(()=>props.revision,()=>{if(props.project&&shown===scope()&&!loading.value)void load(true);});onBeforeUnmount(()=>{generation++;});
</script>
<template>
  <ElDialog
    :model-value="!!project"
    title="项目关联会话"
    width="min(920px, 94vw)"
    align-center
    @update:model-value="visibilityChanged"
  >
    <template v-if="project">
      <p class="project-context">
        {{ project.workspace }}<br>{{ project.name }} · {{ project.email }}
      </p><p class="muted small-text">
        关联记录保留365天；会话详情仍受45天近期窗口限制，不保证包含全部关联历史。
      </p>
      <p class="muted small-text">
        最近观测会话：<span data-testid="project-observed-session">{{ project.source_hook_session_id??'暂无有效来源' }}</span><span v-if="project.unconfirmed&&project.confirmed_source_hook_session_id&&project.confirmed_source_hook_session_id!==project.source_hook_session_id"><br>上次确认会话：{{ project.confirmed_source_hook_session_id }}</span>
      </p>
      <ElButton
        :loading="loading"
        @click="load(true)"
      >
        刷新关联
      </ElButton><ElAlert
        v-if="error"
        :title="error"
        type="error"
        :closable="false"
      /><ElAlert
        v-if="notice"
        :title="notice"
        type="info"
        :closable="false"
      />
      <ElTable
        :data="data?.items??[]"
        :empty-text="loading?'正在读取…':data?'当前没有有效关联会话':'关联会话尚未读取'"
      >
        <ElTableColumn
          label="Hook会话ID"
          min-width="250"
        >
          <template #default="{row}">
            <span class="project-context">{{ row.hook_session_id }}</span>
          </template>
        </ElTableColumn>
        <ElTableColumn
          label="最近关联Hook"
          min-width="165"
        >
          <template #default="{row}">
            {{ time(row.last_hook_at) }}<small>{{ row.hook_events }} 条Hook</small>
          </template>
        </ElTableColumn>
        <ElTableColumn
          label="详情"
          min-width="180"
        >
          <template #default="{row}">
            <RouterLink
              v-if="row.readable"
              :to="{path:`/all/sessions/${row.session_id}`,query:{return:route.fullPath,...(departmentId?{dept:departmentId}:{})}}"
              @click="remember"
            >
              查看近期内容
            </RouterLink><span v-else>{{ row.unavailable_reason==='outside_recent_window'?'已超出正文近期窗口':'当前没有可读取的近期内容' }}</span>
          </template>
        </ElTableColumn>
      </ElTable><div class="table-pager">
        <span>共 {{ data?.total??'—' }} 个会话 · 第 {{ page }} 页</span><div>
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
    </template><template #footer>
      <ElButton @click="emit('close')">
        关闭
      </ElButton>
    </template>
  </ElDialog>
</template>
<style scoped>
.project-context { overflow-wrap: anywhere; }small { display: block; margin-top: 6px; color: var(--el-text-color-secondary); }
</style>
