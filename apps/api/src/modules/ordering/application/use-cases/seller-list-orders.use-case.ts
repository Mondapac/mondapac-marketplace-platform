import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_VIEW } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import { listSellerOrders, type FulfilmentFailure, type SellerListInput } from '../fulfilment-flow';
import type { LabelledSellerOrderPageView } from '../../domain/order-views';

/** The seller's paid seller orders, newest payment first, optionally by fulfilment step (rule `permissions [ordering.seller-order.view]`). */
export class SellerListOrders extends UseCase<
  SellerListInput,
  LabelledSellerOrderPageView,
  FulfilmentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-list-orders',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: SellerListInput) {
    return listSellerOrders(this.deps, context, input);
  }
}
