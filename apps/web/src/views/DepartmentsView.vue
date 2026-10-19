<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessageBox } from 'element-plus';
import type { DepartmentDto, MemberDto } from '@adi/contracts';
import { useDirectory } from '../composables/directory.js';
import UsageMappingDialog from '../components/UsageMappingDialog.vue';
import * as api from '../api/organization.js';
const mappingOpen=ref(false);const mappingDepartment=ref<DepartmentDto|null>(null);
const directory = useDirectory(); const rows = computed(() => directory.items.value);
const error = ref(''); const busy = ref(false); const showName = ref(false); const title = ref(''); const selected = ref<DepartmentDto | null>(null);
const showAdmins = ref(false); const adminIds = ref<string[]>([]); const candidates = ref<MemberDto[]>([]); const candidateSearch = ref('');
function edit(department?: DepartmentDto) { selected.value = department ?? null; title.value = department?.name ?? ''; error.value = ''; showName.value = true; }
async function saveName() {
  busy.value = true; error.value = '';
  try { if (selected.value) await api.renameDepartment(selected.value.id, title.value.trim(), selected.value.version); else await api.createDepartment(title.value.trim()); await directory.refresh(); showName.value = false; }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '保存失败'; } finally { busy.value = false; }
}
async function remove(department: DepartmentDto) {
  try { await ElMessageBox.confirm(`确认删除空部门“${department.name}”？历史归属和使用数据将保留。`, '删除部门', { confirmButtonText: '确认删除', cancelButtonText: '取消', type: 'warning', confirmButtonClass: 'danger-confirm' }); }
  catch { return; }
  busy.value = true; error.value = '';
  try { await api.deleteDepartment(department.id, department.version); await directory.refresh(); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '删除失败'; } finally { busy.value = false; }
}
async function searchCandidates() {
  try { candidates.value = (await api.members(undefined, { limit: 100, search: candidateSearch.value })).data.items.filter(item => item.status === 'active'); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '人员查询失败'; }
}
async function configure(department: DepartmentDto) { selected.value = department; adminIds.value = department.admins.map(item => item.user_id); error.value = ''; candidateSearch.value = ''; showAdmins.value = true; await searchCandidates(); }
async function saveAdmins() {
  if (!selected.value) return; busy.value = true; error.value = '';
  try { await api.setAdmins(selected.value.id, adminIds.value, selected.value.version); showAdmins.value = false; await directory.refresh(); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '配置失败'; } finally { busy.value = false; }
}
</script>
<template>
  <div class="page-heading">
    <div><h1>一级部门配置</h1><p>配置 组织 一级部门，保持成员归属与历史记录清晰。</p></div><ElButton @click="directory.refresh">
      刷新
    </ElButton>
  </div>
  <ElAlert
    v-if="error || directory.error.value"
    :title="error || directory.error.value"
    type="error"
    :closable="false"
    class="page-notice"
  />
  <div class="page-toolbar">
    <span class="muted">{{ rows.length }} 个一级部门</span><ElButton
      type="primary"
      @click="edit()"
    >
      新增部门
    </ElButton>
  </div>
  <section class="data-panel department-panel">
    <table
      class="department-table"
      aria-label="一级部门列表"
    >
      <colgroup>
        <col class="department-name-column">
        <col class="department-count-column">
        <col>
        <col class="department-actions-column">
      </colgroup>
      <thead>
        <tr>
          <th scope="col">
            一级部门 / 编码
          </th><th scope="col">
            成员数
          </th><th scope="col">
            一级部门管理员
          </th><th scope="col">
            操作
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in rows"
          :key="row.id"
        >
          <td>
            <RouterLink
              :to="`/organization-management/${row.id}/members`"
              class="text-link"
            >
              {{ row.name }}
            </RouterLink>
            <small class="secondary">{{ row.id }}</small>
          </td>
          <td>
            {{ row.member_count }}<small
              v-if="row.pending_member_count"
              class="secondary"
            >另有 {{ row.pending_member_count }} 名待调入</small>
          </td>
          <td>
            <div
              v-if="row.admins.length"
              class="department-admins"
            >
              <span
                v-for="person in row.admins"
                :key="person.user_id"
                class="department-admin"
              >{{ person.display_name }}</span>
            </div>
            <span
              v-else
              class="muted"
            >未配置</span>
          </td>
          <td>
            <div class="department-actions">
              <ElButton
                link
                type="primary"
                @click="mappingDepartment = row; mappingOpen = true"
              >
                官方部门关联
              </ElButton>
              <ElButton
                link
                @click="edit(row)"
              >
                重命名
              </ElButton>
              <ElButton
                link
                @click="configure(row)"
              >
                配置管理员
              </ElButton>
              <ElButton
                link
                type="danger"
                :disabled="row.member_count > 0 || row.pending_member_count > 0 || busy"
                @click="remove(row)"
              >
                删除部门
              </ElButton>
            </div>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td
            colspan="4"
            class="department-empty"
          >
            {{ directory.loading.value ? '正在加载部门…' : '暂无部门，请先新增一级部门' }}
          </td>
        </tr>
      </tbody>
    </table>
    <div class="panel-footer">
      部门下有成员时禁止删除，提交时会再次检查；删除不清理历史使用数据。
    </div>
  </section>
  <UsageMappingDialog
    v-model="mappingOpen"
    :department="mappingDepartment"
  />
  <ElDialog
    v-model="showName"
    :title="selected ? '重命名部门' : '新增部门'"
    width="480px"
    align-center
    destroy-on-close
  >
    <p class="dialog-description">
      {{ selected ? '更新部门显示名称，成员归属与历史记录保持不变。' : '创建一级部门，用于管理成员归属与部门使用统计。' }}
    </p>
    <ElAlert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
    />
    <ElForm
      label-position="top"
      @submit.prevent="saveName"
    >
      <ElFormItem
        label="部门名称"
        required
      >
        <ElInput
          v-model="title"
          aria-label="部门名称"
          aria-describedby="department-name-hint"
          placeholder="例如：平台研发部"
          maxlength="128"
          required
        />
        <p
          id="department-name-hint"
          class="dialog-field-hint"
        >
          建议使用清晰、完整的部门名称，最多 128 个字符。
        </p>
      </ElFormItem>
    </ElForm>
    <template #footer>
      <ElButton @click="showName = false">
        取消
      </ElButton><ElButton
        type="primary"
        :loading="busy"
        :disabled="!title.trim()"
        @click="saveName"
      >
        保存
      </ElButton>
    </template>
  </ElDialog>
  <ElDialog
    v-model="showAdmins"
    align-center
    title="配置一级部门管理员"
    width="560px"
    destroy-on-close
  >
    <p>管理授权与人员归属分开，可配置多名管理员。</p><ElAlert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
    />
    <ElForm label-position="top">
      <ElFormItem label="筛选管理员候选人">
        <ElInput
          v-model="candidateSearch"
          aria-label="搜索管理员候选人"
          placeholder="搜索姓名或工作邮箱"
          @input="searchCandidates"
        />
      </ElFormItem>
      <ElFormItem label="已选管理员">
        <ElSelect
          v-model="adminIds"
          multiple
          filterable
          placeholder="选择管理员"
          aria-label="部门管理员"
          class="full-width"
        >
          <ElOption
            v-for="person in candidates"
            :key="person.user_id"
            :label="`${person.display_name} · ${person.email}`"
            :value="person.user_id"
          />
        </ElSelect>
      </ElFormItem>
    </ElForm>
    <template #footer>
      <ElButton @click="showAdmins = false">
        取消
      </ElButton><ElButton
        type="primary"
        :loading="busy"
        @click="saveAdmins"
      >
        保存
      </ElButton>
    </template>
  </ElDialog>
</template>
<style scoped>
/* Native table sizing keeps header/body in one layout without a resize feedback loop. */
.department-panel { overflow-x: auto; }
.department-table { width: 100%; min-width: 800px; table-layout: fixed; border-collapse: collapse; }
.department-name-column { width: 30%; }
.department-count-column { width: 100px; }
.department-actions-column { width: 300px; }
.department-table th, .department-table td { padding: 14px 12px; text-align: left; vertical-align: top; overflow-wrap: anywhere; border-bottom: 1px solid var(--el-border-color-lighter); }
.department-table th { background: var(--el-fill-color-light); color: var(--el-text-color-secondary); font-size: var(--ui-font-small); }
.department-admins { display: flex; flex-wrap: wrap; gap: 4px; }
.department-admin { min-width: 0; max-width: 100%; padding: 2px 6px; border: 1px solid var(--el-border-color); border-radius: 4px; color: var(--el-color-primary); font-size: var(--ui-font-small); overflow-wrap: anywhere; }
.department-actions { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px 12px; }
.department-actions :deep(.el-button + .el-button) { margin-left: 0; }
.department-empty { color: var(--el-text-color-secondary); }
</style>
