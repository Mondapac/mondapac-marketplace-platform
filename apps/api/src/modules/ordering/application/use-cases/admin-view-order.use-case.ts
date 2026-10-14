import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_ORDER_VIEW } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import type { AdminOrderView } from '../../domain/order-views';
import { viewAnyOrder, type ReadFailure } from '../read-flow';

/** One order of the Market for support and oversight (rule `permissions [ordering.order.view]`). */
export class AdminViewOrder extends UseCase<
  { readonly orderId: unknown },
  AdminOrderView,
  ReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-view-order',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly orderId: unknown }) {
    return viewAnyOrder(this.deps, context, input);
  }
}
