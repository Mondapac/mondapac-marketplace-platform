import type { CallContext, Id, Money } from '@mondapac/shared-kernel';
import type { PromotionsFacade } from '../../promotions';
import type { WasPriceCheck } from '../application/ports/was-price-check';

/**
 * {@link WasPriceCheck} over `promotions`' `wasPriceEligible`, called with the request's context
 * unchanged. A refusal (promotions off or unavailable in the Market, a validation failure, an
 * access denial) or a fault is `false`: the shelf shows the special without a struck-through price.
 */
export class FacadeWasPriceCheck implements WasPriceCheck {
  constructor(private readonly promotions: PromotionsFacade) {}

  async eligible(
    context: CallContext,
    unit: { readonly offerId: Id<'Offer'>; readonly variantId: Id<'Variant'> },
    regularPrice: Money,
  ): Promise<boolean> {
    try {
      const answer = await this.promotions.wasPriceEligible(context, unit, regularPrice);
      return answer.ok && answer.value.eligible === true;
    } catch {
      return false;
    }
  }
}
