// The was-price rule (plan decision 10): a struck-through earlier price is shown only if the
// product sold at that price on at least `minDaysAtPrice` of the last `windowDays` days. The
// system measures it; a seller cannot type it. Unknown history is "not eligible" (fail closed).

export interface WasPriceRule {
  readonly windowDays: number;
  readonly minDaysAtPrice: number;
}

/** `daysAtPrice`: days of the window the product sold at the price; null when unknown. */
export function wasPriceEligible(daysAtPrice: number | null, rule: WasPriceRule): boolean {
  if (daysAtPrice === null || !Number.isInteger(daysAtPrice) || daysAtPrice < 0) return false;
  // More days than the window is a faulty answer, not a stronger one.
  if (daysAtPrice > rule.windowDays) return false;
  return daysAtPrice >= rule.minDaysAtPrice;
}
