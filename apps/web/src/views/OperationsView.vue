<script setup lang="ts">
import ModelCheckPanel from '../components/ModelCheckPanel.vue';
import UsageReconciliationPanel from '../components/UsageReconciliationPanel.vue';
import StorageMonitorPanel from '../components/StorageMonitorPanel.vue';
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue';import {useRouter} from 'vue-router';
import AppIcon from '../components/AppIcon.vue';
import type {OperationsHealthDto,OperationsRetentionDto,OperationsUsageDto} from '@adi/contracts';
import {request,ApiFailure,isTransientReadFailure} from '../api/http.js';import {useSession} from '../stores/session.js';
import AnalysisPeriodFilter from '../components/AnalysisPeriodFilter.vue';import {useAnalysisPeriod,type AnalysisPeriod} from '../stores/analysis-period.js';
const props=defineProps<{section:'health'|'usage-sync'|'retention'}>();const session=useSession(),router=useRouter(),periods=useAnalysisPeriod();periods.setOwner(session.user?.user_id??'');
const health=ref<OperationsHealthDto|null>(null),usage=ref<OperationsUsageDto|null>(null),retention=ref<OperationsRetentionDto|null>(null),loading=ref(false),error=ref(''),automatic=ref(true);let generation=0,timer:number|undefined;
const title=computed(()=>({health:'采集健康','usage-sync':'出账同步',retention:'数据保留'})[props.section]);
const time=(value:string|null|undefined)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未观测';
const number=(value:number|null|undefined)=>value===null||value===undefined?'—':value.toLocaleString('zh-CN');
const bytes=(value:string|null|undefined)=>value===null||value===undefined?'未观测':`${(Number(BigInt(value))/1048576).toLocaleString('zh-CN',{maximumFractionDigits:1})} MiB`;
const kinds:Record<string,string>={collector:'采集接收',worker:'派生与导入',usage_worker:'官方用量同步',cleanup_worker:'数据清理',maintenance_worker:'留存维护',derive_session:'会话派生',member_import:'成员导入',usage_sync:'按日用量同步',usage_attribution:'会话归因',usage_model_check:'模型交叉核查',cleanup:'数据清理',other:'其他任务'};
const maintenanceStates:Record<string,string>={unobserved:'未观测',running:'维护进行中',degraded:'维护需处理',stale:'超过计划时间',observed:'本轮已完成'};
const maintenancePhases:Record<string,string>={idle:'等待下次维护',partitions:'预建分区',discover:'确认过期会话',derived:'回收旧派生副本',references:'回收过期会话关联',keys:'回收去重索引',boundary:'清理边界月份',drop_partitions:'回收过期月份',finalize:'更新会话范围',usage:'回收过期官方数据',auxiliary:'回收临时工作记录',verify:'核对结果'};
const states:Record<string,string>={unknown:'未观测',observed:'最近收到状态',running:'运行状态已上报',degraded:'降级',stale:'状态已过期',stopped:'已停止',queued:'排队',failed:'失败',succeeded:'成功',cancelled:'取消',empty:'上游返回空',not_queried:'未探查'};
const taskStates:Record<string,string>={queued:'排队',running:'运行中',failed:'失败',succeeded:'执行成功',cancelled:'取消'};
const probeStates:Record<string,string>={running:'探查中',observed:'有返回记录',empty:'返回空',failed:'失败'};
const currentCollector=computed(()=>health.value?.instances.find(row=>row.boot_id===health.value?.collector.boot_id));const gauge=(key:string)=>{const value=currentCollector.value?.metrics[key];return typeof value==='number'?value:null;};
const limitReasons=[{key:'limited_body_bytes',label:'单条正文过大'},{key:'limited_inflight_bytes',label:'同时读取的总字节超限'},{key:'limited_readers',label:'同时读取请求数超限'},{key:'limited_read_timeout',label:'读取超时'},{key:'limited_json_budget',label:'JSON资源预算超限'},{key:'limited_delivery_capacity',label:'投递队列容量或状态不允许接收'}];
const snapshot=computed(()=>health.value?.as_of??usage.value?.as_of??retention.value?.as_of);
function clear(){health.value=null;usage.value=null;retention.value=null;}
async function load(reset=false){const current=++generation;if(reset)clear();loading.value=true;error.value='';try{
 if(props.section==='health'){const response=await request<{data:OperationsHealthDto}>('/api/v1/system/health');if(current===generation)health.value=response.data;}
 else if(props.section==='retention'){const response=await request<{data:OperationsRetentionDto}>('/api/v1/system/retention');if(current===generation)retention.value=response.data;}
 else{const params=new window.URLSearchParams(periods.period??{});const response=await request<{data:OperationsUsageDto}>(`/api/v1/system/usage-sync?${params}`);if(current===generation){usage.value=response.data;periods.remember(response.data.period);}}
 }catch(reason){if(current===generation){const message=reason instanceof Error?reason.message:'无法读取运营状态';if((health.value||usage.value||retention.value)&&isTransientReadFailure(reason))error.value=`刷新失败，当前为上次结果：${message}`;else{clear();error.value=message;}if(reason instanceof ApiFailure&&[401,403].includes(reason.status)){await session.refresh();await router.replace(session.user?.default_route??'/login');}}}finally{if(current===generation)loading.value=false;}}
function changePeriod(value:AnalysisPeriod){periods.remember(value);void load(true);}function resetPeriod(){periods.clear();void load(true);}
watch(()=>props.section,()=>{void load(true);},{immediate:true});onMounted(()=>{timer=window.setInterval(()=>{if(automatic.value&&!loading.value&&window.document.visibilityState==='visible')void load();},10000);});onBeforeUnmount(()=>{generation++;window.clearInterval(timer);});
</script>
<template>
  <div class="page-heading">
    <div>
      <h1 class="section-icon-title">
        <AppIcon
          :name="section==='retention'?'database':section==='usage-sync'?'refresh':'ops'"
          :size="24"
        />{{ title }}
      </h1><p>真实运行观测与持久任务状态；缺少观测不等于服务正常或数据完整。</p>
    </div><ElButton
      :loading="loading"
      @click="load()"
    >
      刷新状态
    </ElButton>
  </div>
  <div class="ops-toolbar">
    <ElCheckbox v-model="automatic">
      可见页面每10秒刷新
    </ElCheckbox><span class="muted small-text">状态快照：{{ time(snapshot) }}</span>
  </div>
  <ElAlert
    v-if="error"
    :title="error"
    type="error"
    :closable="false"
    class="page-notice"
  >
    <ElButton
      v-if="section==='usage-sync'"
      link
      @click="resetPeriod"
    >
      恢复近7天
    </ElButton>
  </ElAlert>
  <p
    v-if="loading&&!snapshot"
    role="status"
    class="muted"
  >
    正在读取状态…
  </p>
  <template v-if="health">
    <div class="ops-metrics">
      <ElCard><span>采集观测</span><strong>{{ states[health.collector.state] }}</strong><small>{{ time(health.collector.last_observed_at) }}</small></ElCard><ElCard><span>接收请求</span><strong data-testid="operations-received">{{ number(health.collector.received) }}</strong><small>所示采集进程本次运行累计</small></ElCard><ElCard><span>已知丢弃</span><strong>{{ number(health.collector.known_dropped) }}</strong><small>准入超限＋已确认拒收/丢弃</small></ElCard><ElCard><span>投递结果未知</span><strong>{{ number(health.collector.delivery_unknown) }}</strong><small>未取得确定的提交结果</small></ElCard>
    </div>
    <p class="ops-info">
      未知投递不等于确定丢弃。计数属于对应进程运行周期；采样、进程重启和未送达的最后状态都可能形成观测缺口，不能由此证明全部客户端数据完整。
    </p>
    <div class="ops-grid">
      <ElCard>
        <h2>接收与处理</h2><dl><dt>入库已确认</dt><dd>{{ number(health.collector.persisted) }}</dd><dt>暂存条数</dt><dd>{{ number(gauge('delivery_retainedItems')) }}</dd><dt>暂存内存</dt><dd>{{ gauge('delivery_retainedBytes')===null?'未观测':bytes(String(gauge('delivery_retainedBytes'))) }}</dd><dt>进行中的投递</dt><dd>{{ number(gauge('delivery_inFlight')) }}</dd><dt>接收端过滤</dt><dd>{{ number(gauge('intake_filtered')) }}</dd></dl><p class="muted small-text">
          HTTP返回成功不等于已经入库。这里显示最近一条采集实例观测，完整运行记录见下表。
        </p>
        <details
          class="ops-missing"
          data-testid="intake-limit-reasons"
        >
          <summary>查看接收限制原因</summary>
          <dl>
            <template
              v-for="reason in limitReasons"
              :key="reason.key"
            >
              <dt>{{ reason.label }}</dt><dd :data-testid="reason.key==='limited_read_timeout'?'intake-read-timeouts':undefined">
                {{ number(gauge('intake_'+reason.key)) }}
              </dd>
            </template>
          </dl>
          <p class="muted small-text">
            未观测表示当前采集进程没有上报该项，不能按0处理。以上是同一进程本次运行的累计计数。
          </p>
        </details>
      </ElCard><ElCard>
        <h2>空间与预算</h2><dl><dt>业务Schema关系文件</dt><dd>{{ bytes(health.database.schema_bytes) }}</dd><dt>配置的项目预算</dt><dd>{{ health.database.budget_bytes?bytes(health.database.budget_bytes):'未配置' }}</dd><dt>观测挂载盘可用</dt><dd>{{ bytes(health.disk.available_bytes) }}</dd></dl><p
          v-if="health.database.over_budget"
          class="ops-notice"
        >
          业务关系文件已超过配置预算。
        </p><p
          v-if="!health.disk.observed"
          class="ops-notice"
        >
          未取得挂载盘空间观测，不以Schema大小推断剩余磁盘。
        </p><p class="muted small-text">
          关系文件不含WAL、备份和其他服务；挂载盘由部署配置指定，不自动认定为数据库所在盘。
        </p>
      </ElCard>
    </div>
    <ElCard class="ops-section">
      <h2>运行实例观测</h2><div class="ops-table">
        <table>
          <thead><tr><th>组件 / 本次运行</th><th>状态</th><th>首次观测</th><th>最近观测</th></tr></thead><tbody>
            <tr
              v-for="item in health.instances"
              :key="item.boot_id"
            >
              <td>{{ kinds[item.component]??item.component }}<small>{{ item.boot_id.slice(0,8) }}</small></td><td>{{ item.state==='stopped'?'已停止':item.fresh?(states[item.state]??item.state):'状态已过期' }}</td><td>{{ time(item.first_observed_at) }}</td><td>{{ time(item.last_observed_at) }}</td>
            </tr><tr v-if="!health.instances.length">
              <td colspan="4">
                尚未收到运行状态。
              </td>
            </tr>
          </tbody>
        </table>
      </div><p class="muted small-text">
        30秒未更新标记过期；这表示观测缺失，不直接证明进程退出。{{ health.truncated?'仅展示最近100条运行记录。':'' }}
      </p>
    </ElCard>
    <ElCard class="ops-section">
      <h2>后台任务</h2><div class="ops-table">
        <table>
          <thead><tr><th>类型</th><th>排队 / 可领取</th><th>运行</th><th>租约过期</th><th>失败</th><th>成功</th></tr></thead><tbody>
            <tr
              v-for="item in health.jobs"
              :key="item.kind"
            >
              <td>{{ kinds[item.kind]??item.kind }}</td><td>{{ number(item.queued) }} / {{ number(item.ready) }}</td><td>{{ number(item.running) }}</td><td>{{ number(item.expired) }}</td><td>{{ number(item.failed) }}</td><td>{{ number(item.succeeded) }}</td>
            </tr><tr v-if="!health.jobs.length">
              <td colspan="6">
                尚无任务记录。
              </td>
            </tr>
          </tbody>
        </table>
      </div><p class="muted small-text">
        这是当前持久任务状态，不是累计模型调用或事件成功次数。
      </p>
    </ElCard>
  </template>
  <template v-if="usage">
    <AnalysisPeriodFilter
      basis="official"
      :period="usage.period"
      :computed-at="usage.as_of"
      :loading="loading"
      @change="changePeriod"
    />
    <ElAlert
      v-if="!usage.configured"
      title="未配置官方用量来源，当前不生成同步覆盖数字。"
      type="info"
      :closable="false"
    />
    <div
      v-else
      class="ops-metrics"
    >
      <ElCard><span>已有有效查询结果</span><strong>{{ number(usage.coverage?.verified_user_days) }} 人日</strong><small>统计范围 {{ number(usage.coverage?.expected_user_days) }} 人日</small></ElCard><ElCard><span>缺少有效查询结果</span><strong>{{ number(usage.coverage?.missing_user_days) }} 人日</strong><small>缺少结果不等于零使用</small></ElCard><ElCard><span>本地部门归属</span><strong>{{ usage.departments.match_ratio===null?'—':`${(usage.departments.match_ratio*100).toFixed(1)}%` }}</strong><small>{{ number(usage.departments.matched) }} / {{ number(usage.departments.records) }} 条已获取记录；其余部门待归属</small></ElCard><ElCard><span>限流暂停窗口</span><strong>{{ !usage.rate_limit.observed?'未观测':usage.rate_limit.paused?'暂停中':'当前未暂停' }}</strong><small>{{ usage.rate_limit.paused?time(usage.rate_limit.paused_until):'来自持久控制记录' }}</small></ElCard>
    </div>
    <p class="ops-notice">
      1人日＝1账号×1天；包含空结果及当日部分时段结果，不代表整日或会话用量完整。
      已获取记录中有 {{ number(usage.departments.unmatched) }} 条部门待归属，{{ number(usage.conflicting_sessions) }} 个近期会话存在有效关联冲突。
    </p>
    <ModelCheckPanel
      v-if="usage.model_check"
      :data="usage.model_check"
    />
    <UsageReconciliationPanel
      v-if="usage.reconciliation"
      :data="usage.reconciliation"
    />
    <ElCard
      v-if="usage.backfill"
      class="ops-section"
      data-testid="backfill-progress"
    >
      <h2>初始 45 天回补</h2>
      <p v-if="usage.backfill.users">
        当前启用轮次 {{ number(usage.backfill.users) }} 个账户；已完成首轮核验 {{ number(usage.backfill.verified_days) }} / {{ number(usage.backfill.expected_days) }} 人员日，{{ number(usage.backfill.completed_users) }} 个账户完成目标窗口。
      </p>
      <p v-else>
        尚未发现当前启用账户的回补任务。
      </p>
      <p>待入队 {{ number(usage.backfill.not_queued_days) }}，待处理 {{ number(usage.backfill.pending_days) }}，失败 {{ number(usage.backfill.failed_days) }}；暂停账户 {{ number(usage.backfill.paused_users) }} 个。</p>
      <p class="muted small-text">
        这是首次接入或重新启用时的固定窗口任务进度，不代表当前查询窗口覆盖完整，也不代表会话官方用量完整。历史回补与近期同步共用限流。
      </p>
    </ElCard>
    <div class="ops-grid">
      <ElCard>
        <h2>同步任务状态</h2><div class="ops-table">
          <table>
            <thead><tr><th>任务</th><th>状态</th><th>数量</th></tr></thead><tbody>
              <tr
                v-for="item in usage.jobs"
                :key="`${item.kind}-${item.status}`"
              >
                <td>{{ kinds[item.kind]??item.kind }}</td><td>{{ taskStates[item.status]??item.status }}</td><td>{{ number(item.count) }}</td>
              </tr><tr v-if="!usage.jobs.length">
                <td colspan="3">
                  未观测到同步任务。
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </ElCard><ElCard>
        <h2>会话归因探查</h2><div class="ops-table">
          <table>
            <thead><tr><th>最近记录状态</th><th>数量</th></tr></thead><tbody>
              <tr
                v-for="item in usage.probes"
                :key="item.state"
              >
                <td>{{ probeStates[item.state]??item.state }}</td><td>{{ number(item.count) }}</td>
              </tr><tr v-if="!usage.probes.length">
                <td colspan="2">
                  尚无探查记录。
                </td>
              </tr>
            </tbody>
          </table>
        </div><p class="muted small-text">
          探查返回空不等于个人自配；探查观测数量不等于有完整官方用量的会话数。
        </p>
      </ElCard>
    </div>
  </template>
  <template v-if="retention">
    <div class="ops-metrics">
      <ElCard><span>近期查询窗口</span><strong>{{ retention.policy.recent_days }} 天</strong><small>第46天不搬表、不复制正文</small></ElCard><ElCard><span>完整明细策略</span><strong>{{ retention.policy.detail_days }} 天</strong><small>滚动天数，分区按UTC月</small></ElCard><ElCard><span>缺少预建分区</span><strong>{{ retention.missing_partitions.length }}</strong><small>检查保留窗口和未来两月</small></ElCard><ElCard><span>清理屏障</span><strong>{{ number(retention.cleanup.barriers) }}</strong><small>不是已清除原文的数量</small></ElCard>
    </div>
    <p class="ops-notice">
      未观测到备份恢复验证。{{ retention.maintenance.state==='unobserved'?'未观测到周期维护完成记录。':retention.maintenance.scope==='hook_and_usage'?'当前维护记录覆盖Hook及到期官方数据。':'当前维护记录仅覆盖Hook数据。' }}保留策略声明不等于已验证全部物理清理或拥有可恢复备份。
    </p><p class="muted">
      策略截止时间：{{ time(retention.policy.cutoff) }}。清理任务：{{ retention.cleanup.pending }} 排队，{{ retention.cleanup.running }} 运行，{{ retention.cleanup.failed }} 失败。
    </p>
    <ElCard
      v-if="retention.maintenance.state!=='unobserved'"
      class="ops-section"
    >
      <h2>{{ retention.maintenance.scope==='hook_and_usage'?'年度数据维护':'Hook 明细维护' }}</h2>
      <p data-testid="operations-maintenance-state">
        {{ maintenanceStates[retention.maintenance.state] }}
      </p>
      <p>{{ maintenancePhases[retention.maintenance.phase]??retention.maintenance.phase }} · 上次完成：{{ time(retention.maintenance.last_success_at) }} · 下次计划：{{ time(retention.maintenance.next_run_at) }}</p>
      <p>本轮截止：{{ time(retention.maintenance.cutoff) }}。回收月份分区 {{ number(retention.maintenance.counters.dropped_partitions) }} 个，边界月过期记录 {{ number(retention.maintenance.counters.deleted_boundary_events) }} 条，保留跨界会话 {{ number(retention.maintenance.counters.retained_sessions) }} 个。</p>
      <p v-if="retention.maintenance.scope==='hook_and_usage'">
        回收官方观测行 {{ number(retention.maintenance.counters.usage_deleted_rows) }} 条，隔离跨界范围 {{ number(retention.maintenance.counters.usage_invalidated_scopes) }} 个，回收临时记录 {{ number(retention.maintenance.counters.aux_deleted_rows) }} 条。跨界聚合不会按时间比例拆分；仍在使用的工作记录会延期处理。
      </p>
      <p
        v-if="retention.maintenance.last_error"
        class="error-text"
      >
        维护未完成：{{ retention.maintenance.last_error }}；下次重试：{{ time(retention.maintenance.retry_at) }}
      </p>
    </ElCard>
    <details
      v-if="retention.missing_partitions.length"
      class="ops-missing"
    >
      <summary>查看缺少的预建分区（{{ retention.missing_partitions.length }}）</summary><ul>
        <li
          v-for="name in retention.missing_partitions"
          :key="name"
        >
          {{ name }}
        </li>
      </ul>
    </details>
    <StorageMonitorPanel :data="retention.storage_monitor" />
    <ElCard>
      <h2>实际分区观测</h2><div class="ops-table">
        <table>
          <thead><tr><th>表 / UTC月份</th><th>分区</th><th>估计行数</th><th>关系文件大小</th></tr></thead><tbody>
            <tr
              v-for="item in retention.partitions"
              :key="item.table"
            >
              <td>{{ item.parent }}<small>{{ item.month??'非标准月边界' }}</small></td><td>{{ item.table }}</td><td>{{ item.rows_estimate===null?'未知':`约 ${BigInt(item.rows_estimate).toLocaleString()}` }}</td><td>{{ bytes(item.bytes) }}</td>
            </tr><tr v-if="!retention.partitions.length">
              <td colspan="4">
                尚未发现明细分区。
              </td>
            </tr>
          </tbody>
        </table>
      </div><p class="muted small-text">
        行数来自PostgreSQL统计，不是精确清理计数。{{ retention.truncated?'观测超过240个分区，当前展示和缺失判断可能不完整。':'' }}
      </p>
    </ElCard>
  </template>
</template>
<style scoped>
.ops-toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:10px 0 20px}.ops-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin:20px 0}.ops-metrics span{font-size: var(--ui-font-small);color:var(--el-text-color-secondary)}.ops-metrics strong{display:block;font-size: var(--ui-font-metric);margin:12px 0;overflow-wrap:anywhere}.ops-metrics small,.ops-table small{display:block;color:var(--el-text-color-secondary);font-size: var(--ui-font-small);margin-top:6px}.ops-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin:20px 0}.ops-info{padding:14px 18px;background:#122139;color:#93c5fd;border:1px solid #254066;border-radius:6px;font-size: var(--ui-font-body);line-height:1.8}.ops-notice{padding:14px 18px;background:#2e2616;color:#f4c77e;border-radius:6px;font-size: var(--ui-font-body);line-height:1.8}.ops-section{margin:20px 0}.ops-table{overflow:auto}.ops-table table{width:100%;text-align:left;border-collapse:collapse}.ops-table th,.ops-table td{padding:14px 12px;border-bottom:1px solid var(--el-border-color);font-size: var(--ui-font-body);vertical-align:top}.ops-table th{color:var(--el-text-color-secondary);white-space:nowrap}.ops-table td{overflow-wrap:anywhere}.ops-grid dl{display:grid;grid-template-columns:1fr auto;gap:14px;font-size: var(--ui-font-body)}.ops-grid dt{color:var(--el-text-color-secondary)}.ops-grid dd{margin:0}.ops-missing{margin:18px 0;font-size: var(--ui-font-body)}.ops-missing summary{cursor:pointer}.ops-missing ul{columns:2;line-height:1.9}@media(max-width:1050px){.ops-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:700px){.ops-grid,.ops-metrics{grid-template-columns:1fr}.ops-toolbar{align-items:flex-start;flex-direction:column}}
</style>
