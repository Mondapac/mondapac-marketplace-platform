import type { CallContext, Id, Money } from '@mondapac/shared-kernel';

/** One priced unit: an Offer and one of its Variants (a price belongs to one seller's Offer). */
export interface PricedUnit {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
}

/**
 * How many whole days of the last `windowDays` days a priced unit sold at exactly `price`: the
 * fact behind the was-price rule (a struck-through earlier price is shown only if the unit sold at
 * it on at least 28 of the last 90 days; the system decides, a seller cannot type it). Null when
 * it is not known (no price history, or the read failed); the rule then answers "not eligible"
 * (fail closed). Bound to `pricing`'s `daysAtPrice`.
 */
export interface PriceHistory {
  daysSoldAtPrice(
    context: CallContext,
    unit: PricedUnit,
    price: Money,
    windowDays: number,
  ): Promise<number | null>;
}

export const PRICE_HISTORY = Symbol('PROMOTIONS_PRICE_HISTORY');
