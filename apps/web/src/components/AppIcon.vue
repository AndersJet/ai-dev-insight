<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 18 });
// A single 24px grid and stroke weight keeps navigation and metric icons consistent.
const paths: Record<string, string> = {
  org: 'M4 20V10h4v10m4 0V4h4v16m4 0V8h2v12M2 20h20',
  my: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
  traces: 'M4 4h16v12H9l-5 4V4Zm4 4h8M8 12h5',
  flow: 'M6 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm12 14a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 8v6a5 5 0 0 0 5 5h4M6 14h7a5 5 0 0 0 5-5V3m-3 3 3-3 3 3',
  manage: 'M9 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm12 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM1 21v-4a5 5 0 0 1 10 0v4m2 0v-4a5 5 0 0 1 10 0v4',
  ops: 'M2 12h4l3-8 6 16 3-8h4',
  history: 'M3 7v5h5M3 12a9 9 0 1 1 3 7M12 7v5l3 2',
  manual: 'M3 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H3V4Zm18 0h-6a3 3 0 0 0-3 3v14a4 4 0 0 1 4-3h5V4Z',
  install: 'M8 2v6m8-6v6M5 8h14v3a7 7 0 0 1-14 0V8Zm7 10v4',
  shield: 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4Zm-4 10 3 3 5-6',
  database: 'M20 5c0 2-4 3-8 3s-8-1-8-3 4-3 8-3 8 1 8 3Zm-16 0v7c0 2 4 3 8 3s8-1 8-3V5M4 12v7c0 2 4 3 8 3s8-1 8-3v-7',
  workspace: 'M3 4h18v13H3V4Zm5 17h8m-4-4v4',
  repository: 'M3 5h7l2 3h9v12H3V5Zm5 8-2 2 2 2m8-4 2 2-2 2',
  prompt: 'M13 2 4 14h7l-1 8 10-13h-8l1-7Z',
  trend: 'M3 18 9 12l4 3 8-11m-6 0h6v6',
  purpose: 'M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z',
  refresh: 'M20 7a9 9 0 0 0-15-2L2 8m0-6v6h6m-4 9a9 9 0 0 0 15 2l3-3m0 6v-6h-6',
};
</script>
<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
    class="app-icon"
  ><path :d="paths[name] ?? paths.org" /></svg>
</template>
<style scoped>
.app-icon { flex-shrink: 0; vertical-align: middle; }
</style>
