<script setup lang="ts">
import BrandMark from '../components/BrandMark.vue';
import BrandScene from '../components/BrandScene.vue';
import { useRoute } from 'vue-router';
import { computed } from 'vue';
const route = useRoute();
const authentication = computed(() => ['/login', '/register', '/change-password'].includes(route.path));
</script>
<template>
  <div class="app-shell">
    <header><BrandMark /></header>
    <main :class="{ 'entry-layout': authentication }">
      <BrandScene v-if="authentication" />
      <slot />
    </main>
  </div>
</template>
