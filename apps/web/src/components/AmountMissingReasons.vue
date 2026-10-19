<script setup lang="ts">
import type { AmountMissingReasonDto } from '@adi/contracts';
defineProps<{ reasons: AmountMissingReasonDto[] }>();
const labels: Record<AmountMissingReasonDto['reason'], string> = {
  missing: '未返回金额字段',
  null: '金额字段为空',
  not_priced: '来源标记未计价',
  currency_missing: '未提供币种',
  unknown: '金额缺失原因未知',
};
</script>
<template>
  <span
    v-for="item in reasons"
    :key="item.reason"
    class="secondary"
  >{{ labels[item.reason] }}：{{ item.records }} 条</span>
</template>
