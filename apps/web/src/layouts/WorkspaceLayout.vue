<script setup lang="ts">
import { computed, onBeforeUnmount, provide, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { DepartmentDto } from '@adi/contracts';
import BrandMark from '../components/BrandMark.vue';
import AppIcon from '../components/AppIcon.vue';
import { manualPath } from '../router/manual.js';
import { useSession } from '../stores/session.js';
import { directoryKey } from '../composables/directory.js';
import { departments } from '../api/organization.js';
import { ApiFailure } from '../api/http.js';
import { useAnalysisPeriod } from '../stores/analysis-period.js';
const route = useRoute(); const router = useRouter(); const session = useSession();
const analysisPeriod = useAnalysisPeriod();
const locked = computed(() => session.user?.must_change_password === true);
function dated(path: string) {
  const [pathname, query = ''] = path.split('?');
  return { path: pathname!, query: { ...Object.fromEntries(new window.URLSearchParams(query)), ...(['/code-flow','/plugin-code-flow'].includes(pathname!) ? {} : analysisPeriod.period ?? {}) } };
}
const items = ref<DepartmentDto[]>([]); const loading = ref(false); const error = ref(''); const search = ref(''); let generation = 0, directoryLoaded = false;
const superAdmin = computed(() => session.user?.roles.includes('super'));
const globalManager = computed(() => superAdmin.value || session.user?.roles.includes('anc_admin'));
const manager = computed(() => globalManager.value || session.user?.roles.includes('department_admin'));
const roleName = computed(() => superAdmin.value ? '系统超级管理员' : session.user?.roles.includes('anc_admin') ? '组织管理员' : manager.value ? '一级部门管理员' : '普通员工');
const group = computed(() => route.path.startsWith('/manual/') ? 'manual' : route.path.startsWith('/organization-management') ? 'manage' : (route.path.startsWith('/organization') || route.path.startsWith('/all') || route.path.startsWith('/code-flow') || route.path.startsWith('/plugin-code-flow')) ? 'org' : route.path.startsWith('/system') ? 'ops' : route.path.startsWith('/history') ? 'history' : 'my');
const nav = computed(() => [
  { key: 'my', label: '我的空间', path: '/my/overview' },
  ...(manager.value ? [{ key: 'org', label: '组织分析', path: globalManager.value ? '/organization' : `/organization/${session.user?.managed_departments[0]?.id ?? ''}` }] : []),
  ...(manager.value ? [{ key: 'manage', label: '组织管理', path: `/organization-management/${globalManager.value ? 'all' : items.value[0]?.id ?? 'all'}/members` }] : []),
  ...(superAdmin.value ? [{ key: 'ops', label: '系统运营', path: '/system/health' }] : []),
  { key: 'history', label: '历史查询', path: '/history' },
]);
const scopedGroup = computed(() => ['org', 'manage'].includes(group.value));
const visibleDepartments = computed(() => items.value.filter(item => item.name.includes(search.value.trim())));
// An omitted optional path parameter is an empty string in Vue Router.
const selected = computed(() => String(route.params.departmentId || route.query.dept || 'all'));
const scopeName = computed(() => selected.value === 'all' ? '全部一级部门' : items.value.find(item => item.id === selected.value)?.name ?? '授权范围');
const organizationFeature = computed(() => route.path.startsWith('/all/') ? 'traces' : route.path.startsWith('/code-flow') ? 'flow' : 'overview');
const organizationFeatures = computed(() => [
  {key:'overview',label:'统计概览',icon:'org'},
  ...(superAdmin.value ? [{key:'traces',label:'Token使用分析',icon:'traces'},{key:'flow',label:'代码流向追踪',icon:'flow'}] : []),
]);
function analysisPath(feature:string,id=selected.value) {
  const encoded=encodeURIComponent(id);
  if(feature==='flow'){
    const query=new window.URLSearchParams({dept:id});
    if(route.path==='/code-flow'){
      if(route.query.source==='plugin')query.set('source','plugin');
      if(typeof route.query.search==='string')query.set('search',route.query.search);
    }
    return `/code-flow?${query}`;
  }
  return feature==='overview' ? id==='all'?'/organization':`/organization/${encoded}` : `/all/sessions?dept=${encoded}`;
}
function departmentPath(id:string) { return group.value==='manage'?`/organization-management/${encodeURIComponent(id)}/members`:analysisPath(organizationFeature.value,id); }
async function refresh() {
  const current = ++generation; error.value = '';
  if (!manager.value || locked.value) { items.value = []; directoryLoaded = false; loading.value=false; return; }
  loading.value = true;
  try { const result = await departments(); if (current === generation) { items.value = result.data; directoryLoaded = true; } }
  catch (reason) {
    if (current !== generation) return;
    error.value = reason instanceof Error ? reason.message : '无法加载部门';
    if (reason instanceof ApiFailure && [401,403,404,410].includes(reason.status)) { items.value = []; directoryLoaded = false; }
    else if (directoryLoaded) error.value += '，当前显示上次结果。';
    if (reason instanceof ApiFailure && reason.status === 401) { await session.refresh(); if (!session.user) await router.replace('/login'); }
  }
  finally { if (current === generation) loading.value = false; }
}
provide(directoryKey, { items, loading, error, refresh });
watch([() => session.user?.user_id, locked], ([id]) => { analysisPeriod.setOwner(id ?? ''); items.value = []; directoryLoaded = false; void refresh(); }, { immediate: true, flush:'sync' });
watch(group, () => { search.value = ''; });
onBeforeUnmount(() => { generation++; });
async function logout() { try { await session.logout(); await router.replace('/login'); } catch { /* Store error is shown below. */ } }
</script>
<template>
  <div class="workspace-shell">
    <header class="workspace-header">
      <BrandMark />
      <nav
        aria-label="一级导航"
        class="workspace-nav"
      >
        <template
          v-for="item in nav"
          :key="item.key"
        >
          <button
            v-if="locked||item.key==='history'"
            type="button"
            disabled
            :aria-label="item.key==='history'?'历史查询 暂未开放':item.label"
          >
            <AppIcon
              :name="item.key"
              :size="16"
            />{{ item.label }}<small v-if="item.key==='history'">暂未开放</small>
          </button>
          <RouterLink
            v-else
            :to="dated(item.path)"
            :class="{ selected: group === item.key }"
          >
            <AppIcon
              :name="item.key"
              :size="16"
            />{{ item.label }}
          </RouterLink>
        </template>
      </nav>
      <div class="workspace-identity">
        <span class="avatar">{{ session.user?.display_name.slice(0, 1) }}</span><span>{{ roleName }}<small>{{ session.user?.email }}</small></span><ElButton
          v-if="!locked"
          link
          @click="router.push(manualPath(session.user?.roles??[]))"
        >
          操作手册
        </ElButton><ElButton
          link
          @click="logout"
        >
          退出登录
        </ElButton>
      </div>
    </header>
    <div class="workspace-body">
      <aside
        aria-label="当前工作区菜单"
        class="workspace-sidebar"
      >
        <div class="side-content">
          <template v-if="locked">
            <div class="side-label">
              账号安全
            </div>
            <span
              class="side-link selected"
              aria-current="page"
            ><AppIcon name="shield" />修改密码</span>
            <p class="side-status muted">
              请先设置新密码，再使用业务功能。
            </p>
          </template>
          <template v-else-if="scopedGroup||route.path==='/plugin-code-flow'">
            <template v-if="group==='org'">
              <div class="side-label">
                分析功能
              </div>
              <RouterLink
                v-for="feature in organizationFeatures"
                :key="feature.key"
                :to="dated(analysisPath(feature.key))"
                class="side-link"
                :class="{selected:organizationFeature===feature.key}"
              >
                <AppIcon :name="feature.icon" />{{ feature.label }}
              </RouterLink>
              <div class="side-divider" />
            </template>
            <template v-if="scopedGroup">
              <div class="side-label">
                {{ group === 'manage' ? '组织与成员' : '部门范围' }}
              </div>
              <RouterLink
                v-if="globalManager"
                :to="dated(departmentPath('all'))"
                class="side-link"
                :class="{ selected: selected === 'all' && !route.path.endsWith('/departments') }"
              >
                <AppIcon name="org" />{{ group==='manage'?'全部部门成员':organizationFeature==='overview'?'组织概览':'全部部门人员' }}
              </RouterLink>
              <div class="side-divider" /><div class="side-label">
                {{ globalManager ? '一级部门' : '我的管理范围' }}<small>一键切换</small>
              </div>
              <ElInput
                v-model="search"
                aria-label="搜索侧栏部门"
                placeholder="搜索部门…"
                clearable
              />
              <p
                v-if="loading"
                class="muted side-status"
              >
                正在加载…
              </p>
              <p
                v-if="error"
                class="side-status error-text"
              >
                {{ error }}
              </p>
              <RouterLink
                v-for="item in visibleDepartments"
                :key="item.id"
                :to="dated(departmentPath(item.id))"
                class="side-link"
                :class="{ selected: selected === item.id }"
              >
                <span class="side-dot" /><span class="side-department-name">{{ item.name }}</span><small v-if="organizationFeature !== 'flow'">{{ item.member_count }}</small>
              </RouterLink>
              <template v-if="group === 'manage' && globalManager">
                <div class="side-divider" /><RouterLink
                  to="/organization-management/departments"
                  class="side-link"
                  :class="{ selected: route.path.endsWith('/departments') }"
                >
                  <AppIcon name="manage" />部门配置
                </RouterLink>
              </template>
            </template>
          </template>
          <template v-else-if="group === 'my'">
            <div class="side-label">
              个人空间
            </div><div class="side-person">
              <b>我的使用复盘</b><small>{{ session.user?.email }}</small>
            </div>
            <RouterLink
              :to="dated('/my/overview')"
              class="side-link"
              :class="{ selected: route.path === '/my/overview' }"
            >
              <AppIcon name="org" />我的概览
            </RouterLink>
            <RouterLink
              :to="dated('/my/sessions')"
              class="side-link"
              :class="{ selected: route.path.startsWith('/my/sessions') }"
            >
              <AppIcon name="traces" />我的Token使用分析
            </RouterLink>
            <div class="side-divider" /><RouterLink
              to="/my/installations"
              class="side-link"
              :class="{ selected: route.path === '/my/installations' }"
            >
              <AppIcon name="install" />采集安装
            </RouterLink><RouterLink
              v-if="session.user?.allowed_actions.includes('self:password')"
              to="/change-password"
              class="side-link"
              :class="{selected:route.path==='/change-password'}"
            >
              <AppIcon name="shield" />修改密码
            </RouterLink>
          </template>
          <template v-else-if="group === 'ops'">
            <div class="side-label">
              平台运行
            </div><RouterLink
              v-for="item in [{ path: 'health', label: '采集健康', icon: 'ops' }, { path: 'usage-sync', label: '出账同步', icon: 'refresh' }, { path: 'retention', label: '数据保留', icon: 'database' }, { path: 'plugin-releases', label: '插件版本管理', icon: 'install' }]"
              :key="item.path"
              :to="`/system/${item.path}`"
              class="side-link"
              :class="{ selected: route.path.endsWith(item.path) }"
            >
              <AppIcon :name="item.icon" />{{ item.label }}
            </RouterLink>
          </template>
          <template v-else-if="group==='manual'">
            <div class="side-label">
              {{ roleName }}手册
            </div><p class="side-status muted">
              按当前角色的菜单和权限查看操作说明。
            </p><RouterLink
              class="side-link"
              to="/my/installations"
            >
              <AppIcon name="manual" />采集安装
            </RouterLink>
          </template>
          <template v-else>
            <div class="side-label">
              历史查询
            </div><p class="side-status muted">
              暂未开放
            </p><ElButton
              disabled
              text
            >
              历史统计
            </ElButton><ElButton
              disabled
              text
            >
              历史明细
            </ElButton>
          </template>
        </div>
        <div class="side-footer">
          <small><AppIcon
            name="shield"
            :size="14"
          />数据访问范围</small><p>{{ locked ? '完成改密前仅可修改密码或退出登录。' : group === 'my' ? '固定为本人数据，不随管理部门切换。' : superAdmin ? '可管理全部组织与人员，并查看所有人的Token使用分析。' : globalManager ? '可管理所有一级部门与成员；他人仅看统计。' : manager ? '仅管理授权部门；成员原文不可见。' : '仅查看自己的统计与会话。' }}</p>
        </div>
      </aside>
      <main class="workspace-main">
        <div class="workspace-breadcrumb">
          <AppIcon
            :name="group"
            :size="15"
          />{{ nav.find(item => item.key === group)?.label ?? '操作手册' }} <span>/</span> {{ scopedGroup ? scopeName : group === 'my' ? '本人' : '平台' }}
        </div>
        <ElAlert
          v-if="session.error"
          :title="session.error"
          type="error"
          :closable="false"
        />
        <RouterView />
      </main>
    </div>
  </div>
</template>
