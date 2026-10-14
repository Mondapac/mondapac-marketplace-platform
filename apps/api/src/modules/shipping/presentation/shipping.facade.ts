import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { FlatFees } from '../application/use-cases/flat-fees.use-case';
import type { ShippingFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to one use case, so the gate runs. */
export class ShippingFacadeImplementation implements ShippingFacade {
  constructor(private readonly fees: FlatFees) {}

  flatFees(context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    return this.fees.execute(context, { sellerIds });
  }
}
