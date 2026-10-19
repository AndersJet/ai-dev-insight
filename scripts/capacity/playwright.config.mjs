import {defineConfig} from '@playwright/test';
import base from '../../playwright.config.mjs';
import {environment} from '../../apps/web/e2e/helpers/environment.mjs';
import {fileURLToPath,URL} from 'node:url';
const cwd=fileURLToPath(new URL('../../',import.meta.url));

// Explicit local benchmark: excluded from the ordinary 25-test browser suite.
export default defineConfig({...base,testDir:'.',testMatch:'detail.spec.mjs',timeout:180000,
 outputDir:'../../.run/detail-capacity-results',
 reporter:[['list'],['junit',{outputFile:'.run/detail-capacity-junit.xml'}]],
 webServer:base.webServer.map(server=>({...server,cwd,...(server.command==='pnpm --filter @adi/web dev'
  ? {command:'pnpm --filter @adi/web exec vite preview --host 127.0.0.1 --port '+(environment.portBase+1)+' --strictPort'}:{})})),
});
