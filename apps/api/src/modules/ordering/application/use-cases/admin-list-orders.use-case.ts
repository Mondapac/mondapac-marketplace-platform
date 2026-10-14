import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_ORDER_VIEW } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import type { AdminOrderView, OrderPageView } from '../../domain/order-views';
import { listAllOrders, type ListInput, type ReadFailure } from '../read-flow';

/** The Market's orders, newest first, optionally by status (rule `permissions [ordering.order.view]`). */
export class AdminListOrders extends UseCase<
  ListInput,
  OrderPageView<AdminOrderView>,
  ReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-list-orders',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: ListInput) {
    return listAllOrders(this.deps, context, input);
  }
}
