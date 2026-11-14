import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_ORDER_VIEW } from '../../contracts/permissions';
import { adminOrderActivity, type ActivityFailure, type OrderActivityView } from '../activity-flow';
import type { OrderingDependencies } from '../checkout-flow';

export type { OrderActivityView };

/**
 * The activity timeline of one order of the Market, every seller order included, read-only
 * (rule `permissions [ordering.order.view]`).
 */
export class AdminViewOrderActivity extends UseCase<
  { readonly orderId: unknown },
  OrderActivityView,
  ActivityFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-view-order-activity',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly orderId: unknown }) {
    return adminOrderActivity(this.deps, context, input);
  }
}
