import { manualPath } from './manual.js';
import { createRouter, createWebHistory } from 'vue-router';
import { useSession } from '../stores/session.js';
import { safeReturnPath } from './access.js';
export const router = createRouter({ history: createWebHistory(), routes: [
  { path: '/manual', redirect: '/my/installations' },
  { path: '/register', component: () => import('../views/RegisterView.vue') },
  { path: '/login', component: () => import('../views/AuthView.vue') },
  { path: '/', component: () => import('../layouts/WorkspaceLayout.vue'), children: [
    { path: 'change-password', component: () => import('../views/AuthView.vue') },
    { path: 'history', component: () => import('../views/HistoryView.vue') },
    ...['system-admin','anc-admin','department-admin','employee'].map(role=>({path:`manual/${role}`,component:()=>import('../views/ManualView.vue')})),
    ...(['health','usage-sync','retention'] as const).map(section=>({path:`system/${section}`,component:()=>import('../views/OperationsView.vue'),props:{section}})),
    { path: 'system/plugin-releases', component: () => import('../views/PluginReleasesView.vue') },
    { path: 'code-flow', component: () => import('../views/CodeFlowTrackingView.vue') },
    { path: 'plugin-code-flow', redirect: to => ({path:'/code-flow',query:{dept:to.query.dept,search:to.query.search,page:to.query.page,source:'plugin'}}) },
    { path: 'my/overview', component: () => import('../views/AnalyticsView.vue') },
    { path: 'my/sessions', component: () => import('../views/SessionListView.vue') },
    { path: 'all/sessions', component: () => import('../views/SessionListView.vue') },
    { path: 'my/sessions/:sessionId', component: () => import('../views/SessionDetailView.vue') },
    { path: 'all/sessions/:sessionId', component: () => import('../views/SessionDetailView.vue') },
    { path: 'my/installations', component: () => import('../views/InstallationsView.vue') },
    { path: 'organization-management/departments', component: () => import('../views/DepartmentsView.vue') },
    { path: 'organization-management/:departmentId/members', component: () => import('../views/MembersView.vue') },
    { path: 'organization-management', redirect: '/organization-management/all/members' },
    { path: 'organization/:departmentId/members/:memberId', component: () => import('../views/AnalyticsView.vue') },
    { path: 'organization/:departmentId?', component: () => import('../views/AnalyticsView.vue') },
    { path: ':pathMatch(.*)*', component: () => import('../views/EntryView.vue') },
  ] },
] });
router.beforeEach(async to => {
  const session = useSession();
  if (!session.initialized) await session.refresh();
  if (!session.user) return ['/login','/register'].includes(to.path) ? true : { path: '/login', query: { redirect: to.fullPath } };
  if (session.user.must_change_password && to.path !== '/change-password') return { path: '/change-password', query: { redirect: safeReturnPath(to.query.redirect ?? to.fullPath, '/my/overview') } };
  if (to.path === '/change-password' && session.user.management_source === 'environment') return session.user.default_route;
  if(to.path==='/register'&&session.user.registered===false) return true;
  if (to.path === '/login' || to.path === '/register' || to.path === '/') return safeReturnPath(to.query.redirect, session.user.default_route);
  const roles = session.user.roles;
  if(to.path.startsWith('/manual/')&&to.path!==manualPath(roles)) return manualPath(roles);
  const global = roles.includes('super') || roles.includes('anc_admin');
  const manager = global || roles.includes('department_admin');
  if ((to.path.startsWith('/organization') && !manager) || ((to.path.startsWith('/all') || to.path.startsWith('/code-flow') || to.path.startsWith('/plugin-code-flow') || to.path.startsWith('/system')) && !roles.includes('super'))) return '/my/overview';
  if (to.path === '/organization-management/departments' && !global) return `/organization-management/${session.user.managed_departments[0]?.id}/members`;
  if (to.path === '/organization-management/all/members' && !global) return `/organization-management/${session.user.managed_departments[0]?.id}/members`;
  return true;
});
