import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_VIEW } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import { listSellerOrders, type FulfilmentFailure } from '../fulfilment-flow';
import type { SellerOrderPageView } from '../../domain/order-views';

/** The seller's paid seller orders, newest payment first (rule `permissions [ordering.seller-order.view]`). */
export class SellerListOrders extends UseCase<
  { readonly limit?: unknown; readonly cursor?: unknown },
  SellerOrderPageView,
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

  protected handle(
    context: CallContext,
    input: { readonly limit?: unknown; readonly cursor?: unknown },
  ) {
    return listSellerOrders(this.deps, context, input);
  }
}
