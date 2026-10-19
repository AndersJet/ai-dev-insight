<script setup lang="ts">
import {computed,onMounted,onBeforeUnmount,ref} from 'vue';
import type {PluginReleaseDto} from '@adi/contracts';
import {request} from '../api/http.js';
const release=ref<PluginReleaseDto|null>(null),loading=ref(false),failed=ref(false);
let disposed=false;const controller=new window.AbortController();
const remoteIncluded=computed(()=>{if(!release.value)return false;const [major=0n,minor=0n,patch=0n]=release.value.version.split('.').map(BigInt);return major>1n||major===1n&&(minor>0n||patch>=5n);});
const path=computed(()=>release.value?`/api/v1/plugin-releases/builds/${release.value.build_id}/download`:'');
async function load(){if(loading.value)return;loading.value=true;failed.value=false;try{const r=await request<{data:PluginReleaseDto|null}>('/api/v1/plugin-releases/current','GET',undefined,{},controller.signal);if(disposed)return;const d=r.data;release.value=d&&d.channel==='stable'&&/^[a-f0-9]{64}$/.test(d.build_id)&&/^\d+\.\d+\.\d+$/.test(d.version)?d:null;}catch{if(!disposed){release.value=null;failed.value=true;}}finally{if(!disposed)loading.value=false;}}
onMounted(load);onBeforeUnmount(()=>{disposed=true;controller.abort();});
</script>
<template>
  <section
    class="plugin-download"
    aria-label="下载 IDE 插件"
  >
    <h3>安装 IDE 插件</h3>
    <p class="muted">
      只需下载并安装主插件，在插件中注册或登录。
    </p>
    <p class="muted">
      本地项目无需额外安装。
    </p>
    <p
      v-if="remoteIncluded"
      class="muted"
    >
      使用 Remote SSH 时，主插件侧栏会提供“一键安装配套助手”；助手已包含在主插件中，无需另外下载。
    </p>
    <p
      v-else-if="release"
      class="muted"
    >
      Remote SSH 支持需要 1.0.5 及以上版本。当前正式版尚未包含远端助手，请等待管理员发布新版。
    </p>
    <p
      v-else
      class="muted"
    >
      Remote SSH 功能从 1.0.5 提供；新版发布后，只需在主插件侧栏安装其内置助手。
    </p>
    <a
      v-if="release"
      class="el-button el-button--primary download-link"
      :href="path"
      download
    >下载正式版插件 {{ release.version }}</a>
    <p
      v-else
      class="muted"
    >
      {{ loading?'正在查询安装包…':failed?'插件下载暂不可用，请稍后重试。':'管理员尚未发布正式插件。' }}
    </p>
    <ElButton
      v-if="failed"
      link
      type="primary"
      @click="load"
    >
      重试
    </ElButton>
  </section>
</template>
<style scoped>
.plugin-download{margin:20px 0;padding:18px;border:1px solid var(--el-border-color);border-radius:var(--el-border-radius-base);background:var(--el-bg-color)}.plugin-download h3{margin:0 0 8px;font-size:var(--ui-font-body)}.plugin-download p{font-size:var(--ui-font-small);line-height:1.6;margin:8px 0 14px}.download-link{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-height:var(--ui-button-height);padding:0 15px;border-radius:var(--ui-control-radius);background:var(--ui-action-fill);color:var(--el-color-white);font-size:var(--ui-font-body);text-decoration:none;max-width:100%;overflow-wrap:anywhere}.download-link:focus-visible{outline:2px solid var(--el-color-primary);outline-offset:3px}
</style>
