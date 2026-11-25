import { dateFormat, numberFormat } from '../shared/intl.ts';
import type { KpiDelta, KpiMoney, KpiPeriodId } from './kpi-types.ts';

/** The message key of a period preset ("7d" is `days7`). */
export const PERIOD_KEY: Record<KpiPeriodId, string> = {
  custom: 'custom',
  today: 'today',
  '7d': 'days7',
  '30d': 'days30',
  month: 'month',
};

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

/** A major-unit amount (a chart value) shown in the currency, whatever its number of digits. */
export function kpiMajor(value: number, currency: string, locale: string): string {
  try {
    return numberFormat(locale, { style: 'currency', currency }).format(value);
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

/**
 * A change as the card shows it. The literal 'n/a' is a contract with `StatDelta` (no arrow, the
 * comparison read alone); "pts" stays English because admin panels are English LTR.
 * Shapes: "+12.5%" for a count or an amount, "+1.5 pts" for a rate, "n/a".
 */
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

const NA: KpiDelta = { value: 0, direction: 'flat', state: 'na' };

/** A figure as a number for comparing with zero only (never shown, never summed). */
export function figureOf(value: KpiMoney | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : Number(value.amountMinor);
}

/**
 * A change that cannot disagree with its own figures: with no previous figure, or a previous of
 * zero, it is "n/a" (never a stale percentage); a figure that fell to zero from something is a
 * fall, whatever the change said. Otherwise the API's change stands.
 */
export function guardDelta(
  delta: KpiDelta | undefined,
  current: KpiMoney | number | null | undefined,
  previous: KpiMoney | number | null | undefined,
): KpiDelta | undefined {
  if (delta === undefined) return undefined;
  const now = figureOf(current);
  const before = figureOf(previous);
  if (now === null || before === null || Number.isNaN(now) || Number.isNaN(before)) return NA;
  if (before === 0) return NA;
  if (now === 0 && before > 0) return { value: -10000, direction: 'down', state: 'ok' };
  return delta;
}

/** "23 Nov 2026" for a Market day, read as that calendar day whatever the viewer's zone. */
export function longDay(day: string, locale: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return dateFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** Minor units as a string in the given currency (a figure of the month target or goal). */
export const kpiMinor = (amountMinor: string, currency: string, locale: string): string =>
  kpiMoney({ amountMinor, currency }, locale);

/** "November" for a calendar month (`YYYY-MM`); the text itself when it is not one. */
export function kpiMonthName(month: string, locale: string): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  if (!/^[0-9]{4}-[0-9]{2}$/.test(month) || Number.isNaN(date.getTime())) return month;
  return dateFormat(locale, { month: 'long', timeZone: 'UTC' }).format(date);
}

/** "30 Nov" for a day of a calendar month (`YYYY-MM`). */
export function kpiMonthDay(month: string, day: number, locale: string): string {
  return kpiDayLabel(`${month}-${String(day).padStart(2, '0')}`, locale);
}
