import type { OfficialTokenBreakdownDto, OfficialUsageCountersDto } from '@adi/contracts';

const fields = { input: 'prompt_tokens', output: 'completion_tokens', cache_read: 'cache_read_input_tokens', cache_creation: 'cache_creation_input_tokens' } as const;
export type RawTokenBreakdown = Record<`${keyof typeof fields}_known` | `${keyof typeof fields}_missing`, string>;
/** Each field has its own missing count. A missing cache value must not hide output. */
export const officialTokenBreakdownSql = Object.entries(fields).map(([key, field]) =>
  `COALESCE(sum((value->'usage'->>'${field}')::numeric),0)::text AS ${key}_known,count(*) FILTER(WHERE value->'usage'->>'${field}' IS NULL)::text AS ${key}_missing`
).join(',');
export function officialTokenBreakdown(row: RawTokenBreakdown): OfficialTokenBreakdownDto {
  return Object.fromEntries(Object.keys(fields).map(key => {
    const field = key as keyof typeof fields;
    return [field, { tokens: row[`${field}_missing`] === '0' ? row[`${field}_known`] : null, known_tokens: row[`${field}_known`], missing_token_records: Number(row[`${field}_missing`]) }];
  })) as OfficialTokenBreakdownDto;
}
/** Aggregate published groups only; never combine the day ledger with session quantities. */
export function officialUsageCounters(groups: readonly (Omit<OfficialUsageCountersDto, 'token_breakdown'> & { token_breakdown?: OfficialTokenBreakdownDto })[]): OfficialUsageCountersDto {
  const records = groups.reduce((sum, row) => sum + row.records, 0);
  const quantity = (read: (row: typeof groups[number]) => { tokens: string | null; known_tokens: string; missing_token_records: number }) => {
    let known = 0n, missing = 0, complete = true;
    for (const row of groups) { const metric = read(row); known += BigInt(metric.known_tokens); missing += metric.missing_token_records; complete &&= metric.tokens !== null; }
    return { tokens: records > 0 && complete && missing === 0 ? known.toString() : null, known_tokens: known.toString(), missing_token_records: missing };
  };
  const totals = quantity(row => row);
  const calls = quantity(row => ({ tokens: row.calls, known_tokens: row.known_calls, missing_token_records: row.missing_call_records }));
  const token_breakdown = Object.fromEntries(Object.keys(fields).map(key => [key, quantity(row => row.token_breakdown?.[key as keyof typeof fields] ?? { tokens: null, known_tokens: '0', missing_token_records: row.records })])) as OfficialTokenBreakdownDto;
  return { records, ...totals, calls: calls.tokens, known_calls: calls.known_tokens, missing_call_records: calls.missing_token_records, token_breakdown };
}
