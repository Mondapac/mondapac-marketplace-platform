import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
import type { BookCarrierDelivery } from '../application/use-cases/book-carrier-delivery.use-case';
import type { CancelCarrierDelivery } from '../application/use-cases/cancel-carrier-delivery.use-case';
import type { CarrierShipmentQuery } from '../application/use-cases/carrier-shipment.use-case';
import type { CarrierTrackingLinks } from '../application/use-cases/carrier-tracking-links.use-case';
import type { DeliveryAvailability } from '../application/use-cases/delivery-availability.use-case';
import type { DeliveryChoice } from '../application/use-cases/delivery-choice.use-case';
import type { PriceDelivery } from '../application/use-cases/price-delivery.use-case';
import type { DeliveryArea } from '../application/use-cases/delivery-area.use-case';
import type { FlatFees } from '../application/use-cases/flat-fees.use-case';
import type { PickupAvailability } from '../application/use-cases/pickup-availability.use-case';
import type { ShippingFees } from '../application/use-cases/shipping-fees.use-case';
import type {
  CarrierDeliveryRequest,
  QuoteDropoff,
  ShippingFacade,
  ShippingFailure,
} from '../contracts';

/** The use cases behind the facade. */
export interface ShippingFacadeUseCases {
  readonly fees: FlatFees;
  readonly shippingFees: ShippingFees;
  readonly area: DeliveryArea;
  readonly pickup: PickupAvailability;
  readonly book: BookCarrierDelivery;
  readonly shipment: CarrierShipmentQuery;
  readonly cancel: CancelCarrierDelivery;
  readonly trackingLinks: CarrierTrackingLinks;
  readonly availability: DeliveryAvailability;
  readonly choice: DeliveryChoice;
  readonly price: PriceDelivery;
}

/** The facade's failure set: a refusal, a bad input, or "unavailable" for any other cause. */
function failuresOf<T>(result: Result<T, { readonly code: string }>): Result<T, ShippingFailure> {
  if (result.ok) return result;
  return {
    ok: false,
    error:
      result.error.code === 'validation.failed'
        ? { code: 'validation.failed' }
        : result.error.code === 'access.denied'
          ? { code: 'access.denied' }
          : { code: 'shipping.unavailable' },
  };
}

/** Passes the caller's `CallContext` unchanged to one use case each, so the gate runs. */
export class ShippingFacadeImplementation implements ShippingFacade {
  constructor(private readonly useCases: ShippingFacadeUseCases) {}

  flatFees(context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    return this.useCases.fees.execute(context, { sellerIds });
  }

  shippingFees(context: CallContext, sellerIds: readonly Id<'Seller'>[], dropoff: QuoteDropoff) {
    return this.useCases.shippingFees.execute(context, { sellerIds, dropoff });
  }

  async pickupAvailability(context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    const result = await this.useCases.pickup.execute(context, { sellerIds });
    return result.ok
      ? result
      : ({
          ok: false,
          error:
            result.error.code === 'validation.failed'
              ? ({ code: 'validation.failed' } as const)
              : result.error.code === 'access.denied'
                ? result.error
                : ({ code: 'shipping.unavailable' } as const),
        } as const);
  }

  async deliveryAvailability(context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    return failuresOf(await this.useCases.availability.execute(context, { sellerIds }));
  }

  async deliveryChoice(
    context: CallContext,
    request: Parameters<ShippingFacade['deliveryChoice']>[1],
  ) {
    return failuresOf(
      await this.useCases.choice.execute(context, {
        sellerId: request?.sellerId,
        method: request?.method,
        window: request?.window,
      }),
    );
  }

  async priceDelivery(context: CallContext, quote: Money) {
    return failuresOf(await this.useCases.price.execute(context, { quote }));
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

  async carrierTrackingLinks(
    context: CallContext,
    orderId: string,
    sellerOrderIds: readonly string[],
  ) {
    const result = await this.useCases.trackingLinks.execute(context, { orderId, sellerOrderIds });
    return result.ok
      ? result
      : ({
          ok: false,
          error:
            result.error.code === 'access.denied'
              ? result.error
              : result.error.code === 'validation.failed'
                ? ({ code: 'validation.failed' } as const)
                : ({ code: 'shipping.unavailable' } as const),
        } as const);
  }

  cancelCarrierDelivery(context: CallContext, sellerOrderId: string) {
    return this.useCases.cancel.execute(context, { sellerOrderId });
  }
}
