import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import process from 'node:process';
import {environment,e2eArtifact} from './apps/web/e2e/helpers/environment.mjs';
const testDatabase=environment.databaseURL,cleanupJournal=e2eArtifact('e2e-cleanup-journal');
const httpOrigin = process.env.ADI_E2E_HTTP === 'true';
const localChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export default defineConfig({
  testDir: './apps/web/e2e',
  workers: 1, retries: 0, timeout: 30_000,
  forbidOnly: !!process.env.CI,
  outputDir: e2eArtifact('e2e-results'),
  reporter: [['list'], ['html', { outputFolder: e2eArtifact('e2e-report'), open: 'never' }], ['junit', { outputFile: e2eArtifact('e2e-junit.xml') }]],
  use: { baseURL: environment.webURL, trace: 'retain-on-failure', screenshot: 'only-on-failure',
    launchOptions: { ...(process.platform === 'darwin' && existsSync(localChrome) ? { executablePath: localChrome } : {}), ...(httpOrigin ? {args:['--host-resolver-rules=MAP adi-http.test 127.0.0.1','--no-proxy-server']} : {}) } },
  webServer: [
    { command: 'node apps/collector/dist/main.js', wait: { stdout: /collector_listening/ }, reuseExistingServer: false, timeout: 30_000,
      env: { NODE_ENV: 'test', ADI_DATABASE_URL: testDatabase, ADI_DATABASE_SCHEMA: environment.schema, ADI_COLLECTOR_PORT: String(environment.portBase+3) }, gracefulShutdown: { signal: 'SIGTERM', timeout: 12000 } },
    { command: 'node apps/worker/dist/main.js', wait: { stdout: /jobs_ready/ }, reuseExistingServer: false, timeout: 30_000,
      env: { NODE_ENV: 'test', ADI_DATABASE_URL: testDatabase, ADI_DATABASE_SCHEMA: environment.schema, ADI_EMAIL_DOMAINS: 'example.invalid', ADI_USAGE_PROVIDER_ACCOUNT:'e2e-official', ADI_USAGE_STOP_WINDOW_ENABLED:'true' }, gracefulShutdown: { signal: 'SIGTERM', timeout: 3000 } },
    { command:'node apps/worker/dist/cleanup-main.js',wait:{stdout:/cleanup_worker_ready/},reuseExistingServer:false,timeout:30000,env:{NODE_ENV:'test',ADI_DATABASE_URL:testDatabase,ADI_DATABASE_SCHEMA:environment.schema,ADI_EMAIL_DOMAINS:'example.invalid',ADI_CLEANUP_JOURNAL_DIR:cleanupJournal},gracefulShutdown:{signal:'SIGTERM',timeout:12000}},
    { command:'node apps/worker/dist/maintenance-main.js',wait:{stdout:/maintenance_ready/},reuseExistingServer:false,timeout:30000,env:{NODE_ENV:'test',ADI_DATABASE_URL:testDatabase,ADI_DATABASE_SCHEMA:environment.schema,ADI_MAINTENANCE_ENABLED:'true'},gracefulShutdown:{signal:'SIGTERM',timeout:12000}},
    { command: 'node apps/api/dist/main.js', url: environment.apiURL+'/api/v1/me', reuseExistingServer: false, timeout: 30_000,
      env: { NODE_ENV: httpOrigin ? 'production' : 'test', ADI_INSTALLATION_KEY_FILE:e2eArtifact('e2e-installation.key'), ADI_CLEANUP_JOURNAL_DIR:cleanupJournal, ADI_API_PORT: String(environment.portBase), ADI_DATABASE_URL: testDatabase, ADI_DATABASE_SCHEMA: environment.schema, ADI_EMAIL_DOMAINS: 'example.invalid,example.org', ADI_WEB_ORIGIN: httpOrigin ? environment.httpWebURL : environment.webURL, ADI_PUBLIC_COLLECTOR_URL: (httpOrigin ? environment.httpWebURL : environment.webURL)+'/hooks', ADI_USAGE_PROVIDER_ACCOUNT: 'e2e-official', ADI_USAGE_STOP_WINDOW_ENABLED:'true' }, gracefulShutdown: { signal: 'SIGTERM', timeout: 3000 } },
    { command: 'pnpm --filter @adi/web dev', url: environment.webURL+'/', reuseExistingServer: false, timeout: 30_000,
      env: { ADI_DEV_ALLOWED_HOSTS:'adi-http.test', ADI_WEB_PORT: String(environment.portBase+1), ADI_DEV_API_TARGET: environment.apiURL, ADI_DEV_COLLECTOR_TARGET: environment.collectorURL }, gracefulShutdown: { signal: 'SIGTERM', timeout: 3000 } },
  ],
});
