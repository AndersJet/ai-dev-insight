import { defineStore } from 'pinia';
export const useSessionNavigation = defineStore('session-navigation', {
  state: () => ({ owner: '', list: '', scroll: 0, restore: false, pages: {} as Record<string, string> }),
  actions: {
    forOwner(id: string) { if (this.owner !== id) { this.$reset(); this.owner = id; } },
    rememberPage(owner: string, key: string, path: string) {
      this.forOwner(owner);
      this.pages[key] = path;
      if (Object.keys(this.pages).length > 100) delete this.pages[Object.keys(this.pages)[0]!];
    },
    previous(owner: string, key: string): string | undefined { this.forOwner(owner); return this.pages[key]; },
    open(owner: string, path: string, scroll: number) {
      this.forOwner(owner); this.list = path; this.scroll = scroll; this.restore = true;
    },
    takeScroll(owner: string, path: string): number | null {
      this.forOwner(owner);
      if (!this.restore || this.list !== path) return null;
      this.restore = false;
      return this.scroll;
    },
    returnTo(owner: string, all: boolean, value: unknown): string {
      this.forOwner(owner);
      const prefix = all ? '/all/sessions' : '/my/sessions';
      const target = typeof value === 'string' && (value === prefix || value.startsWith(`${prefix}?`) || (all && /^\/code-flow(?:\?|$)/.test(value))) && !value.includes('\\') ? value : prefix;
      this.restore = this.list === target;
      return target;
    },
  },
});
