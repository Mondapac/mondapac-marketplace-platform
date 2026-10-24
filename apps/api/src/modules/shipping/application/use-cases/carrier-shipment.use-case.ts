import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CarrierDeliveryFailure, CarrierShipment } from '../../contracts/shipping.facade';
import { readCarrierShipment } from '../carrier-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/**
 * `shipping.carrier-shipment`: the carrier delivery of a seller order (carrier name, tracking
 * reference, progress), for ordering's handler of `shipping.carrier-delivery-progressed.v1`.
 * Rule `system`; not exposed over HTTP.
 */
export class CarrierShipmentQuery extends UseCase<
  { readonly sellerOrderId: unknown },
  CarrierShipment,
  CarrierDeliveryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.carrier-shipment',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly sellerOrderId: unknown }) {
    return readCarrierShipment(this.deps, context, input);
  }
}
