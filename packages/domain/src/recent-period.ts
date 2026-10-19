import { DomainError } from './errors.js';
export interface RecentPeriodQuery { from?: string; to?: string }
const day = 86_400_000; const offset = 8 * 3600_000;
function timestamp(value: string) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!parts) throw new DomainError('invalid_period', 422);
  const year = Number(parts[1]); const month = Number(parts[2]); const date = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || date < 1 || date > days[month - 1]! || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) throw new DomainError('invalid_period', 422);
  const time = Date.parse(value); if (!Number.isFinite(time)) throw new DomainError('invalid_period', 422); return time;
}
export function recentPeriod(input: RecentPeriodQuery, now: Date, defaultDays = 7) {
  if (!Number.isInteger(defaultDays) || defaultDays < 1 || defaultDays > 45) throw new Error('Invalid default period');
  const today = Math.floor((now.getTime() + offset) / day) * day - offset;
  if ((input.from === undefined) !== (input.to === undefined)) throw new DomainError('invalid_period', 422);
  const from = input.from === undefined ? today - (defaultDays - 1) * day : timestamp(input.from);
  const to = input.to === undefined ? today + day : timestamp(input.to);
  if (from < today - 44 * day || to > today + day || from >= to) throw new DomainError('invalid_period', 422);
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}
