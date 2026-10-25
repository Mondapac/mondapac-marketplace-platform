import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type {
  CarrierBookingOutcome,
  CarrierDeliveryFailure,
  CarrierDeliveryRequest,
} from '../../contracts/shipping.facade';
import { bookCarrierDelivery } from '../carrier-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/**
 * `shipping.book-carrier-delivery`: the `real_time_delivery` FulfillmentStrategy for one paid
 * seller order (SHP-02/03). Rule `system`: only ordering's handlers of `ordering.order-paid.v1` (scheduled) and `ordering.seller-order-ready.v1` (instant, same day)
 * calls it, through the shipping facade; not exposed over HTTP.
 */
export class BookCarrierDelivery extends UseCase<
  CarrierDeliveryRequest,
  CarrierBookingOutcome,
  CarrierDeliveryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.book-carrier-delivery',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: CarrierDeliveryRequest) {
    return bookCarrierDelivery(this.deps, context, input);
  }
}
