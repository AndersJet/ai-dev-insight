<script setup lang="ts">
import type {StorageMonitorDto} from '@adi/contracts';
defineProps<{data:StorageMonitorDto}>();
const states:Record<string,string>={unobserved:'尚未观测',observed:'近期已观测',stale:'观测已过期',degraded:'观测失败'};
const severity:Record<string,string>={warning:'关注',high:'预警',critical:'严重',resolved:'已恢复',unknown:'无法判定'};
const delivery:Record<string,string>={disabled:'外部出口关闭',queued:'等待投递',running:'投递中',sent:'出口已接收',failed:'投递未确认',cancelled:'已取消'};
const names:Record<string,string>={storage_budget:'业务关系文件接近项目预算',statistics_disabled:'数据库统计采集关闭',autovacuum_disabled:'自动 vacuum 关闭',dead_tuple_backlog:'估计死元组积压'};
const name=(key:string)=>names[key.split(':')[0]!]??key;
const time=(value:string|null)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-CN',{hour12:false}):'未观测';
const bytes=(value:string|null)=>value===null?'未配置':`${(Number(BigInt(value))/1048576).toLocaleString('zh-CN',{maximumFractionDigits:1})} MiB`;
const count=(value:string|null)=>value===null?'未知':BigInt(value).toLocaleString();
</script>
<template>
  <ElCard
    class="monitor-card"
    data-testid="storage-monitor"
  >
    <h2>数据库空间与 vacuum</h2>
    <p><strong>{{ states[data.state] }}</strong> · {{ time(data.observation?.observed_at??null) }}</p>
    <p class="muted small-text">
      死元组来自 PostgreSQL 估计统计，不等于真实膨胀率或可释放磁盘空间。页面读取后台观测，不执行 vacuum。
    </p>
    <template v-if="data.observation">
      <p>业务关系文件：{{ bytes(data.observation.schema_bytes) }}；项目预算：{{ bytes(data.observation.budget_bytes) }}。</p>
      <p>统计采集：{{ data.observation.track_counts?'开启':'关闭' }}；自动 vacuum：{{ data.observation.autovacuum_enabled?'开启':'关闭' }}；已观测 {{ data.observation.table_count }} 张表。</p>
      <details>
        <summary>查看估计死元组最多的前 20 张表</summary>
        <div class="monitor-table">
          <table>
            <thead><tr><th>表</th><th>存活行估计</th><th>死元组估计</th><th>最近 vacuum</th><th>自动维护</th></tr></thead>
            <tbody>
              <tr
                v-for="table in data.observation.tables.slice(0,20)"
                :key="table.table"
              >
                <td>{{ table.table }}</td><td>{{ count(table.live_estimate) }}</td><td>{{ count(table.dead_estimate) }}</td><td>{{ time(table.last_vacuum_at) }}</td><td>{{ table.autovacuum_enabled?'开启':'关闭' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </template>
    <p v-if="data.observation">
      外部告警出口：{{ data.observation.delivery_configured?'已配置':'关闭' }}。项目预算只计算业务关系文件，不包含 WAL、备份和其他服务。
    </p>
    <h3>当前空间维护告警（{{ data.alerts_total }}）</h3>
    <p v-if="data.alerts_total>data.alerts.length">
      当前显示前 {{ data.alerts.length }} 项。
    </p>
    <p v-if="!data.alerts.length">
      当前没有已记录的触发项；未观测或过期时不能据此判定健康。
    </p>
    <ul v-else>
      <li
        v-for="item in data.alerts"
        :key="item.key"
      >
        {{ severity[item.severity] }} · {{ name(item.key) }} {{ item.subject??'' }} <span v-if="item.key==='storage_budget'&&item.severity!=='unknown'">（预算占用约 {{ item.value }}%）</span>
      </li>
    </ul>
    <details v-if="data.events.length">
      <summary>最近告警变化与投递结果</summary><ul>
        <li
          v-for="event in data.events"
          :key="event.id"
        >
          {{ time(event.created_at) }} · {{ severity[event.severity] }} · {{ name(event.key) }} · {{ delivery[event.status]??event.status }}
        </li>
      </ul>
    </details>
  </ElCard>
</template>
<style scoped>
.monitor-card{margin:20px 0}.monitor-card p,.monitor-card li{font-size: var(--ui-font-body);line-height:1.8}.monitor-card h3{margin-top:24px;font-size: var(--ui-font-subtitle)}.monitor-card summary{cursor:pointer;font-size: var(--ui-font-body);line-height:2}.monitor-table{overflow:auto}.monitor-table table{width:100%;text-align:left;border-collapse:collapse}.monitor-table td,.monitor-table th{padding:12px 8px;border-bottom:1px solid var(--el-border-color);font-size: var(--ui-font-small)}.monitor-table td{overflow-wrap:anywhere}.monitor-table th{white-space:nowrap;color:var(--el-text-color-secondary)}
</style>
