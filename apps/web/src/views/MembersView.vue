<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessageBox } from 'element-plus';
import type { MemberDto, MemberPage } from '@adi/contracts';
import { useSession } from '../stores/session.js';
import { useDirectory } from '../composables/directory.js';
import * as api from '../api/organization.js';
import { ApiFailure } from '../api/http.js';
import AdoptionPanel from '../components/AdoptionPanel.vue';
import AccountActions from '../components/AccountActions.vue';
import MemberImportDialog from '../components/MemberImportDialog.vue';
const route = useRoute(); const router = useRouter(); const session = useSession(); const directory = useDirectory();
const departmentId = computed(() => route.params.departmentId === 'all' ? undefined : String(route.params.departmentId));
const globalManager = computed(() => session.user?.roles.some(role => ['super', 'anc_admin'].includes(role)));
const roleNames = { super: '系统超级管理员', anc_admin: '组织管理员', department_admin: '一级部门管理员', employee: '普通员工' };
const showImport = ref(false); const revision=ref(0);
const adoptionFilter=computed(()=>['pending','adopted','unregistered'].includes(String(route.query.adoption))?String(route.query.adoption) as 'pending'|'adopted'|'unregistered':undefined);
const statusFilter=computed(()=>['active','suspended','deleted'].includes(String(route.query.status))?String(route.query.status) as 'active'|'suspended'|'deleted':undefined);
function clearFilters(){void router.replace({path:route.path,query:{}});}
async function accountUpdated() { const currentScope = scope; await Promise.all([load(), directory.refresh()]); if (currentScope === scope) revision.value++; }
const search = ref(''); const appliedSearch = ref(''); const page = ref(0); const cursors = ref<(string | undefined)[]>([undefined]);
const data = ref<MemberPage>({ items: [], total: 0, has_more: false, next_cursor: null }); const readBusy = ref(false); const writeBusy = ref(false); const busy = computed(() => readBusy.value || writeBusy.value); const error = ref(''); let generation = 0; let scope = 0;
const hasResult = ref(false); const notice = ref('');
const dialog = ref(false); const edited = ref<MemberDto | null>(null); const displayName = ref(''); const email = ref(''); const attachExisting = ref(false);
const moving = ref<MemberDto | null>(null); const showTransfer = ref(false); const targetDepartment = ref(''); const scheduled = ref(false); const effectiveLocal = ref('');
const formatTime = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
function withdrawMembers() {
  generation++; scope++; readBusy.value = false; writeBusy.value = false;
  data.value = { items: [], total: 0, has_more: false, next_cursor: null }; hasResult.value = false; page.value = 0; cursors.value = [undefined]; notice.value = '';
  dialog.value = false; showTransfer.value = false; showImport.value = false; edited.value = null; moving.value = null; displayName.value = ''; email.value = ''; targetDepartment.value = ''; effectiveLocal.value = '';
}
async function writeFailed(reason: unknown, fallback: string, currentScope: number) {
  if (currentScope !== scope) return; error.value = reason instanceof Error ? reason.message : fallback;
  if (reason instanceof ApiFailure && ([401,403].includes(reason.status) || reason.code === 'recovery_quarantined')) {
    withdrawMembers();
    if (reason.status === 401) { await session.refresh(); if (!session.user) await router.replace('/login'); }
  }
}
async function load(targetPage = page.value) {
  const current = ++generation; readBusy.value = true; error.value = ''; notice.value = '';
  const department = departmentId.value, input = { limit: 8, search: appliedSearch.value, ...(adoptionFilter.value?{adoption:adoptionFilter.value}:{}),...(statusFilter.value?{status:statusFilter.value}:{}) };
  let cursor = cursors.value[targetPage], recovered = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await api.members(department, { ...input, ...(cursor ? { cursor } : {}) });
        if (current !== generation) return;
        if (!recovered && cursor && result.data.items.length === 0) {
          recovered = true; cursor = undefined; targetPage = 0; page.value = 0; cursors.value = [undefined];
          data.value = { items: [], total: 0, has_more: false, next_cursor: null }; hasResult.value = false;
          notice.value = '当前成员页已无结果，正在重新读取第一页。';
          continue;
        }
        data.value = result.data; hasResult.value = true; page.value = targetPage;
        if (recovered) notice.value = '成员分页已更新，已恢复第一页。';
        return;
      } catch (reason) {
        if (current !== generation) return;
        if (!recovered && cursor && reason instanceof ApiFailure && reason.code === 'invalid_cursor') {
          recovered = true; cursor = undefined; targetPage = 0; page.value = 0; cursors.value = [undefined];
          data.value = { items: [], total: 0, has_more: false, next_cursor: null }; hasResult.value = false;
          notice.value = '成员分页已失效，正在重新读取第一页。';
        } else throw reason;
      }
    }
  }
  catch (reason) {
    if (current !== generation) return;
    error.value = reason instanceof Error ? reason.message : '查询失败';
    if (reason instanceof ApiFailure && ([401,403,404,410].includes(reason.status) || reason.code === 'recovery_quarantined')) {
      withdrawMembers();
      if (reason.status === 401) { await session.refresh(); if (!session.user) await router.replace('/login'); }
    } else if (hasResult.value) notice.value = '刷新失败，当前显示上次结果。';
  }
  finally { if (current === generation) readBusy.value = false; }
}
function query() {
  appliedSearch.value = search.value; page.value = 0; cursors.value = [undefined];
  data.value = { items: [], total: 0, has_more: false, next_cursor: null }; hasResult.value = false;
  return load();
}
watch(()=>[departmentId.value,adoptionFilter.value,statusFilter.value], () => {
  scope++; writeBusy.value = false;
  search.value = ''; dialog.value = false; showTransfer.value = false; showImport.value = false; edited.value = null; moving.value = null;
  void query();
}, { immediate: true, flush: 'sync' });
onBeforeUnmount(() => { generation++; scope++; });
function next() { if (busy.value || !data.value.next_cursor) return; cursors.value[page.value + 1] = data.value.next_cursor; void load(page.value + 1); }
function previous() { if (!busy.value && page.value) void load(page.value - 1); }
function open(member?: MemberDto) { edited.value = member ?? null; displayName.value = member?.display_name ?? ''; email.value = member?.email ?? ''; attachExisting.value = false; error.value = ''; dialog.value = true; }
async function save() {
  const id = edited.value?.department_id ?? departmentId.value; if (!id || writeBusy.value) return;
  const currentScope = scope; writeBusy.value = true; error.value = '';
  try {
    if (edited.value) await api.updateMember(id, edited.value.user_id, { version: edited.value.version, display_name: displayName.value });
    else await api.addMember(id, { email: email.value.trim(), ...(attachExisting.value ? { attach_existing: true } : { display_name: displayName.value }) });
    if (currentScope !== scope) return;
    dialog.value = false; await accountUpdated();
  } catch (reason) { await writeFailed(reason, '保存失败', currentScope); } finally { if (currentScope === scope) writeBusy.value = false; }
}
async function remove(member: MemberDto) {
  if (!member.department_id || writeBusy.value) return; const currentScope = scope;
  try { await ElMessageBox.confirm(`将“${member.display_name}”移出当前部门？账号与历史使用记录会保留。`, '移除成员', { confirmButtonText: '确认移除', cancelButtonText: '取消', type: 'warning', confirmButtonClass: 'danger-confirm' }); } catch { return; }
  if (currentScope !== scope || writeBusy.value) return; writeBusy.value = true; error.value = '';
  try { await api.removeMember(member.department_id, member.user_id, member.version); if (currentScope === scope) await accountUpdated(); } catch (reason) { await writeFailed(reason, '移除失败', currentScope); } finally { if (currentScope === scope) writeBusy.value = false; }
}
function move(member: MemberDto) { moving.value = member; targetDepartment.value = ''; scheduled.value = false; effectiveLocal.value = ''; error.value = ''; showTransfer.value = true; }
async function saveTransfer() {
  if (!moving.value || !targetDepartment.value || writeBusy.value) return;
  if (scheduled.value && !effectiveLocal.value) { error.value = '请选择生效时间（北京时间）'; return; }
  const currentScope = scope; writeBusy.value = true; error.value = '';
  try {
    await api.transferMember(moving.value.user_id, { version: moving.value.version, target_department_id: targetDepartment.value, ...(scheduled.value ? { effective_at: new Date(`${effectiveLocal.value}+08:00`).toISOString() } : {}) });
    if (currentScope !== scope) return;
    showTransfer.value = false; await accountUpdated();
  } catch (reason) { await writeFailed(reason, '调动失败', currentScope); } finally { if (currentScope === scope) writeBusy.value = false; }
}
async function cancelMove(member: MemberDto) {
  if (writeBusy.value) return; const currentScope = scope;
  try { await ElMessageBox.confirm(`取消“${member.display_name}”的待生效调动？`, '取消调动', { confirmButtonText: '确认取消', cancelButtonText: '返回' }); } catch { return; }
  if (currentScope !== scope || writeBusy.value) return; writeBusy.value = true; error.value = '';
  try { await api.cancelTransfer(member.user_id, member.version); if (currentScope === scope) await accountUpdated(); } catch (reason) { await writeFailed(reason, '取消失败', currentScope); } finally { if (currentScope === scope) writeBusy.value = false; }
}
</script>
<template>
  <p
    v-if="adoptionFilter||statusFilter"
    class="page-notice"
  >
    当前筛选：{{ adoptionFilter==='pending'?'待采纳':adoptionFilter==='adopted'?'已采纳':adoptionFilter==='unregistered'?'未完成注册':'' }} {{ statusFilter==='suspended'?'已停用':statusFilter==='deleted'?'已逻辑删除':statusFilter==='active'?'正常':'' }} <ElButton
      link
      @click="clearFilters"
    >
      清除筛选
    </ElButton>
  </p>
  <div class="page-heading">
    <div><h1>{{ globalManager ? '组织与成员' : '部门成员管理' }}</h1><p>通过界面或模板维护人员，保持邮箱唯一与历史组织归属。</p></div><ElButton
      :loading="busy"
      @click="load()"
    >
      刷新
    </ElButton>
  </div>
  <AdoptionPanel
    :department-id="departmentId"
    :revision="revision"
    manage
  />
  <div class="page-toolbar">
    <div class="search-row">
      <ElInput
        v-model="search"
        aria-label="搜索成员"
        placeholder="搜索姓名或工作邮箱"
        clearable
        @keyup.enter="query"
      /><ElButton @click="query">
        查询
      </ElButton>
    </div><div
      v-if="departmentId"
      class="member-toolbar-actions"
    >
      <a
        :href="`/api/v1/member-imports/template?department_id=${departmentId}`"
        class="text-link"
      >下载模板</a><ElButton @click="showImport = true">
        批量导入
      </ElButton><ElButton
        v-if="departmentId"
        type="primary"
        :disabled="busy"
        @click="open()"
      >
        添加成员
      </ElButton>
    </div><span
      v-else
      class="muted"
    >选择左侧一级部门后，可添加或导入成员</span>
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
  <ElAlert
    :title="globalManager ? '可维护全部部门成员。成员关系与管理授权分别维护；密码和账号全局操作仅限超级管理员。' : '仅可维护获授权部门。跨部门调动由 组织 或超级管理员完成，不提供他人原文。'"
    type="info"
    :closable="false"
    class="page-notice"
  />
  <section class="data-panel">
    <ElTable
      row-key="user_id"
      :data="data.items"
      :empty-text="hasResult ? '暂无成员，可通过表单添加。' : busy ? '正在读取成员…' : '成员尚未加载。'"
    >
      <ElTableColumn
        label="姓名 / 工作邮箱"
        min-width="230"
      >
        <template #default="{ row }">
          {{ row.display_name }}<small class="secondary">{{ row.email }}</small><small
            v-if="row.primary_role"
            class="secondary"
          >{{ roleNames[row.primary_role as keyof typeof roleNames] }}</small>
        </template>
      </ElTableColumn>
      <ElTableColumn
        label="归属部门"
        min-width="140"
      >
        <template #default="{ row }">
          {{ row.department_name ?? '未分配' }}
          <small
            v-if="row.scheduled_transfer"
            class="secondary"
          >{{ formatTime(row.scheduled_transfer.effective_at) }} 起调入 {{ row.scheduled_transfer.department_name }}</small>
        </template>
      </ElTableColumn>
      <ElTableColumn
        label="账号 / 采集"
        min-width="190"
      >
        <template #default="{ row }">
          <ElTag :type="row.status === 'active' ? 'success' : 'warning'">
            {{ row.status === 'active' ? '启用' : row.status === 'suspended' ? '已停用' : '已删除' }}
          </ElTag><small class="secondary">{{ row.status === 'active' ? '允许接收新增事件' : '停止新增采集 · 历史保留' }}<span
            v-if="row.status!=='active'&&row.status_since"
            class="secondary"
          >{{ formatTime(row.status_since) }} · 持续 {{ Math.max(0,Math.floor((Date.now()-Date.parse(row.status_since))/86400000)) }} 天 · {{ row.status_actor||'未记录操作人' }} · {{ row.status_reason||'未记录原因' }}</span></small>
        </template>
      </ElTableColumn>
      <ElTableColumn
        label="采纳状态"
        min-width="130"
      >
        <template #default="{ row }">
          {{ !row.registered_at ? '未完成注册' : row.adopted_at ? '已采纳' : '待采纳' }}
        </template>
      </ElTableColumn>
      <ElTableColumn
        label="操作"
        width="170"
      >
        <template #default="{ row }">
          <ElButton
            link
            :disabled="!row.department_id || busy || row.status === 'deleted'"
            @click="open(row)"
          >
            编辑
          </ElButton>
          <ElDropdown trigger="click">
            <ElButton
              link
              :disabled="busy"
              aria-label="更多"
            >
              更多 <span aria-hidden="true">⌄</span>
            </ElButton>
            <template #dropdown>
              <ElDropdownMenu>
                <ElDropdownItem
                  class="danger-action"
                  :disabled="!row.department_id"
                  @click="remove(row)"
                >
                  移除成员
                </ElDropdownItem>
                <ElDropdownItem
                  v-if="globalManager && !row.scheduled_transfer"
                  :disabled="row.status === 'deleted'"
                  @click="move(row)"
                >
                  跨部门调动
                </ElDropdownItem>
                <ElDropdownItem
                  v-if="globalManager && row.scheduled_transfer"
                  @click="cancelMove(row)"
                >
                  取消待生效调动
                </ElDropdownItem>
                <AccountActions
                  v-if="session.user?.roles.includes('super')"
                  :member="row"
                  @updated="accountUpdated"
                />
              </ElDropdownMenu>
            </template>
          </ElDropdown>
        </template>
      </ElTableColumn>
    </ElTable><div class="table-pager">
      <span>共 {{ data.total }} 项 · 第 {{ page + 1 }} 页</span><div>
        <ElButton
          :disabled="!page || busy"
          @click="previous"
        >
          上一页
        </ElButton><ElButton
          :disabled="!data.has_more || busy"
          @click="next"
        >
          下一页
        </ElButton>
      </div>
    </div>
  </section>
  <ElDialog
    v-model="dialog"
    align-center
    :title="edited ? '编辑成员' : '添加成员'"
    width="500px"
    destroy-on-close
    :close-on-click-modal="!busy"
    :close-on-press-escape="!busy"
    :show-close="!busy"
  >
    <ElAlert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
    />
    <ElForm
      label-position="top"
      @submit.prevent="save"
    >
      <ElFormItem
        v-if="edited || !attachExisting"
        label="姓名"
        :required="!!edited || !attachExisting"
      >
        <ElInput
          v-model="displayName"
          aria-label="姓名"
          maxlength="128"
          :disabled="!edited && attachExisting"
          :required="!!edited || !attachExisting"
        />
      </ElFormItem><ElFormItem
        label="工作邮箱"
        required
      >
        <ElInput
          v-model="email"
          aria-label="工作邮箱"
          type="email"
          :disabled="!!edited"
          required
        />
      </ElFormItem>
      <ElCheckbox
        v-if="!edited"
        v-model="attachExisting"
      >
        关联已有的未分配账号（保留原资料与历史）
      </ElCheckbox>
      <p
        v-if="!edited && attachExisting"
        class="field-help"
      >
        姓名与部门将沿用已有账号资料，无需重复填写。
      </p>
    </ElForm><p class="muted small-text">
      邮箱是唯一身份标识；修改邮箱或恢复已删除账号请联系超级管理员。
    </p>
    <template #footer>
      <ElButton
        :disabled="busy"
        @click="dialog = false"
      >
        取消
      </ElButton><ElButton
        type="primary"
        :loading="busy"
        :disabled="(!attachExisting && !displayName.trim()) || !email.trim()"
        @click="save"
      >
        保存
      </ElButton>
    </template>
  </ElDialog>
  <ElDialog
    v-model="showTransfer"
    align-center
    title="跨部门调动"
    width="520px"
    destroy-on-close
    :close-on-click-modal="!busy"
    :show-close="!busy"
  >
    <p>{{ moving?.display_name }} · 当前 {{ moving?.department_name ?? '未分配' }}</p>
    <ElAlert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
    />
    <ElForm label-position="top">
      <ElFormItem
        label="调入部门"
        required
      >
        <ElSelect
          v-model="targetDepartment"
          aria-label="调入部门"
          placeholder="请选择调入部门"
          no-data-text="暂无其他可调入部门"
          class="full-width"
        >
          <ElOption
            v-for="item in directory.items.value.filter(item => item.id !== moving?.department_id)"
            :key="item.id"
            :label="item.name"
            :value="item.id"
          />
        </ElSelect>
      </ElFormItem>
      <ElCheckbox v-model="scheduled">
        指定未来生效时间
      </ElCheckbox><ElFormItem
        v-if="scheduled"
        label="生效时间（北京时间）"
        required
      >
        <ElInput
          v-model="effectiveLocal"
          type="datetime-local"
          aria-label="生效时间（北京时间）"
          required
        />
      </ElFormItem>
    </ElForm><p class="small-text muted">
      默认立即生效。历史归属和使用记录不会被普通调岗改写；待生效计划可取消。
    </p>
    <template #footer>
      <ElButton
        :disabled="busy"
        @click="showTransfer = false"
      >
        取消
      </ElButton><ElButton
        type="primary"
        :loading="busy"
        :disabled="!targetDepartment"
        @click="saveTransfer"
      >
        确认调动
      </ElButton>
    </template>
  </ElDialog>
  <MemberImportDialog
    v-if="departmentId"
    v-model="showImport"
    :department-id="departmentId"
    @completed="accountUpdated"
  />
</template>
