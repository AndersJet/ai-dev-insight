import process from 'node:process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';

const systemKeys = ['PATH','HOME','USER','TMPDIR','TEMP','TMP','SystemRoot','COMSPEC','PATHEXT','PNPM_HOME','COREPACK_HOME','LANG','LC_ALL','TERM'];
export function loadEnvironment(inherited = process.env) {
  const path = resolve(inherited.ENV_FILE || '.env');
  let fromFile;
  try { fromFile = parseEnv(readFileSync(path, 'utf8')); }
  catch { throw new Error('environment_file_unreadable'); }
  const env = { ...fromFile, ...inherited };
  const defaults = { ADI_DATABASE_SCHEMA: 'adi', ADI_EMAIL_DOMAINS: '', ADI_API_PORT: '4180', ADI_WEB_PORT: '4181', ADI_COLLECTOR_PORT: '4186', ADI_USAGE_ENABLED: 'false', ADI_CLEANUP_JOURNAL_DIR: resolve('.local/cleanup-journal') };
  for (const [key, value] of Object.entries(defaults)) env[key] ??= value;
  env.ADI_WEB_ORIGIN ??= `http://127.0.0.1:${env.ADI_WEB_PORT}`;
  env.ADI_DEV_API_TARGET ??= `http://127.0.0.1:${env.ADI_API_PORT}`;
  env.ADI_DEV_COLLECTOR_TARGET ??= `http://127.0.0.1:${env.ADI_COLLECTOR_PORT}`;
  env.ADI_PUBLIC_COLLECTOR_URL ??= `${env.ADI_WEB_ORIGIN}/hooks`;
  return env;
}
export function environmentFor(env, role) {
  const common = ['ADI_DATABASE_URL','ADI_DATABASE_SCHEMA','NODE_ENV'];
  const keys = {
    build: [], web: ['ADI_WEB_PORT','ADI_DEV_API_TARGET','ADI_DEV_COLLECTOR_TARGET','NODE_ENV'],
    init: [...common,'ADI_EMAIL_DOMAINS','ADI_ADMIN_EMAIL','ADI_ADMIN_PASSWORD','ADI_INSTALLATION_KEY_FILE','ADI_DEV_RUN_ID'],
    api: [...common,'ADI_EMAIL_DOMAINS','ADI_API_HOST','ADI_API_PORT','ADI_WEB_ORIGIN','ADI_PUBLIC_COLLECTOR_URL','ADI_CLEANUP_JOURNAL_DIR','ADI_USAGE_PROVIDER_ACCOUNT','ADI_USAGE_STOP_WINDOW_ENABLED','ADI_STORAGE_BUDGET_BYTES','ADI_STORAGE_OBSERVER_PATH','ADI_CLIENT_RELEASE_DIR','ADI_INSTALLATION_KEY_FILE'],
    collector: [...common,'ADI_COLLECTOR_HOST','ADI_COLLECTOR_PORT'],
    worker: [...common,'ADI_EMAIL_DOMAINS','ADI_CLEANUP_JOURNAL_DIR','ADI_USAGE_ENABLED','ADI_USAGE_PROVIDER_ACCOUNT','ADI_USAGE_DISCOVERY','ADI_USAGE_STOP_WINDOW_ENABLED','ADI_USAGE_MIN_INTERVAL_MS','TRAE_OPENAPI_BASE_URL','TRAE_OPENAPI_APP_ID','TRAE_OPENAPI_APP_SECRET','ADI_STORAGE_BUDGET_BYTES','ADI_ALERT_WEBHOOK_URL','ADI_ALERT_WEBHOOK_TOKEN','ADI_DEV_RUN_ID'],
  }[role];
  if (!keys) throw new Error('unknown_process_role');
  return Object.fromEntries([...systemKeys, ...keys].filter(key => env[key] !== undefined).map(key => [key, env[key]]));
}
