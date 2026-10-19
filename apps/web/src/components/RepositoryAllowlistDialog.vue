<script setup lang="ts">
import {onBeforeUnmount,ref,watch} from 'vue';
import {ElMessageBox} from 'element-plus';
import type {RepositoryAllowlistDto,RepositoryRuleDto,RepositoryRuleBody} from '@adi/contracts';
import {request,ApiFailure,isTransientReadFailure} from '../api/http.js';
const open=defineModel<boolean>({default:false}),emit=defineEmits<{changed:[];unavailable:[reason:Error]}>();
const data=ref<RepositoryAllowlistDto|null>(null),loading=ref(false),busy=ref(false),error=ref(''),notice=ref('');
const search=ref(''),appliedSearch=ref(''),page=ref(0),cursors=ref<(string|undefined)[]>([undefined]);
const kind=ref<RepositoryRuleBody['kind']>('host'),value=ref(''),editing=ref<RepositoryRuleDto|null>(null);
let lifetime=0,reading=0;
function resetForm(){kind.value='host';value.value='';editing.value=null;}
function rejectAccess(reason:unknown){
  if(!(reason instanceof ApiFailure)||(![401,403].includes(reason.status)&&reason.code!=='recovery_quarantined'))return false;
  data.value=null;resetForm();emit('unavailable',reason);return true;
}
async function load(preserve=true,recovering=false):Promise<void>{
  if(!open.value)return;const scope=lifetime,current=++reading;
  loading.value=true;error.value='';if(!recovering)notice.value='';if(!preserve)data.value=null;
  const query=new window.URLSearchParams({limit:'20',search:appliedSearch.value});const cursor=cursors.value[page.value];if(cursor)query.set('cursor',cursor);
  try{
    const result=await request<{data:RepositoryAllowlistDto}>(`/api/v1/repository-allowlist?${query}`);if(scope!==lifetime||current!==reading)return;
    if(cursor&&!result.data.items.length){data.value=null;page.value=0;cursors.value=[undefined];notice.value='白名单分页已更新，已回到第一页。';return load(false,true);}
    data.value=result.data;
  }
  catch(reason){
    if(scope!==lifetime||current!==reading)return;
    if(cursor&&reason instanceof ApiFailure&&reason.code==='invalid_cursor'){
      data.value=null;page.value=0;cursors.value=[undefined];notice.value='白名单分页已更新，已回到第一页。';return load(false,true);
    }
    const message=reason instanceof Error?reason.message:'白名单暂不可用';
    if(data.value&&isTransientReadFailure(reason))error.value=`刷新失败，当前为上次结果：${message}`;
    else{data.value=null;error.value=message;rejectAccess(reason);}
  }finally{if(scope===lifetime&&current===reading)loading.value=false;}
}
function find(){appliedSearch.value=search.value.trim();page.value=0;cursors.value=[undefined];void load(false);}
function next(direction:number){if(loading.value||busy.value)return;if(direction>0){if(!data.value?.next_cursor)return;cursors.value[page.value+1]=data.value.next_cursor;}page.value=Math.max(0,page.value+direction);void load(false);}
function edit(row:RepositoryRuleDto){editing.value=row;kind.value=row.kind;value.value=row.value;error.value='';}
async function save(){
  if(busy.value||loading.value||!value.value.trim())return;
  const scope=lifetime,row=editing.value;busy.value=true;error.value='';
  const body={kind:kind.value,value:value.value.trim(),...(row?{version:row.version}:{})};
  try{
    await request(row?`/api/v1/repository-allowlist/${row.id}`:'/api/v1/repository-allowlist',row?'PATCH':'POST',body);
    if(scope!==lifetime)return;resetForm();page.value=0;cursors.value=[undefined];emit('changed');await load(false);
  }catch(reason){if(scope===lifetime&&!rejectAccess(reason))error.value=reason instanceof Error?reason.message:'保存失败，请重试';}
  finally{if(scope===lifetime)busy.value=false;}
}
async function remove(row:RepositoryRuleDto){
  const scope=lifetime;
  try{await ElMessageBox.confirm(`移除 ${row.value}？匹配该规则的仓库将按剩余规则重新分类。`,'移除白名单规则',{confirmButtonText:'确认移除',cancelButtonText:'取消',type:'warning'});}catch{return;}
  if(scope!==lifetime||busy.value)return;busy.value=true;error.value='';
  try{
    await request(`/api/v1/repository-allowlist/${row.id}`,'DELETE',{version:row.version});
    if(scope!==lifetime)return;if(editing.value?.id===row.id)resetForm();page.value=0;cursors.value=[undefined];emit('changed');await load(false);
  }catch(reason){if(scope===lifetime&&!rejectAccess(reason))error.value=reason instanceof Error?reason.message:'移除失败，请重试';}
  finally{if(scope===lifetime)busy.value=false;}
}
watch(open,()=>{lifetime++;reading++;data.value=null;loading.value=false;busy.value=false;error.value='';notice.value='';search.value='';appliedSearch.value='';page.value=0;cursors.value=[undefined];resetForm();if(open.value)void load(false);},{immediate:true});
onBeforeUnmount(()=>{lifetime++;reading++;});
</script>
<template>
  <ElDialog
    v-model="open"
    title="部门仓库白名单"
    width="min(920px, 94vw)"
    align-center
    destroy-on-close
  >
    <p>全局规则仅用于个人／部门仓库分类，不绑定具体部门，也不授予仓库或会话访问权。</p>
    <p class="muted small-text">
      精确主机覆盖该主机的所有协议、端口和仓库，不含子域。完整仓库地址按脱敏后的协议、端口与路径精确匹配。合法字面 10 网段自动标为部门仓库。
    </p>
    <ElAlert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
    />
    <ElAlert
      v-if="notice"
      :title="notice"
      type="info"
      :closable="false"
    />
    <ElForm
      label-position="top"
      class="rule-form"
      @submit.prevent="save"
    >
      <ElFormItem label="规则类型">
        <ElSelect
          v-model="kind"
          aria-label="规则类型"
          :disabled="busy"
        >
          <ElOption
            label="精确主机"
            value="host"
          /><ElOption
            label="完整仓库地址"
            value="repository"
          />
        </ElSelect>
      </ElFormItem>
      <ElFormItem label="匹配地址">
        <ElInput
          v-model="value"
          aria-label="匹配地址"
          maxlength="4096"
          :disabled="busy"
          placeholder="例如 git.example.com 或 https://git.example.com/team/app.git"
        />
      </ElFormItem>
      <div class="rule-actions">
        <ElButton
          type="primary"
          native-type="submit"
          :loading="busy"
          :disabled="loading||!value.trim()"
        >
          {{ editing?'保存修改':'添加规则' }}
        </ElButton><ElButton
          v-if="editing"
          :disabled="busy"
          @click="resetForm"
        >
          取消编辑
        </ElButton>
      </div>
    </ElForm>
    <form
      class="rule-search"
      @submit.prevent="find"
    >
      <ElInput
        v-model="search"
        aria-label="搜索白名单"
        placeholder="搜索主机或仓库地址"
        maxlength="128"
        clearable
      /><ElButton
        native-type="submit"
        :disabled="loading||busy"
      >
        查询
      </ElButton><ElButton
        :disabled="busy"
        :loading="loading"
        @click="load()"
      >
        刷新白名单
      </ElButton>
    </form>
    <ElTable
      :data="data?.items??[]"
      :empty-text="loading?'正在读取…':data?'暂无匹配规则':'白名单尚未读取'"
    >
      <ElTableColumn
        label="规则类型"
        width="145"
      >
        <template #default="{row}">
          {{ row.kind==='host'?'精确主机':'完整仓库地址' }}
        </template>
      </ElTableColumn>
      <ElTableColumn
        label="匹配地址"
        min-width="250"
      >
        <template #default="{row}">
          <span class="rule-value">{{ row.value }}</span>
        </template>
      </ElTableColumn>
      <ElTableColumn
        label="操作"
        width="150"
      >
        <template #default="{row}">
          <ElButton
            link
            :disabled="busy||loading"
            @click="edit(row)"
          >
            编辑
          </ElButton><ElButton
            link
            type="danger"
            :disabled="busy||loading"
            @click="remove(row)"
          >
            移除
          </ElButton>
        </template>
      </ElTableColumn>
    </ElTable>
    <div class="table-pager">
      <span>共 {{ data?.total??'—' }} 条 · 第 {{ page+1 }} 页</span><div>
        <ElButton
          :disabled="loading||busy||page===0"
          @click="next(-1)"
        >
          上一页
        </ElButton><ElButton
          :disabled="loading||busy||!data?.next_cursor"
          @click="next(1)"
        >
          下一页
        </ElButton>
      </div>
    </div>
    <template #footer>
      <ElButton @click="open=false">
        关闭
      </ElButton>
    </template>
  </ElDialog>
</template>
<style scoped>
.rule-form { margin: 20px 0; }.rule-form .el-select { width: 220px; }.rule-actions,.rule-search { display: flex; gap: 12px; }.rule-search { margin: 20px 0; }.rule-value { overflow-wrap: anywhere; }
</style>
