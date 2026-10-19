<script setup lang="ts">
import {computed,nextTick,onBeforeUnmount,ref,watch} from 'vue';import type {CleanupPreviewDto,CleanupJobDto} from '@adi/contracts';import * as api from '../api/cleanup.js';
import {ApiFailure,isTransientReadFailure} from '../api/http.js';
import {createOperationKey} from '../lib/operation-key.js';
const props=defineProps<{userId:string;email:string;name:string}>();const emit=defineEmits<{changed:[]}>();
const panel=ref<HTMLElement|null>(null);
const from=ref(''),to=ref(''),confirmation=ref(''),preview=ref<CleanupPreviewDto|null>(null),job=ref<CleanupJobDto|null>(null),history=ref<CleanupJobDto[]>([]),cursor=ref<string|null>(null),busy=ref(false),error=ref('');let generation=0,polling=false,timer:number|undefined,key='';
const jobLoading=ref(false),jobError=ref('');let jobRequest=0;
const historyLoading=ref(false),historyLoaded=ref(false),historyError=ref(''),historyNotice=ref(''),accessBlocked=ref(false);let historyRequest=0,lifetime=0,historyPages=1;
const states:Record<string,string>={queued:'排队中',running:'执行中',succeeded:'已完成',failed:'未完成',cancelled:'已中止'};const phases:Record<string,string>={journal:'保存恢复屏障',journal_verify:'校验恢复屏障',journal_seal:'确认屏障持久化',events:'清理原始记录',keys:'清理去重索引',derived:'清理旧派生副本',models:'处理会话声明',attribution:'处理关联证据',usage:'处理官方快照',rebuild:'安排范围外数据重建',verify:'核验目标存储',complete:'存储核验完成'};
const inProgress=computed(()=>!!job.value&&['queued','running'].includes(job.value.status));const expected=computed(()=>job.value?.current_email??preview.value?.target.email??'');const confirmed=computed(()=>!!expected.value&&confirmation.value.trim().toLowerCase()===expected.value);
const time=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});const local=(value:number)=>new Date(value+28800000).toISOString().slice(0,19);
function rejectAccess(reason:unknown){
 if(!(reason instanceof ApiFailure)||(![401,403].includes(reason.status)&&reason.code!=='recovery_quarantined'))return false;
 generation++;lifetime++;jobRequest++;historyRequest++;accessBlocked.value=true;jobLoading.value=false;historyLoading.value=false;busy.value=false;
 job.value=null;preview.value=null;confirmation.value='';history.value=[];historyPages=1;historyLoaded.value=false;cursor.value=null;jobError.value='';historyError.value='';historyNotice.value='';key='';error.value=reason.message;return true;
}
async function loadHistory(next=false,recovering=false):Promise<void>{
 const current=lifetime,request=++historyRequest,nextCursor=next?cursor.value??undefined:undefined,pages=next?1:historyPages;
 historyLoading.value=true;historyError.value='';if(!recovering)historyNotice.value='';
 let readCursor=nextCursor;
 try{
  const items:CleanupJobDto[]=[];let fetched=0;
  for(let index=0;index<pages;index++){
   const result=await api.list(props.userId,readCursor);if(current!==lifetime||request!==historyRequest)return;
   items.push(...result.data.items);fetched++;readCursor=result.data.next_cursor??undefined;if(!readCursor)break;
  }
  if(accessBlocked.value){accessBlocked.value=false;error.value='';}
  history.value=next?[...history.value,...items]:items;cursor.value=readCursor??null;historyLoaded.value=true;historyPages=next?historyPages+(items.length?1:0):Math.max(1,fetched);
 }catch(reason){
  if(current!==lifetime||request!==historyRequest)return;
  if(rejectAccess(reason))return;
  if(readCursor&&reason instanceof ApiFailure&&reason.code==='invalid_cursor'){history.value=[];historyPages=1;historyLoaded.value=false;cursor.value=null;historyNotice.value='任务列表分页已更新，已回到第一页。';return loadHistory(false,true);}
  const message=reason instanceof Error?reason.message:'无法读取清理任务';
  if(historyLoaded.value&&isTransientReadFailure(reason))historyError.value=`刷新失败，当前为上次任务列表：${message}`;
  else{history.value=[];historyLoaded.value=false;cursor.value=null;historyError.value=message;}
 }finally{if(current===lifetime&&request===historyRequest)historyLoading.value=false;}
}
async function loadJob(id:string){
 const current=generation,request=++jobRequest;jobLoading.value=true;jobError.value='';
 if(job.value?.job_id!==id)job.value=null;
 try{const result=await api.status(id);if(current===generation&&request===jobRequest){const prior=job.value?.status;job.value=result.data;if(prior!==result.data.status&&['succeeded','failed'].includes(result.data.status)){emit('changed');void loadHistory();}return true;}}
 catch(reason){if(current===generation&&request===jobRequest&&!rejectAccess(reason)){const message=reason instanceof Error?reason.message:'无法读取任务';if(isTransientReadFailure(reason))jobError.value=job.value?`刷新失败，当前为上次进度：${message}`:message;else{job.value=null;confirmation.value='';jobError.value=message;}}}
 finally{if(current===generation&&request===jobRequest)jobLoading.value=false;}
 return false;
}
function selectJob(id:string){if(busy.value||accessBlocked.value)return;if(job.value?.job_id!==id){preview.value=null;confirmation.value='';error.value='';}void loadJob(id);}
async function makePreview(){if(busy.value||jobLoading.value||accessBlocked.value||inProgress.value)return;const current=++generation;busy.value=true;error.value='';preview.value=null;job.value=null;confirmation.value='';key='';try{key=createOperationKey();const start=Date.parse(`${from.value}+08:00`),end=Date.parse(`${to.value}+08:00`);if(!Number.isFinite(start)||!Number.isFinite(end))throw new Error('请填写有效起止时间');const result=await api.preview({user_id:props.userId,from:new Date(start).toISOString(),to:new Date(end).toISOString()});if(current===generation)preview.value=result.data;}catch(reason){if(current===generation&&!rejectAccess(reason))error.value=reason instanceof Error?reason.message:'无法预览';}finally{if(current===generation)busy.value=false;}}
async function commit(){const value=preview.value;if(!value||!confirmed.value||busy.value||accessBlocked.value||value.target.id!==props.userId)return;busy.value=true;error.value='';const current=generation;try{const result=await api.submit({preview_id:value.preview_id,user_id:value.target.id,...value.range,confirmation_email:confirmation.value},key);if(current!==generation)return;if(await loadJob(result.data.job_id)){confirmation.value='';void loadHistory();}}catch(reason){if(current===generation&&!rejectAccess(reason))error.value=reason instanceof Error?reason.message:'提交未确认，请使用同一预览重试';}finally{if(current===generation)busy.value=false;}}
async function retry(){if(!job.value||!confirmed.value||busy.value||jobLoading.value||accessBlocked.value)return;busy.value=true;error.value='';const id=job.value.job_id,current=generation;try{await api.resume(id,confirmation.value);if(current===generation&&await loadJob(id))confirmation.value='';}catch(reason){if(current===generation&&!rejectAccess(reason))error.value=reason instanceof Error?reason.message:'无法继续';}finally{if(current===generation)busy.value=false;}}
function invalidate(){preview.value=null;confirmation.value='';}function fresh(){if(accessBlocked.value)return;generation++;historyRequest++;historyLoading.value=false;jobRequest++;jobLoading.value=false;jobError.value='';job.value=null;preview.value=null;confirmation.value='';error.value='';void loadHistory();}
function reset(){generation++;lifetime++;historyPages=1;historyRequest++;historyLoading.value=false;historyLoaded.value=false;historyError.value='';historyNotice.value='';accessBlocked.value=false;jobRequest++;jobLoading.value=false;jobError.value='';from.value=local(Date.now()-7*86400000);to.value=local(Date.now()-1000);job.value=null;preview.value=null;confirmation.value='';history.value=[];cursor.value=null;error.value='';busy.value=false;void loadHistory();}
watch(()=>job.value?.job_id,async()=>{await nextTick();panel.value?.closest('.el-dialog__body')?.scrollTo({top:0});});
watch(()=>props.userId,reset,{immediate:true,flush:'sync'});timer=window.setInterval(()=>{if(!inProgress.value||busy.value||jobLoading.value||polling)return;polling=true;void loadJob(job.value!.job_id).finally(()=>{polling=false;});},1000);onBeforeUnmount(()=>{generation++;lifetime++;window.clearInterval(timer);});
</script>
<template>
  <div
    ref="panel"
    class="cleanup-panel"
  >
    <p><strong>{{ name }}</strong> · {{ email }}</p><p class="muted">
      处理本平台该用户所有采集来源的指定时间范围，包含 Hook 与插件使用事实。提交后目标记录立即隐藏，后台核验完成才显示“已完成”；不通过取消恢复已删内容。
    </p>
    <ElAlert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
    />
    <ElAlert
      v-if="jobError"
      :title="jobError"
      type="error"
      :closable="false"
    />
    <p
      v-if="jobLoading && !job"
      role="status"
    >
      正在读取任务…
    </p>
    <template v-if="!job && !jobLoading">
      <div class="cleanup-range">
        <label>开始时间（北京时间）<input
          v-model="from"
          type="datetime-local"
          step="1"
          :disabled="busy"
          @input="invalidate"
        ></label><label>结束时间（北京时间）<input
          v-model="to"
          type="datetime-local"
          step="1"
          :disabled="busy"
          @input="invalidate"
        ></label>
      </div><p class="muted small-text">
        范围为开始时刻包含、结束时刻不包含；可选择任意已经发生的历史，不改变正文读取窗口和既有自动留存政策。
      </p><ElButton
        :loading="busy"
        :disabled="accessBlocked"
        @click="makePreview"
      >
        生成清理预览
      </ElButton>
      <section
        v-if="preview"
        class="cleanup-preview"
      >
        <h3>确认目标与影响</h3><p>{{ preview.target.name }} · {{ preview.target.email }}</p><p>{{ time(preview.range.from) }} 至 {{ time(preview.range.to) }}（结束不含）</p><dl>
          <dt>原始Hook记录</dt><dd data-testid="cleanup-event-count">
            {{ preview.counts.hook_events.toLocaleString() }}
          </dd><dt>Git观测证据合计</dt><dd data-testid="cleanup-project-observation-count">
            {{ preview.counts.project_observations?.toLocaleString()??'未提供' }}
          </dd><dt>Hook观测证据</dt><dd data-testid="cleanup-hook-project-observation-count">
            {{ preview.counts.hook_project_observations?.toLocaleString()??'未提供' }}
          </dd><dt>插件观测证据</dt><dd data-testid="cleanup-plugin-project-observation-count">
            {{ preview.counts.plugin_project_observations?.toLocaleString()??'未提供' }}
          </dd><dt>真实Hook项目关联</dt><dd data-testid="cleanup-project-link-count">
            {{ preview.counts.project_links?.toLocaleString()??'未提供' }}
          </dd><dt>受影响会话</dt><dd>{{ preview.counts.sessions }}</dd><dt>整会话模型声明</dt><dd>{{ preview.counts.declared_sessions }}</dd><dt>可能涉及官方查询分段</dt><dd>{{ preview.counts.official_days }}</dd>
        </dl><p class="cleanup-warning">
          受影响会话数不等于整会话删除数。旧派生和声明会清除，仍保存的范围外事实保留并重建；没有剩余原始事件才删除会话。
          跨界官方快照会失效，不能精确拆分的部分重新核验，不生成分摊金额。
          Hook观测按原探测时间或首次来源Hook时间清理，插件观测按原探测时间；原始事件与真实项目关联按实际Hook时间清理。
        </p><p class="muted small-text">
          预览有效至 {{ time(preview.expires_at) }}。身份或数据变化后必须重新预览。
        </p><label>确认目标邮箱<ElInput
          v-model="confirmation"
          aria-label="确认目标邮箱"
          :placeholder="preview.target.email"
          :disabled="busy"
        /></label><p
          v-if="!preview.can_submit"
          class="cleanup-warning"
        >
          未配置恢复屏障存储，当前不能提交清理。
        </p><ElButton
          type="danger"
          :disabled="!confirmed || !preview.can_submit"
          :loading="busy"
          @click="commit"
        >
          确认清理并提交任务
        </ElButton>
      </section>
    </template>
    <section
      v-else-if="job"
      class="cleanup-progress"
    >
      <div class="cleanup-heading">
        <h3>清理任务</h3><strong data-testid="cleanup-job-status">{{ states[job.status]??job.status }}</strong>
      </div><p>{{ job.current_name }} · {{ job.current_email }}</p><p v-if="job.target_email!==job.current_email">
        提交时确认邮箱：{{ job.target_email }}
      </p><p>{{ time(job.from_at) }} 至 {{ time(job.to_at) }}（结束不含）</p><p>{{ phases[job.phase]??job.phase }} · 原始记录已删除 {{ job.progress.deleted_events??0 }} 条</p><p class="muted small-text">
        任务ID：{{ job.job_id }}
      </p><p
        v-if="inProgress"
        class="cleanup-warning"
      >
        任务仍在处理，不能把排队或在线隐藏当作物理清理完成。关闭窗口后后台继续执行。
      </p><p v-if="job.status==='succeeded'">
        本平台目标在线数据已完成清理，恢复屏障已保存；保留记录的派生及官方核验可能仍在后台补齐。
      </p><template v-if="job.status==='failed'">
        <p class="cleanup-warning">
          清理未完成，隐藏屏障仍保留。请先检查权限或恢复存储，再重新授权继续。错误码：{{ job.error_code??'未知' }}
        </p><label>确认目标邮箱<ElInput
          v-model="confirmation"
          aria-label="确认目标邮箱"
          :placeholder="job.current_email"
        /></label><ElButton
          type="danger"
          :disabled="!confirmed"
          :loading="busy"
          @click="retry"
        >
          重新授权并继续
        </ElButton>
      </template><ElButton
        v-if="!inProgress"
        :disabled="busy"
        @click="fresh"
      >
        新建清理预览
      </ElButton>
    </section>
    <p class="muted small-text">
      账号、账号共用插件 API 码、来源绑定与身份、安装、必要审计和排序屏障保留。第三方官方源与IDE本地历史不由此操作删除；备份按保留策略处理，恢复数据库前必须应用最新外部屏障。没有匹配记录只说明当前没有相应已保存目标，不代表未使用。
    </p>
    <details class="cleanup-history">
      <summary>该用户的清理任务</summary><ElButton
        link
        :loading="historyLoading"
        @click="loadHistory()"
      >
        刷新任务列表
      </ElButton><ElAlert
        v-if="historyError"
        :title="historyError"
        type="error"
        :closable="false"
      /><p
        v-if="historyNotice"
        role="status"
      >
        {{ historyNotice }}
      </p><ul>
        <li
          v-for="item in history"
          :key="item.job_id"
        >
          <ElButton
            link
            :disabled="busy"
            @click="selectJob(item.job_id)"
          >
            {{ time(item.from_at) }} — {{ states[item.status]??item.status }}
          </ElButton>
        </li>
      </ul><p
        v-if="!history.length"
        class="muted"
      >
        {{ historyLoading ? '正在读取任务列表…' : historyLoaded ? '暂无已提交任务。' : '任务列表尚未读取。' }}
      </p><ElButton
        v-if="cursor"
        link
        :disabled="historyLoading"
        @click="loadHistory(true)"
      >
        更早的任务
      </ElButton>
    </details>
  </div>
</template>
<style scoped>
.cleanup-panel{min-width:0}
.cleanup-range{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin:20px 0}.cleanup-range label,.cleanup-preview label,.cleanup-progress label{display:grid;gap:8px;font-size: var(--ui-font-body)}.cleanup-range input{background:var(--ui-control-bg);border:1px solid var(--ui-control-border);border-radius:var(--ui-control-radius);height:var(--ui-control-height);padding:8px 12px;color:var(--el-text-color-primary);width:100%;box-sizing:border-box}.cleanup-preview,.cleanup-progress{margin:22px 0;padding:18px;border:1px solid var(--el-border-color);border-radius:8px}.cleanup-preview dl{display:grid;grid-template-columns:1fr auto;gap:12px}.cleanup-preview dd{margin:0}.cleanup-warning{color:#f4c77e;font-size: var(--ui-font-body);line-height:1.8}.cleanup-preview .el-button,.cleanup-progress .el-button{margin-top:16px}.cleanup-heading{display:flex;justify-content:space-between;align-items:center}.cleanup-heading strong{color:#93c5fd}.cleanup-history summary{cursor:pointer;padding:12px 0}.cleanup-history ul{padding-left:16px}@media(max-width:700px){.cleanup-range{grid-template-columns:1fr}}
</style>
