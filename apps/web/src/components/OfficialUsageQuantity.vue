<script setup lang="ts">
import { computed } from 'vue';
import type { OfficialTokenQuantityDto } from '@adi/contracts';
const props=defineProps<{ quantity?: OfficialTokenQuantityDto | undefined; records?: number }>();
const knownOnly=computed(()=>props.quantity?.tokens===null&&props.quantity.missing_token_records>0&&(props.records??0)>props.quantity.missing_token_records);
const format = (value: string | null | undefined) => value == null ? '—' : BigInt(value).toLocaleString('zh-CN');
</script>
<template>
  <span class="official-quantity">
    <span>{{ knownOnly?`已知 ${format(quantity?.known_tokens)}`:quantity?.tokens==null&&records?'未提供':format(quantity?.tokens) }}</span>
    <span
      v-if="knownOnly && quantity?.missing_token_records"
      class="quantity-detail"
    >数据不完整 · 已知部分 {{ format(quantity.known_tokens) }}（缺 {{ quantity.missing_token_records }} 条）</span>

  </span>
</template>
<style scoped>
.official-quantity{overflow-wrap:anywhere}.quantity-detail{display:block;font-size:var(--ui-font-small);font-weight:normal;line-height:1.7;color:var(--el-text-color-secondary)}
</style>
