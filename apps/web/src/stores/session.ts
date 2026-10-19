import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { CurrentUser } from '@adi/contracts';
import * as api from '../api/session.js';
export const useSession = defineStore('session', () => {
  const user = ref<CurrentUser | null>(null);
  const loading = ref(false);
  const error = ref('');
  const initialized = ref(false);
  let generation = 0;
  let authentication: AbortController | undefined;
  function message(reason: unknown) { return reason instanceof api.ApiFailure ? reason.message : '连接暂时不可用，请稍后重试'; }
  async function refresh() {
    authentication?.abort();
    const current = ++generation; loading.value = true; error.value = '';
    try { const result = await api.getMe(); if (current === generation) user.value = result?.data ?? null; }
    catch (reason) { if (current === generation) { error.value = message(reason); user.value = null; } }
    finally { if (current === generation) { loading.value = false; initialized.value = true; } }
  }
  async function authenticate(action: (signal:AbortSignal) => ReturnType<typeof api.login>, signal?:AbortSignal) {
    authentication?.abort();
    const controller = new AbortController(); authentication = controller;
    const cancel = () => controller.abort();
    signal?.addEventListener('abort',cancel,{once:true});
    if(signal?.aborted)controller.abort();
    const current = ++generation; loading.value = true; error.value = '';
    try {
      const result = await action(controller.signal);
      if (current !== generation || controller.signal.aborted) throw new api.ApiFailure(0, 'superseded', '该操作已被新的操作取代');
      user.value = result.data; return result.data;
    } catch (reason) { if (current === generation && !controller.signal.aborted) error.value = message(reason); throw reason; }
    finally { signal?.removeEventListener('abort',cancel); if(authentication===controller)authentication=undefined; if (current === generation) { loading.value = false; initialized.value = true; } }
  }
  const login = (email: string, password: string, signal?:AbortSignal) => authenticate(requestSignal => api.login(email, password, requestSignal),signal);
  const changePassword = (currentPassword: string, newPassword: string, signal?:AbortSignal) => authenticate(requestSignal => api.changePassword(currentPassword, newPassword, requestSignal),signal);
  async function logout() {
    authentication?.abort();
    const current = ++generation; loading.value = true; error.value = '';
    try { await api.logout(); if (current === generation) user.value = null; }
    catch (reason) { if (current === generation) { if (reason instanceof api.ApiFailure && reason.status === 401) user.value = null; else { error.value = message(reason); throw reason; } } }
    finally { if (current === generation) { loading.value = false; initialized.value = true; } }
  }
  return { user, loading, error, initialized, refresh, login, changePassword, logout };
});
