import {Value} from '@sinclair/typebox/value';
import {Type,type Static} from '@sinclair/typebox';
export const PLUGIN_RELEASE_MAX_BYTES=16*1024*1024;
const hash=()=>Type.String({pattern:'^[a-f0-9]{64}$'}),uuid=()=>Type.String({format:'uuid'}),date=()=>Type.String({format:'date-time'});
const common={version:Type.String({pattern:'^[0-9]+\\.[0-9]+\\.[0-9]+$',maxLength:32}),build_id:hash(),sha256:hash(),bytes:Type.Integer({minimum:1,maximum:PLUGIN_RELEASE_MAX_BYTES}),download_path:Type.String({pattern:'^/api/v1/plugin-releases/builds/[a-f0-9]{64}/download$'})};
export const PluginReleaseSchema=Type.Object({...common,channel:Type.Union([Type.Literal('stable'),Type.Literal('trial')])},{additionalProperties:false});
export type PluginReleaseDto=Static<typeof PluginReleaseSchema>;
export const PluginReleaseRecordSchema=Type.Object({...common,id:uuid(),state:Type.Union([Type.Literal('draft'),Type.Literal('pilot'),Type.Literal('released')]),uploaded_at:date(),published_at:Type.Union([date(),Type.Null()]),pilot_user_ids:Type.Array(uuid()),current_stable:Type.Boolean(),current_pilot:Type.Boolean()},{additionalProperties:false});
export type PluginReleaseRecordDto=Static<typeof PluginReleaseRecordSchema>;
export const PluginTesterSchema=Type.Object({user_id:uuid(),email:Type.String(),display_name:Type.String()},{additionalProperties:false});
export type PluginTesterDto=Static<typeof PluginTesterSchema>;
export const PluginPilotBodySchema=Type.Object({build_id:hash(),user_ids:Type.Array(uuid(),{minItems:1,maxItems:100,uniqueItems:true})},{additionalProperties:false});
export type PluginPilotBody=Static<typeof PluginPilotBodySchema>;
const params=Type.Object({id:uuid()},{additionalProperties:false});
const meta=Type.Object({request_id:Type.String()},{additionalProperties:false});
const result=(data:import('@sinclair/typebox').TSchema)=>Type.Object({data,meta},{additionalProperties:false});
const failure=Type.Object({error:Type.Object({code:Type.String(),message:Type.String(),request_id:Type.String()},{additionalProperties:false})},{additionalProperties:false});
const failures={400:failure,401:failure,403:failure,404:failure,409:failure,413:failure,422:failure,429:failure,503:failure};
export const pluginReleaseRoutes={
 current:{method:'get',path:'/api/v1/plugin-releases/current',querystring:Type.Object({},{additionalProperties:false}),response:{200:result(Type.Union([PluginReleaseSchema,Type.Null()])),...failures}},
 trial:{method:'get',path:'/api/v1/plugin-releases/trial',querystring:Type.Object({},{additionalProperties:false}),response:{200:result(Type.Union([PluginReleaseSchema,Type.Null()])),...failures}},
 build:{method:'get',path:'/api/v1/plugin-releases/builds/:build',params:Type.Object({build:hash()},{additionalProperties:false}),querystring:Type.Object({},{additionalProperties:false}),response:{200:result(PluginReleaseSchema),...failures}},
 download:{method:'get',path:'/api/v1/plugin-releases/builds/:build/download',params:Type.Object({build:hash()},{additionalProperties:false}),querystring:Type.Object({},{additionalProperties:false}),download:'application/octet-stream',response:{...failures}},
 list:{method:'get',path:'/api/v1/system/plugin-releases',querystring:Type.Object({},{additionalProperties:false}),response:{200:result(Type.Object({items:Type.Array(PluginReleaseRecordSchema)},{additionalProperties:false})),...failures}},
 testers:{method:'get',path:'/api/v1/system/plugin-releases/testers',querystring:Type.Object({search:Type.Optional(Type.String({maxLength:128})),release_id:Type.Optional(uuid())},{additionalProperties:false}),response:{200:result(Type.Array(PluginTesterSchema)),...failures}},
 upload:{method:'post',path:'/api/v1/system/plugin-releases/upload',upload:true,response:{200:result(PluginReleaseRecordSchema),...failures}},
 pilot:{method:'post',path:'/api/v1/system/plugin-releases/:id/pilot',params,body:PluginPilotBodySchema,response:{200:result(PluginReleaseRecordSchema),...failures}},
 publish:{method:'post',path:'/api/v1/system/plugin-releases/:id/publish',params,body:Type.Object({build_id:hash()},{additionalProperties:false}),response:{200:result(PluginReleaseRecordSchema),...failures}},
} as const;

export function decodePluginRelease(value:unknown):PluginReleaseDto|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const input=value as Record<string,unknown>;
 const fields=Object.fromEntries(Object.keys(PluginReleaseSchema.properties).map(key=>[key,input[key]]));
 if(!Value.Check(PluginReleaseSchema,fields)||fields.download_path!==`/api/v1/plugin-releases/builds/${fields.build_id}/download`)return;
 return fields;
}
