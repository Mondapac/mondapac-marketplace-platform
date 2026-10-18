/** Formats minor units in the Market's locale; the currency comes with the amount. */
export function formatMoney(money: { amount: number; currency: string }, locale: string): string {
  const digits =
    new Intl.NumberFormat(locale, { style: 'currency', currency: money.currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: money.currency,
  }).format(money.amount / 10 ** digits);
}
