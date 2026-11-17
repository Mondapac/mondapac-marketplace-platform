import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { heldKeys, rowActions, type PermissionProbe } from '../../../../platform/list-query';
import {
  ORDERING_ORDER_NOTE,
  ORDERING_ORDER_REFUND,
  ORDERING_ORDER_VIEW,
} from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import type { AdminOrderListView } from '../../domain/order-views';
import { adminOrderActionRules } from '../order-list-actions';
import { listAllOrders, type ListInput, type ReadFailure } from '../read-flow';

/** The probes the row actions need (each asks the gate for one key). */
export interface AdminListOrdersProbes {
  readonly refundProbe: PermissionProbe;
  readonly noteProbe: PermissionProbe;
}

/**
 * The Market's orders, newest first, optionally by status (rule `permissions [ordering.order.view]`).
 * Every row carries `actions`: what the caller may run on it (the row Actions menu), from the
 * caller's keys and the order's state.
 */
export class AdminListOrders extends UseCase<ListInput, AdminOrderListView, ReadFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-list-orders',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
    private readonly probes: AdminListOrdersProbes,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ListInput,
  ): Promise<Result<AdminOrderListView, ReadFailure>> {
    const page = await listAllOrders(this.deps, context, input);
    if (!page.ok) return page;
    const granted = await heldKeys(context, {
      [ORDERING_ORDER_REFUND.key]: this.probes.refundProbe,
      [ORDERING_ORDER_NOTE.key]: this.probes.noteProbe,
    });
    const rules = adminOrderActionRules(this.deps.policy.refundsEnabled(context.market));
    return ok({
      ...page.value,
      orders: page.value.orders.map((order) => ({
        ...order,
        actions: rowActions(order, rules, granted),
      })),
    });
  }
}
