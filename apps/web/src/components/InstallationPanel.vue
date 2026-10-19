<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { CollectionCredentialDto, PluginCredentialStatusDto } from '@adi/contracts';
import * as api from '../api/installations.js';
import { ApiFailure, isTransientReadFailure } from '../api/http.js';
import { useSession } from '../stores/session.js';
import PluginDownload from './PluginDownload.vue';
const props = defineProps<{ ownerId?: string }>();
const session = useSession(), router = useRouter();
const status = ref<PluginCredentialStatusDto | null>(null), legacy = ref<CollectionCredentialDto | null>(null);
const token = ref<string | null>(null), loading = ref(false), busy = ref(false), error = ref(''), notice = ref('');
let generation = 0, readRequest = 0, secretRequest = 0;
const registered = computed(() => session.user?.registered === true);
const scope = () => JSON.stringify([props.ownerId, session.user?.user_id, session.user?.roles, session.user?.registered, session.user?.must_change_password]);
const date = (value?: string | null) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) : '尚未成功上报';
const legacyLabel = computed(() => !legacy.value ? '尚未读取' : legacy.value.installation ? legacy.value.installation.enabled ? '有效' : '已停用' : '暂无共用 Hook 凭据');
function withdraw() { generation++; secretRequest++; readRequest++; token.value = null; status.value = null; legacy.value = null; loading.value = false; busy.value = false; notice.value = ''; }
async function failure(reason: unknown, retained = false) {
  const message = reason instanceof Error ? reason.message : '采集接入信息暂不可用';
  if (!isTransientReadFailure(reason)) withdraw();
  error.value = retained && isTransientReadFailure(reason) ? `刷新失败，当前显示上次接入记录：${message}` : message;
  if (reason instanceof ApiFailure && reason.status === 401) { await session.refresh(); if (!session.user) await router.replace('/login'); }
}
async function load() {
  if (!props.ownerId && (!session.user || !registered.value || session.user.must_change_password)) return;
  const current = generation, request = ++readRequest, key = scope();
  const active = () => current === generation && request === readRequest && key === scope();
  token.value = null; secretRequest++; loading.value = true; error.value = ''; notice.value = '';
  try {
    if (props.ownerId) { const result = await api.collectionCredential(props.ownerId); if (active()) legacy.value = result.data; }
    else { const result = await api.pluginCredentialStatus(); if (active()) status.value = result.data; }
  } catch (reason) { if (active()) await failure(reason, !!(status.value || legacy.value)); }
  finally { if (active()) loading.value = false; }
}
async function obtain(copy = false) {
  if (props.ownerId || busy.value || loading.value || !registered.value || !session.user) return;
  const current = generation, request = ++secretRequest, key = scope();
  const active = () => current === generation && request === secretRequest && key === scope();
  token.value = null; busy.value = true; error.value = ''; notice.value = '';
  try {
    const result = await api.pluginCredential(); if (!active()) return;
    if (result.data.user_id !== session.user.user_id) throw new ApiFailure(403, 'identity_changed', '登录身份已变化，请重新读取');
    if (status.value) status.value = { ...status.value, credential: { created_at: result.data.created_at } };
    if (copy) {
      try {
        if (window.navigator.clipboard?.writeText) await window.navigator.clipboard.writeText(result.data.api_token);
        else {
          const field = window.document.createElement('textarea'), previous = window.document.activeElement;
          field.value = result.data.api_token; field.readOnly = true; field.style.position = 'fixed'; field.style.opacity = '0';
          window.document.body.append(field); field.focus(); field.select();
          try { if (!window.document.execCommand('copy')) throw new Error('copy_unavailable'); }
          finally { field.value = ''; field.remove(); if (previous instanceof window.HTMLElement) previous.focus(); }
        }
        if (active()) notice.value = 'API 码已复制';
      } catch { if (active()) error.value = '浏览器未允许自动复制，请显示 API 码后手动复制。'; }
    }
    else token.value = result.data.api_token;
  } catch (reason) { if (active()) await failure(reason); }
  finally { if (active()) busy.value = false; }
}
function reveal() { if (token.value) { secretRequest++; token.value = null; notice.value = ''; } else void obtain(); }
watch(scope, () => { withdraw(); error.value = ''; void load(); }, { immediate: true, flush: 'sync' });
onBeforeUnmount(withdraw);
</script>
<template>
  <PluginDownload v-if="!ownerId" />
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
  <section
    v-if="ownerId"
    class="data-panel collection-status"
    aria-label="共用 Hook 凭据摘要"
  >
    <h2>共用 Hook 凭据摘要</h2>
    <dl><dt>凭据状态</dt><dd>{{ legacyLabel }}</dd><dt>最近成功上报（北京时间）</dt><dd>{{ date(legacy?.last_seen) }}</dd></dl>
    <p class="muted">
      此处只读本人以外的 Hook 接入摘要。插件 API 码仅由本人正常网页登录后查看；上报时间不代表当前在线。
    </p>
    <ElButton
      :loading="loading"
      @click="load"
    >
      刷新接入摘要
    </ElButton>
  </section>
  <template v-else-if="!registered">
    <ElAlert
      title="请先完成账号注册，再查看采集接入信息。"
      type="info"
      :closable="false"
    />
    <RouterLink to="/register">
      完成账号注册
    </RouterLink>
  </template>
  <template v-else>
    <section
      class="data-panel collection-status"
      aria-labelledby="plugin-credential-heading"
    >
      <div class="page-toolbar">
        <h2 id="plugin-credential-heading">
          账号共用插件 API 码
        </h2><ElButton
          :loading="loading"
          :disabled="busy"
          @click="load"
        >
          刷新采集状态
        </ElButton>
      </div>
      <p class="muted">
        不同电脑共用本人同一枚插件 API 码，每处采集来源分别登记。请从 Trae 插件完成登录绑定与 Hook 自动安装。
      </p>
      <p
        v-if="loading && !status"
        role="status"
      >
        正在读取接入信息…
      </p>
      <template v-else-if="status">
        <p>账号共用码：{{ status.credential ? '已建立' : '尚未领取' }}<span v-if="status.credential"> · 建立于 {{ date(status.credential.created_at) }}</span></p>
        <output
          class="credential-value"
          aria-label="插件 API 码"
        >{{ token ?? '•••••••• •••••••• ••••••••' }}</output>
        <div class="credential-actions">
          <ElButton
            :loading="busy"
            :disabled="loading"
            @click="reveal"
          >
            {{ token ? '隐藏 API 码' : '显示 API 码' }}
          </ElButton><ElButton
            :disabled="loading || busy"
            @click="obtain(true)"
          >
            复制 API 码
          </ElButton>
        </div>
      </template>
    </section>
    <section
      class="data-panel collection-status"
      aria-labelledby="plugin-sources-heading"
    >
      <h2 id="plugin-sources-heading">
        采集来源绑定
      </h2>
      <p class="muted">
        来源记录不等于物理设备，也不代表当前在线。最近成功上报只表示服务端已保存新观测。
      </p>
      <div class="source-table">
        <table>
          <thead><tr><th>采集来源</th><th>系统</th><th>绑定时间（北京时间）</th><th>最近成功上报（北京时间）</th></tr></thead><tbody>
            <tr
              v-for="source in status?.sources ?? []"
              :key="source.collector_id"
            >
              <td class="project-path">
                {{ source.collector_id }}<small>插件 {{ source.plugin_version }}</small>
              </td><td>{{ source.platform === 'windows' ? 'Windows' : source.platform === 'linux' ? 'Linux (SSH)' : 'macOS' }}</td><td>{{ date(source.created_at) }}</td><td>{{ date(source.last_seen) }}</td>
            </tr>
            <tr v-if="!status?.sources.length">
              <td colspan="4">
                {{ loading ? '正在读取来源…' : !status ? '当前来源记录不可用，请重试。' : '暂无采集来源绑定。仅安装插件不会开始仓库采集，请在插件内本人登录绑定。' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </template>
</template>
<style scoped>
.collection-status{padding:20px;margin-top:20px}.collection-status h2{margin-top:0}.collection-status dl{display:grid;grid-template-columns:auto 1fr;gap:12px 24px}.collection-status dd{margin:0}.credential-value{display:block;overflow-wrap:anywhere;padding:16px;background:var(--el-fill-color-light);font-family:var(--ui-font-mono);border-radius:8px}.credential-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:16px}.credential-actions .el-button+.el-button{margin-left:0}.source-table{overflow-x:auto}.source-table table{width:100%;min-width:640px;border-collapse:collapse;text-align:left}.source-table th,.source-table td{padding:16px 12px;border-bottom:1px solid var(--el-border-color);vertical-align:top}.source-table th{color:var(--el-text-color-secondary)}.source-table small{display:block;margin-top:6px;color:var(--el-text-color-secondary)}.project-path{overflow-wrap:anywhere}
</style>
