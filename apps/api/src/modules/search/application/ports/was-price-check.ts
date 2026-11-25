import type { CallContext, Id, Money } from '@mondapac/shared-kernel';

/**
 * May this priced unit show `regularPrice` struck through beside its special? The Market's
 * was-price rule, owned by `promotions` (AU: the unit sold at that price on at least 28 of the
 * last 90 days, as `pricing` measures it). Search never applies the rule itself. `false` for
 * "no", and also when the answer cannot be had (promotions off or unavailable, a refusal, a
 * fault): an unproven reference price is never shown (fail closed).
 */
export interface WasPriceCheck {
  eligible(
    context: CallContext,
    unit: { readonly offerId: Id<'Offer'>; readonly variantId: Id<'Variant'> },
    regularPrice: Money,
  ): Promise<boolean>;
}

export const WAS_PRICE_CHECK = Symbol('WAS_PRICE_CHECK');
