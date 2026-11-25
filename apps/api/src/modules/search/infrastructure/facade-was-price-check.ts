import { Logger } from '@nestjs/common';
import type { CallContext, Id, Money } from '@mondapac/shared-kernel';
import type { PromotionsFacade } from '../../promotions';
import type { WasPriceCheck } from '../application/ports/was-price-check';

/**
 * {@link WasPriceCheck} over `promotions`' `wasPriceEligible`, called with the request's context
 * unchanged. A refusal (promotions off or unavailable in the Market, a validation failure, an
 * access denial) or a fault is `false`: the shelf shows the special without a struck-through price.
 * Anything but "promotions off" is logged (codes only, never a price), so a broken read that hides
 * every was price is seen (Hassan L, was price).
 */
export class FacadeWasPriceCheck implements WasPriceCheck {
  readonly #logger = new Logger('FacadeWasPriceCheck');

  constructor(private readonly promotions: PromotionsFacade) {}

  async eligible(
    context: CallContext,
    unit: { readonly offerId: Id<'Offer'>; readonly variantId: Id<'Variant'> },
    regularPrice: Money,
  ): Promise<boolean> {
    try {
      const answer = await this.promotions.wasPriceEligible(context, unit, regularPrice);
      if (answer.ok) return answer.value.eligible === true;
      if (answer.error.code !== 'promotions.disabled') this.warn(context, answer.error.code);
      return false;
    } catch {
      this.warn(context, 'thrown');
      return false;
    }
  }

  private warn(context: CallContext, code: string): void {
    this.#logger.warn({
      msg: 'search.was-price-check-failed',
      code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
