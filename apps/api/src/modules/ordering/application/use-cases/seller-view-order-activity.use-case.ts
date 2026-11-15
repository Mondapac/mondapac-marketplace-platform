import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_VIEW } from '../../contracts/permissions';
import { sellerActivity, type ActivityFailure, type OrderActivityView } from '../activity-flow';
import type { OrderingDependencies } from '../checkout-flow';

/**
 * The activity timeline of one of the shop's own paid seller orders, read-only (rule
 * `permissions [ordering.seller-order.view]`): only that seller order's steps and refunds.
 */
export class SellerViewOrderActivity extends UseCase<
  { readonly sellerOrderId: unknown },
  OrderActivityView,
  ActivityFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-view-order-activity',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly sellerOrderId: unknown }) {
    return sellerActivity(this.deps, context, input);
  }
}
