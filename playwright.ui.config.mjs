import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import process from 'node:process';
import {environment} from './apps/web/ui/environment.mjs';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export default defineConfig({
  testDir: './apps/web/ui', testMatch: '*.spec.mjs', workers: 1, retries: 0,
  timeout: 30_000, forbidOnly: !!process.env.CI,
  outputDir: `${environment.reportRoot}/ui-results`, reporter: [['list'], ['json', { outputFile: `${environment.reportRoot}/ui-results.json` }], ['junit', { outputFile: `${environment.reportRoot}/ui-junit.xml` }], ['html', { outputFolder: `${environment.reportRoot}/ui-report`, open: 'never' }]],
  use: { baseURL: environment.baseURL, viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure',
    launchOptions: process.platform === 'darwin' && existsSync(chrome) ? { executablePath: chrome } : {} },
  webServer: { command: 'pnpm --filter @adi/web dev', url: environment.baseURL, reuseExistingServer: false,
    env: { ADI_WEB_PORT: String(environment.port) }, gracefulShutdown: { signal: 'SIGTERM', timeout: 3000 } },
});
