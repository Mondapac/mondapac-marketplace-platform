import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_CONFIRM_PICKUP } from '../../contracts/permissions';
import type { LabelledSellerOrderShipView } from '../../domain/order-views';
import type { OrderingDependencies } from '../checkout-flow';
import { confirmSellerPickup, type FulfilmentFailure } from '../fulfilment-flow';

/**
 * The seller confirms the handover of a ready pickup order by typing the buyer's 4-digit code. A
 * correct code records the order as collected (`delivered`); a wrong one is counted and the fifth
 * locks the order until the buyer asks for a new code. The seller never delivers. Idempotent on a
 * collected order. The seller comes from the session and the order must be its own.
 */
export class SellerConfirmPickup extends UseCase<
  { readonly sellerOrderId: unknown; readonly code: unknown },
  LabelledSellerOrderShipView,
  FulfilmentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-confirm-pickup',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_CONFIRM_PICKUP.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly sellerOrderId: unknown; readonly code: unknown },
  ) {
    return confirmSellerPickup(this.deps, context, input);
  }
}
