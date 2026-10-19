import {createPluginReleaseService,type PluginReleaseService} from '@adi/domain';
import type {PluginBackend} from './plugin-tracking.js';
import {createRepositoryAllowlistService,type RepositoryAllowlistService} from '@adi/domain';
import { loadInstallationKey } from './installation-key.js';
import {createAdoptionService,type AdoptionService} from '@adi/domain';
import { createRegistrationService, type RegistrationService } from '@adi/domain';
import {createCleanupService,type CleanupService} from '@adi/domain';
import {createCleanupJournal} from '@adi/storage';
import {createOperationsService,type OperationsService} from '@adi/domain';
import {createDiskObserver} from './disk-observer.js';
import {createProjectInventoryService,type ProjectInventoryService} from '@adi/domain';
import { createIdentityService, createOrganizationService, createAdministrationService, createMemberImportService, createInstallationService, type IdentityService, type OrganizationService, type AdministrationService, type MemberImportService, type InstallationService } from '@adi/domain';
import { openDatabase, type Database } from '@adi/storage';
import { createSessionReadService, type SessionReadService, createUsageMappingService, type UsageMappingService, createAnalyticsService, type AnalyticsService } from '@adi/domain';
import { createSessionPersonalModelService,type SessionPersonalModelService } from '@adi/domain';
import {createSessionListSnapshotReader} from '@adi/domain';

export function configuredServices(): { pluginReleases:PluginReleaseService; plugin:PluginBackend; repositoryAllowlist:RepositoryAllowlistService; adoption: AdoptionService; registration: RegistrationService; cleanup:CleanupService; operations:OperationsService; db: Database; identity: IdentityService; organization: OrganizationService; administration: AdministrationService; imports: MemberImportService; installations: InstallationService; analytics: AnalyticsService; usageMappings: UsageMappingService; sessions: SessionReadService; warmSessionList:()=>Promise<string>; sessionModels:SessionPersonalModelService;codeFlow:ProjectInventoryService } | null {
  const url = process.env.ADI_DATABASE_URL;
  if (!url) return null;
  const stopWindow=process.env.ADI_USAGE_STOP_WINDOW_ENABLED??'false';
  if(!['true','false'].includes(stopWindow))throw new Error('Invalid usage configuration');
  const db = openDatabase({ connectionString: url, schema: process.env.ADI_DATABASE_SCHEMA ?? 'adi' });
  const identity = createIdentityService(db, { emailDomains: (process.env.ADI_EMAIL_DOMAINS ?? '').split(',') });
  const usageOptions=process.env.ADI_USAGE_PROVIDER_ACCOUNT?{providerAccount:process.env.ADI_USAGE_PROVIDER_ACCOUNT}:{};
  const snapshotReader=createSessionListSnapshotReader(db,{...usageOptions,stopWindowEnabled:stopWindow==='true'});
  const signingKey=loadInstallationKey(process.env.ADI_INSTALLATION_KEY_FILE);
  return { pluginReleases:createPluginReleaseService(db,identity), plugin:{db,signingKey,...usageOptions,snapshots:snapshotReader,stopWindowEnabled:stopWindow==='true'}, db, identity, warmSessionList:snapshotReader.warm, repositoryAllowlist:createRepositoryAllowlistService(db,identity), adoption:createAdoptionService(db,identity), registration: createRegistrationService(db,identity), cleanup:createCleanupService(db,identity,{...(process.env.ADI_CLEANUP_JOURNAL_DIR?{journal:createCleanupJournal(process.env.ADI_CLEANUP_JOURNAL_DIR)}:{})}), operations:createOperationsService(db,identity,{...usageOptions,...(process.env.ADI_STORAGE_BUDGET_BYTES?{storageBudgetBytes:process.env.ADI_STORAGE_BUDGET_BYTES}:{}),...(process.env.ADI_STORAGE_OBSERVER_PATH?{diskObserver:createDiskObserver(process.env.ADI_STORAGE_OBSERVER_PATH)}:{})}), codeFlow:createProjectInventoryService(db,identity), organization: createOrganizationService(db, identity), administration: createAdministrationService(db, identity), imports: createMemberImportService(db, identity), installations: createInstallationService(db, identity, { encryptionKey: signingKey }), analytics: createAnalyticsService(db, identity, usageOptions), usageMappings:createUsageMappingService(db,identity,usageOptions), sessions: createSessionReadService(db, identity,{...usageOptions,stopWindowEnabled:stopWindow==='true',snapshots:snapshotReader}),sessionModels:createSessionPersonalModelService(db,identity) };
}
