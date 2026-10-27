import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CarrierDeliveryFailure } from '../../contracts/shipping.facade';
import { cancelCarrierDelivery } from '../carrier-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/**
 * `shipping.cancel-carrier-delivery`: asks the carrier to drop a seller order's delivery that is
 * not picked up yet. Rule `system`, for ordering once a paid order can be cancelled; not exposed
 * over HTTP.
 */
export class CancelCarrierDelivery extends UseCase<
  { readonly sellerOrderId: unknown },
  'cancelled' | 'not-cancellable' | 'none' | 'unknown',
  CarrierDeliveryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.cancel-carrier-delivery',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly sellerOrderId: unknown }) {
    return cancelCarrierDelivery(this.deps, context, input);
  }
}
