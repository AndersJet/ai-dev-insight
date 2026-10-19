import {join} from 'node:path';

/** Stable coordination and private backups, outside both replaceable runtime roots. */
export const environmentRecoveryDirectory=(profile:string)=>join(profile,'adi-environment-recovery');
