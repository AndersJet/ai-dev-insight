import { test as base, expect } from '@playwright/test';

export const test = base.extend<{ browserErrors: void }>({
  browserErrors: [async ({ page }, use) => {
    const errors: string[] = [];
    const capture = (error: Error) => errors.push(error.message);
    page.on('pageerror', capture);
    await page.exposeFunction('__adiRecordRuntimeError', (message: string) => errors.push(message));
    await page.addInitScript(() => {
      window.addEventListener('error', event => {
        const monitor = window as unknown as { __adiRecordRuntimeError: (message: string) => Promise<void> };
        void monitor.__adiRecordRuntimeError(event.message);
      });
    });
    try {
      await use();
      if (!page.isClosed()) await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(errors, 'Browser runtime errors must not be hidden by passing UI assertions').toEqual([]);
    } finally {
      page.off('pageerror', capture);
    }
  }, { auto: true }],
});
export { expect };
