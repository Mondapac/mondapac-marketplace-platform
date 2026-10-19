import type { CallContext, Id, Money, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { PricingValidationFailed } from './pricing.facade';

/** The most specials one call answers; a larger `limit` is refused. */
export const MAX_SPECIALS = 200;

/**
 * One (Offer, Variant) whose effective price is a special right now (pricing design 4.1): the
 * special in force is below the regular price in force. Both amounts are buyer-facing prices,
 * never Cost (ADR-0024). It does not say the Offer is visible: the caller checks catalog and
 * sellers before showing it.
 */
export interface SpecialInForce {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  /** The price a buyer pays now (the special). */
  readonly price: Money;
  /** The regular price in force, shown beside it. */
  readonly regularPrice: Money;
  /** The Market's `pricesIncludeTax` when the special was written. */
  readonly taxInclusive: boolean;
  /** When the special window ends. */
  readonly endsAt: Temporal.Instant;
}

/** The storefront's specials shelf (storefront reads package). Not exposed over HTTP. */
export interface PricingSpecialsFacade {
  /**
   * The (Offer, Variant) keys of the context's Market whose effective price is a special now
   * (Clock time), newest special first (by effective start, then record id), at most `limit`
   * (1 to {@link MAX_SPECIALS}). Rule `anonymous`.
   */
  specialsInForce(
    context: CallContext,
    request: { readonly limit: number },
  ): Promise<Result<readonly SpecialInForce[], AccessDenied | PricingValidationFailed>>;
}

/** Nest token of the {@link PricingSpecialsFacade}, provided and exported by `PricingModule`. */
export const PRICING_SPECIALS_FACADE = Symbol('PRICING_SPECIALS_FACADE');
