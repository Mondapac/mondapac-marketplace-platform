import type { CallContext, Id, Money, Temporal } from '@mondapac/shared-kernel';
import type { PricingFacade } from '../../pricing';
import type { SellersFacade } from '../../sellers';
import type { PriceHistory, PricedUnit } from '../application/ports/price-history';
import type { SellerActivity } from '../application/ports/seller-activity';

/**
 * {@link SellerActivity} over `sellers`' `activeSinceOf`, called with the caller's context
 * unchanged. A refusal, a fault or a seller never approved is null: the approval rule treats the
 * seller as new (fail closed).
 */
export class FacadeSellerActivity implements SellerActivity {
  constructor(private readonly sellers: SellersFacade) {}

  async activeSince(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<Temporal.Instant | null> {
    try {
      const answer = await this.sellers.activeSinceOf(context, sellerId);
      return answer.ok ? answer.value : null;
    } catch {
      return null;
    }
  }
}

/**
 * {@link PriceHistory} over `pricing`'s `daysAtPrice`, called with the caller's context unchanged.
 * A refusal, a fault or a unit with no price series is null: the was-price rule answers "not
 * eligible" (fail closed).
 */
export class FacadePriceHistory implements PriceHistory {
  constructor(private readonly pricing: PricingFacade) {}

  async daysSoldAtPrice(
    context: CallContext,
    unit: PricedUnit,
    price: Money,
    windowDays: number,
  ): Promise<number | null> {
    try {
      const answer = await this.pricing.daysAtPrice(
        context,
        { offerId: unit.offerId, variantId: unit.variantId },
        price,
        windowDays,
      );
      return answer.ok ? answer.value : null;
    } catch {
      return null;
    }
  }
}
