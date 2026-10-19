import { ref, watch } from 'vue';

/** Keep SVG coordinates in CSS pixels so axis text does not shrink with the chart. */
export function useChartWidth() {
  const chart = ref<SVGSVGElement | null>(null);
  const width = ref(610);
  watch(chart, (element, _previous, cleanup) => {
    if (!element) return;
    const measure = () => {
      const measured = Math.round(element.getBoundingClientRect().width);
      if (measured > 0) width.value = measured;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    cleanup(() => observer.disconnect());
  }, { flush: 'post' });
  return { chart, width };
}
