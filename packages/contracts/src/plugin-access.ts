import { OfficialUsageCountersSchema } from './official-usage-counters.js';
import {Type,type Static} from '@sinclair/typebox';
const uuid=()=>Type.String({format:'uuid'}),date=()=>Type.String({format:'date-time'});
const optionalText=Type.Union([Type.String(),Type.Null()]);
const empty=Type.Object({},{additionalProperties:false});
const meta=Type.Object({request_id:Type.String()},{additionalProperties:false});
const result=(data:import('@sinclair/typebox').TSchema)=>Type.Object({data,meta},{additionalProperties:false});
const failure=Type.Object({error:Type.Object({code:Type.String(),message:Type.String(),request_id:Type.String()},{additionalProperties:false})},{additionalProperties:false});
const failures={400:failure,401:failure,403:failure,409:failure,410:failure,422:failure,429:failure,503:failure};
export const PluginCollectorSchema=Type.Object({collector_id:uuid(),source_config_id:uuid(),platform:Type.Union([Type.Literal('windows'),Type.Literal('macos'),Type.Literal('linux')]),plugin_version:Type.String(),created_at:date(),last_seen:Type.Union([date(),Type.Null()])},{additionalProperties:false});
export const PluginCredentialStatusSchema=Type.Object({credential:Type.Union([Type.Object({created_at:date()},{additionalProperties:false}),Type.Null()]),sources:Type.Array(PluginCollectorSchema)},{additionalProperties:false});
export type PluginCredentialStatusDto=Static<typeof PluginCredentialStatusSchema>;
export const PluginCredentialSchema=Type.Object({api_token:Type.String({pattern:'^adi_api_v2\\.[A-Za-z0-9_-]{43}$'}),user_id:uuid(),email:Type.String({format:'email'}),created_at:date()},{additionalProperties:false});
export type PluginCredentialDto=Static<typeof PluginCredentialSchema>;
export const PluginSourceRegistrationSchema=Type.Object({source_secret:Type.String({pattern:'^[A-Za-z0-9_-]{43}$'}),source_config_id:uuid(),platform:PluginCollectorSchema.properties.platform,plugin_version:Type.String({pattern:'^[0-9]+\\.[0-9]+\\.[0-9]+$',maxLength:32})},{additionalProperties:false});
export type PluginSourceRegistration=Static<typeof PluginSourceRegistrationSchema>;
const boundSource=Type.Object({collector_id:uuid(),source_config_id:uuid(),user_id:uuid(),email:Type.String({format:'email'})},{additionalProperties:false});
const coverage=Type.Object({complete:Type.Boolean(),expected_user_days:Type.Integer({minimum:0}),verified_user_days:Type.Integer({minimum:0}),missing_user_days:Type.Integer({minimum:0}),invalidated_user_days:Type.Integer({minimum:0}),refreshing_user_days:Type.Integer({minimum:0}),oldest_verified_at:Type.Union([date(),Type.Null()])},{additionalProperties:false});
const quantity=Type.Union([Type.String({pattern:'^[0-9]+$'}),Type.Null()]);
export const PluginTodaySchema=Type.Object({business_date:Type.String({format:'date'}),timezone:Type.Literal('Asia/Shanghai'),period:Type.Object({from:date(),to:date()},{additionalProperties:false}),as_of:date(),today_in_progress:Type.Literal(true),official_chat_tokens:quantity,official_cue_tokens:quantity,official_chat_usage:Type.Optional(OfficialUsageCountersSchema),official_cue_usage:Type.Optional(OfficialUsageCountersSchema),official_configured:Type.Boolean(),official_coverage:coverage,hook_sessions:Type.Integer({minimum:0}),prompt_turns:Type.Integer({minimum:0}),content_estimate_tokens:quantity,content_estimate_reason:Type.Union([Type.Literal('projection_pending'),Type.Literal('no_observations'),Type.Null()]),cleanup_generation:Type.Integer({minimum:0}),partial_history:Type.Boolean(),baseline_at:optionalText},{additionalProperties:false});
export type PluginTodayDto=Static<typeof PluginTodaySchema>;
export const PluginCollectionGrantSchema=Type.Object({authorization:Type.String(),expires_at:date(),installation_id:uuid(),download_path:Type.Literal('/api/v1/plugin/collection-client'),sha256:Type.String({pattern:'^[a-f0-9]{64}$'}),bytes:Type.Integer({minimum:1,maximum:4*1024*1024}),version:Type.String(),endpoint:Type.String({format:'uri'})},{additionalProperties:false});
export type PluginCollectionGrantDto=Static<typeof PluginCollectionGrantSchema>;
export const PluginCollectionSetupSchema=Type.Object({collector_url:Type.String({format:'uri'}),client:Type.Object({version:Type.String(),runtime:Type.Literal('system'),platforms:Type.Array(PluginCollectorSchema.properties.platform),channel:Type.Union([Type.Literal('preview'),Type.Literal('stable')]),file_name:Type.String(),sha256:Type.String({pattern:'^[a-f0-9]{64}$'}),bytes:Type.Integer({minimum:1,maximum:4*1024*1024})},{additionalProperties:false})},{additionalProperties:false});
export const pluginAccessRoutes={
  credentialStatus:{method:'get',path:'/api/v1/me/plugin-credential',response:{200:result(PluginCredentialStatusSchema),...failures}},
  credential:{method:'post',path:'/api/v1/me/plugin-credential',body:empty,response:{200:result(PluginCredentialSchema),...failures}},
  me:{method:'get',path:'/api/v1/plugin/me',querystring:empty,response:{200:result(Type.Object({user_id:uuid(),email:Type.String({format:'email'}),display_name:Type.String(),registered:Type.Literal(true)},{additionalProperties:false})),...failures}},
  source:{method:'post',path:'/api/v1/plugin/sources',body:PluginSourceRegistrationSchema,response:{200:result(boundSource),...failures}},
  today:{method:'get',path:'/api/v1/plugin/today',querystring:empty,response:{200:result(PluginTodaySchema),...failures}},
  grant:{method:'post',path:'/api/v1/plugin/collection-grant',body:empty,response:{200:result(PluginCollectionGrantSchema),...failures}},
  setup:{method:'get',path:'/api/v1/plugin/collection-setup',querystring:empty,response:{200:result(PluginCollectionSetupSchema),...failures}},
  download:{method:'get',path:'/api/v1/plugin/collection-client',querystring:empty,download:'application/zip',response:{...failures}},
} as const;
