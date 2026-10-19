import { Type, type Static } from '@sinclair/typebox';

const quantity = Type.Union([Type.String({ pattern: '^[0-9]+$' }), Type.Null()]);
export const OfficialTokenQuantitySchema = Type.Object({
  tokens: quantity,
  known_tokens: Type.String({ pattern: '^[0-9]+$' }),
  missing_token_records: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export const OfficialTokenBreakdownSchema = Type.Object({
  input: OfficialTokenQuantitySchema,
  output: OfficialTokenQuantitySchema,
  cache_read: OfficialTokenQuantitySchema,
  cache_creation: OfficialTokenQuantitySchema,
}, { additionalProperties: false });
export type OfficialTokenQuantityDto = Static<typeof OfficialTokenQuantitySchema>;
export type OfficialTokenBreakdownDto = Static<typeof OfficialTokenBreakdownSchema>;
export const OfficialUsageCountersSchema = Type.Object({
  records: Type.Integer({ minimum: 0 }),
  ...OfficialTokenQuantitySchema.properties,
  calls: quantity,
  known_calls: Type.String({ pattern: '^[0-9]+$' }),
  missing_call_records: Type.Integer({ minimum: 0 }),
  token_breakdown: OfficialTokenBreakdownSchema,
}, { additionalProperties: false });
export type OfficialUsageCountersDto = Static<typeof OfficialUsageCountersSchema>;
