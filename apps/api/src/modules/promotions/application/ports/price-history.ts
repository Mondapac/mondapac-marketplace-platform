import type { CallContext, Id, Money } from '@mondapac/shared-kernel';

/**
 * How many of the last `windowDays` days a product sold at exactly `price`: the fact behind the
 * was-price rule (a struck-through earlier price is shown only if the product sold at it on at
 * least 28 of the last 90 days; the system decides, a seller cannot type it). Null when it is not
 * known. `pricing` publishes no price-history read yet, so the shipped adapter always answers
 * null and the rule answers "not eligible" (fail closed); a later package replaces the adapter
 * with a call of the pricing facade.
 */
export interface PriceHistory {
  daysSoldAtPrice(
    context: CallContext,
    productId: Id<'Product'>,
    price: Money,
    windowDays: number,
  ): Promise<number | null>;
}

export const PRICE_HISTORY = Symbol('PROMOTIONS_PRICE_HISTORY');
