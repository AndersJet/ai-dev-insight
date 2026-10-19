import type { OfficialTokenBreakdownDto, OfficialTokenQuantityDto, SessionOfficialUsageDto } from '@adi/contracts';
export type OfficialMetric = 'total' | 'calls' | keyof OfficialTokenBreakdownDto;
export function sumOfficialQuantity(groups: SessionOfficialUsageDto['groups'], key: OfficialMetric): OfficialTokenQuantityDto | undefined {
  let known = 0n, missing = 0, complete = groups.length > 0, available = key === 'total' || key === 'calls';
  for (const row of groups) {
    const metric = key === 'total' ? { tokens: row.tokens, known_tokens: row.known_tokens, missing_token_records: row.missing_token_records }
      : key === 'calls' ? { tokens: row.calls, known_tokens: row.known_calls, missing_token_records: row.missing_call_records }
      : row.token_breakdown?.[key];
    if (!metric) { missing += row.records; complete = false; continue; }
    available = true; known += BigInt(metric.known_tokens); missing += metric.missing_token_records; complete &&= metric.tokens !== null;
  }
  if (groups.length && !available) return undefined;
  return { tokens: complete && !missing ? known.toString() : null, known_tokens: known.toString(), missing_token_records: missing };
}

/** A zero counts as reported; a missing field or all-missing records do not. */
export function hasOfficialQuantity(groups: SessionOfficialUsageDto['groups'], key: OfficialMetric): boolean {
  return groups.some(row => {
    const metric = key === 'total' ? { tokens: row.tokens, missing_token_records: row.missing_token_records }
      : key === 'calls' ? { tokens: row.calls, missing_token_records: row.missing_call_records }
      : row.token_breakdown?.[key];
    return !!metric && (metric.tokens != null || metric.missing_token_records > 0 && row.records > metric.missing_token_records);
  });
}

/** Token-weighted cache reads over the same fully reported input scope. */
export function inputCacheHitRate(groups: SessionOfficialUsageDto['groups']): string | undefined {
  const input = sumOfficialQuantity(groups, 'input')?.tokens;
  const cached = sumOfficialQuantity(groups, 'cache_read')?.tokens;
  if (input == null || cached == null) return undefined;
  const denominator = BigInt(input), numerator = BigInt(cached);
  if (denominator <= 0n || numerator < 0n || numerator > denominator) return undefined;
  const hundredths = (numerator * 10000n + denominator / 2n) / denominator;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}%`;
}
