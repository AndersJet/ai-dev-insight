import { defineStore } from 'pinia';
import { ref } from 'vue';
export type AnalysisPeriod = { from: string; to: string };
export const useAnalysisPeriod = defineStore('analysis-period', () => {
  const owner = ref(''); const period = ref<AnalysisPeriod | null>(null);
  function setOwner(value: string) { if (owner.value !== value) { owner.value = value; period.value = null; } }
  function remember(value: AnalysisPeriod) { period.value = value; }
  function clear() { period.value = null; }
  return { owner, period, setOwner, remember, clear };
});
