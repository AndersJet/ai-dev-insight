<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { ImportBatchDto } from '@adi/contracts';
import * as api from '../api/member-import.js';
import { ApiFailure, isTransientReadFailure } from '../api/http.js';
import { createOperationKey } from '../lib/operation-key.js';
const props = defineProps<{ departmentId: string }>(); const open = defineModel<boolean>({ default: false }); const emit = defineEmits<{ completed: [] }>();
const file = ref<File | null>(null); const mode = ref<'insert_only' | 'upsert'>('insert_only'); const batch = ref<ImportBatchDto | null>(null); const error = ref(''); const busy = ref(false); const rowPage = ref(1);
const fileInput = ref<HTMLInputElement | null>(null);
const currentStep = computed(() => batch.value && ['queued', 'succeeded', 'failed'].includes(batch.value.status) ? 3 : file.value || batch.value ? 2 : 1);
const history = ref<Awaited<ReturnType<typeof api.recent>>['data']>([]); let generation = 0; let timer: ReturnType<typeof setTimeout> | undefined; let key = ''; let completedId = '';
let lifetime = 0; let historyRequest = 0;
const historyLoading = ref(false); const historyLoaded = ref(false); const historyError = ref(''); const historyNotice = ref('');
const accessBlocked = ref(false);
const batchLoading = ref(false);
const batchNotice = ref('');
const rows = computed(() => batch.value?.rows.slice((rowPage.value - 1) * 20, rowPage.value * 20) ?? []);
const labels = { create: '新增', update: '更新', skip: '已有跳过', unchanged: '无变化', error: '错误' };
const reasons: Record<string, string> = { invalid_email: '邮箱不符合允许格式或域名', invalid_name: '姓名超长或含控制字符', name_required: '新增人员必须填写姓名', account_deleted: '账号已删除，需超管恢复', cross_department: '跨部门冲突，不自动调动', duplicate_email: '文件内邮箱重复', invalid_date: '日期应为YYYY-MM-DD', invalid_date_range: '资格结束日期早于生效时间', invalid_qualification: '资格值应为有效、未纳入或待确认', qualification_required_for_dates: '填写日期时必须明确资格状态', formula_not_allowed: '不接受公式单元格', formula_like_value: '不接受公式内容', invalid_cell: '单元格类型不支持', cell_too_long: '单元格内容过长', preview_stale: '人员或组织已变化，整批未提交，请重新预览', job_authorization_changed: '导入人权限已变化，整批未提交', forbidden: '管理授权已变化，整批未提交', preview_expired: '预览已过期，整批未提交' };
function cancelPolling() { clearTimeout(timer); timer = undefined; }
function denied(reason: unknown) { return reason instanceof ApiFailure && ([401,403].includes(reason.status) || reason.code === 'recovery_quarantined'); }
function withdraw(reason: unknown) {
  generation++; lifetime++; historyRequest++; cancelPolling(); accessBlocked.value = true;
  batch.value = null; file.value = null; key = ''; busy.value = false; batchLoading.value = false; batchNotice.value = ''; rowPage.value = 1;
  if (fileInput.value) fileInput.value.value = '';
  history.value = []; historyLoaded.value = false; historyLoading.value = false; historyError.value = ''; historyNotice.value = '';
  error.value = reason instanceof Error ? reason.message : '导入已不可访问';
}
async function refreshHistory() {
  if (!open.value) return; const current = ++historyRequest, epoch = lifetime, department = props.departmentId;
  const valid = () => open.value && epoch === lifetime && current === historyRequest && department === props.departmentId;
  historyLoading.value = true; historyError.value = ''; historyNotice.value = '';
  try { const result = await api.recent(department); if (valid()) { history.value = result.data; historyLoaded.value = true; accessBlocked.value = false; } }
  catch (reason) {
    if (valid()) {
      if (denied(reason)) withdraw(reason);
      else {
        historyError.value = reason instanceof Error ? reason.message : '无法读取导入历史';
        if (isTransientReadFailure(reason) && historyLoaded.value) historyNotice.value = '刷新失败，当前显示上次导入历史。';
        else { history.value = []; historyLoaded.value = false; }
      }
    }
  }
  finally { if (valid()) historyLoading.value = false; }
}
async function inspect() {
  if (!file.value || accessBlocked.value || !open.value) return; const current = ++generation; cancelPolling(); busy.value = true; error.value = ''; batchNotice.value = ''; batch.value = null; rowPage.value = 1; key = '';
  try { key = createOperationKey(); const result = await api.preview(props.departmentId, mode.value, file.value); if (current === generation) { batch.value = result.data; void refreshHistory(); } }
  catch (reason) { if (current === generation) { if (denied(reason)) withdraw(reason); else error.value = reason instanceof Error ? reason.message : '预览失败'; } }
  finally { if (current === generation) busy.value = false; }
}
function choose(event: Event) { file.value = (event.target as HTMLInputElement).files?.[0] ?? null; void inspect(); }
async function poll(id: string, current: number) {
  if (!open.value || current !== generation) return;
  batchLoading.value = true;
  try {
    const result = await api.get(id); if (current !== generation) return; batch.value = result.data; mode.value = result.data.mode; batchNotice.value = '';
    rowPage.value = Math.min(rowPage.value, Math.max(1, Math.ceil(result.data.rows.length / 20)));
    batchLoading.value = false;
    if (result.data.status === 'queued') timer = setTimeout(() => { void poll(id, current); }, 600);
    else {
      if (result.data.status === 'succeeded' && completedId !== id) { completedId = id; emit('completed'); }
      void refreshHistory();
    }
  } catch (reason) {
    if (current === generation) {
      if (denied(reason)) withdraw(reason);
      else {
        error.value = reason instanceof Error ? reason.message : '任务查询失败，请重新打开导入记录';
        if (isTransientReadFailure(reason) && batch.value) batchNotice.value = '任务刷新失败，当前显示上次任务结果。';
        else { batch.value = null; batchNotice.value = ''; rowPage.value = 1; }
      }
    }
  }
  finally { if (current === generation) batchLoading.value = false; }
}
async function commit() {
  if (!open.value || accessBlocked.value || batchLoading.value || !batch.value || !batch.value.can_submit || batch.value.status !== 'previewed' || busy.value) return; const current = generation; busy.value = true; error.value = '';
  try { await api.submit(batch.value, key || (key = createOperationKey())); if (current === generation) { batch.value.status = 'queued'; void poll(batch.value.id, current); } }
  catch (reason) { if (current === generation) { if (denied(reason)) withdraw(reason); else error.value = reason instanceof Error ? reason.message : '提交失败'; } }
  finally { if (current === generation) busy.value = false; }
}
async function view(id: string) {
  if (accessBlocked.value || busy.value) return; file.value = null; const current = ++generation; cancelPolling(); error.value = ''; batchNotice.value = '';
  if (batch.value?.id !== id) { batch.value = null; rowPage.value = 1; key = ''; }
  await poll(id, current);
}
watch(mode, () => { if (file.value) void inspect(); });
watch(() => [open.value, props.departmentId] as const, () => { generation++; lifetime++; historyRequest++; history.value = []; historyLoaded.value = false; historyLoading.value = false; historyError.value = ''; historyNotice.value = ''; cancelPolling(); file.value = null; batch.value = null; batchNotice.value = ''; error.value = ''; busy.value = false; batchLoading.value = false; accessBlocked.value = false; rowPage.value = 1; key = ''; if (open.value) void refreshHistory(); });
onBeforeUnmount(() => { generation++; lifetime++; historyRequest++; cancelPolling(); });
</script>
<template>
  <ElDialog
    v-model="open"
    align-center
    title="批量导入成员"
    width="900px"
    destroy-on-close
    :close-on-click-modal="false"
  >
    <ol
      class="import-steps"
      aria-label="导入进度"
    >
      <li
        v-for="(step, index) in ['选择文件', '预览与修正', '整批提交']"
        :key="step"
        :aria-current="currentStep === index + 1 ? 'step' : undefined"
        :class="{ completed: currentStep > index + 1 }"
      >
        <span class="import-step-number">{{ index + 1 }}</span>{{ step }}
      </li>
    </ol>
    <p class="small-text muted">
      支持.xlsx和UTF-8 CSV，最大5MiB、2000行。空白不覆盖、表外人员不删除、跨部门不自动调动。
    </p>
    <ElAlert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
      class="page-notice"
    />
    <p
      v-if="batchNotice"
      role="status"
    >
      {{ batchNotice }}
    </p>
    <div class="import-controls">
      <div class="import-file">
        <span>上传成员文件</span>
        <div class="import-file-action">
          <ElButton
            :disabled="busy || batchLoading || accessBlocked"
            @click="fileInput?.click()"
          >
            {{ file ? '重新选择文件' : '选择文件' }}
          </ElButton>
          <span
            class="small-text muted"
            aria-live="polite"
          >{{ file?.name ?? '尚未选择文件' }}</span>
        </div>
        <input
          ref="fileInput"
          hidden
          type="file"
          aria-label="选择成员文件"
          accept=".xlsx,.csv"
          @change="choose"
        >
      </div><a
        v-if="!accessBlocked"
        :href="`/api/v1/member-imports/template?department_id=${departmentId}`"
        class="text-link"
      >下载当前部门模板</a>
    </div>
    <div class="import-controls">
      <span>导入模式</span><div
        role="radiogroup"
        aria-label="导入模式"
      >
        <ElButton
          :type="mode === 'insert_only' ? 'primary' : 'default'"
          role="radio"
          :aria-checked="mode === 'insert_only'"
          :disabled="busy || batchLoading || accessBlocked"
          @click="mode = 'insert_only'"
        >
          仅新增（默认）
        </ElButton><ElButton
          :type="mode === 'upsert' ? 'primary' : 'default'"
          role="radio"
          :aria-checked="mode === 'upsert'"
          :disabled="busy || batchLoading || accessBlocked"
          @click="mode = 'upsert'"
        >
          新增并更新基础资料
        </ElButton>
      </div><span
        v-if="busy || batchLoading"
        role="status"
      >处理中…</span>
    </div>
    <template v-if="batch">
      <div class="import-controls">
        <ElTag
          v-for="kind in (['create', 'update', 'skip', 'unchanged', 'error'] as const)"
          :key="kind"
          :type="kind === 'error' && batch.counts.error ? 'danger' : kind === 'create' ? 'success' : 'info'"
        >
          {{ labels[kind] }} {{ batch.counts[kind] }}
        </ElTag>
      </div>
      <ElAlert
        v-if="batch.status === 'queued'"
        title="已提交，正在后台处理；关闭后可从最近导入记录继续查看。"
        type="info"
        :closable="false"
      />
      <ElAlert
        v-if="batch.status === 'succeeded'"
        title="整批导入成功"
        type="success"
        :closable="false"
      />
      <ElAlert
        v-if="batch.status === 'failed'"
        :title="reasons[batch.job?.error_code ?? ''] ?? '整批导入失败，未提交人员修改。请重新预览或联系管理员。'"
        type="error"
        :closable="false"
      />
      <ElTable
        :data="rows"
        max-height="320"
      >
        <ElTableColumn
          prop="row"
          label="行"
          width="55"
        /><ElTableColumn
          prop="email"
          label="工作邮箱"
          min-width="220"
        /><ElTableColumn
          label="姓名"
          min-width="130"
        >
          <template #default="{ row }">
            <s
              v-if="row.changes.includes('display_name')"
              class="muted"
            >{{ row.before?.display_name }}</s><span>{{ row.display_name ?? row.before?.display_name ?? '—' }}</span>
          </template>
        </ElTableColumn><ElTableColumn
          label="预览"
          min-width="260"
        >
          <template #default="{ row }">
            <span :class="{ 'error-text': row.action === 'error' }">{{ labels[row.action as keyof typeof labels] }}</span><small
              v-for="reason in row.errors"
              :key="reason"
              class="secondary error-text"
            >{{ reasons[reason] ?? reason }}</small><small
              v-if="row.changes.includes('department')"
              class="secondary"
            >关联已有未分配账号到当前部门</small><small
              v-if="row.changes.includes('eligibility')"
              class="secondary"
            >更新资格有效期</small>
          </template>
        </ElTableColumn>
      </ElTable>
      <div class="table-pager">
        <span>{{ batch.rows.length }} 行 · 预览第 {{ rowPage }} 页</span><div>
          <ElButton
            :disabled="rowPage <= 1"
            @click="rowPage--"
          >
            上一页
          </ElButton><ElButton
            :disabled="rowPage * 20 >= batch.rows.length"
            @click="rowPage++"
          >
            下一页
          </ElButton>
        </div>
      </div>
    </template>
    <section
      class="import-history"
    >
      <h3>最近导入记录</h3>
      <ElButton
        :loading="historyLoading"
        @click="refreshHistory"
      >
        刷新导入记录
      </ElButton>
      <ElAlert
        v-if="historyError"
        :title="historyError"
        type="error"
        :closable="false"
      />
      <p
        v-if="historyNotice"
        role="status"
      >
        {{ historyNotice }}
      </p>
      <p
        v-if="!historyLoaded"
        class="muted"
      >
        {{ historyLoading ? '正在读取导入历史…' : '导入历史尚未读取。' }}
      </p>
      <p
        v-else-if="!history.length"
        class="muted"
      >
        没有最近导入记录。
      </p>
      <div
        v-for="item in history"
        :key="item.id"
        class="history-row"
      >
        <span>{{ item.source_name }}</span><span>{{ item.status === 'succeeded' ? '成功' : item.status === 'failed' ? '失败' : item.status === 'queued' ? '处理中' : '待提交' }}</span><ElButton
          link
          :disabled="busy || accessBlocked"
          @click="view(item.id)"
        >
          查看
        </ElButton>
      </div>
    </section>
    <template #footer>
      <ElButton @click="open = false">
        {{ batch?.status === 'queued' ? '后台继续' : '关闭' }}
      </ElButton><ElButton
        type="primary"
        :loading="busy"
        :disabled="accessBlocked || batchLoading || !batch || !batch.can_submit || batch.status !== 'previewed'"
        @click="commit"
      >
        确认整批导入
      </ElButton>
    </template>
  </ElDialog>
</template>
