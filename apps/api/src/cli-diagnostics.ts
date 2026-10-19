const messages: Record<string, string> = {
  invalid_database_url: 'ADI_DATABASE_URL 格式无效，请检查连接串并对用户名和密码中的特殊字符进行 URL 编码。',
  independent_clean_dataset_required: '当前数据库包含旧版账号或使用数据，不能原地迁移。请保留原库，按 deploy/manual/README.md#dataset-rebuild 使用 dataset-rebuild-cli 准备独立干净目标，完成迁移与验收后再更新 ADI_DATABASE_SCHEMA。',
  migration_checksum_mismatch: '数据库迁移记录与当前迁移文件不一致，请检查代码版本和迁移完整性；保留原库，不要修改校验记录或删除历史表。',
  migration_schema_not_empty: '目标 schema 中存在不属于本项目迁移的表，请保留原 schema 并选择独立干净目标。',
  database_extension_required: '数据库缺少启动必需的 public 扩展，需要数据库管理员预先安装。',
  database_prompt_index_invalid: '提示词搜索索引未通过结构校验；检查当前迁移版本、索引有效性和 public.pg_trgm，不要修改历史迁移账本。',
  configuration_required: '缺少命令必需配置；初始化时检查数据库和管理员配置。',
  invalid_password: '配置管理员密码长度应为 12–128 个字符。',
  invalid_identity: '配置管理员身份格式无效，请检查邮箱配置。',
  invalid_email_domain: '管理员邮箱不属于允许域名，请核对 ADI_EMAIL_DOMAINS。',
  configuration_admin_email_conflict: '配置管理员邮箱与现有账号冲突，请核对账号和配置。',
  configuration_managed_account: '该账号由部署配置管理，请通过配置维护。',
  recovery_quarantined: '数据库处于恢复隔离状态，请完成恢复验收和解除隔离后重试。',
  already_initialized: '目标已初始化，请核对命令及目标。',
  installation_key_unavailable: '持久安装凭据密钥不可用；检查文件是否为 32 字节私有普通文件及读取权限，保留原密钥，不要删除或轮换。',
  ECONNREFUSED: '数据库拒绝连接，请检查实例是否运行及主机、端口配置。',
  ENOTFOUND: '无法解析数据库主机名，请检查配置和 DNS。',
  ETIMEDOUT: '数据库连接或操作超时，请检查网络连通性和数据库负载。',
  EHOSTUNREACH: '数据库主机不可达，请检查网络和路由。',
  ENETUNREACH: '数据库网络不可达，请检查网络连接。',
  '28P01': '数据库认证失败，请核对连接账号及密码。',
  '3D000': '配置的数据库不存在，请先由数据库管理员创建。',
  '42501': '数据库权限不足，请核对应用角色的 schema、表及扩展权限。',
  '55P03': '数据库锁等待超时，请检查并发初始化或阻塞事务后重试。',
  '57014': '数据库操作被取消或达到超时限制，请检查锁等待和数据库负载。',
  operation_failed: '操作失败；根据 stage 和 sqlstate 定位，未输出可能包含私有数据的原始错误。',
};
const extensionGuards = new Map([
  ['public.pg_trgm must be preinstalled by the database administrator', 'pg_trgm'],
  ['public.btree_gist must be preinstalled by the database administrator', 'btree_gist'],
]);
const indexGuards = new Set([
  'hook_prompt_trgm must be a valid prompt-only GIN index with the public.pg_trgm operator class',
  'hook_prompt_search_trgm must be the valid native normalized prompt-only GIN with public.pg_trgm',
]);

/** Exact owned guards and static descriptions only; never print SQL, detail or stack. */
export function cliDiagnostic(error: unknown): {error: string; message: string; sqlstate?: string; extension?: string; hint?: string} {
  const chain: Error[] = [];
  for (let current = error; current instanceof Error && chain.length < 5 && !chain.includes(current); current = current.cause) chain.push(current);
  for (const current of chain) {
    const code = 'code' in current && typeof current.code === 'string' ? current.code : '';
    const sqlstate = /^(?=.*[0-9])[0-9A-Z]{5}$/.test(code) ? code : undefined;
    const extension = code === '55000' ? extensionGuards.get(current.message) : undefined;
    if (extension) return {error: 'database_extension_required', message: messages.database_extension_required!, sqlstate:'55000', extension, hint: `请数据库管理员在目标数据库的 public schema 安装 ${extension} 后重试；不会自动创建扩展。`};
    if (code === '55000' && indexGuards.has(current.message)) return {error: 'database_prompt_index_invalid', message: messages.database_prompt_index_invalid!, sqlstate:'55000'};
    if (code === 'P0001' && current.message === 'independent_clean_dataset_required') return {error: 'independent_clean_dataset_required', message: messages.independent_clean_dataset_required!, sqlstate:'P0001'};
    if (code === 'migration_checksum_mismatch' && current.message !== code) continue;
    if (Object.hasOwn(messages, code) && !['database_extension_required','database_prompt_index_invalid','independent_clean_dataset_required','operation_failed'].includes(code)) return {error: code, message: messages[code]!, ...(sqlstate ? {sqlstate} : {})};
    if (current.message === 'installation_key_unavailable') return {error: 'installation_key_unavailable', message: messages.installation_key_unavailable!};
  }
  const code = chain.map(current => 'code' in current ? current.code : undefined).find(code => typeof code === 'string' && /^(?=.*[0-9])[0-9A-Z]{5}$/.test(code));
  return {error: 'operation_failed', message: messages.operation_failed!, ...(typeof code === 'string' ? {sqlstate: code} : {})};
}
