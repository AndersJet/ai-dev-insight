<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppLayout from '../layouts/AppLayout.vue';
import PluginDownload from '../components/PluginDownload.vue';
import { useSession } from '../stores/session.js';
import { safeReturnPath } from '../router/access.js';
const session = useSession(); const route = useRoute(); const router = useRouter();
const changing = computed(() => route.path === '/change-password');
const forced = computed(() => changing.value && session.user?.must_change_password === true);
const email = ref(''); const password = ref(''); const nextPassword = ref(''); const confirmation = ref(''); const formError = ref('');
const success = ref(false);
let operation:InstanceType<typeof window.AbortController>|undefined;
function clearPasswords(){password.value='';nextPassword.value='';confirmation.value='';}
function leave(){operation?.abort();clearPasswords();formError.value='';success.value=false;}
watch(()=>route.fullPath,leave,{flush:'sync'});onBeforeUnmount(leave);
async function submit() {
  if (session.loading) return;
  formError.value = ''; success.value=false;
  if (changing.value && nextPassword.value !== confirmation.value) { formError.value = '两次输入的新密码不一致'; return; }
  const wasForced = session.user?.must_change_password === true;
  const wasChanging=changing.value, current=new window.AbortController();operation=current;
  try {
    const user = wasChanging ? await session.changePassword(password.value, nextPassword.value,current.signal) : await session.login(email.value.trim(), password.value,current.signal);
    if(current.signal.aborted)return;
    clearPasswords();
    if(wasChanging&&!wasForced&&!(user.registered===false&&!user.roles.includes('super'))){success.value=true;return;}
    const target = safeReturnPath(route.query.redirect, user.default_route);
    await router.replace(user.must_change_password ? { path: '/change-password', query: { redirect: target } } : user.registered===false&&!user.roles.includes('super') ? '/register' : target);
  } catch { /* The store exposes the user-facing error without retaining passwords. */ }
}
</script>
<template>
  <component :is="changing ? 'div' : AppLayout">
    <ElCard
      class="auth-card"
      :class="{'password-card':changing}"
      shadow="never"
    >
      <div class="auth-eyebrow">
        AI DEV INSIGHT
      </div>
      <h1>{{ forced ? '请先设置新密码' : changing ? '修改密码' : '登录工作空间' }}</h1>
      <p>{{ forced ? '当前密码需要更新，完成后继续使用工作空间。' : changing ? '更新用于登录工作空间的密码。' : '使用工作邮箱登录，查看你的 Trae 使用分析。' }}</p>
      <ElAlert
        v-if="success"
        title="密码已修改"
        type="success"
        :closable="false"
      />
      <ElAlert
        v-if="formError || session.error"
        :title="formError || session.error"
        type="error"
        :closable="false"
        show-icon
      />
      <ElForm
        label-position="top"
        class="auth-form"
        @submit.prevent="submit"
      >
        <ElFormItem
          v-if="!changing"
          label="邮箱"
          required
        >
          <ElInput
            v-model="email"
            aria-label="邮箱"
            type="email"
            autocomplete="username"
            maxlength="254"
            required
            placeholder="请输入工作邮箱"
          />
        </ElFormItem>
        <ElFormItem
          :label="changing ? '当前密码' : '密码'"
          required
        >
          <ElInput
            v-model="password"
            :aria-label="changing ? '当前密码' : '密码'"
            type="password"
            autocomplete="current-password"
            maxlength="128"
            required
            show-password
          />
        </ElFormItem>
        <template v-if="changing">
          <ElFormItem
            label="新密码"
            required
          >
            <ElInput
              v-model="nextPassword"
              aria-label="新密码"
              aria-describedby="new-password-help"
              type="password"
              autocomplete="new-password"
              minlength="12"
              maxlength="128"
              required
              show-password
            />
            <p
              id="new-password-help"
              class="field-help"
            >
              请使用 12 至 128 个字符的新密码。
            </p>
          </ElFormItem>
          <ElFormItem
            label="确认新密码"
            required
          >
            <ElInput
              v-model="confirmation"
              aria-label="确认新密码"
              type="password"
              autocomplete="new-password"
              minlength="12"
              maxlength="128"
              required
              show-password
            />
          </ElFormItem>
        </template>
        <ElButton
          class="auth-submit"
          type="primary"
          native-type="submit"
          :loading="session.loading"
        >
          {{ forced ? '保存并继续' : changing ? '保存修改' : '登录' }}
        </ElButton>
      </ElForm>
      <p
        v-if="changing&&!session.user?.must_change_password"
        class="auth-help"
      >
        <RouterLink to="/my/overview">
          返回我的概览
        </RouterLink>
      </p>
      <p
        v-if="!changing"
        class="auth-help"
      >
        <RouterLink to="/register">
          注册工作账号
        </RouterLink>
      </p>
      <PluginDownload v-if="!changing" />
      <p class="auth-help">
        忘记密码或临时密码已过期，请联系系统超级管理员。
      </p>
    </ElCard>
  </component>
</template>
<style scoped>
.password-card { margin: 0; width: 100%; max-width: 560px; }
</style>
