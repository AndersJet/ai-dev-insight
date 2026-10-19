import { inject, type InjectionKey, type Ref } from 'vue';
import type { DepartmentDto } from '@adi/contracts';
export interface Directory { items: Ref<DepartmentDto[]>; loading: Ref<boolean>; error: Ref<string>; refresh: () => Promise<void> }
export const directoryKey: InjectionKey<Directory> = Symbol('department-directory');
export function useDirectory() { const value = inject(directoryKey); if (!value) throw new Error('Workspace directory is required'); return value; }
