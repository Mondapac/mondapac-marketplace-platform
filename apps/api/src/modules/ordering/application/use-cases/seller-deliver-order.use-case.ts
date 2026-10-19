import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_MARK_DELIVERED } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import { deliverSellerOrder, type FulfilmentFailure } from '../fulfilment-flow';
import type { LabelledSellerOrderShipView } from '../../domain/order-views';

/** The seller marks a shipped seller order delivered. */
export class SellerDeliverOrder extends UseCase<
  { readonly sellerOrderId: unknown },
  LabelledSellerOrderShipView,
  FulfilmentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-deliver-order',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_MARK_DELIVERED.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly sellerOrderId: unknown }) {
    return deliverSellerOrder(this.deps, context, input);
  }
}
