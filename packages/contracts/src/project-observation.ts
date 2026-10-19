import {Type,type Static} from '@sinclair/typebox';
const path=()=>Type.String({minLength:1,maxLength:4096});
export const ProjectRepositoryAddressSchema=Type.Object({address:Type.Union([path(),Type.Null()])},{additionalProperties:false});
// Read-time management classification; never part of the collector's evidence.
export const ProjectRepositoryClassificationSchema=Type.Object({
  ...ProjectRepositoryAddressSchema.properties,host:Type.Union([Type.String(),Type.Null()]),
  source_tag:Type.Union([Type.Literal('department'),Type.Literal('personal'),Type.Null()]),
  reason:Type.Union(['internal_ipv4','allowlist','unmatched','unrecognized'].map(value=>Type.Literal(value))),
},{additionalProperties:false});
export type ProjectRepositoryClassification=Static<typeof ProjectRepositoryClassificationSchema>;
// Legacy metadata is accepted only at ingress so installed clients can replay cached observations.
export const ProjectRemoteSchema=Type.Object({...ProjectRepositoryAddressSchema.properties,name:Type.Optional(Type.String({minLength:1,maxLength:128})),direction:Type.Optional(Type.Union([Type.Literal('fetch'),Type.Literal('push')]))},{additionalProperties:false});
export const ProjectProbeReasonSchema=Type.Union(['git_missing','inaccessible','timeout','invalid_git_output','output_limit','git_error'].map(value=>Type.Literal(value)));
export const ProjectObservationSchema=Type.Object({
  id:Type.String({format:'uuid'}),sequence:Type.String({pattern:'^[1-9][0-9]{0,18}$'}),observed_at:Type.String({format:'date-time'}),
  state:Type.Union(['repository','not_git','no_remote','failed','unknown'].map(value=>Type.Literal(value))),
  reason:Type.Union([ProjectProbeReasonSchema,Type.Null()]),git_root:Type.Union([path(),Type.Null()]),remotes:Type.Array(ProjectRemoteSchema,{maxItems:64}),
},{additionalProperties:false});
export const ProjectContextSchema=Type.Object({
  collector_id:Type.String({format:'uuid'}),platform:Type.Union([Type.Literal('macos'),Type.Literal('windows'),Type.Literal('linux')]),workspace:Type.Union([path(),Type.Null()]),
  unresolved_reason:Type.Union([Type.Literal('missing_workspace'),Type.Literal('ambiguous_workspace'),Type.Literal('invalid_workspace'),Type.Null()]),
  observation:Type.Union([ProjectObservationSchema,Type.Null()]),
},{additionalProperties:false});
export type ProjectContext=Static<typeof ProjectContextSchema>;
export type ProjectObservation=Static<typeof ProjectObservationSchema>;
