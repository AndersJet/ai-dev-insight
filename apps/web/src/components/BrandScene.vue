<script setup lang="ts">
import insightFlow from '../assets/brand/insight-flow.webp';
import AppIcon from './AppIcon.vue';
</script>
<template>
  <section
    class="brand-scene"
    aria-label="平台介绍"
  >
    <div class="brand-scene-copy">
      <span class="brand-kicker">AI DEV INSIGHT</span>
      <h2>让研发使用数据<br>成为有依据的洞察。</h2>
      <p>连接个人实践与组织视角，清晰呈现使用、用量与采纳进展。</p>
    </div>
    <img
      :src="insightFlow"
      alt=""
      class="brand-scene-image"
      fetchpriority="high"
      width="1774"
      height="887"
    >
    <div class="brand-scene-principles">
      <span><AppIcon name="org" />组织与个人视角</span>
      <span><AppIcon name="database" />清晰的数据口径</span>
      <span><AppIcon name="shield" />按角色管理访问</span>
    </div>
  </section>
</template>
