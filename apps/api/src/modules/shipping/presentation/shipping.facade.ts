import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
import type { BookCarrierDelivery } from '../application/use-cases/book-carrier-delivery.use-case';
import type { CancelCarrierDelivery } from '../application/use-cases/cancel-carrier-delivery.use-case';
import type { CarrierShipmentQuery } from '../application/use-cases/carrier-shipment.use-case';
import type { DeliveryAvailability } from '../application/use-cases/delivery-availability.use-case';
import type { DeliveryChoice } from '../application/use-cases/delivery-choice.use-case';
import type { PriceDelivery } from '../application/use-cases/price-delivery.use-case';
import type { DeliveryArea } from '../application/use-cases/delivery-area.use-case';
import type { PickupAvailability } from '../application/use-cases/pickup-availability.use-case';
import type { ChargeDelivery } from '../application/use-cases/charge-delivery.use-case';
import type { QuoteDeliveries } from '../application/use-cases/quote-deliveries.use-case';
import type { RecordFleetFee } from '../application/use-cases/record-fleet-fee.use-case';
import type {
  CarrierDeliveryRequest,
  QuoteDropoff,
  QuoteSeller,
  ShippingFacade,
  ShippingFailure,
} from '../contracts';

/** The use cases behind the facade. */
export interface ShippingFacadeUseCases {
  readonly area: DeliveryArea;
  readonly pickup: PickupAvailability;
  readonly book: BookCarrierDelivery;
  readonly shipment: CarrierShipmentQuery;
  readonly cancel: CancelCarrierDelivery;
  readonly availability: DeliveryAvailability;
  readonly choice: DeliveryChoice;
  readonly price: PriceDelivery;
  readonly quote: QuoteDeliveries;
  readonly charge: ChargeDelivery;
  readonly fee: RecordFleetFee;
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

  quoteDeliveries(
    context: CallContext,
    request: { readonly sellers: readonly QuoteSeller[]; readonly dropoff: QuoteDropoff },
  ) {
    return this.useCases.quote.execute(context, {
      sellers: request?.sellers,
      dropoff: request?.dropoff,
    });
  }

  chargeDelivery(context: CallContext, request: Parameters<ShippingFacade['chargeDelivery']>[1]) {
    return this.useCases.charge.execute(context, {
      seller: request?.seller,
      method: request?.method,
      quoteId: request?.quoteId,
      dropoff: request?.dropoff,
    });
  }

  recordFleetFee(context: CallContext, report: Parameters<ShippingFacade['recordFleetFee']>[1]) {
    return this.useCases.fee.execute(context, report);
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

  cancelCarrierDelivery(context: CallContext, sellerOrderId: string) {
    return this.useCases.cancel.execute(context, { sellerOrderId });
  }
}
