import type { HoldMoney } from './types.ts';

/** Minor-unit digits of a string amount shown in the currency; a bad value shows as a dash. */
export function formatMoney(money: HoldMoney): string {
  if (!/^[0-9]{1,18}$/.test(money.amount)) return '-';
  try {
    const format = new Intl.NumberFormat('en-AU', { style: 'currency', currency: money.currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(Number(money.amount) / 10 ** digits);
  } catch {
    return '-';
  }
}

const PERCENT = new Intl.NumberFormat('en-AU', {
  style: 'percent',
  signDisplay: 'exceptZero',
  maximumFractionDigits: 0,
});

/** The held price against the price it is compared with ("+128%"); null when either is unusable. */
export function percentChange(amount: string, anchor: string): string | null {
  if (!/^[0-9]{1,18}$/.test(amount) || !/^[1-9][0-9]{0,17}$/.test(anchor)) return null;
  return PERCENT.format(Number(amount) / Number(anchor) - 1);
}
