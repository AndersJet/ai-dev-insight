import {Type,type Static} from '@sinclair/typebox';
import {ProjectRemoteSchema,ProjectRepositoryClassificationSchema,ProjectProbeReasonSchema} from './project-observation.js';

export const PluginRegistrationSchema=Type.Object({
  nt_email:Type.String({format:'email',maxLength:254}),
  source_secret:Type.String({pattern:'^[A-Za-z0-9_-]{43}$'}),
  source_config_id:Type.String({format:'uuid'}),
  platform:Type.Union([Type.Literal('macos'),Type.Literal('windows'),Type.Literal('linux')]),
  plugin_version:Type.String({pattern:'^[0-9]+\\.[0-9]+\\.[0-9]+$',maxLength:32}),
},{additionalProperties:false});
export type PluginRegistration=Static<typeof PluginRegistrationSchema>;
export const PluginObservationSchema=Type.Object({
  schema_version:Type.Literal(2),collector_id:Type.String({format:'uuid'}),nt_email:PluginRegistrationSchema.properties.nt_email,
  source_config_id:Type.String({format:'uuid'}),observation_id:Type.String({format:'uuid'}),sequence:Type.String({pattern:'^[1-9][0-9]{0,18}$'}),
  platform:PluginRegistrationSchema.properties.platform,workspace_path:Type.String({minLength:1,maxLength:4096}),
  observed_at:Type.String({format:'date-time'}),state:Type.Union(['repository','not_git','no_remote','failed','unknown'].map(value=>Type.Literal(value))),
  reason:Type.Union([ProjectProbeReasonSchema,Type.Null()]),git_root:Type.Union([Type.String({minLength:1,maxLength:4096}),Type.Null()]),
  remotes:Type.Array(ProjectRemoteSchema,{maxItems:64}),plugin_version:PluginRegistrationSchema.properties.plugin_version,
},{additionalProperties:false});
export type PluginObservation=Static<typeof PluginObservationSchema>;
export const PluginQuerySchema=Type.Object({
  project_id:Type.Optional(Type.String({format:'uuid'})),user_id:Type.Optional(Type.String({format:'uuid'})),
  nt_email:Type.Optional(PluginRegistrationSchema.properties.nt_email),collector_id:Type.Optional(Type.String({format:'uuid'})),
  department_id:Type.Optional(Type.String({format:'uuid'})),
  workspace_path:Type.Optional(Type.String({maxLength:4096})),workspace_key:Type.Optional(Type.String({pattern:'^[a-f0-9]{64}$'})),
  search:Type.Optional(Type.String({maxLength:128})),from:Type.Optional(Type.String({format:'date-time'})),to:Type.Optional(Type.String({format:'date-time'})),
  page:Type.Optional(Type.Integer({minimum:1,maximum:100000})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100})),
},{additionalProperties:false});
export type PluginQuery=Static<typeof PluginQuerySchema>;
export const PluginProjectDeleteSchema=Type.Object({
  nt_email:PluginRegistrationSchema.properties.nt_email,collector_id:Type.String({format:'uuid'}),workspace_key:Type.String({pattern:'^[a-f0-9]{64}$'}),
},{additionalProperties:false});
export type PluginProjectDelete=Static<typeof PluginProjectDeleteSchema>;
const PluginProjectDeleteResultSchema=Type.Object({deleted_observations:Type.Integer({minimum:0})},{additionalProperties:false});
export type PluginRecord=Omit<PluginObservation,'schema_version'|'remotes'>&{remotes:Static<typeof ProjectRepositoryClassificationSchema>[];workspace_key:string;received_at:string};
export const PluginLinkedUserSchema=Type.Object({
  user_id:Type.String({format:'uuid'}),name:Type.String(),email:Type.String({format:'email'}),
  account_status:Type.Union([Type.Literal('active'),Type.Literal('suspended'),Type.Literal('deleted')]),
  department_id:Type.Union([Type.String({format:'uuid'}),Type.Null()]),department_name:Type.Union([Type.String(),Type.Null()]),
},{additionalProperties:false});
export type PluginLinkedUser=Static<typeof PluginLinkedUserSchema>;
export interface PluginProject {nt_email:string;collector_id:string;workspace_key:string;workspace_path:string;platform:'macos'|'windows'|'linux';linked_user:PluginLinkedUser|null;latest:PluginRecord|null;confirmed:PluginRecord|null;user_id?:string;project_id?:string;current_available?:boolean;history_only?:boolean;retained_observations?:number}
export interface PluginPage<T> {items:T[];total:number;page:number;limit:number;has_more:boolean}
const Meta=Type.Object({request_id:Type.String()},{additionalProperties:false});
const Result=(data:import('@sinclair/typebox').TSchema)=>Type.Object({data,meta:Meta},{additionalProperties:false});
const ErrorResponse=Type.Object({error:Type.Object({code:Type.String(),message:Type.String(),request_id:Type.String()},{additionalProperties:false})},{additionalProperties:false});
const Failures={400:ErrorResponse,401:ErrorResponse,403:ErrorResponse,409:ErrorResponse,413:ErrorResponse,422:ErrorResponse,429:ErrorResponse,500:ErrorResponse,503:ErrorResponse};
export const PluginRecordSchema=Type.Object({...Type.Omit(PluginObservationSchema,['schema_version','remotes']).properties,remotes:Type.Array(ProjectRepositoryClassificationSchema,{maxItems:64}),workspace_key:Type.String(),received_at:Type.String({format:'date-time'})},{additionalProperties:false});
export const PluginProjectSchema=Type.Object({nt_email:Type.String(),collector_id:Type.String({format:'uuid'}),workspace_key:Type.String(),workspace_path:Type.String(),platform:PluginRegistrationSchema.properties.platform,linked_user:Type.Union([PluginLinkedUserSchema,Type.Null()]),latest:Type.Union([PluginRecordSchema,Type.Null()]),confirmed:Type.Union([PluginRecordSchema,Type.Null()]),user_id:Type.Optional(Type.String({format:'uuid'})),project_id:Type.Optional(Type.String({format:'uuid'})),current_available:Type.Optional(Type.Boolean()),history_only:Type.Optional(Type.Boolean()),retained_observations:Type.Optional(Type.Integer({minimum:0}))},{additionalProperties:false});
const Page=(item:import('@sinclair/typebox').TSchema)=>Type.Object({items:Type.Array(item),total:Type.Integer({minimum:0}),page:Type.Integer({minimum:1}),limit:Type.Integer({minimum:1,maximum:100}),has_more:Type.Boolean()},{additionalProperties:false});
const Receipt=Result(Type.Object({outcome:Type.Union([Type.Literal('saved'),Type.Literal('duplicate')]),observation_id:Type.String({format:'uuid'}),received_at:Type.String({format:'date-time'}),cleanup_generation:Type.Optional(Type.Integer({minimum:0})),baseline_missing:Type.Optional(Type.Boolean())},{additionalProperties:false}));
export const pluginRoutes={
  registration:{method:'post',path:'/api/v1/plugin/registration',body:PluginRegistrationSchema,response:{200:Result(Type.Object({collector_id:Type.String({format:'uuid'}),nt_email:Type.String(),token:Type.String({maxLength:4096})},{additionalProperties:false})),...Failures}},
  report:{method:'post',path:'/api/v1/plugin/observations',body:PluginObservationSchema,response:{200:Receipt,201:Receipt,...Failures}},
  projects:{method:'get',path:'/api/v1/plugin/projects',querystring:PluginQuerySchema,response:{200:Result(Page(PluginProjectSchema)),...Failures}},
  removeProject:{method:'delete',path:'/api/v1/plugin/projects',body:PluginProjectDeleteSchema,response:{200:Result(PluginProjectDeleteResultSchema),...Failures}},
  history:{method:'get',path:'/api/v1/plugin/observations',querystring:PluginQuerySchema,response:{200:Result(Page(PluginRecordSchema)),...Failures}},
} as const;
