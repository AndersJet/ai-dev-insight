export type ManualRole='system-admin'|'anc-admin'|'department-admin'|'employee';
export const manualRole=(roles:readonly string[]):ManualRole=>roles.includes('super')?'system-admin':roles.includes('anc_admin')?'anc-admin':roles.includes('department_admin')?'department-admin':'employee';
export const manualPath=(roles:readonly string[])=>`/manual/${manualRole(roles)}`;
