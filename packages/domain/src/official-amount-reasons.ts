import type { AmountMissingReasonDto } from '@adi/contracts';
import { DomainError } from './errors.js';

type Reason = AmountMissingReasonDto['reason'];
export type RawAmountMissingReasons = Record<Reason, string>;
// A record contributes once. An absent amount takes precedence over currency;
// the enclosing currency group still identifies whether the currency is absent.
export const officialAmountReasonsSql = `jsonb_build_object(
 'missing',count(*) FILTER(WHERE value->>'amount' IS NULL AND value->>'amount_reason'='missing')::text,
 'null',count(*) FILTER(WHERE value->>'amount' IS NULL AND value->>'amount_reason'='null')::text,
 'not_priced',count(*) FILTER(WHERE value->>'amount' IS NULL AND value->>'amount_reason'='not_priced')::text,
 'currency_missing',count(*) FILTER(WHERE value->>'amount' IS NOT NULL AND NULLIF(value->>'currency','') IS NULL)::text,
 'unknown',count(*) FILTER(WHERE value->>'amount' IS NULL AND COALESCE(value->>'amount_reason','unknown') NOT IN('missing','null','not_priced'))::text
) AS amount_missing_reasons`;
export function amountMissingReasons(raw: RawAmountMissingReasons): AmountMissingReasonDto[] {
  const result: AmountMissingReasonDto[] = [];
  for (const reason of ['missing', 'null', 'not_priced', 'currency_missing', 'unknown'] as const) {
    const records = Number(raw[reason]);
    if (!Number.isSafeInteger(records) || records < 0) throw new DomainError('metric_overflow', 503);
    if (records) result.push({ reason, records });
  }
  return result;
}
