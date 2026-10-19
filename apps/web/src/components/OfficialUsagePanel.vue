<script setup lang="ts">
import ModelCheckPanel from './ModelCheckPanel.vue';
import UsageReconciliationPanel from './UsageReconciliationPanel.vue';
import AmountMissingReasons from './AmountMissingReasons.vue';
import type {OfficialUsageDto} from '@adi/contracts';
defineProps<{data:OfficialUsageDto}>();
const integer=(value:string|null)=>value===null?'未知':BigInt(value).toLocaleString('zh-CN');
const sourceNames:Record<string,string>={basic:'基础额度',pay_go:'超额用量',mixed:'基础与超额混用',enterprise_builtin:'企业模型',unknown:'未知来源'};
const originNames:Record<string,string>={Trae:'TRAE 内置',Custom:'企业统一接入',unknown:'未知模型来源'};
</script>
<template>
  <section
    class="data-panel official-panel"
    data-testid="official-usage-panel"
  >
    <div class="official-heading">
      <h2>官方用量</h2><span>{{ data.configured ? `已有有效查询结果 ${data.coverage.verified_user_days} / ${data.coverage.expected_user_days} 人日` : '尚未配置来源' }}</span>
    </div>
    <template v-if="data.configured">
      <p class="official-description">
        按所选业务日汇总已获取的官方记录。Chat 与 CUE 分开；金额是上游报告值，不代表最终现金支付或加量包抵扣结果。
      </p>
      <ElAlert
        v-if="data.coverage.missing_user_days"
        :title="`${data.coverage.missing_user_days} 人日缺少有效查询结果，缺少结果不等于零使用。`"
        type="warning"
        :closable="false"
      />
      <UsageReconciliationPanel
        v-if="data.reconciliation"
        :data="data.reconciliation"
      />
      <ModelCheckPanel
        v-if="data.model_check"
        :data="data.model_check"
      />
      <ElTable
        :data="data.groups"
        empty-text="当前范围尚未获取官方记录，不能据此认定没有使用。"
      >
        <ElTableColumn
          label="来源 / 场景"
          min-width="175"
        >
          <template #default="{row}">
            {{ originNames[row.model_source] }}<span class="secondary">{{ row.scene === 'Chat' ? '问答' : row.scene === 'CUE' ? 'CUE 补全' : '其他场景' }} · {{ row.client === 'ide' ? 'IDE' : '客户端未标明' }}</span>
          </template>
        </ElTableColumn>
        <ElTableColumn
          label="消耗类别"
          min-width="130"
        >
          <template #default="{row}">
            {{ sourceNames[row.consumption_source] }}
          </template>
        </ElTableColumn>
        <ElTableColumn
          label="官方 Token"
          min-width="120"
        >
          <template #default="{row}">
            {{ integer(row.tokens) }}<span
              v-if="row.missing_token_records"
              class="secondary"
            >已知部分 {{ integer(row.known_tokens) }}</span>
          </template>
        </ElTableColumn>
        <ElTableColumn
          label="模型调用"
          min-width="100"
        >
          <template #default="{row}">
            {{ integer(row.calls) }}
          </template>
        </ElTableColumn>
        <ElTableColumn
          label="报告金额"
          min-width="160"
        >
          <template #default="{row}">
            {{ row.amount === null ? '未提供完整金额' : `${row.amount} ${row.currency}` }}<span
              v-if="row.amount === null && row.known_amount !== null"
              class="secondary"
            >已知部分 {{ row.known_amount }} {{ row.currency }}</span>
          </template>
        </ElTableColumn>
        <ElTableColumn
          label="数据提示"
          min-width="140"
        >
          <template #default="{row}">
            {{ row.quality_records ? `${row.quality_records} 条记录含质量提示` : row.amount_missing_reasons.length ? '' : '—' }}
            <AmountMissingReasons :reasons="row.amount_missing_reasons" />
          </template>
        </ElTableColumn>
      </ElTable>
      <div class="panel-footer">
        <p v-if="data.unassigned_records">
          {{ data.unassigned_records }} 条记录部门待归属：本地部门历史缺失或账项跨调岗期间，仍计入有权查看的全局或本人汇总。
        </p><p v-if="data.scope.kind === 'organization' && data.scope.department_ids">
          部门按使用期间的本地人员部门历史统计；官方账项中的部门不参与归属。调岗后请在 Trae IDE 新开会话，无法可靠拆分的账项不重复计入部门。
        </p><p v-if="data.excluded_client_records">
          {{ data.excluded_client_records }} 条其他客户端记录未纳入。
        </p><p>1人日＝1账号×1天；包含空结果及当日部分时段结果，不代表整日或会话用量完整。</p><p>统计范围按当前启用账号及可见历史记录计算，与使用覆盖率或员工绩效无关。</p>
      </div>
    </template>
    <p
      v-else
      class="official-description"
    >
      官方用量来源尚未配置。当前仍可查看 Hook 观测统计。
    </p>
  </section>
</template>
<style scoped>
.official-panel { margin-top: 24px; }.official-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 20px; }.official-heading h2 { font-size: var(--ui-font-section); margin: 0; }.official-heading span { font-size: var(--ui-font-small); color: #8195b1; }.official-description { font-size: var(--ui-font-small); padding: 0 20px; margin: 0 0 18px; }.official-panel .el-alert { margin: 0 20px 18px; width: auto; }.panel-footer p { margin: 4px 0; }
</style>
