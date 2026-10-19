export * from './plugin-releases.js';
import {pluginReleaseRoutes} from './plugin-releases.js';
import { OfficialTokenBreakdownSchema } from './official-usage-counters.js';
export * from './official-usage-counters.js';
import { Type, type Static } from '@sinclair/typebox';
import {ProjectContextSchema,ProjectRepositoryClassificationSchema} from './project-observation.js';
export * from './plugin-tracking.js';
import {pluginRoutes} from './plugin-tracking.js';
export * from './plugin-access.js';
import {pluginAccessRoutes} from './plugin-access.js';
export {ProjectContextSchema,ProjectObservationSchema,ProjectRemoteSchema,ProjectRepositoryAddressSchema,ProjectRepositoryClassificationSchema,type ProjectContext,type ProjectObservation,type ProjectRepositoryClassification} from './project-observation.js';
export {parseRepositoryAddress,normalizeRepositoryAddresses,normalizeRepositoryHost,type RepositoryAddress} from './repository-address.js';
const ManagementSourceSchema = Type.Union([Type.Literal('system'), Type.Literal('environment')]);
const text = () => Type.String({ minLength: 1, maxLength: 256 });
export const ErrorSchema = Type.Object({ error: Type.Object({ code: text(), message: Type.String(), request_id: text() }, { additionalProperties: false }) }, { additionalProperties: false });
export const MeSchema = Type.Object({
  data: Type.Object({
    registered: Type.Optional(Type.Boolean()),
    management_source: ManagementSourceSchema, user_id: text(), display_name: text(), email: Type.String({ format: 'email', maxLength: 254 }),
    roles: Type.Array(Type.Union([Type.Literal('super'), Type.Literal('anc_admin'), Type.Literal('department_admin'), Type.Literal('employee')]), { maxItems: 4 }),
    managed_departments: Type.Array(Type.Object({ id: text(), name: text() }, { additionalProperties: false })),
    allowed_actions: Type.Array(text()), default_route: text(), must_change_password: Type.Boolean(),
  }, { additionalProperties: false }),
  meta: Type.Object({ request_id: text() }, { additionalProperties: false }),
}, { additionalProperties: false });
export type MeResponse = Static<typeof MeSchema>;
export type CurrentUser = MeResponse['data'];
export type ApiError = Static<typeof ErrorSchema>;
export const HookSchema = Type.Object({
  schema_version: Type.Literal(2), installation_id: text(), client_event_id: text(),
  occurred_at: Type.String({ format: 'date-time' }), event_type: text(), source_session_id: text(),
  timestamp_source: Type.Optional(Type.Union([Type.Literal('client_observed'), Type.Literal('source_reported'), Type.Literal('unknown')])),
  project:Type.Optional(ProjectContextSchema),
  payload: Type.Record(Type.String(), Type.Unknown()),
}, { additionalProperties: false });
export type HookEnvelope = Static<typeof HookSchema>;
export const meRoute = { method: 'get', path: '/api/v1/me', response: { 200: MeSchema, 401: ErrorSchema, 503: ErrorSchema } } as const;
export const LoginBodySchema = Type.Object({ email: Type.String({ format: 'email', maxLength: 254 }), password: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false });
export const ChangePasswordBodySchema = Type.Object({ current_password: Type.String({ minLength: 1, maxLength: 128 }), new_password: Type.String({ minLength: 12, maxLength: 128 }) }, { additionalProperties: false });
export const ResetReasonSchema = Type.Union([Type.Literal('initial_issue'), Type.Literal('forgotten'), Type.Literal('expired'), Type.Literal('security'), Type.Literal('administrative')]);
export const ResetPasswordBodySchema = Type.Object({ version: Type.Integer({ minimum: 1 }), reason: ResetReasonSchema }, { additionalProperties: false });
export const UserIdParamsSchema = Type.Object({ id: Type.String({ format: 'uuid' }) }, { additionalProperties: false });
export const TemporaryPasswordSchema = Type.Object({ data: Type.Object({ temporary_password: Type.String(), version: Type.Integer() }, { additionalProperties: false }), meta: Type.Object({ request_id: text() }, { additionalProperties: false }) }, { additionalProperties: false });
export type LoginBody = Static<typeof LoginBodySchema>;
export type ChangePasswordBody = Static<typeof ChangePasswordBodySchema>;
export type ResetPasswordBody = Static<typeof ResetPasswordBodySchema>;
export const authRoutes = {
  login: { method: 'post', path: '/api/v1/auth/login', body: LoginBodySchema, response: { 200: MeSchema, 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema, 429: ErrorSchema, 503: ErrorSchema } },
  changePassword: { method: 'post', path: '/api/v1/auth/change-password', body: ChangePasswordBodySchema, response: { 200: MeSchema, 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema, 503: ErrorSchema } },
  logout: { method: 'post', path: '/api/v1/auth/logout', response: { 204: Type.Null(), 401: ErrorSchema, 403: ErrorSchema, 503: ErrorSchema } },
  resetPassword: { method: 'post', path: '/api/v1/admin/users/:id/reset-password', body: ResetPasswordBodySchema, params: UserIdParamsSchema, response: { 200: TemporaryPasswordSchema, 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 503: ErrorSchema } },
} as const;
const uuid = () => Type.String({ format: 'uuid' });
const meta = Type.Object({ request_id: text() }, { additionalProperties: false });
const result = <T extends import('@sinclair/typebox').TSchema>(data: T) => Type.Object({ data, meta }, { additionalProperties: false });
const failures = { 400: ErrorSchema, 401: ErrorSchema, 403: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 422: ErrorSchema, 503: ErrorSchema };
export const DepartmentSchema = Type.Object({ id: uuid(), name: text(), version: Type.Integer(), member_count: Type.Integer(), pending_member_count: Type.Integer(), admins: Type.Array(Type.Object({ user_id: uuid(), display_name: text() }, { additionalProperties: false })) }, { additionalProperties: false });
const DepartmentChangeSchema = Type.Object({ id: uuid(), name: text(), version: Type.Integer() }, { additionalProperties: false });
const ScheduledTransferSchema = Type.Object({ department_id: uuid(), department_name: text(), effective_at: Type.String({ format: 'date-time' }) }, { additionalProperties: false });
export const MemberSchema = Type.Object({registered_at: Type.Optional(Type.Union([Type.String(),Type.Null()])), adopted_at: Type.Optional(Type.Union([Type.String(),Type.Null()])), status_since: Type.Optional(Type.Union([Type.String(),Type.Null()])), status_reason: Type.Optional(Type.Union([Type.String(),Type.Null()])), status_actor: Type.Optional(Type.Union([Type.String(),Type.Null()])),  user_id: uuid(), email: Type.String({ format: 'email' }), display_name: text(), status: Type.Union([Type.Literal('active'), Type.Literal('suspended'), Type.Literal('deleted')]), primary_role: Type.Optional(Type.Union([Type.Literal('super'), Type.Literal('anc_admin'), Type.Literal('department_admin'), Type.Literal('employee')])), version: Type.Integer(), department_id: Type.Union([uuid(), Type.Null()]), department_name: Type.Union([Type.String(), Type.Null()]), eligible: Type.Union([Type.Boolean(), Type.Null()]), scheduled_transfer: Type.Union([ScheduledTransferSchema, Type.Null()]) }, { additionalProperties: false });
export const MemberPageSchema = Type.Object({ items: Type.Array(MemberSchema), total: Type.Integer({ minimum: 0 }), next_cursor: Type.Union([Type.String(), Type.Null()]), has_more: Type.Boolean() }, { additionalProperties: false });
export const NewDepartmentBody = Type.Object({ name: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false });
export const RenameDepartmentBody = Type.Object({ name: Type.String({ minLength: 1, maxLength: 128 }), version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
export const VersionBody = Type.Object({ version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
export const DepartmentAdminsBody = Type.Object({ user_ids: Type.Array(uuid(), { maxItems: 500, uniqueItems: true }), version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
export const NewMemberBody = Type.Object({ email: Type.String({ format: 'email', maxLength: 254 }), display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })), attach_existing: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
export const EditMemberBody = Type.Object({ version: Type.Integer({ minimum: 1 }), display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })) }, { additionalProperties: false });
export const TransferBody = Type.Object({ version: Type.Integer({ minimum: 1 }), target_department_id: uuid(), effective_at: Type.Optional(Type.String({ format: 'date-time' })) }, { additionalProperties: false });
export type TransferMember = Static<typeof TransferBody>;
const MemberParams = Type.Object({ id: uuid(), userId: uuid() }, { additionalProperties: false });
const PagingQuery = Type.Object({ adoption: Type.Optional(Type.Union([Type.Literal('pending'),Type.Literal('adopted'),Type.Literal('unregistered')])), status: Type.Optional(Type.Union([Type.Literal('active'),Type.Literal('suspended'),Type.Literal('deleted')])),  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), cursor: Type.Optional(Type.String({ maxLength: 2048 })), search: Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false });
export type DepartmentDto = Static<typeof DepartmentSchema>;
export type MemberDto = Static<typeof MemberSchema>;
export type MemberPage = Static<typeof MemberPageSchema>;
export type NewMember = Static<typeof NewMemberBody>;
export type EditMember = Static<typeof EditMemberBody>;
export type Paging = Static<typeof PagingQuery>;
export const organizationRoutes = {
  departments: { method: 'get', path: '/api/v1/departments', response: { 200: result(Type.Array(DepartmentSchema)), ...failures } },
  create: { method: 'post', path: '/api/v1/departments', body: NewDepartmentBody, response: { 201: result(DepartmentChangeSchema), ...failures } },
  rename: { method: 'patch', path: '/api/v1/departments/:id', params: UserIdParamsSchema, body: RenameDepartmentBody, response: { 200: result(DepartmentChangeSchema), ...failures } },
  remove: { method: 'delete', path: '/api/v1/departments/:id', params: UserIdParamsSchema, body: VersionBody, response: { 204: Type.Null(), ...failures } },
  admins: { method: 'put', path: '/api/v1/departments/:id/admins', params: UserIdParamsSchema, body: DepartmentAdminsBody, response: { 200: result(DepartmentChangeSchema), ...failures } },
  members: { method: 'get', path: '/api/v1/departments/:id/members', params: UserIdParamsSchema, querystring: PagingQuery, response: { 200: result(MemberPageSchema), ...failures } },
  allMembers: { method: 'get', path: '/api/v1/members', querystring: PagingQuery, response: { 200: result(MemberPageSchema), ...failures } },
  addMember: { method: 'post', path: '/api/v1/departments/:id/members', params: UserIdParamsSchema, body: NewMemberBody, response: { 201: result(MemberSchema), ...failures } },
  editMember: { method: 'patch', path: '/api/v1/departments/:id/members/:userId', params: MemberParams, body: EditMemberBody, response: { 200: result(MemberSchema), ...failures } },
  removeMember: { method: 'delete', path: '/api/v1/departments/:id/members/:userId', params: MemberParams, body: VersionBody, response: { 204: Type.Null(), ...failures } },
  transfer: { method: 'post', path: '/api/v1/members/:id/transfers', params: UserIdParamsSchema, body: TransferBody, response: { 200: result(Type.Object({ user_id: uuid(), target_department_id: uuid(), effective_at: Type.String({ format: 'date-time' }), version: Type.Integer() }, { additionalProperties: false })), ...failures } },
  cancelTransfer: { method: 'delete', path: '/api/v1/members/:id/transfers', params: UserIdParamsSchema, body: VersionBody, response: { 200: result(VersionBody), ...failures } },
} as const;
const GlobalRolesSchema = Type.Array(Type.Union([Type.Literal('super'), Type.Literal('anc_admin')]), { uniqueItems: true, maxItems: 2 });
export const AccountSchema = Type.Object({ management_source: ManagementSourceSchema, id: uuid(), email: Type.String({ format: 'email' }), display_name: text(), status: Type.Union([Type.Literal('active'), Type.Literal('suspended'), Type.Literal('deleted')]), version: Type.Integer(), credential_state: Type.Union([Type.Literal('unissued'), Type.Literal('temporary'), Type.Literal('expired'), Type.Literal('ready')]), global_roles: GlobalRolesSchema, department_ids: Type.Array(uuid()) }, { additionalProperties: false });
export const AccessBodySchema = Type.Object({ version: Type.Integer({ minimum: 1 }), global_roles: GlobalRolesSchema, department_ids: Type.Optional(Type.Array(uuid(), { uniqueItems: true, maxItems: 500 })) }, { additionalProperties: false });
export const StatusBodySchema = Type.Object({ version: Type.Integer({ minimum: 1 }), status: Type.Union([Type.Literal('active'), Type.Literal('suspended'), Type.Literal('deleted')]), reason: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false });
export const EmailCorrectionBody = Type.Object({ version: Type.Integer({ minimum: 1 }), email: Type.String({ format: 'email', maxLength: 254 }), verification_note: Type.String({ minLength: 1, maxLength: 500 }) }, { additionalProperties: false });
export type AccountDto = Static<typeof AccountSchema>;
export type AccessBody = Static<typeof AccessBodySchema>;
export type StatusBody = Static<typeof StatusBodySchema>;
export type EmailCorrection = Static<typeof EmailCorrectionBody>;
export type ResetReason = Static<typeof ResetReasonSchema>;
export const administrationRoutes = {
  list: { method: 'get', path: '/api/v1/admin/users', querystring: PagingQuery, response: { 200: result(MemberPageSchema), ...failures } },
  account: { method: 'get', path: '/api/v1/admin/users/:id', params: UserIdParamsSchema, response: { 200: result(AccountSchema), ...failures } },
  access: { method: 'put', path: '/api/v1/admin/users/:id/global-roles', params: UserIdParamsSchema, body: AccessBodySchema, response: { 200: result(VersionBody), ...failures } },
  status: { method: 'patch', path: '/api/v1/admin/users/:id/status', params: UserIdParamsSchema, body: StatusBodySchema, response: { 200: result(Type.Object({ version: Type.Integer(), committed_at: Type.String({ format: 'date-time' }) }, { additionalProperties: false })), ...failures } },
  email: { method: 'patch', path: '/api/v1/admin/users/:id/email', params: UserIdParamsSchema, body: EmailCorrectionBody, response: { 200: result(VersionBody), ...failures } },
} as const;
export const ImportCountsSchema = Type.Object({ create: Type.Integer(), update: Type.Integer(), skip: Type.Integer(), unchanged: Type.Integer(), error: Type.Integer() }, { additionalProperties: false });
const ImportJobSchema = Type.Object({ status: Type.String(), error_code: Type.Union([Type.String(), Type.Null()]), attempt: Type.Integer(), progress: Type.Partial(ImportCountsSchema) }, { additionalProperties: false });
export const ImportRowSchema = Type.Object({ row: Type.Integer(), email: Type.String(), display_name: Type.Optional(Type.String()), eligibility_from: Type.Optional(Type.String()), eligibility_to: Type.Optional(Type.Union([Type.String(), Type.Null()])), action: Type.Union([Type.Literal('create'), Type.Literal('update'), Type.Literal('skip'), Type.Literal('unchanged'), Type.Literal('error')]), changes: Type.Array(Type.String()), errors: Type.Array(Type.String()), before: Type.Optional(Type.Object({ display_name: Type.String(), eligible: Type.Union([Type.Boolean(), Type.Null()]), department_id: Type.Union([uuid(), Type.Null()]) }, { additionalProperties: false })) }, { additionalProperties: false });
export const ImportBatchSchema = Type.Object({ id: uuid(), department_id: uuid(), mode: Type.Union([Type.Literal('insert_only'), Type.Literal('upsert')]), source_name: Type.String(), rows: Type.Array(ImportRowSchema), counts: ImportCountsSchema, preview_hash: Type.String(), status: Type.Union([Type.Literal('previewed'), Type.Literal('queued'), Type.Literal('succeeded'), Type.Literal('failed')]), expires_at: Type.String({ format: 'date-time' }), can_submit: Type.Boolean(), job_id: Type.Union([uuid(), Type.Null()]), job: Type.Union([ImportJobSchema, Type.Null()]) }, { additionalProperties: false });
const ImportQuery = Type.Object({ department_id: uuid(), mode: Type.Optional(Type.Union([Type.Literal('insert_only'), Type.Literal('upsert')])) }, { additionalProperties: false });
const CommitImportBody = Type.Object({ preview_hash: Type.String({ pattern: '^[0-9a-f]{64}$' }) }, { additionalProperties: false });
const IdempotencyHeaders = Type.Object({ 'idempotency-key': Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: true });
export type ImportBatchDto = Static<typeof ImportBatchSchema>;
export type ImportQueryDto = Static<typeof ImportQuery>;
export const importRoutes = {
  template: { method: 'get', path: '/api/v1/member-imports/template', querystring: Type.Object({ department_id: uuid() }, { additionalProperties: false }), download: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', response: { ...failures } },
  recent: { method: 'get', path: '/api/v1/member-imports', querystring: Type.Object({ department_id: uuid() }, { additionalProperties: false }), response: { 200: result(Type.Array(Type.Object({ id: uuid(), source_name: Type.String(), status: Type.String(), created_at: Type.String({ format: 'date-time' }), expires_at: Type.String({ format: 'date-time' }) }, { additionalProperties: false }))), ...failures } },
  preview: { method: 'post', path: '/api/v1/member-imports/preview', querystring: ImportQuery, upload: true, response: { 200: result(ImportBatchSchema), ...failures } },
  batch: { method: 'get', path: '/api/v1/member-imports/:id', params: UserIdParamsSchema, response: { 200: result(ImportBatchSchema), ...failures } },
  commit: { method: 'post', path: '/api/v1/member-imports/:id/commit', params: UserIdParamsSchema, body: CommitImportBody, headers: IdempotencyHeaders, response: { 202: result(Type.Object({ job_id: uuid() }, { additionalProperties: false })), ...failures } },
  job: { method: 'get', path: '/api/v1/jobs/:id', params: UserIdParamsSchema, response: { 200: result(Type.Object({ ...ImportJobSchema.properties, id: uuid(), batch_id: uuid() }, { additionalProperties: false })), ...failures } },
} as const;
export const InstallationSchema = Type.Object({ id: uuid(), label: Type.String(), enabled: Type.Boolean(), created_at: Type.String({ format: 'date-time' }), last_seen: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]), revoked_at: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]) }, { additionalProperties: false });
const CollectionCredentialSchema = Type.Object({ installation: Type.Union([InstallationSchema, Type.Null()]), legacy_installations: Type.Integer({ minimum: 0 }), reset_required: Type.Boolean(), last_seen: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]) }, { additionalProperties: false });
export type CollectionCredentialDto = Static<typeof CollectionCredentialSchema>;
export const ClientReleaseSchema = Type.Object({ version: Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+$' }), runtime: Type.Literal('system'), platforms: Type.Array(Type.Union([Type.Literal('windows'), Type.Literal('macos')]), { minItems: 2, maxItems: 2, uniqueItems: true }), channel: Type.Union([Type.Literal('preview'), Type.Literal('stable')]), file_name: Type.String({ pattern: '^adi-hook-client-[0-9.]+-[0-9a-f]{12}\\.zip$' }), sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }), bytes: Type.Integer({ minimum: 1, maximum: 4 * 1024 * 1024 }) }, { additionalProperties: false });
export const CollectionSetupSchema = Type.Object({ collector_url: Type.Union([Type.String({ format: 'uri' }), Type.Null()]), client: Type.Union([ClientReleaseSchema, Type.Null()]) }, { additionalProperties: false });
export type ClientReleaseDto = Static<typeof ClientReleaseSchema>;
const OnlineInstallationGrantSchema = Type.Object({ authorization: Type.String({ pattern: '^adi_dl_[A-Za-z0-9_-]{1,400}\\.[A-Za-z0-9_-]{43}$' }), expires_at: Type.String({ format: 'date-time' }), installation_id: uuid() }, { additionalProperties: false });
export const clientDistributionRoutes = {
  authorize: { method: 'post', path: '/api/v1/me/collection-install-command', body: Type.Object({}, { additionalProperties: false }), response: { 200: result(OnlineInstallationGrantSchema), ...failures, 503: ErrorSchema } },
  online: { method: 'get', path: '/api/v1/collection-install/:platform', params: Type.Object({ platform: Type.Union([Type.Literal('macos'), Type.Literal('windows')]) }, { additionalProperties: false }), download: 'text/plain', response: { ...failures, 410: ErrorSchema, 503: ErrorSchema } },
  setup: { method: 'get', path: '/api/v1/me/collection-setup', response: { 200: result(CollectionSetupSchema), ...failures } },
  download: { method: 'post', path: '/api/v1/me/collection-client', body: Type.Object({}, { additionalProperties: false }), download: 'application/zip', response: { ...failures, 503: ErrorSchema } },
} as const;
const AnalyticsQuerySchema = Type.Object({ from: Type.Optional(Type.String({ format: 'date-time' })), to: Type.Optional(Type.String({ format: 'date-time' })), scope: Type.Optional(Type.Union([Type.Literal('self'), Type.Literal('organization')])), department_id: Type.Optional(uuid()), member_id: Type.Optional(uuid()) }, { additionalProperties: false });
const AnalyticsPageQuerySchema = Type.Object({ ...AnalyticsQuerySchema.properties, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), cursor: Type.Optional(Type.String({ maxLength: 2048 })), search: Type.Optional(Type.String({ maxLength: 128 })) }, { additionalProperties: false });
const AnalyticsTrendQuerySchema = Type.Object({ ...AnalyticsQuerySchema.properties, granularity: Type.Optional(Type.Union([Type.Literal('day'), Type.Literal('week')])) }, { additionalProperties: false });
const PeriodSchema = Type.Object({ from: Type.String({ format: 'date-time' }), to: Type.String({ format: 'date-time' }) }, { additionalProperties: false });
const AnalyticsScopeSchema = Type.Object({ kind: Type.Union([Type.Literal('self'), Type.Literal('organization')]), label: Type.String(), department_ids: Type.Union([Type.Array(uuid()), Type.Null()]), member: Type.Optional(Type.Union([Type.Object({id:uuid(),name:Type.String(),email:Type.String(),archived:Type.Boolean()},{additionalProperties:false}),Type.Null()])) }, { additionalProperties: false });
const CounterSchema = Type.Integer({ minimum: 0 });
const RatioSchema = Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]);
const EstimatedTokensSchema = Type.Union([Type.String({ pattern: '^[0-9]+$' }), Type.Null()]);
export const ContentEstimateSchema = Type.Object({ source: Type.Literal('trae_personal_hooks'), kind: Type.Literal('observed_content'), metric_version: Type.Literal('content-heuristic-v1'), tokens: EstimatedTokensSchema, components: Type.Object({ prompt: EstimatedTokensSchema, tool_input: EstimatedTokensSchema, tool_output: EstimatedTokensSchema, assistant: EstimatedTokensSchema }, { additionalProperties: false }), sessions: CounterSchema, pending_sessions: CounterSchema, as_of: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]), reason: Type.Union([Type.Literal('projection_pending'), Type.Literal('no_observations'), Type.Null()]) }, { additionalProperties: false });
export type ContentEstimateDto = Static<typeof ContentEstimateSchema>;
export const AnalyticsContentEstimateSchema = Type.Object({ period: PeriodSchema, scope: AnalyticsScopeSchema, estimate: ContentEstimateSchema }, { additionalProperties: false });
export type AnalyticsContentEstimateDto = Static<typeof AnalyticsContentEstimateSchema>;
const AnalyticsCounters = { observed_users: CounterSchema, eligible_users: CounterSchema, eligible_observed_users: CounterSchema, coverage_ratio: RatioSchema, sessions: CounterSchema, prompt_turns: CounterSchema, tool_events: CounterSchema };
const AnalyticsQualitySchema = Type.Object({ source: Type.Literal('trae_personal_hooks'), metric_version: Type.String(), computed_at: Type.String({ format: 'date-time' }), source_watermark: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]), pending_sessions: CounterSchema, state: Type.Union([Type.Literal('ready'), Type.Literal('processing'), Type.Literal('rebuilding')]), lag_seconds: Type.Union([CounterSchema, Type.Null()]), unassigned_events: CounterSchema }, { additionalProperties: false });
export const AnalyticsOverviewSchema = Type.Object({ period: PeriodSchema, scope: AnalyticsScopeSchema, ...AnalyticsCounters, observed_outside_eligibility: CounterSchema, outside_eligibility_prompt_events: CounterSchema, coverage_reason: Type.Union([Type.Literal('no_eligible_members'), Type.Null()]), active_days: CounterSchema, quality: AnalyticsQualitySchema }, { additionalProperties: false });
const AnalyticsTrendItemSchema = Type.Object({ date: Type.String({ format: 'date' }), ...PeriodSchema.properties, ...AnalyticsCounters }, { additionalProperties: false });
export const AnalyticsTrendsSchema = Type.Object({ period: PeriodSchema, scope: AnalyticsScopeSchema, granularity: Type.Union([Type.Literal('day'), Type.Literal('week')]), computed_at: Type.String({ format: 'date-time' }), items: Type.Array(AnalyticsTrendItemSchema) }, { additionalProperties: false });
const AnalyticsGroupSchema = Type.Object({ id: uuid(), name: Type.String(), email: Type.Union([Type.String(), Type.Null()]), archived: Type.Boolean(), ...AnalyticsCounters, active_days: CounterSchema, last_observed_at: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]) }, { additionalProperties: false });
export const AnalyticsGroupsSchema = Type.Object({ period: PeriodSchema, scope: AnalyticsScopeSchema, computed_at: Type.String({ format: 'date-time' }), items: Type.Array(AnalyticsGroupSchema), total: CounterSchema, has_more: Type.Boolean(), next_cursor: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false });
export type AnalyticsOverviewDto = Static<typeof AnalyticsOverviewSchema>;
export type AnalyticsTrendsDto = Static<typeof AnalyticsTrendsSchema>;
export type AnalyticsGroupsDto = Static<typeof AnalyticsGroupsSchema>;
export type AnalyticsQueryDto = Static<typeof AnalyticsQuerySchema>;
export type AnalyticsPageQueryDto = Static<typeof AnalyticsPageQuerySchema>;
export type AnalyticsTrendQueryDto = Static<typeof AnalyticsTrendQuerySchema>;
export const AnalyticsPurposesSchema = Type.Object({ period: PeriodSchema, scope: AnalyticsScopeSchema, metric_version: Type.String(), computed_at: Type.String({ format: 'date-time' }), total_sessions: CounterSchema, pending_sessions: CounterSchema, items: Type.Array(Type.Object({ purpose: Type.Union(['docs', 'ops', 'test', 'refactor', 'bugfix', 'feature', 'learning', 'chat', 'unknown'].map(value => Type.Literal(value))), sessions: CounterSchema, ratio: RatioSchema, rule_sessions: CounterSchema, behavior_sessions: CounterSchema, pending_sessions: CounterSchema }, { additionalProperties: false })) }, { additionalProperties: false });
export type AnalyticsPurposesDto = Static<typeof AnalyticsPurposesSchema>;
export const AmountMissingReasonSchema = Type.Object({reason:Type.Union((['missing','null','not_priced','currency_missing','unknown'] as const).map(value=>Type.Literal(value))),records:CounterSchema},{additionalProperties:false});
export type AmountMissingReasonDto = Static<typeof AmountMissingReasonSchema>;
const OfficialGroupSchema = Type.Object({ token_breakdown:Type.Optional(OfficialTokenBreakdownSchema),scene:Type.Union([Type.Literal('Chat'),Type.Literal('CUE'),Type.Literal('other')]),client:Type.Union([Type.Literal('ide'),Type.Literal('unspecified')]),model_source:Type.Union([Type.Literal('Trae'),Type.Literal('Custom'),Type.Literal('unknown')]),consumption_source:Type.Union(['basic','pay_go','mixed','enterprise_builtin','unknown'].map(value=>Type.Literal(value))),currency:Type.Union([Type.String(),Type.Null()]),records:CounterSchema,tokens:EstimatedTokensSchema,known_tokens:Type.String(),missing_token_records:CounterSchema,calls:EstimatedTokensSchema,known_calls:Type.String(),missing_call_records:CounterSchema,amount:Type.Union([Type.String(),Type.Null()]),known_amount:Type.Union([Type.String(),Type.Null()]),unknown_amount_records:CounterSchema,amount_missing_reasons:Type.Array(AmountMissingReasonSchema,{maxItems:5}),quality_records:CounterSchema },{additionalProperties:false});
const UsageTokenBucketSchema=Type.Pick(OfficialGroupSchema,['records','tokens','known_tokens','missing_token_records']);
const UsageReconciliationSchema=Type.Object({as_of:Type.String({format:'date-time'}),days:Type.Array(Type.Object({date:Type.String({format:'date'}),waiting_user_days:CounterSchema,overdue_user_days:CounterSchema,failed_user_days:CounterSchema,known_gap_user_days:CounterSchema,next_check_at:Type.Union([Type.String({format:'date-time'}),Type.Null()])},{additionalProperties:false}),{maxItems:45}),scope:Type.Literal('chat_ide_or_unspecified'),session_completeness:Type.Literal('unknown'),total:UsageTokenBucketSchema,attributed:UsageTokenBucketSchema,unattributed:UsageTokenBucketSchema,conflicting:UsageTokenBucketSchema},{additionalProperties:false});
export type UsageReconciliationDto=Static<typeof UsageReconciliationSchema>;
const ModelCheckStateSchema=Type.Union((['matched','cohort_matched','difference','not_comparable','stale','pending','failed','not_checked'] as const).map(value=>Type.Literal(value)));
const ModelCheckSchema=Type.Object({availability:Type.Union([Type.Literal('available'),Type.Literal('department_scope_not_comparable')]),scope:Type.Literal('all_clients_all_consumption'),as_of:Type.String({format:'date-time'}),
 days:Type.Array(Type.Object({date:Type.String({format:'date'}),state:ModelCheckStateSchema,user_days:CounterSchema,oldest_checked_at:Type.Union([Type.String({format:'date-time'}),Type.Null()]),next_check_at:Type.Union([Type.String({format:'date-time'}),Type.Null()])},{additionalProperties:false}),{maxItems:360}),
 groups:Type.Array(Type.Object({model_source:Type.String({maxLength:256}),model_type:Type.String({maxLength:256}),user_days:CounterSchema,detail_input_tokens:EstimatedTokensSchema,detail_output_tokens:EstimatedTokensSchema,official_input_tokens:EstimatedTokensSchema,official_output_tokens:EstimatedTokensSchema,models_comparable:Type.Boolean()},{additionalProperties:false}),{maxItems:100}),truncated:Type.Boolean()},{additionalProperties:false});
export type ModelCheckDto=Static<typeof ModelCheckSchema>;
export const OfficialUsageSchema=Type.Object({model_check:Type.Union([ModelCheckSchema,Type.Null()]),reconciliation:Type.Union([UsageReconciliationSchema,Type.Null()]),period:PeriodSchema,scope:AnalyticsScopeSchema,configured:Type.Boolean(),source:Type.Literal('trae_openapi'),token_basis:Type.Literal('provider_reported'),settlement:Type.Literal('unverified'),coverage:Type.Object({expected_user_days:CounterSchema,verified_user_days:CounterSchema,missing_user_days:CounterSchema,invalidated_user_days:CounterSchema,refreshing_user_days:CounterSchema,oldest_verified_at:Type.Union([Type.String({format:'date-time'}),Type.Null()]),complete:Type.Boolean()},{additionalProperties:false}),unassigned_records:Type.Union([CounterSchema,Type.Null()]),excluded_client_records:CounterSchema,groups:Type.Array(OfficialGroupSchema,{maxItems:200})},{additionalProperties:false});
export type OfficialUsageDto=Static<typeof OfficialUsageSchema>;
const AnalyticsModelQuerySchema=Type.Object({...AnalyticsQuerySchema.properties,scene:Type.Optional(Type.Union([Type.Literal('Chat'),Type.Literal('CUE'),Type.Literal('other')])),client:Type.Optional(Type.Union([Type.Literal('ide'),Type.Literal('unspecified')])),model_key:Type.Optional(Type.String({pattern:'^[a-f0-9]{64}$'})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100})),cursor:Type.Optional(Type.String({maxLength:3070}))},{additionalProperties:false});
const ModelIdentityFields={key:Type.String({pattern:'^[a-f0-9]{64}$'}),name:Type.Union([Type.String({maxLength:1024}),Type.Null()]),model_source:Type.Union(['Trae','Custom','unknown'].map(value=>Type.Literal(value)))};
const ModelCostSchema=Type.Object({currency:Type.Union([Type.String(),Type.Null()]),amount:Type.Union([Type.String(),Type.Null()]),known_amount:Type.Union([Type.String(),Type.Null()]),unknown_amount_records:CounterSchema,amount_missing_reasons:Type.Array(AmountMissingReasonSchema,{maxItems:5})},{additionalProperties:false});
const ModelItemSchema=Type.Object({...ModelIdentityFields,records:CounterSchema,users:CounterSchema,tokens:EstimatedTokensSchema,known_tokens:Type.String(),missing_token_records:CounterSchema,calls:EstimatedTokensSchema,known_calls:Type.String(),missing_call_records:CounterSchema,quality_records:CounterSchema,costs:Type.Array(ModelCostSchema,{maxItems:200})},{additionalProperties:false});
const ModelTrendSchema=Type.Object({date:Type.String({format:'date'}),records:CounterSchema,tokens:EstimatedTokensSchema,known_tokens:Type.String(),calls:EstimatedTokensSchema,missing_token_records:CounterSchema,expected_users:CounterSchema,verified_users:CounterSchema},{additionalProperties:false});
const ModelsSchema=Type.Object({period:PeriodSchema,scope:AnalyticsScopeSchema,configured:Type.Boolean(),source:Type.Literal('trae_openapi'),settlement:Type.Literal('unverified'),filters:Type.Object({scene:Type.Union(['Chat','CUE','other'].map(value=>Type.Literal(value))),client:Type.Union([Type.Literal('ide'),Type.Literal('unspecified')])},{additionalProperties:false}),total:CounterSchema,items:Type.Array(ModelItemSchema,{maxItems:100}),has_more:Type.Boolean(),next_cursor:Type.Union([Type.String(),Type.Null()]),selected_model:Type.Union([Type.Object(ModelIdentityFields,{additionalProperties:false}),Type.Null()]),trend:Type.Array(ModelTrendSchema,{maxItems:45}),coverage:Type.Object({expected_user_days:CounterSchema,verified_user_days:CounterSchema,missing_user_days:CounterSchema,oldest_verified_at:Type.Union([Type.String({format:'date-time'}),Type.Null()]),query_through_at:Type.Union([Type.String({format:'date-time'}),Type.Null()])},{additionalProperties:false})},{additionalProperties:false});
const DeclaredModelsSchema=Type.Object({period:PeriodSchema,scope:AnalyticsScopeSchema,source:Type.Literal('user_declared'),basis:Type.Literal('observed_session_cohort'),total:CounterSchema,confirmed_sessions:CounterSchema,has_more:Type.Boolean(),next_cursor:Type.Union([Type.String(),Type.Null()]),items:Type.Array(Type.Object({name:Type.String({maxLength:120}),sessions:CounterSchema,users:CounterSchema},{additionalProperties:false}),{maxItems:100})},{additionalProperties:false});
export type AnalyticsModelQueryDto=Static<typeof AnalyticsModelQuerySchema>;
export type ModelsDto=Static<typeof ModelsSchema>;
export type DeclaredModelsDto=Static<typeof DeclaredModelsSchema>;
const UsageMappingQuerySchema=Type.Object({department_id:uuid(),search:Type.Optional(Type.String({maxLength:128})),after:Type.Optional(Type.String({maxLength:256})),after_mapping:Type.Optional(uuid()),limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))},{additionalProperties:false});
const UsageMappingBodySchema=Type.Object({department_id:uuid(),external_department_id:Type.String({minLength:1,maxLength:256}),from_date:Type.String({format:'date'}),to_date:Type.Optional(Type.String({format:'date'})),version:CounterSchema},{additionalProperties:false});
const UsageMappingPageSchema=Type.Object({configured:Type.Boolean(),version:CounterSchema,items:Type.Array(Type.Object({id:uuid(),external_department_id:Type.String(),department_id:uuid(),valid_from:Type.String({format:'date-time'}),valid_to:Type.Union([Type.String({format:'date-time'}),Type.Null()])},{additionalProperties:false})),candidates:Type.Array(Type.Object({external_department_id:Type.String(),name:Type.String(),full_path:Type.String()},{additionalProperties:false})),next_cursor:Type.Union([Type.String(),Type.Null()]),next_mapping_cursor:Type.Union([uuid(),Type.Null()])},{additionalProperties:false});
export type UsageMappingPageDto=Static<typeof UsageMappingPageSchema>;
export type UsageMappingQueryDto=Static<typeof UsageMappingQuerySchema>;
export type UsageMappingBodyDto=Static<typeof UsageMappingBodySchema>;
export const usageMappingRoutes={
 list:{method:'get',path:'/api/v1/usage/department-mappings',querystring:UsageMappingQuerySchema,response:{200:result(UsageMappingPageSchema),...failures}},
 create:{method:'post',path:'/api/v1/usage/department-mappings',body:UsageMappingBodySchema,response:{201:result(Type.Object({id:uuid(),version:CounterSchema},{additionalProperties:false})),...failures}},
 remove:{method:'delete',path:'/api/v1/usage/department-mappings/:id',params:UserIdParamsSchema,body:Type.Object({version:CounterSchema},{additionalProperties:false}),response:{200:result(Type.Object({version:CounterSchema},{additionalProperties:false})),...failures}},
} as const;

export const analyticsRoutes = {
  member: {method: 'get',path:'/api/v1/analytics/members/:id',params:UserIdParamsSchema,querystring:Type.Omit(AnalyticsQuerySchema,['member_id']),response:{200:result(AnalyticsOverviewSchema),...failures}},
  models:{method:'get',path:'/api/v1/analytics/models',querystring:AnalyticsModelQuerySchema,response:{200:result(ModelsSchema),...failures}},
  declaredModels:{method:'get',path:'/api/v1/analytics/declared-models',querystring:AnalyticsPageQuerySchema,response:{200:result(DeclaredModelsSchema),...failures}},
  officialUsage:{method:'get',path:'/api/v1/analytics/official-usage',querystring:AnalyticsQuerySchema,response:{200:result(OfficialUsageSchema),...failures}},
  contentEstimate: { method: 'get', path: '/api/v1/analytics/content-estimate', querystring: AnalyticsQuerySchema, response: { 200: result(AnalyticsContentEstimateSchema), ...failures } },
  overview: { method: 'get', path: '/api/v1/analytics/overview', querystring: AnalyticsQuerySchema, response: { 200: result(AnalyticsOverviewSchema), ...failures } },
  trends: { method: 'get', path: '/api/v1/analytics/trends', querystring: AnalyticsTrendQuerySchema, response: { 200: result(AnalyticsTrendsSchema), ...failures } },
  departments: { method: 'get', path: '/api/v1/analytics/departments', querystring: AnalyticsPageQuerySchema, response: { 200: result(AnalyticsGroupsSchema), ...failures } },
  members: { method: 'get', path: '/api/v1/analytics/members', querystring: AnalyticsPageQuerySchema, response: { 200: result(AnalyticsGroupsSchema), ...failures } },
  purposes: { method: 'get', path: '/api/v1/analytics/purposes', querystring: AnalyticsQuerySchema, response: { 200: result(AnalyticsPurposesSchema), ...failures } },
} as const;
export const installationRoutes = {
  status: { method: 'get', path: '/api/v1/me/collection-credential', response: { 200: result(CollectionCredentialSchema), ...failures } },
  reset: { method: 'post', path: '/api/v1/me/collection-credential/reset', body: Type.Object({}, { additionalProperties: false }), response: { 200: result(CollectionCredentialSchema), ...failures, 503: ErrorSchema } },
  revoke: { method: 'delete', path: '/api/v1/me/collection-credential', response: { 204: Type.Null(), ...failures } },
  adminStatus: { method: 'get', path: '/api/v1/admin/users/:id/collection-credential', params: UserIdParamsSchema, response: { 200: result(CollectionCredentialSchema), ...failures } },
  adminRevoke: { method: 'delete', path: '/api/v1/admin/users/:id/collection-credential', params: UserIdParamsSchema, response: { 204: Type.Null(), ...failures } },
} as const;
const RecentSessionQuerySchema = Type.Object({ from: Type.Optional(Type.String({ format: 'date-time' })), to: Type.Optional(Type.String({ format: 'date-time' })) }, { additionalProperties: false });
const SessionQuerySchema = Type.Object({ ...RecentSessionQuerySchema.properties, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), cursor: Type.Optional(Type.String({ maxLength: 3070 })), search: Type.Optional(Type.String({ maxLength: 128 })), channel: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('official'), Type.Literal('pending'), Type.Literal('custom')])) }, { additionalProperties: false });
const AllSessionQuerySchema = Type.Object({ ...SessionQuerySchema.properties, user_id: Type.Optional(uuid()), department_id: Type.Optional(uuid()) }, { additionalProperties: false });
const SessionFragmentQuerySchema = Type.Object({ ...RecentSessionQuerySchema.properties, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), cursor: Type.Optional(Type.String({ maxLength: 3070 })), mode: Type.Optional(Type.Union([Type.Literal('trace'), Type.Literal('raw')])), snapshot: Type.Optional(Type.String({ maxLength: 3070 })), turn: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false });
const SessionContentPartSchema = Type.Union([Type.Literal('payload'), Type.Literal('prompt'), Type.Literal('response'), Type.Literal('tool_input'), Type.Literal('tool_response')]);
const SessionContentQuerySchema = Type.Object({ ...RecentSessionQuerySchema.properties, occurred_at:Type.Optional(Type.String({format:'date-time'})), part: SessionContentPartSchema, offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483646 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8192 })) }, { additionalProperties: false });
const SessionIdentityFields = { id: uuid(), user_id: uuid(), name: Type.String(), email: Type.String(), source_session_id: Type.String(), first_at: Type.String({ format: 'date-time' }), last_at: Type.String({ format: 'date-time' }), prompt_turns: CounterSchema };
const PageFields = { has_more: Type.Boolean(), next_cursor: Type.Union([Type.String(), Type.Null()]) };
const PersonalModelNamesSchema=Type.Array(Type.String({minLength:1,maxLength:120}),{maxItems:10});
const SessionCoverageSchema=Type.Object({state:Type.Literal('unknown'),reason:Type.Literal('billing_id_inventory_unavailable')},{additionalProperties:false});
const SessionListSnapshotSchema=Type.Object({id:Type.String({minLength:1,maxLength:128}),as_of:Type.String({format:'date-time'}),expires_at:Type.String({format:'date-time'}),updating:Type.Boolean()},{additionalProperties:false});
export type SessionListSnapshotDto=Static<typeof SessionListSnapshotSchema>;
const SessionListSchema = Type.Object({ period: PeriodSchema, items: Type.Array(Type.Object({ ...SessionIdentityFields, title: Type.String(),channel:Type.Union(['official','pending','custom','mixed','unknown'].map(value=>Type.Literal(value))),model:Type.Union([Type.String(),Type.Null()]),model_count:CounterSchema,official_tokens:EstimatedTokensSchema,official_records:CounterSchema,department_unassigned_records:CounterSchema,session_coverage:SessionCoverageSchema,attribution_conflicts:CounterSchema,personal_models:PersonalModelNamesSchema }, { additionalProperties: false })), total: CounterSchema, ...PageFields, channel_available: Type.Boolean(),available_channels:Type.Array(Type.Union(['all','official','pending','custom'].map(value=>Type.Literal(value)))),snapshot:Type.Optional(SessionListSnapshotSchema) }, { additionalProperties: false });
const SessionDetailSchema = Type.Object({ ...SessionIdentityFields, content_estimate: ContentEstimateSchema, period: PeriodSchema, partial_history: Type.Boolean(), events: CounterSchema, tool_events: CounterSchema, status: Type.String(), projection_ready: Type.Boolean(), computed_at: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]), quality: Type.Array(Type.String()) }, { additionalProperties: false });
const SessionTimeCandidatesSchema=Type.Object({state:Type.Union(['unavailable','none','available'].map(value=>Type.Literal(value))),reason:Type.Union([Type.String({maxLength:64}),Type.Null()]),basis:Type.Literal('observed_prompt_windows_seconds'),items:Type.Array(Type.Object({billing_session_id:Type.String({maxLength:256}),model_name:Type.Union([Type.String({maxLength:1024}),Type.Null()]),business_date:Type.String({format:'date'}),tokens:EstimatedTokensSchema,scope_from:Type.String({format:'date-time'}),scope_to:Type.String({format:'date-time'}),observed_start_at:Type.String({format:'date-time'}),relation:Type.Union(['time_inferred','ambiguous'].map(value=>Type.Literal(value))),reason:Type.Union(['unique_observed_window','multiple_bills_in_window','competing_hook_sessions'].map(value=>Type.Literal(value)))},{additionalProperties:false}),{maxItems:200})},{additionalProperties:false});
const SessionOfficialUsageSchema=Type.Object({session_query:Type.Optional(Type.Object({state:Type.Union(['ready','partial','pending'].map(value=>Type.Literal(value))),reasons:Type.Array(Type.String({maxLength:64})),observed_at:Type.String({format:'date-time'}),billing_ids:Type.Array(Type.String({maxLength:256}),{maxItems:5000}),revision:Type.String({pattern:'^[0-9]+$'})},{additionalProperties:false})),time_candidates:SessionTimeCandidatesSchema,period:PeriodSchema,configured:Type.Boolean(),source:Type.Literal('trae_openapi'),settlement:Type.Literal('unverified'),session_coverage:SessionCoverageSchema,
  attribution:Type.Object({state:Type.Union(['unlinked','linked','partial','conflict'].map(value=>Type.Literal(value))),linked_ids:CounterSchema,conflicting_ids:CounterSchema,unmatched_ids:CounterSchema,evidence:Type.Literal('single_hook_query'),probe_state:Type.String({maxLength:32}),pending:Type.Boolean(),requested_at:Type.Union([Type.String({format:'date-time'}),Type.Null()]),probe_revision:Type.Union([CounterSchema,Type.Null()]),observed_at:Type.Union([Type.String({format:'date-time'}),Type.Null()])},{additionalProperties:false}),
  coverage:Type.Object({revision:Type.Union([Type.String({pattern:'^[a-f0-9]{32}$'}),Type.Null()]),expected_days:CounterSchema,verified_days:CounterSchema,missing_days:CounterSchema,invalidated_days:CounterSchema,oldest_verified_at:Type.Union([Type.String({format:'date-time'}),Type.Null()]),query_through_at:Type.Union([Type.String({format:'date-time'}),Type.Null()])},{additionalProperties:false}),
  groups:Type.Array(Type.Object({...OfficialGroupSchema.properties,model_name:Type.Union([Type.String({maxLength:1024}),Type.Null()])},{additionalProperties:false}),{maxItems:200})},{additionalProperties:false});
export type SessionOfficialUsageDto=Static<typeof SessionOfficialUsageSchema>;
const PersonalModelBodySchema=Type.Object({version:CounterSchema,cleanup_generation:CounterSchema,models:PersonalModelNamesSchema},{additionalProperties:false});
const PersonalModelSchema=Type.Object({...PersonalModelBodySchema.properties,source:Type.Literal('user_declared'),scope:Type.Literal('session'),can_edit:Type.Boolean(),updated_at:Type.Union([Type.String({format:'date-time'}),Type.Null()])},{additionalProperties:false});
export type PersonalModelBodyDto=Static<typeof PersonalModelBodySchema>;
export type PersonalModelDto=Static<typeof PersonalModelSchema>;
export const personalModelRoutes={
 read:{method:'get',path:'/api/v1/sessions/:id/personal-models',params:UserIdParamsSchema,querystring:Type.Object({},{additionalProperties:false}),response:{200:result(PersonalModelSchema),...failures}},
 replace:{method:'put',path:'/api/v1/sessions/:id/personal-models',params:UserIdParamsSchema,body:PersonalModelBodySchema,response:{200:result(PersonalModelSchema),...failures}},
} as const;
const EventRefSchema = Type.Union([Type.Object({ event_id: uuid(), occurred_at: Type.String({ format: 'date-time' }) }, { additionalProperties: false }), Type.Null()]);
const StopObservationSchema=Type.Object({reentry_count:Type.Union([Type.Integer({minimum:0,maximum:2147483647}),Type.Null()]),count_state:Type.Union([Type.Literal('valid'),Type.Literal('missing'),Type.Literal('invalid')]),hook_active:Type.Union([Type.Boolean(),Type.Null()])},{additionalProperties:false});
const SessionFragmentSchema = Type.Object({ stop:Type.Union([StopObservationSchema,Type.Null()]), event_id: uuid(), occurred_at: Type.String({ format: 'date-time' }), kind: Type.String(), timestamp_source: Type.String(), turn_index: Type.Union([CounterSchema, Type.Null()]), step_id: Type.Union([uuid(), Type.Null()]), tool_name: Type.Union([Type.String(), Type.Null()]), status: Type.Union([Type.String(), Type.Null()]), duration_ms: Type.Union([Type.String(), Type.Null()]), input_ref: EventRefSchema, pre_ref: EventRefSchema, post_ref: EventRefSchema }, { additionalProperties: false });
const SessionFragmentsSchema = Type.Object({ period: PeriodSchema, items: Type.Array(SessionFragmentSchema), ...PageFields, projection_ready: Type.Boolean() }, { additionalProperties: false });
const SessionContentSchema = Type.Object({ event_id: uuid(), part: SessionContentPartSchema, available: Type.Boolean(), text: Type.String(), offset: CounterSchema, returned_chars: CounterSchema, total_chars: CounterSchema, next_offset: Type.Union([CounterSchema, Type.Null()]) }, { additionalProperties: false });
const SessionTurnsQuerySchema = Type.Object({ ...RecentSessionQuerySchema.properties, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), cursor: Type.Optional(Type.String({ maxLength: 3070 })) }, { additionalProperties: false });
const SessionTurnsSchema = Type.Object({ period: PeriodSchema, items: Type.Array(Type.Object({ turn_index: CounterSchema, first_at: Type.String({ format: 'date-time' }), last_at: Type.String({ format: 'date-time' }), events: CounterSchema, prompt_preview: Type.Union([Type.String(), Type.Null()]) }, { additionalProperties: false })), ...PageFields, snapshot: Type.Union([Type.String(), Type.Null()]), snapshot_version: Type.Optional(Type.Union([Type.String({ pattern: '^[a-f0-9]{64}$' }), Type.Null()])), projection_ready: Type.Boolean() }, { additionalProperties: false });
export type SessionTurnsQueryDto = Static<typeof SessionTurnsQuerySchema>;
export type SessionTurnsDto = Static<typeof SessionTurnsSchema>;
export type SessionQueryDto = Static<typeof SessionQuerySchema>;
export type AllSessionQueryDto = Static<typeof AllSessionQuerySchema>;
export type SessionListDto = Static<typeof SessionListSchema>;
export type SessionDetailDto = Static<typeof SessionDetailSchema>;
export type RecentSessionQueryDto = Static<typeof RecentSessionQuerySchema>;
export type SessionFragmentQueryDto = Static<typeof SessionFragmentQuerySchema>;
export type SessionFragmentsDto = Static<typeof SessionFragmentsSchema>;
export type SessionFragmentDto = Static<typeof SessionFragmentSchema>;
export type SessionContentQueryDto = Static<typeof SessionContentQuerySchema>;
export type SessionContentDto = Static<typeof SessionContentSchema>;
export const AnalysisSelectionSchema=Type.Object({session_ids:Type.Array(uuid(),{minItems:1,maxItems:20,uniqueItems:true})},{additionalProperties:false});
export type AnalysisSelectionDto=Static<typeof AnalysisSelectionSchema>;
export const analysisRoutes={
  download:{method:'post',path:'/api/v1/sessions/analysis-package',body:AnalysisSelectionSchema,download:'application/zip',response:{...failures,413:ErrorSchema}},
  pluginList:{method:'post',path:'/api/v1/plugin/analysis/sessions',body:SessionQuerySchema,response:{200:result(SessionListSchema),...failures}},
  pluginDownload:{method:'post',path:'/api/v1/plugin/analysis/package',body:AnalysisSelectionSchema,download:'application/zip',response:{...failures,413:ErrorSchema}},
} as const;
export const sessionRoutes = {
  mine: { method: 'get', path: '/api/v1/me/sessions', querystring: SessionQuerySchema, response: { 200: result(SessionListSchema), ...failures } },
  all: { method: 'get', path: '/api/v1/admin/sessions', querystring: AllSessionQuerySchema, response: { 200: result(SessionListSchema), ...failures } },
  detail: { method: 'get', path: '/api/v1/sessions/:id', params: UserIdParamsSchema, querystring: RecentSessionQuerySchema, response: { 200: result(SessionDetailSchema), ...failures } },
  officialUsage: {method:'get',path:'/api/v1/sessions/:id/official-usage',params:UserIdParamsSchema,querystring:RecentSessionQuerySchema,response:{200:result(SessionOfficialUsageSchema),...failures}},
  turns: { method: 'get', path: '/api/v1/sessions/:id/turns', params: UserIdParamsSchema, querystring: SessionTurnsQuerySchema, response: { 200: result(SessionTurnsSchema), ...failures } },
  fragments: { method: 'get', path: '/api/v1/sessions/:id/fragments', params: UserIdParamsSchema, querystring: SessionFragmentQuerySchema, response: { 200: result(SessionFragmentsSchema), ...failures } },
  content: { method: 'get', path: '/api/v1/sessions/:id/events/:eventId/content', params: Type.Object({ id: uuid(), eventId: uuid() }, { additionalProperties: false }), querystring: SessionContentQuerySchema, response: { 200: result(SessionContentSchema), ...failures } },
} as const;

export const RepositoryRuleBodySchema=Type.Object({kind:Type.Union([Type.Literal('host'),Type.Literal('repository')]),value:Type.String({minLength:1,maxLength:4096})},{additionalProperties:false});
export const RepositoryRuleSchema=Type.Object({...RepositoryRuleBodySchema.properties,id:uuid(),version:Type.Integer({minimum:1}),created_at:Type.String({format:'date-time'}),updated_at:Type.String({format:'date-time'})},{additionalProperties:false});
export const RepositoryRuleUpdateSchema=Type.Object({...RepositoryRuleBodySchema.properties,version:Type.Integer({minimum:1})},{additionalProperties:false});
export const RepositoryAllowlistQuerySchema=Type.Object({search:Type.Optional(Type.String({maxLength:128})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100})),cursor:Type.Optional(Type.String({maxLength:4096}))},{additionalProperties:false});
export const RepositoryAllowlistSchema=Type.Object({items:Type.Array(RepositoryRuleSchema,{maxItems:100}),total:Type.Integer({minimum:0}),next_cursor:Type.Union([Type.String(),Type.Null()])},{additionalProperties:false});
export type RepositoryRuleDto=Static<typeof RepositoryRuleSchema>;
export type RepositoryRuleBody=Static<typeof RepositoryRuleBodySchema>;
export type RepositoryRuleUpdate=Static<typeof RepositoryRuleUpdateSchema>;
export type RepositoryAllowlistQuery=Static<typeof RepositoryAllowlistQuerySchema>;
export type RepositoryAllowlistDto=Static<typeof RepositoryAllowlistSchema>;
export const repositoryAllowlistRoutes={
  list:{method:'get',path:'/api/v1/repository-allowlist',querystring:RepositoryAllowlistQuerySchema,response:{200:result(RepositoryAllowlistSchema),...failures}},
  create:{method:'post',path:'/api/v1/repository-allowlist',body:RepositoryRuleBodySchema,response:{201:result(RepositoryRuleSchema),...failures}},
  update:{method:'patch',path:'/api/v1/repository-allowlist/:id',params:UserIdParamsSchema,body:RepositoryRuleUpdateSchema,response:{200:result(RepositoryRuleSchema),...failures}},
  remove:{method:'delete',path:'/api/v1/repository-allowlist/:id',params:UserIdParamsSchema,body:VersionBody,response:{204:Type.Null(),...failures}},
} as const;

const ProjectNullableText=Type.Union([Type.String(),Type.Null()]);
export const CodeFlowQuerySchema=Type.Object({from:Type.Optional(Type.String({maxLength:128})),to:Type.Optional(Type.String({maxLength:128})),department_id:Type.Optional(uuid()),search:Type.Optional(Type.String({maxLength:128})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100})),cursor:Type.Optional(Type.String({maxLength:4096}))},{additionalProperties:false});
export const ProjectInventoryItemSchema=Type.Object({id:uuid(),user_id:uuid(),name:Type.String(),email:Type.String(),account_status:Type.String(),department_id:Type.Union([uuid(),Type.Null()]),department_name:ProjectNullableText,collector_id:uuid(),workspace:Type.String({maxLength:4096}),platform:Type.Union([Type.Literal('macos'),Type.Literal('windows'),Type.Literal('linux')]),observation_id:Type.Union([uuid(),Type.Null()]),source_hook_session_id:ProjectNullableText,confirmed_source_hook_session_id:ProjectNullableText,state:Type.String(),reason:ProjectNullableText,observed_at:ProjectNullableText,confirmed_at:ProjectNullableText,confirmed_state:ProjectNullableText,unconfirmed:Type.Boolean(),git_root:ProjectNullableText,
 remotes:Type.Array(ProjectRepositoryClassificationSchema,{maxItems:64}),session_count:Type.Integer({minimum:0}),last_hook_at:ProjectNullableText,current_available:Type.Optional(Type.Boolean()),history_only:Type.Optional(Type.Boolean()),retained_observations:Type.Optional(CounterSchema)},{additionalProperties:false});
export const CodeFlowSchema=Type.Object({as_of:Type.String(),items:Type.Array(ProjectInventoryItemSchema,{maxItems:100}),total:Type.Integer({minimum:0}),pending_hooks:Type.Integer({minimum:0}),next_cursor:ProjectNullableText},{additionalProperties:false});
export const ProjectSessionsQuerySchema=Type.Object({department_id:Type.Optional(uuid()),limit:Type.Optional(Type.Integer({minimum:1,maximum:100})),cursor:Type.Optional(Type.String({maxLength:4096}))},{additionalProperties:false});
export const ProjectSessionsSchema=Type.Object({project_id:uuid(),as_of:Type.String(),total:Type.Integer({minimum:0}),next_cursor:ProjectNullableText,items:Type.Array(Type.Object({session_id:uuid(),hook_session_id:Type.String(),first_hook_at:Type.String(),last_hook_at:Type.String(),hook_events:Type.Integer({minimum:1}),readable:Type.Boolean(),unavailable_reason:Type.Union([Type.Literal('outside_recent_window'),Type.Literal('content_unavailable'),Type.Null()])},{additionalProperties:false}),{maxItems:100})},{additionalProperties:false});
export type CodeFlowQueryDto=Static<typeof CodeFlowQuerySchema>;
export type CodeFlowDto=Static<typeof CodeFlowSchema>;
export type ProjectSessionsQueryDto=Static<typeof ProjectSessionsQuerySchema>;
export type ProjectSessionsDto=Static<typeof ProjectSessionsSchema>;
export const codeFlowRoute={method:'get',path:'/api/v1/code-flow',querystring:CodeFlowQuerySchema,response:{200:result(CodeFlowSchema),...failures}} as const;
export const projectInventoryRoutes={list:codeFlowRoute,sessions:{method:'get',path:'/api/v1/code-flow/:id/sessions',params:UserIdParamsSchema,querystring:ProjectSessionsQuerySchema,response:{200:result(ProjectSessionsSchema),...failures}}} as const;

export const BillingSimulationQuerySchema=Type.Object({base_tokens:Type.Optional(Type.String({pattern:'^(0|[1-9][0-9]{0,6})$',maxLength:7})),model:Type.Optional(Type.String({minLength:1,maxLength:256})),min_call_gap_ms:Type.Optional(Type.Integer({minimum:0,maximum:60000})),overlap_gap_ms:Type.Optional(Type.Integer({minimum:0,maximum:60000})),mutating_gap_ms:Type.Optional(Type.Integer({minimum:0,maximum:60000})),max_batch_steps:Type.Optional(Type.Integer({minimum:1,maximum:100}))},{additionalProperties:false});
const SimulationNullableText=Type.Union([Type.String(),Type.Null()]);
export const BillingSimulationSchema=Type.Object({computed_at:Type.Union([Type.String({format:'date-time'}),Type.Null()]),source_version:Type.Union([Type.String({pattern:'^[a-f0-9]{64}$'}),Type.Null()]),kind:Type.Literal('billing_simulation'),metric_version:Type.String(),period:Type.Object({from:Type.String(),to:Type.String()}),reason:SimulationNullableText,
 baseline:Type.Object({tokens:Type.String(),source:Type.Union([Type.Literal('default'),Type.Literal('scenario_override'),Type.Literal('personal_model'),Type.Literal('model_mean')]),model:SimulationNullableText,samples:Type.Integer(),version:Type.String(),reason:SimulationNullableText,training_before:Type.String({format:'date-time'}),calibrated:Type.Boolean()}),
 parameters:Type.Object({min_call_gap_ms:Type.Integer(),overlap_gap_ms:Type.Integer(),mutating_gap_ms:Type.Integer(),max_batch_steps:Type.Integer()}),simulated_input_tokens:SimulationNullableText,hypothetical_calls:Type.Union([Type.Integer(),Type.Null()]),observed_output_tokens:SimulationNullableText,context_tokens:SimulationNullableText,amount:Type.Null(),warnings:Type.Array(Type.String()),turns:Type.Array(Type.Object({turn_index:Type.Integer(),hypothetical_calls:Type.Integer(),simulated_input_tokens:Type.String()}),{maxItems:2000}),as_of:SimulationNullableText},{additionalProperties:false});
export type BillingSimulationDto=Static<typeof BillingSimulationSchema>;
export type BillingSimulationQueryDto=Static<typeof BillingSimulationQuerySchema>;
export const billingSimulationRoute={method:'get',path:'/api/v1/sessions/:id/billing-simulation',params:UserIdParamsSchema,querystring:BillingSimulationQuerySchema,response:{200:result(BillingSimulationSchema),...failures}} as const;
export const SessionTokenCheckSchema=Type.Object({state:Type.Union([Type.Literal('not_checked'),Type.Literal('pending'),Type.Literal('failed'),Type.Literal('stale'),Type.Literal('current')]),checked_at:Type.Union([Type.String({format:'date-time'}),Type.Null()]),source_version:SimulationNullableText,next_check_at:Type.Union([Type.String({format:'date-time'}),Type.Null()]),error_code:SimulationNullableText,result:Type.Union([Type.Object({version:Type.String(),verdict:Type.Literal('insufficient_data'),eligible:Type.Literal(false),reasons:Type.Array(Type.String(),{maxItems:16}),period:PeriodSchema},{additionalProperties:false}),Type.Null()])},{additionalProperties:false});
export type SessionTokenCheckDto=Static<typeof SessionTokenCheckSchema>;
export const sessionTokenCheckRoute={method:'get',path:'/api/v1/sessions/:id/token-check',params:UserIdParamsSchema,querystring:Type.Object({},{additionalProperties:false}),response:{200:result(SessionTokenCheckSchema),...failures}} as const;

const OpsNullableText=Type.Union([Type.String(),Type.Null()]);
const OpsNullableCounter=Type.Union([CounterSchema,Type.Null()]);
const OpsMetricsSchema=Type.Record(Type.String(),Type.Union([CounterSchema,Type.Boolean()]));
const OperationsHealthSchema=Type.Object({as_of:Type.String(),collector:Type.Object({state:Type.Union(['unknown','stopped','stale','degraded','observed'].map(value=>Type.Literal(value))),last_observed_at:OpsNullableText,boot_id:OpsNullableText,known_dropped:OpsNullableCounter,delivery_unknown:OpsNullableCounter,persisted:OpsNullableCounter,received:OpsNullableCounter,continuity:Type.Literal('best_effort')}),instances:Type.Array(Type.Object({component:Type.String(),boot_id:Type.String(),sequence:Type.String(),state:Type.String(),metrics:OpsMetricsSchema,first_observed_at:Type.String(),last_observed_at:Type.String(),fresh:Type.Boolean()}),{maxItems:100}),truncated:Type.Boolean(),jobs:Type.Array(Type.Object({kind:Type.String(),queued:CounterSchema,ready:CounterSchema,running:CounterSchema,expired:CounterSchema,failed:CounterSchema,succeeded:CounterSchema,cancelled:CounterSchema,oldest_ready_at:OpsNullableText})),database:Type.Object({schema_bytes:Type.String(),budget_bytes:OpsNullableText,over_budget:Type.Union([Type.Boolean(),Type.Null()])}),disk:Type.Object({observed:Type.Boolean(),available_bytes:OpsNullableText,total_bytes:OpsNullableText,observed_at:OpsNullableText,reason:OpsNullableText,source:Type.Literal('configured_application_mount')})},{additionalProperties:false});
const MonitorAlertFields={key:Type.String(),severity:Type.Union(['warning','high','critical','resolved','unknown'].map(value=>Type.Literal(value))),subject:OpsNullableText,value:OpsNullableText};
const StorageMonitorSchema=Type.Object({state:Type.Union(['unobserved','observed','stale','degraded'].map(value=>Type.Literal(value))),last_error:OpsNullableText,
 alerts_total:CounterSchema,alerts:Type.Array(Type.Object(MonitorAlertFields),{maxItems:100}),events:Type.Array(Type.Object({...MonitorAlertFields,id:Type.String(),status:Type.String(),created_at:Type.String(),last_error:OpsNullableText}),{maxItems:20}),
 observation:Type.Union([Type.Null(),Type.Object({source:Type.Literal('postgres_catalog_estimates'),observed_at:Type.String(),schema_bytes:Type.String(),budget_bytes:OpsNullableText,delivery_configured:Type.Boolean(),bloat_bytes:Type.Null(),track_counts:Type.Boolean(),autovacuum_enabled:Type.Boolean(),stats_reset_at:OpsNullableText,table_count:CounterSchema,
 tables:Type.Array(Type.Object({table:Type.String(),bytes:Type.String(),live_estimate:OpsNullableText,dead_estimate:OpsNullableText,last_vacuum_at:OpsNullableText,last_analyze_at:OpsNullableText,autovacuum_enabled:Type.Boolean()}),{maxItems:500})})])});
export type StorageMonitorDto=Static<typeof StorageMonitorSchema>;
const OperationsRetentionSchema=Type.Object({storage_monitor:StorageMonitorSchema,as_of:Type.String(),policy:Type.Object({recent_days:CounterSchema,detail_days:CounterSchema,cutoff:Type.String()}),partitions:Type.Array(Type.Object({table:Type.String(),parent:Type.String(),bounds:Type.String(),rows_estimate:OpsNullableText,bytes:Type.String(),month:OpsNullableText}),{maxItems:240}),missing_partitions:Type.Array(Type.String()),truncated:Type.Boolean(),cleanup:Type.Object({pending:CounterSchema,running:CounterSchema,failed:CounterSchema,barriers:CounterSchema}),backup:Type.Object({state:Type.Literal('unobserved'),last_verified_at:Type.Null()}),maintenance:Type.Object({state:Type.Union(['unobserved','running','degraded','stale','observed'].map(value=>Type.Literal(value))),scope:Type.Union([Type.Literal('hook_details'),Type.Literal('hook_and_usage')]),phase:Type.String(),cutoff:OpsNullableText,last_success_at:OpsNullableText,next_run_at:OpsNullableText,retry_at:OpsNullableText,last_error:OpsNullableText,counters:Type.Record(Type.String(),CounterSchema)})},{additionalProperties:false});
const BackfillProgressSchema=Type.Object({users:CounterSchema,queuing_users:CounterSchema,completed_users:CounterSchema,paused_users:CounterSchema,expected_days:CounterSchema,verified_days:CounterSchema,not_queued_days:CounterSchema,failed_days:CounterSchema,pending_days:CounterSchema,meaning:Type.Literal('initial_window_verifications')},{additionalProperties:false});
const OperationsUsageSchema=Type.Object({model_check:Type.Union([ModelCheckSchema,Type.Null()]),reconciliation:Type.Union([UsageReconciliationSchema,Type.Null()]),backfill:Type.Union([BackfillProgressSchema,Type.Null()]),configured:Type.Boolean(),as_of:Type.String(),period:PeriodSchema,coverage:Type.Union([OfficialUsageSchema.properties.coverage,Type.Null()]),departments:Type.Object({records:OpsNullableCounter,matched:OpsNullableCounter,unmatched:OpsNullableCounter,match_ratio:RatioSchema}),rate_limit:Type.Object({observed:Type.Boolean(),paused:Type.Union([Type.Boolean(),Type.Null()]),paused_until:OpsNullableText,interval_ms:OpsNullableCounter}),jobs:Type.Array(Type.Object({kind:Type.String(),status:Type.String(),count:CounterSchema})),probes:Type.Array(Type.Object({state:Type.String(),count:CounterSchema})),conflicting_sessions:CounterSchema},{additionalProperties:false});
export type OperationsHealthDto=Static<typeof OperationsHealthSchema>;
export type OperationsRetentionDto=Static<typeof OperationsRetentionSchema>;
export type OperationsUsageDto=Static<typeof OperationsUsageSchema>;
export const operationsRoutes={
 health:{method:'get',path:'/api/v1/system/health',response:{200:result(OperationsHealthSchema),...failures}},
 retention:{method:'get',path:'/api/v1/system/retention',response:{200:result(OperationsRetentionSchema),...failures}},
 usageSync:{method:'get',path:'/api/v1/system/usage-sync',querystring:Type.Pick(AnalyticsQuerySchema,['from','to']),response:{200:result(OperationsUsageSchema),...failures}},
} as const;

export const CleanupRangeSchema=Type.Object({user_id:uuid(),from:Type.String({format:'date-time'}),to:Type.String({format:'date-time'})},{additionalProperties:false});
const CleanupCountsSchema=Type.Object({hook_project_observations:Type.Optional(CounterSchema),plugin_project_observations:Type.Optional(CounterSchema),project_observations:CounterSchema,project_links:CounterSchema,hook_events:CounterSchema,sessions:CounterSchema,declared_sessions:CounterSchema,official_days:CounterSchema},{additionalProperties:false});
const CleanupPreviewSchema=Type.Object({can_submit:Type.Boolean(),preview_id:uuid(),target:Type.Object({id:uuid(),email:Type.String(),name:Type.String()}),range:PeriodSchema,counts:CleanupCountsSchema,expires_at:Type.String({format:'date-time'})},{additionalProperties:false});
const CleanupSubmitSchema=Type.Object({...CleanupRangeSchema.properties,preview_id:uuid(),confirmation_email:Type.String({format:'email',maxLength:254})},{additionalProperties:false});
const CleanupQueuedSchema=Type.Object({job_id:uuid(),status:Type.String()},{additionalProperties:false});
const CleanupStatusSchema=Type.Object({created_at:Type.Optional(Type.String()),job_id:uuid(),status:Type.String(),phase:Type.String(),error_code:OpsNullableText,user_id:uuid(),target_email:Type.String(),current_email:Type.String(),current_name:Type.String(),from_at:Type.String(),to_at:Type.String(),progress:Type.Object({deleted_events:Type.Optional(CounterSchema),deleted_copies:Type.Optional(CounterSchema),journal_sessions:Type.Optional(CounterSchema),part:Type.Optional(CounterSchema),verify_part:Type.Optional(CounterSchema)},{additionalProperties:false})},{additionalProperties:false});
export type CleanupRangeDto=Static<typeof CleanupRangeSchema>;export type CleanupPreviewDto=Static<typeof CleanupPreviewSchema>;export type CleanupSubmitDto=Static<typeof CleanupSubmitSchema>;export type CleanupJobDto=Static<typeof CleanupStatusSchema>;
export const jobStatusRoute={method:'get',path:'/api/v1/jobs/:id',params:UserIdParamsSchema,response:{200:result(Type.Union([Type.Object({...ImportJobSchema.properties,id:uuid(),batch_id:uuid()},{additionalProperties:false}),CleanupStatusSchema])),...failures}} as const;
export const cleanupRoutes={list:{method:'get',path:'/api/v1/admin/cleanup/jobs',querystring:Type.Object({user_id:Type.Optional(uuid()),cursor:Type.Optional(Type.String({maxLength:4096}))},{additionalProperties:false}),response:{200:result(Type.Object({items:Type.Array(CleanupStatusSchema,{maxItems:20}),next_cursor:OpsNullableText})),...failures}},preview:{method:'post',path:'/api/v1/admin/cleanup/previews',body:CleanupRangeSchema,response:{200:result(CleanupPreviewSchema),...failures,503:ErrorSchema}},submit:{method:'post',path:'/api/v1/admin/cleanup/jobs',body:CleanupSubmitSchema,response:{202:result(CleanupQueuedSchema),...failures,503:ErrorSchema}},status:jobStatusRoute,resume:{method:'post',path:'/api/v1/admin/cleanup/jobs/:id/resume',params:UserIdParamsSchema,body:Type.Object({confirmation_email:Type.String({format:'email',maxLength:254})},{additionalProperties:false}),response:{202:result(CleanupQueuedSchema),...failures,503:ErrorSchema}}} as const;

const paths: Record<string, Record<string, unknown>> = {};
export const AdoptionQuerySchema=Type.Object({scope:Type.Optional(Type.Union([Type.Literal('self'),Type.Literal('organization')])),department_id:Type.Optional(uuid())},{additionalProperties:false});
export const AdoptionSchema=Type.Object({as_of:Type.String({format:'date-time'}),registered:CounterSchema,adopted:CounterSchema,pending:CounterSchema,suspended:CounterSchema,deleted:CounterSchema,adoption_rate:RatioSchema},{additionalProperties:false});
export type AdoptionDto=Static<typeof AdoptionSchema>;
export type AdoptionQuery=Static<typeof AdoptionQuerySchema>;
export const adoptionRoute={method:'get',path:'/api/v1/adoption',querystring:AdoptionQuerySchema,response:{200:result(AdoptionSchema),...failures}} as const;
export const RegistrationBodySchema = Type.Object({ email: Type.String({format:'email',maxLength:254}), password: Type.String({minLength:12,maxLength:128}), display_name: Type.String({minLength:1,maxLength:128}), department_id: uuid() }, {additionalProperties:false});
export type RegistrationBody = Static<typeof RegistrationBodySchema>;
export const ActivationBodySchema = Type.Object({department_id:Type.Optional(uuid())},{additionalProperties:false});
export type ActivationBody = Static<typeof ActivationBodySchema>;
export const registrationRoutes = {
  setup: {method:'get',path:'/api/v1/registration/setup',response:{200:result(Type.Object({departments:Type.Array(Type.Object({id:uuid(),name:Type.String()},{additionalProperties:false}),{maxItems:1000})},{additionalProperties:false})),...failures}},
  complete: {method:'post',path:'/api/v1/registration/complete',body:RegistrationBodySchema,response:{201:result(Type.Object({user_id:uuid()},{additionalProperties:false})),...failures,422:ErrorSchema,429:ErrorSchema}},
  activate: {method:'post',path:'/api/v1/registration/activate',body:ActivationBodySchema,response:{200:result(Type.Object({user_id:uuid()},{additionalProperties:false})),...failures,422:ErrorSchema}},
} as const;
const retiredMaterialPaths=new Set<string>([pluginRoutes.registration.path,clientDistributionRoutes.authorize.path,clientDistributionRoutes.online.path,clientDistributionRoutes.download.path]);
for (const route of [...Object.values(analysisRoutes), ...Object.values(pluginReleaseRoutes), ...Object.values(pluginAccessRoutes), ...Object.values(pluginRoutes), adoptionRoute, jobStatusRoute, meRoute, ...Object.values(registrationRoutes), ...Object.values(cleanupRoutes), ...Object.values(operationsRoutes), ...Object.values(projectInventoryRoutes), billingSimulationRoute, sessionTokenCheckRoute, ...Object.values(authRoutes), ...Object.values(organizationRoutes), ...Object.values(administrationRoutes), ...Object.values(importRoutes), ...Object.values(installationRoutes), ...Object.values(clientDistributionRoutes), ...Object.values(analyticsRoutes), ...Object.values(sessionRoutes), ...Object.values(usageMappingRoutes), ...Object.values(personalModelRoutes), ...Object.values(repositoryAllowlistRoutes)]) {
  if(route.path===jobStatusRoute.path&&route!==jobStatusRoute)continue;
  if(retiredMaterialPaths.has(route.path)||(route.path===pluginRoutes.removeProject.path&&route.method==='delete'))continue;
  const path = route.path.replace(/:([a-z_]+)/gi, '{$1}');
  (paths[path] ??= {})[route.method] = {
    security: route.path===pluginReleaseRoutes.current.path?[]:route.path===pluginReleaseRoutes.trial.path?[{pluginAccount:[]}]:(route.path===pluginReleaseRoutes.download.path||route.path===pluginReleaseRoutes.build.path)?[{}, {pluginAccount:[]}]:route.path === pluginAccessRoutes.download.path ? [{installationGrant:[]}] : (route.path===pluginRoutes.report.path&&route.method==='post') || (route.path.startsWith('/api/v1/plugin/')&&(Object.values(pluginAccessRoutes).some(value=>value.path===route.path)||route.path.startsWith('/api/v1/plugin/analysis/'))) ? [{pluginAccount:[]}] : route.path === authRoutes.login.path || route.path === registrationRoutes.setup.path || route.path === registrationRoutes.complete.path || route.path.startsWith('/api/v1/public/') ? [] : [{ session: [] }],
    ...('body' in route ? { requestBody: { required: true, content: { 'application/json': { schema: route.body } } } } : {}),
    ...('upload' in route ? {
      requestBody: {
        required: true,
        content: { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } } },
      },
    } : {}),
    parameters: [
      ...('params' in route ? Object.entries(route.params.properties).map(([name, schema]) => ({ name, in: 'path', required: true, schema })) : []),
      ...('querystring' in route ? Object.entries(route.querystring.properties).map(([name, schema]) => ({ name, in: 'query', required: route.querystring.required?.some(field => field === name) ?? false, schema })) : []),
      ...('headers' in route ? Object.entries(route.headers.properties).map(([name, schema]) => ({ name, in: 'header', required: true, schema })) : []),
      ...(!['get', 'head', 'options'].includes(route.method) && route.path !== authRoutes.login.path && !route.path.startsWith('/api/v1/plugin/') ? [{ name: 'X-CSRF-Token', in: 'header', required: true, schema: { type: 'string', minLength: 43, maxLength: 43 } }] : []),
    ],
    responses: { ...Object.fromEntries(Object.entries(route.response).map(([status, schema]) => [status, { description: status.startsWith('2') ? 'Success' : 'Error', ...(status === '204' ? {} : { content: { 'application/json': { schema } } }) }])), ...('download' in route ? { 200: { description: 'File download', content: { [route.download]: { schema: { type: 'string', format: 'binary' } } } } } : {}) },
  };
}
export const openApi = {
  openapi: '3.1.0', info: { title: 'AI Dev Insight API', version: '0.1.0' },
  paths,
  components: { securitySchemes: { pluginAccount:{type:'http',scheme:'bearer',description:'Permanent account plugin token: own retained session history and analysis packages, current-day summary, authenticated project reports and own Hook materials and authorized pilot plugin updates only; no Web login or management'}, installationGrant: { type: 'http', scheme: 'bearer', description: '30-minute installation download grant; cannot log in or report Hook events' }, session: { type: 'apiKey', in: 'cookie', name: 'adi_session' } }, schemas: { Me: MeSchema, ApiError: ErrorSchema, HookEnvelope: HookSchema } },
};

export { jsonBudgetFailure, HOOK_JSON_WIRE_BYTES, HOOK_JSON_EXPANDED_BYTES } from './json-budget.js';
