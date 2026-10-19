<script setup lang="ts">
import collectionEmpty from '../assets/brand/collection-empty.webp';
import { useRouter } from 'vue-router';
import { useSession } from '../stores/session.js';
const session = useSession();
const router = useRouter();
</script>
<template>
  <div>
    <ElCard class="entry-card">
      <img
        :src="collectionEmpty"
        alt=""
        width="160"
        height="120"
        class="entry-illustration"
      >
      <h1>页面不存在或已移动</h1>
      <p
        v-if="session.loading"
        role="status"
      >
        正在检查登录状态…
      </p>
      <ElAlert
        v-else-if="session.error"
        :title="session.error"
        type="error"
        :closable="false"
      />
      <p v-else-if="session.user">
        当前地址无法找到对应页面。你可以返回工作空间，或使用导航前往有权访问的功能。
      </p>
      <p v-else>
        请登录后查看你的使用分析。
      </p>
      <ElButton
        v-if="session.user"
        type="primary"
        @click="router.replace(session.user.default_route)"
      >
        返回工作空间
      </ElButton>
      <ElButton
        :loading="session.loading"
        @click="session.refresh"
      >
        重新检查
      </ElButton>
    </ElCard>
  </div>
</template>
