import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { CartReportingFacade } from '../../cart';
import type {
  AbandonedCartCounts,
  AbandonedCartSources,
  AbandonedCartsUnavailable,
} from '../application/ports/abandoned-cart-sources';

/** {@link AbandonedCartSources} on cart's reporting facade `abandonedCarts`. */
export class FacadeAbandonedCartSources implements AbandonedCartSources {
  constructor(private readonly cart: Pick<CartReportingFacade, 'abandonedCarts'>) {}

  async abandonedCartsAt(
    context: CallContext,
    changedAtOrBefore: Temporal.Instant,
  ): Promise<Result<AbandonedCartCounts, AbandonedCartsUnavailable>> {
    const totals = await this.cart.abandonedCarts(context, { changedAtOrBefore });
    if (!totals.ok) {
      return err({
        code: `cart:${totals.error.code}`,
        ...(totals.error.code === 'cart.abandoned-too-large' ? { overCap: true } : {}),
      });
    }
    return ok({ carts: totals.value.carts, values: totals.value.values });
  }
}
