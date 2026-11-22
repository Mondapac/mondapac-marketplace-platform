import { dateFormat, numberFormat } from '../shared/intl.ts';
import type { KpiDelta, KpiMoney } from './kpi-types.ts';

/** Minor units as a string, shown in the currency; a bad value shows as a dash. */
export function kpiMoney(money: KpiMoney, locale: string): string {
  if (!/^-?[0-9]{1,18}$/.test(money.amountMinor)) return '-';
  try {
    const format = numberFormat(locale, { style: 'currency', currency: money.currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(Number(money.amountMinor) / 10 ** digits);
  } catch {
    return '-';
  }
}

/** The major-unit number of minor units, for a chart value; NaN for a bad value (drawn as 0). */
export function minorToMajor(amountMinor: string, currency: string, locale: string): number {
  if (!/^-?[0-9]{1,18}$/.test(amountMinor)) return Number.NaN;
  const digits =
    numberFormat(locale, { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ??
    2;
  return Number(amountMinor) / 10 ** digits;
}

/** A rate in basis points ("12.5%"); a dash when there is nothing to divide. */
export function kpiRate(bp: number | null, locale: string): string {
  if (bp === null) return '-';
  return numberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(bp / 10000);
}

/** A change as the card shows it: "+12.5%" for a count or an amount, "+1.5 pts" for a rate, "n/a". */
export function kpiDelta(delta: KpiDelta, kind: 'percent' | 'points', locale: string): string {
  if (delta.state === 'na') return 'n/a';
  const signed = (text: string) => (delta.value > 0 ? `+${text}` : text);
  if (kind === 'points') {
    const points = numberFormat(locale, { maximumFractionDigits: 1 }).format(delta.value / 100);
    return `${signed(points)} pts`;
  }
  const percent = numberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(
    delta.value / 10000,
  );
  return signed(percent);
}

/** Better or worse for the business, not up or down: more refunds are worse. */
export function kpiSentiment(
  delta: KpiDelta,
  higherIs: 'better' | 'worse',
): 'good' | 'bad' | 'neutral' {
  if (delta.state === 'na' || delta.direction === 'flat') return 'neutral';
  const up = delta.direction === 'up';
  return up === (higherIs === 'better') ? 'good' : 'bad';
}

/** "22 Nov" for a Market day (`YYYY-MM-DD`), read as that calendar day whatever the viewer's zone. */
export function kpiDayLabel(day: string, locale: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return dateFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date);
}

/** Whole minutes between the two instants, never negative; null when either is unusable. */
export function minutesBetween(from: string | null, to: string): number | null {
  if (from === null) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.floor((end - start) / 60000));
}
