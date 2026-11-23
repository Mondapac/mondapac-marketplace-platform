import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { DeliveryRegionsQuery } from '../application/use-cases/delivery-regions.use-case';
import type { ShippingReportingFacade } from '../contracts/shipping-reporting.facade';

/** Passes the caller's `CallContext` unchanged to its use case, so the gate runs. */
export class ShippingReportingFacadeImplementation implements ShippingReportingFacade {
  constructor(private readonly regions: DeliveryRegionsQuery) {}

  deliveryRegions(
    context: CallContext,
    request: {
      readonly quoteIds: readonly string[];
      readonly pickupSellerIds: readonly Id<'Seller'>[];
    },
  ) {
    return this.regions.execute(context, {
      quoteIds: request?.quoteIds,
      pickupSellerIds: request?.pickupSellerIds,
    });
  }
}
