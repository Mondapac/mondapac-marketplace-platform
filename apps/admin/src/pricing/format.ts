import { numberFormat } from '../shared/intl.ts';
import type { HoldMoney } from './types.ts';

/** Minor-unit digits of a string amount shown in the currency; a bad value shows as a dash. */
export function formatMoney(money: HoldMoney, locale: string): string {
  if (!/^[0-9]{1,18}$/.test(money.amount)) return '-';
  try {
    const format = numberFormat(locale, { style: 'currency', currency: money.currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(Number(money.amount) / 10 ** digits);
  } catch {
    return '-';
  }
}

/** The held price against the price it is compared with ("+128%"); null when either is unusable. */
export function percentChange(amount: string, anchor: string, locale: string): string | null {
  if (!/^[0-9]{1,18}$/.test(amount) || !/^[1-9][0-9]{0,17}$/.test(anchor)) return null;
  return numberFormat(locale, {
    style: 'percent',
    signDisplay: 'exceptZero',
    maximumFractionDigits: 0,
  }).format(Number(amount) / Number(anchor) - 1);
}
