import { intlLocale } from '../i18n/locale.ts';

/**
 * Formats minor units in the request's language, always with Latin digits; the currency comes with the amount. With `whole`,
 * an amount without cents drops them ("A$10" for a filter label).
 */
export function formatMoney(
  money: { amount: number; currency: string },
  locale: string,
  { whole = false }: { readonly whole?: boolean } = {},
): string {
  const tag = intlLocale(locale);
  const digits =
    new Intl.NumberFormat(tag, { style: 'currency', currency: money.currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  const value = money.amount / 10 ** digits;
  return new Intl.NumberFormat(tag, {
    style: 'currency',
    currency: money.currency,
    ...(whole && Number.isInteger(value) ? { minimumFractionDigits: 0 } : {}),
  }).format(value);
}
