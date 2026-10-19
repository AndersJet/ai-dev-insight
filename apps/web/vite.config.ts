import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
// Concurrent local previews use different ports; keep their dependency caches separate.
export default defineConfig({ cacheDir: `node_modules/.vite-${Number(process.env.ADI_WEB_PORT ?? 4181)}`, plugins: [vue()], server: { allowedHosts: (process.env.ADI_DEV_ALLOWED_HOSTS ?? '').split(',').filter(Boolean), port: Number(process.env.ADI_WEB_PORT ?? 4181), strictPort: true, proxy: { '/api': process.env.ADI_DEV_API_TARGET ?? 'http://127.0.0.1:4180', '/hooks': process.env.ADI_DEV_COLLECTOR_TARGET ?? 'http://127.0.0.1:4186' } } });
