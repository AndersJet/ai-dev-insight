import {registerPluginReleases,pluginReleaseMessages} from './plugin-releases.js';
import type {PluginReleaseService} from '@adi/domain';
import {registerRepositoryAllowlist} from './repository-allowlist.js';
import {registerPluginTracking,type PluginBackend} from './plugin-tracking.js';
import type {RepositoryAllowlistService} from '@adi/domain';
import { adoptionRoute, type AdoptionQuery } from '@adi/contracts';
import type { AdoptionService } from '@adi/domain';
import { registrationRoutes, type ActivationBody, type RegistrationBody } from '@adi/contracts';
import type { RegistrationService } from '@adi/domain';
import {jobStatusRoute,cleanupRoutes,type CleanupRangeDto,type CleanupSubmitDto} from '@adi/contracts';
import type {CleanupService} from '@adi/domain';
import {operationsRoutes} from '@adi/contracts';
import type {OperationsService} from '@adi/domain';
import {codeFlowRoute,projectInventoryRoutes,type CodeFlowQueryDto,type ProjectSessionsQueryDto} from '@adi/contracts';
import type {ProjectInventoryService} from '@adi/domain';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { authRoutes, meRoute, type CurrentUser, type LoginBody, type ChangePasswordBody, type ResetPasswordBody } from '@adi/contracts';
import type { IdentityService, SessionIdentity, LoginResult, OrganizationService, AdministrationService, MemberImportService, InstallationService } from '@adi/domain';
import multipart from '@fastify/multipart';
import { registerOrganization } from './organization.js';
import { registerAdministration } from './administration.js';
import { registerMemberImports } from './member-import.js';
import { registerInstallations } from './installations.js';
import { registerClientDistribution, type ClientDistribution } from './client-distribution.js';
import { registerUsageMappings } from './usage-mappings.js';
import type { UsageMappingService } from '@adi/domain';
import { registerAnalytics } from './analytics.js';
import { registerSessions } from './sessions.js';
import { registerSessionPersonalModels } from './session-personal-models.js';
import type { SessionReadService, SessionPersonalModelService, AnalyticsService } from '@adi/domain';
declare module 'fastify' {
  interface FastifyRequest { identity: SessionIdentity | null; sessionToken: string }
}
const messages: Record<string, string> = { invalid_repository_address:'请输入有效的精确主机或完整网络仓库地址',repository_rule_exists:'该白名单规则已存在', cleanup_acceptance_unconfirmed: '提交确认尚未完成；任务可能已经接收，请重试原操作并核对任务历史', recovery_quarantined: '数据恢复校验尚未完成，当前不能登录或访问业务数据', unauthenticated: '请先登录', invalid_credentials: '邮箱或密码不正确', forbidden: '无权执行该操作', password_change_required: '请先修改临时密码', invalid_csrf: '请求校验失败，请刷新后重试', invalid_origin: '请求来源不受信任', version_conflict: '数据已变化，请刷新后重试', password_length: '密码长度应为12至128个字符', password_unchanged: '新密码不能与当前密码相同', not_found: '记录不存在', rate_limited: '尝试过于频繁，请稍后再试', auth_unavailable: '登录服务尚未就绪' };
Object.assign(messages,{registration_unavailable:'注册服务尚未就绪',registration_not_allowed:'此邮箱已有账号，请先登录；没有密码请联系超级管理员领取临时密码',department_unavailable:'所选部门已不可用，请刷新后重选',registration_required:'请先完成注册',manual_eligibility_removed:'所有注册人员均纳入统计，不支持手工排除'});
function fault(code: string, status: number) { return Object.assign(new Error(code), { code, status }); }
Object.assign(messages,pluginReleaseMessages);
messages.plugin_unavailable='插件采集服务尚未就绪';
messages.plugin_key_unavailable='插件凭据暂时无法读取，请联系管理员检查持久密钥';
messages.plugin_account_unavailable='插件所属账号当前不可用';
Object.assign(messages,{analysis_same_owner:'一个分析包只能包含同一人员的会话',analysis_too_large:'所选材料过大，请减少会话后重试'});
messages.plugin_entry_retired='该旧入口已退役，请使用新版插件接入';
messages.collection_disabled='新数据基线尚未开放，采集与使用数据查询暂不可用';
messages.cleanup_empty_scope='该时间范围没有可清理的使用数据，请重新预览';
messages.plugin_unauthorized='插件上报授权无效';
messages.plugin_conflict='观测标识或顺序已经对应其他内容';
messages.plugin_limited='插件上报请求过于频繁，请稍后重试';
Object.assign(messages,{project_superseded:'此旧观测已经越过保留水位，请重新探测',project_cleared:'此观测已被清理，请重新探测',project_expired:'此观测早于当前可接收范围，请重新探测',project_invalid:'项目观测不能确认，请重新探测',collection_unavailable:'采集当前暂不可用'});
export interface ApiOptions {plugin?:PluginBackend;pluginReleases?:PluginReleaseService}
function sessionCookie(request: FastifyRequest): string {
  const found = (request.headers.cookie ?? '').split(';').map(item => item.trim()).filter(item => item.startsWith('adi_session='));
  return found.length === 1 ? found[0]!.slice('adi_session='.length) : '';
}
Object.assign(messages, { invalid_request: '请求格式不正确', invalid_name: '名称应为1至128个字符', invalid_identity: '人员信息不正确', invalid_email_domain: '邮箱不在允许的域名范围内', department_not_empty: '部门下仍有成员，不能删除', membership_conflict: '该人员已有部门归属，请通过调动操作处理', email_exists: '邮箱已存在，如需关联未分配人员请显式选择关联已有账号', account_deleted: '该账号已删除，请联系超级管理员恢复', invalid_admin: '请选择启用的人员作为管理员', invalid_cursor: '列表条件已变化或已过期，请重新查询' });
export interface ApiOptions { repositoryAllowlist?:RepositoryAllowlistService; adoption?: AdoptionService; registration?: RegistrationService; cleanup?:CleanupService; operations?:OperationsService; codeFlow?:ProjectInventoryService; identity?: Pick<IdentityService,'login'|'resolve'|'changePassword'|'resetPassword'|'logout'|'validCsrf'> & Partial<Pick<IdentityService,'mutate'>>; organization?: OrganizationService; administration?: AdministrationService; imports?: MemberImportService; installations?: InstallationService; analytics?: AnalyticsService; usageMappings?: UsageMappingService; sessions?: SessionReadService; sessionModels?: SessionPersonalModelService; clientDistribution?: ClientDistribution; secureCookies?: boolean; allowedOrigin?: string }
Object.assign(messages, { invalid_period: '日期范围应位于最近45个北京时间业务日内，起止时间需同时提供', invalid_scope: '统计范围不正确', department_required: '请先选择一级部门', metric_overflow: '统计量超出当前可展示范围，请缩小范围后重试' });
Object.assign(messages, { content_changed: '使用数据已变化，请重新加载', channel_source_unavailable: '渠道来源尚未接通，请先查看全部会话' });
Object.assign(messages,{session_snapshot_expired:'当前列表已过期，请重新查询',session_snapshot_pending:'数据正在更新，请稍后刷新'});
Object.assign(messages, { collection_reset_required: '当前凭据已撤销或来自旧版，请先重置采集凭据，再下载个人安装包；所有电脑都需更新', collection_key_unavailable: '采集凭据暂时无法读取，请联系管理员检查凭据密钥', client_package_unavailable: '客户端程序包暂不可用，请联系管理员', collector_endpoint_unavailable: '采集地址尚未配置，请联系管理员' });
Object.assign(messages, { invalid_installation_command: '安装命令已失效，请登录采集安装页重新生成', installation_command_expired: '安装命令已超过30分钟有效期，请回采集安装页重新生成' });
messages.invalid_model_declaration='最多确认10个模型，每个名称为1至120个字符且不含控制字符';
messages.model_selection_missing='当前范围已没有所选模型记录，请切换全部模型';
Object.assign(messages,{official_period_precision:'官方用量按北京时间完整业务日查询',usage_provider_unconfigured:'尚未配置官方用量来源',usage_department_unobserved:'尚未观测到该官方部门，请先完成用量同步'});
messages.installation_limit = '每个账号最多保留10个有效安装，请先撤销不再使用的安装';
Object.assign(messages, { invalid_import: '没有可导入的有效行或超出行数限制', template_department_mismatch: '模板部门与当前部门不一致，请重新下载模板', preview_expired: '预览已过期，请重新上传', preview_stale: '人员资料、权限或组织已变化，请重新预览', import_has_errors: '请先修正所有错误后再整批提交', import_busy: '正在处理其他导入，请稍后重试', invalid_file: '文件格式无效，请使用模板', file_too_large: '文件超过5MiB或行数限制', file_too_complex: '文件过大或过于复杂，请使用简化后的模板', unsupported_file: '仅支持.xlsx或UTF-8 CSV文件', invalid_csv: 'CSV格式或编码无效，请另存为UTF-8', unsupported_columns: '文件列不匹配，请使用下载的模板', member_sheet_missing: '未找到“成员”工作表', invalid_or_oversized_workbook: '工作簿格式无效或解压内容超限', too_many_rows: '最多导入2000行，请删除多余空行或拆分文件' });
Object.assign(messages, { configuration_managed_account: '此账号由部署配置管理，不能在系统内修改其登录凭据或安全属性', reason_required: '请填写操作原因或核验说明', last_super_admin: '必须保留至少一名可登录的超级管理员', account_inactive: '请先启用账号再调整权限', invalid_department: '选择的部门不可用' });
Object.assign(messages, { invalid_effective_at: '生效时间不能早于当前时间；立即生效请使用默认选项', pending_transfer: '该人员已有待生效调动，请先取消原计划', same_department: '调入部门不能与当前部门相同' });
Object.assign(messages,{invalid_cleanup_range:'请选择滚动365天内已经发生的有效时间范围',cleanup_preview_expired:'预览已过期，请重新预览',cleanup_preview_stale:'目标数据或身份已变化，请重新预览',cleanup_confirmation_mismatch:'确认的邮箱、目标或范围与预览不一致',cleanup_preview_used:'该预览已提交，请查看原任务',cleanup_in_progress:'该用户已有清理任务进行中',cleanup_unavailable:'未配置外部恢复屏障存储，不能提交清理',cleanup_not_retryable:'当前任务不是可重试的失败状态',idempotency_conflict:'重试标识对应另一份提交，请重新预览',dataset_identity_changed:'数据集身份已变化，不能继续该任务'});
// The authentication module supplies this seam. No user/role from request headers is trusted.
export function createApi(resolveUser: (request: FastifyRequest) => Promise<CurrentUser | null> = async () => null, options: ApiOptions = {}) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, requestTimeout: 15_000, ajv: { customOptions: { removeAdditional: false } } });
  app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 1 } });
  app.decorateRequest('identity', null); app.decorateRequest('sessionToken', '');
  function identity() { if (!options.identity) throw fault('auth_unavailable', 503); return options.identity; }
  const secure = options.secureCookies === false ? '' : '; Secure';
  function cookies(reply: FastifyReply, session?: LoginResult) {
    const ttl = session ? Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000)) : 0;
    reply.header('Set-Cookie', [`adi_session=${session?.token ?? ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttl}${secure}`, `adi_csrf=${session?.csrfToken ?? ''}; Path=/; SameSite=Strict; Max-Age=${ttl}${secure}`]);
  }
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/v1/')) return;
    reply.header('Cache-Control', 'no-store');
    const pluginReleaseRequest=request.url.startsWith('/api/v1/plugin-releases/')||request.url.split('?')[0]?.startsWith('/api/v1/system/plugin-releases');
    if(options.plugin&&!pluginReleaseRequest){const dataset=(await options.plugin.db.query<{collection_enabled:boolean;collection_baseline_at:Date|null}>('SELECT collection_enabled,collection_baseline_at FROM data_identity')).rows[0];if(!dataset?.collection_enabled||dataset.collection_baseline_at&&dataset.collection_baseline_at>new Date())throw fault('collection_disabled',503);}
    const path = request.url.split('?')[0];
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin && options.allowedOrigin && request.headers.origin !== options.allowedOrigin) throw fault('invalid_origin', 403);
    if (path === authRoutes.login.path) return;
    if(['GET','HEAD'].includes(request.method)&&path?.startsWith('/api/v1/plugin-releases/'))return;
    if((request.method==='POST'&&['/api/v1/plugin/registration','/api/v1/plugin/observations','/api/v1/plugin/sources','/api/v1/plugin/collection-grant','/api/v1/plugin/analysis/sessions','/api/v1/plugin/analysis/package'].includes(path??''))||(request.method==='GET'&&['/api/v1/plugin/me','/api/v1/plugin/today','/api/v1/plugin/collection-setup','/api/v1/plugin/collection-client'].includes(path??'')))return;
    if ([registrationRoutes.setup,registrationRoutes.complete].some(route => route.path === path && route.method.toUpperCase() === request.method)) return;
    if (request.method === 'GET' && /^\/api\/v1\/collection-install\/(?:macos|windows)$/.test(path ?? '')) return; // Scoped bearer grant is verified in the download handler.
    request.sessionToken = sessionCookie(request);
    request.identity = options.identity ? await options.identity.resolve(request.sessionToken) : null;
    if (path === meRoute.path) return;
    if (!request.identity) throw fault('unauthenticated', 401);
    if (request.identity.user.must_change_password && path !== authRoutes.changePassword.path && path !== authRoutes.logout.path) throw fault('password_change_required', 403);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const csrf = request.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !identity().validCsrf(request.identity, csrf)) throw fault('invalid_csrf', 403);
    }
  });
  app.get(meRoute.path, { schema: { response: meRoute.response } }, async (request, reply) => {
    const user = options.identity ? request.identity?.user : await resolveUser(request);
    if (!user) return reply.code(401).send({ error: { code: 'unauthenticated', message: '请先登录', request_id: request.id } });
    return { data: user, meta: { request_id: request.id } };
  });
  app.get<{Querystring:AdoptionQuery}>(adoptionRoute.path,{schema:adoptionRoute},async request=>{
    if(!options.adoption) throw fault('auth_unavailable',503);
    return {data:await options.adoption.snapshot(request.sessionToken,request.query),meta:{request_id:request.id}};
  });
  app.get(registrationRoutes.setup.path, {schema:registrationRoutes.setup}, async request => {
    if (!options.registration) throw fault('registration_unavailable',503);
    return {data:{departments:await options.registration.departments()},meta:{request_id:request.id}};
  });
  app.post<{Body:RegistrationBody}>(registrationRoutes.complete.path,{schema:registrationRoutes.complete},async(request,reply)=>{
    if (!options.registration) throw fault('registration_unavailable',503);
    return reply.code(201).send({data:await options.registration.register(request.body,request.ip),meta:{request_id:request.id}});
  });
  app.post<{Body:ActivationBody}>(registrationRoutes.activate.path,{schema:registrationRoutes.activate},async request=>{
    if (!options.registration) throw fault('registration_unavailable',503);
    return {data:await options.registration.activate(request.sessionToken,request.body),meta:{request_id:request.id}};
  });
  app.post<{ Body: LoginBody }>(authRoutes.login.path, { schema: authRoutes.login }, async (request, reply) => {
    const result = await identity().login(request.body.email, request.body.password, request.ip);
    cookies(reply, result); return { data: result.user, meta: { request_id: request.id } };
  });
  app.post<{ Body: ChangePasswordBody }>(authRoutes.changePassword.path, { schema: authRoutes.changePassword }, async (request, reply) => {
    const result = await identity().changePassword(request.sessionToken, request.body.current_password, request.body.new_password);
    cookies(reply, result); return { data: result.user, meta: { request_id: request.id } };
  });
  app.post(authRoutes.logout.path, { schema: authRoutes.logout }, async (request, reply) => {
    await identity().logout(request.sessionToken); cookies(reply); return reply.code(204).send();
  });
  app.post<{ Body: ResetPasswordBody; Params: { id: string } }>(authRoutes.resetPassword.path, { schema: authRoutes.resetPassword }, async (request) => {
    const result = await identity().resetPassword(request.sessionToken, request.params.id, request.body.version, request.body.reason);
    return { data: { temporary_password: result.temporaryPassword, version: result.version }, meta: { request_id: request.id } };
  });
  app.setErrorHandler((error, request, reply) => {
    if (typeof error === 'object' && error !== null && 'validation' in error) return reply.code(400).send({ error: { code: 'invalid_request', message: '请求格式不正确', request_id: request.id } });
    if (typeof error === 'object' && error !== null && 'code' in error && ['database_io_timeout', 'database_unavailable'].includes(String(error.code))) return reply.code(503).send({ error: { code: String(error.code), message: '数据服务暂时不可用；如刚提交了操作，请恢复后先核对结果', request_id: request.id } });
    if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && Object.hasOwn(messages, error.code) && 'status' in error && typeof error.status === 'number') {
      return reply.code(error.status).send({ error: { code: error.code, message: messages[error.code], request_id: request.id } });
    }
    if (typeof error === 'object' && error !== null && 'code' in error && ['23505', '23P01', '40001', '40P01', '55P03'].includes(String(error.code))) return reply.code(409).send({ error: { code: 'conflict', message: '记录已存在或发生并发变更，请刷新后重试', request_id: request.id } });
    if (typeof error === 'object' && error !== null && 'code' in error && ['FST_REQ_FILE_TOO_LARGE', 'FST_FILES_LIMIT', 'FST_PARTS_LIMIT', 'FST_FIELDS_LIMIT', 'FST_ERR_CTP_BODY_TOO_LARGE'].includes(String(error.code))) return reply.code(413).send({ error: { code: 'file_too_large', message: '文件数量或大小超过限制', request_id: request.id } });
    reply.code(500).send({ error: { code: 'internal_error', message: '服务暂时不可用', request_id: request.id } });
  });
  if (options.organization) registerOrganization(app, options.organization);
  if (options.administration) registerAdministration(app, options.administration);
  if (options.imports) registerMemberImports(app, options.imports);
  if (options.installations) registerInstallations(app, options.installations);
  registerPluginReleases(app,options.pluginReleases);
  const pluginAccess=registerPluginTracking(app,options.plugin,options.identity);
  registerClientDistribution(app, options.clientDistribution, options.installations,pluginAccess??undefined,options.allowedOrigin);
  if (options.usageMappings) registerUsageMappings(app,options.usageMappings);
  if (options.analytics) registerAnalytics(app, options.analytics);
  if (options.sessions) registerSessions(app, options.sessions);
  if (options.sessionModels) registerSessionPersonalModels(app,options.sessionModels);
  if(options.repositoryAllowlist)registerRepositoryAllowlist(app,options.repositoryAllowlist);
  if(options.codeFlow) app.get<{Querystring:CodeFlowQueryDto}>(codeFlowRoute.path,{schema:codeFlowRoute},async request=>({data:await options.codeFlow!.list(request.sessionToken,request.query),meta:{request_id:request.id}}));
  if(options.codeFlow)app.get<{Params:{id:string};Querystring:ProjectSessionsQueryDto}>(projectInventoryRoutes.sessions.path,{schema:projectInventoryRoutes.sessions},async request=>({data:await options.codeFlow!.sessions(request.sessionToken,request.params.id,request.query),meta:{request_id:request.id}}));
  if(options.operations){
    app.get(operationsRoutes.health.path,{schema:operationsRoutes.health},async request=>({data:await options.operations!.health(request.sessionToken),meta:{request_id:request.id}}));
    app.get(operationsRoutes.retention.path,{schema:operationsRoutes.retention},async request=>({data:await options.operations!.retention(request.sessionToken),meta:{request_id:request.id}}));
    app.get<{Querystring:{from?:string;to?:string}}>(operationsRoutes.usageSync.path,{schema:operationsRoutes.usageSync},async request=>({data:await options.operations!.usageSync(request.sessionToken,request.query),meta:{request_id:request.id}}));
  }
  if(options.imports||options.cleanup)app.get<{Params:{id:string}}>(jobStatusRoute.path,{schema:jobStatusRoute},async request=>{
    if(options.imports){try{return {data:await options.imports.getJob(request.sessionToken,request.params.id),meta:{request_id:request.id}};}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='not_found'&&options.cleanup&&request.identity?.user.roles.includes('super')))throw error;}}
    if(!options.cleanup)throw fault('not_found',404);return {data:await options.cleanup.status(request.sessionToken,request.params.id),meta:{request_id:request.id}};
  });
  if(options.cleanup){
    app.get<{Querystring:{user_id?:string;cursor?:string}}>(cleanupRoutes.list.path,{schema:cleanupRoutes.list},async request=>({data:await options.cleanup!.list(request.sessionToken,request.query),meta:{request_id:request.id}}));
    app.post<{Body:CleanupRangeDto}>(cleanupRoutes.preview.path,{schema:cleanupRoutes.preview},async request=>({data:await options.cleanup!.preview(request.sessionToken,request.body),meta:{request_id:request.id}}));
    app.post<{Body:CleanupSubmitDto}>(cleanupRoutes.submit.path,{schema:cleanupRoutes.submit},async(request,reply)=>reply.code(202).send({data:await options.cleanup!.submit(request.sessionToken,request.body,typeof request.headers['idempotency-key']==='string'?request.headers['idempotency-key']:''),meta:{request_id:request.id}}));
    app.post<{Params:{id:string};Body:{confirmation_email:string}}>(cleanupRoutes.resume.path,{schema:cleanupRoutes.resume},async(request,reply)=>reply.code(202).send({data:await options.cleanup!.resume(request.sessionToken,request.params.id,request.body.confirmation_email),meta:{request_id:request.id}}));
  }
  return app;
}
