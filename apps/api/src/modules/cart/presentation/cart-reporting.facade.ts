import type { CallContext } from '@mondapac/shared-kernel';
import type { CountAbandonedCarts } from '../application/use-cases/count-abandoned-carts.use-case';
import type { CartReportingFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to the use case, so the gate runs. */
export class CartReportingFacadeImplementation implements CartReportingFacade {
  constructor(private readonly count: CountAbandonedCarts) {}

  abandonedCarts(
    context: CallContext,
    request: Parameters<CartReportingFacade['abandonedCarts']>[1],
  ) {
    return this.count.execute(context, request);
  }
}
