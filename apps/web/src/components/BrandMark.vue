<script setup lang="ts">
import brandIcon from '../assets/brand/ai-dev-insight-icon.png';
</script>
<template>
  <div class="app-brand">
    <img
      class="brand-symbol"
      :src="brandIcon"
      width="34"
      height="34"
      alt=""
    >
    <span>AI研发能效洞察平台<small>Ai Dev Insight</small></span>
  </div>
</template>
<style scoped>
.brand-symbol { display: block; object-fit: contain; background: transparent; box-shadow: none; }
</style>
