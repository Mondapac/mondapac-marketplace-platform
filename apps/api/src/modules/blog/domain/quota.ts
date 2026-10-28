import type { Temporal } from '@mondapac/shared-kernel';

// The monthly quota of a seller: how many posts it may submit for the first time in one calendar
// month. The month is read in the Market's time zone (Market config `timezone`), so a post sent at
// 23:30 on the last day of the month uses that month's quota wherever the server runs. The limit
// itself is Market config (`blog.sellerPostsPerMonth`).

/** `YYYY-MM` of the instant in the zone. */
export function quotaPeriod(at: Temporal.Instant, timeZone: string): string {
  const local = at.toZonedDateTimeISO(timeZone);
  return `${String(local.year).padStart(4, '0')}-${String(local.month).padStart(2, '0')}`;
}

/** Whether a seller that used `used` of `limit` may use one more. */
export const hasQuotaLeft = (used: number, limit: number): boolean => used < limit;

export interface QuotaView {
  readonly period: string;
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
}

export function quotaView(period: string, limit: number, used: number): QuotaView {
  return { period, limit, used, remaining: Math.max(0, limit - used) };
}
