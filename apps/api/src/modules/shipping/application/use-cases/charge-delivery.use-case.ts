import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { QuotedDelivery } from '../../domain/delivery-quote';
import { chargeDelivery, type ChargeDeliveryFailure } from '../delivery-quote-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

export interface ChargeDeliveryInput {
  readonly seller: unknown;
  readonly method: unknown;
  readonly quoteId: unknown;
  readonly dropoff: unknown;
}

/**
 * `shipping.charge-delivery`: the delivery price checkout charges for one seller order, from the
 * stored quote the buyer saw while it holds, else from a new one (a changed price is told, not
 * charged). Rule `own-resources`, for checkout under the customer's context. The client never sends
 * a price. Not exposed over HTTP.
 */
export class ChargeDelivery extends UseCase<
  ChargeDeliveryInput,
  QuotedDelivery,
  ChargeDeliveryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.charge-delivery',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: ChargeDeliveryInput) {
    return chargeDelivery(this.deps, context, input);
  }
}
