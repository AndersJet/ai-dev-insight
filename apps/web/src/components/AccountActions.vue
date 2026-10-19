<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { AccountDto, MemberDto, ResetReason, StatusBody } from '@adi/contracts';
import { useSession } from '../stores/session.js';
import { useDirectory } from '../composables/directory.js';
import * as api from '../api/administration.js';
import { ApiFailure } from '../api/http.js';
import CleanupPanel from './CleanupPanel.vue';
import InstallationPanel from './InstallationPanel.vue';
const props = defineProps<{ member: MemberDto }>(); const emit = defineEmits<{ updated: [] }>();
const session = useSession(); const router = useRouter(); const directory = useDirectory();
const open = ref(false); const mode = ref<'access' | 'status' | 'password' | 'email'>('access'); const account = ref<AccountDto | null>(null);
const installationsOpen = ref(false);const cleanupOpen=ref(false);
const busy = ref(false); const error = ref(''); const role = ref('employee'); const departments = ref<string[]>([]); const note = ref(''); const nextEmail = ref('');
const status = ref<StatusBody['status']>('active'); const resetReason = ref<ResetReason>('forgotten'); const temporaryPassword = ref(''); const completed = ref(false); let generation = 0;
const passwordCopied = ref(false);
function failAccount(reason: unknown, fallback: string) {
  error.value = reason instanceof Error ? reason.message : fallback;
  if (reason instanceof ApiFailure && ([401,403,404,410].includes(reason.status) || reason.code === 'recovery_quarantined')) {
    account.value = null; note.value = ''; nextEmail.value = ''; departments.value = []; temporaryPassword.value = ''; passwordCopied.value = false; completed.value = false;
  }
}
async function copyPassword() {
  const current = generation; const password = temporaryPassword.value;
  if (!password) return;
  try { await navigator.clipboard.writeText(password); if (current === generation && temporaryPassword.value === password) passwordCopied.value = true; }
  catch { if (current === generation) error.value = '剪贴板不可用，请选中临时密码后手动复制。'; }
}
const configurationManaged = computed(() => account.value?.management_source === 'environment');
const destructive = computed(() => mode.value === 'status' && status.value !== 'active');
const confirmLabel = computed(() => mode.value === 'password' ? '生成临时密码' : mode.value === 'status' ? ({ active: '确认恢复', suspended: '确认停用', deleted: '确认删除账号' } as const)[status.value] : mode.value === 'email' ? '确认更正邮箱' : '确认保存');
const title = computed(() => mode.value === 'access' ? '角色与管理范围授权' : mode.value === 'password' ? '发放 / 重置临时密码' : mode.value === 'email' ? '更正邮箱身份' : status.value === 'active' ? '恢复账号' : status.value === 'suspended' ? '停用账号' : '逻辑删除账号');
async function show(next: typeof mode.value, nextStatus?: StatusBody['status']) {
  const current = ++generation; mode.value = next; if (nextStatus) status.value = nextStatus;
  error.value = ''; note.value = ''; temporaryPassword.value = ''; passwordCopied.value = false; completed.value = false; busy.value = true; open.value = true; account.value = null;
  try {
    const result = await api.getAccount(props.member.user_id); if (current !== generation) return;
    account.value = result.data; departments.value = [...result.data.department_ids]; nextEmail.value = result.data.email;
    role.value = result.data.global_roles.includes('super') ? 'super' : result.data.global_roles.includes('anc_admin') ? 'anc_admin' : departments.value.length ? 'department_admin' : 'employee';
    resetReason.value = result.data.credential_state === 'unissued' ? 'initial_issue' : result.data.credential_state === 'expired' ? 'expired' : 'forgotten';
  } catch (reason) { if (current === generation) failAccount(reason, '无法加载账号'); }
  finally { if (current === generation) busy.value = false; }
}
async function save() {
  if (!open.value || !account.value || busy.value || configurationManaged.value) return;
  const current = generation; const target = account.value; const action = mode.value; busy.value = true; error.value = '';
  try {
    if (action === 'access') await api.setAccess(target.id, { version: target.version, global_roles: role.value === 'super' ? ['super'] : role.value === 'anc_admin' ? ['anc_admin'] : [], ...(role.value === 'department_admin' ? { department_ids: departments.value } : role.value === 'employee' ? { department_ids: [] } : {}) });
    if (action === 'status') await api.setStatus(target.id, { version: target.version, status: status.value, reason: note.value });
    if (action === 'email') await api.correctEmail(target.id, { version: target.version, email: nextEmail.value.trim(), verification_note: note.value });
    if (action === 'password') {
      const result = await api.resetPassword(target.id, target.version, resetReason.value);
      if (!open.value || current !== generation) return;
      temporaryPassword.value = result.data.temporary_password; completed.value = true; return;
    }
    if (!open.value || current !== generation) return;
    completed.value = true; open.value = false;
  } catch (reason) { if (open.value && current === generation) failAccount(reason, '操作失败'); } finally { if (current === generation) busy.value = false; }
}
async function closed() {
  if (open.value) return;
  generation++; temporaryPassword.value = '';
  if (!completed.value) return;
  if (account.value?.id === session.user?.user_id) { await session.refresh(); if (!session.user) await router.replace('/login'); }
  emit('updated');
}
onBeforeUnmount(() => { generation++; temporaryPassword.value = ''; });
</script>
<template>
  <ElDropdownItem
    :disabled="member.status !== 'active'"
    @click="show('access')"
  >
    角色与管理范围授权
  </ElDropdownItem>
  <ElDropdownItem
    :class="{ 'danger-action': member.status === 'active' }"
    @click="show('status', member.status === 'active' ? 'suspended' : 'active')"
  >
    {{ member.status === 'active' ? '停用账号' : '恢复账号' }}
  </ElDropdownItem>
  <ElDropdownItem
    :disabled="member.status === 'deleted'"
    @click="show('password')"
  >
    发放 / 重置密码
  </ElDropdownItem>
  <ElDropdownItem @click="show('email')">
    更正邮箱身份
  </ElDropdownItem>
  <ElDropdownItem @click="installationsOpen = true">
    采集安装管理
  </ElDropdownItem>
  <ElDropdownItem
    divided
    class="danger-action"
    @click="cleanupOpen=true"
  >
    清理使用数据
  </ElDropdownItem>
  <ElDialog
    v-model="cleanupOpen"
    title="清理使用数据"
    align-center
    width="min(880px, 92vw)"
    append-to-body
    destroy-on-close
    :close-on-click-modal="false"
    @closed="emit('updated')"
  >
    <CleanupPanel
      v-if="cleanupOpen"
      :user-id="member.user_id"
      :email="member.email"
      :name="member.display_name"
    />
    <template #footer>
      <ElButton @click="cleanupOpen=false">
        关闭
      </ElButton>
    </template>
  </ElDialog>
  <ElDialog
    v-model="installationsOpen"
    align-center
    :title="`${member.display_name} · 采集安装`"
    width="min(1100px, 90vw)"
    destroy-on-close
    append-to-body
    :close-on-click-modal="false"
  >
    <p>{{ member.email }} · 仅查看 Hook 接入摘要；插件 API 码须由本人普通网页登录后查看。</p>
    <InstallationPanel
      v-if="installationsOpen"
      :owner-id="member.user_id"
    />
  </ElDialog>
  <ElDropdownItem
    :disabled="member.status === 'deleted'"
    class="danger-action"
    @click="show('status', 'deleted')"
  >
    逻辑删除账号
  </ElDropdownItem>
  <ElDialog
    v-model="open"
    align-center
    :title="title"
    width="540px"
    destroy-on-close
    :close-on-click-modal="false"
    :close-on-press-escape="!busy && !temporaryPassword"
    :show-close="!busy && !temporaryPassword"
    append-to-body
    @closed="closed"
  >
    <p v-if="account">
      {{ account.display_name }} · {{ account.email }}
    </p><ElAlert
      v-if="error"
      :title="error"
      type="error"
      :closable="false"
    />
    <ElAlert
      v-if="configurationManaged"
      title="此账号由部署配置管理"
      description="登录邮箱、密码与超级管理员身份只能通过部署配置调整，系统内不能改密、重置、停用或删除。人员归属和统计设置仍可正常管理。"
      type="info"
      :closable="false"
      show-icon
    />
    <ElForm
      v-if="account && !configurationManaged"
      label-position="top"
      :disabled="busy"
      @submit.prevent="save"
    >
      <template v-if="mode === 'access'">
        <ElFormItem label="角色">
          <ElSelect
            v-model="role"
            aria-label="角色"
            class="full-width"
          >
            <ElOption
              label="普通员工"
              value="employee"
            /><ElOption
              label="一级部门管理员"
              value="department_admin"
            /><ElOption
              label="组织管理员"
              value="anc_admin"
            /><ElOption
              label="系统超级管理员"
              value="super"
            />
          </ElSelect>
        </ElFormItem>
        <ElFormItem
          v-if="role === 'department_admin'"
          label="管理范围"
        >
          <ElSelect
            v-model="departments"
            multiple
            aria-label="管理范围"
            class="full-width"
          >
            <ElOption
              v-for="department in directory.items.value"
              :key="department.id"
              :label="department.name"
              :value="department.id"
            />
          </ElSelect>
        </ElFormItem>
        <p class="small-text muted">
          人员归属与管理授权分开。权限变更后，目标账号需重新登录。
        </p>
      </template>
      <template v-else-if="mode === 'password'">
        <template v-if="!temporaryPassword">
          <ElFormItem label="发放原因">
            <ElSelect
              v-model="resetReason"
              aria-label="发放原因"
              class="full-width"
            >
              <ElOption
                label="首次发放"
                value="initial_issue"
              /><ElOption
                label="忘记密码"
                value="forgotten"
              /><ElOption
                label="临时密码过期"
                value="expired"
              /><ElOption
                label="安全原因"
                value="security"
              /><ElOption
                label="管理要求"
                value="administrative"
              />
            </ElSelect>
          </ElFormItem><p>生成后旧会话立即失效，临时密码24小时有效，首次登录必须修改。</p>
        </template>
        <template v-else>
          <ElAlert
            title="临时密码仅在此显示一次，请保存后通过公司私密渠道交付。"
            type="warning"
            :closable="false"
          /><ElFormItem label="临时密码">
            <ElInput
              :model-value="temporaryPassword"
              aria-label="临时密码"
              readonly
            />
          </ElFormItem><p v-if="account.id === session.user?.user_id">
            当前会话已失效，保存密码并关闭后请重新登录。
          </p>
        </template>
      </template>
      <template v-else>
        <ElFormItem
          v-if="mode === 'email'"
          label="新工作邮箱"
          required
        >
          <ElInput
            v-model="nextEmail"
            aria-label="新工作邮箱"
            type="email"
            required
          />
        </ElFormItem>
        <ElFormItem
          :label="mode === 'email' ? '身份核验说明' : '操作原因'"
          required
        >
          <ElInput
            v-model="note"
            :aria-label="mode === 'email' ? '身份核验说明' : '操作原因'"
            type="textarea"
            maxlength="500"
            required
          />
        </ElFormItem>
        <p class="small-text muted">
          {{ mode === 'email' ? '确认属于同一员工后更正邮箱；内部身份和原始使用记录保持不变。' : status === 'deleted' ? '逻辑删除会禁止登录和新增采集，取消管理授权，保留账号身份与使用历史。' : status === 'suspended' ? '停用会禁止登录和新增采集，保留历史与管理授权。' : '恢复原账号的登录与采集；已删除账号的管理权限需重新授予。' }}
        </p>
      </template>
    </ElForm>
    <template #footer>
      <ElButton
        v-if="temporaryPassword"
        @click="copyPassword"
      >
        {{ passwordCopied ? '已复制密码' : '复制临时密码' }}
      </ElButton>
      <ElButton
        v-if="!temporaryPassword"
        :disabled="busy"
        @click="open = false"
      >
        取消
      </ElButton><ElButton
        v-if="temporaryPassword"
        type="primary"
        @click="open = false"
      >
        已保存，关闭
      </ElButton><ElButton
        v-else
        :type="destructive ? 'danger' : 'primary'"
        :loading="busy"
        :disabled="configurationManaged || !account || ((mode === 'status' || mode === 'email') && !note.trim()) || (mode === 'access' && role === 'department_admin' && !departments.length)"
        @click="save"
      >
        {{ confirmLabel }}
      </ElButton>
    </template>
  </ElDialog>
</template>
