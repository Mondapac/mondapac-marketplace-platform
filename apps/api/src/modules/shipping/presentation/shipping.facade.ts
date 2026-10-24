import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { BookCarrierDelivery } from '../application/use-cases/book-carrier-delivery.use-case';
import type { CancelCarrierDelivery } from '../application/use-cases/cancel-carrier-delivery.use-case';
import type { CarrierShipmentQuery } from '../application/use-cases/carrier-shipment.use-case';
import type { DeliveryArea } from '../application/use-cases/delivery-area.use-case';
import type { FlatFees } from '../application/use-cases/flat-fees.use-case';
import type { CarrierDeliveryRequest, ShippingFacade } from '../contracts';

/** The use cases behind the facade. */
export interface ShippingFacadeUseCases {
  readonly fees: FlatFees;
  readonly area: DeliveryArea;
  readonly book: BookCarrierDelivery;
  readonly shipment: CarrierShipmentQuery;
  readonly cancel: CancelCarrierDelivery;
}

/** Passes the caller's `CallContext` unchanged to one use case each, so the gate runs. */
export class ShippingFacadeImplementation implements ShippingFacade {
  constructor(private readonly useCases: ShippingFacadeUseCases) {}

  flatFees(context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    return this.useCases.fees.execute(context, { sellerIds });
  }

  async deliversTo(context: CallContext, postcode: string) {
    const result = await this.useCases.area.execute(context, { postcode });
    return result.ok
      ? ({ ok: true, value: result.value.delivers } as const)
      : ({
          ok: false,
          error: {
            code:
              result.error.code === 'validation.failed'
                ? 'validation.failed'
                : 'shipping.unavailable',
          },
        } as const);
  }

  bookCarrierDelivery(context: CallContext, request: CarrierDeliveryRequest) {
    return this.useCases.book.execute(context, request);
  }

  carrierShipment(context: CallContext, sellerOrderId: string) {
    return this.useCases.shipment.execute(context, { sellerOrderId });
  }

  cancelCarrierDelivery(context: CallContext, sellerOrderId: string) {
    return this.useCases.cancel.execute(context, { sellerOrderId });
  }
}
