import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { heldKeys, rowActions, type PermissionProbe } from '../../../../platform/list-query';
import {
  ORDERING_SELLER_ORDER_CONFIRM_PICKUP,
  ORDERING_SELLER_ORDER_MARK_DELIVERED,
  ORDERING_SELLER_ORDER_MARK_READY,
  ORDERING_SELLER_ORDER_MARK_UNAVAILABLE,
  ORDERING_SELLER_ORDER_VIEW,
} from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import { listSellerOrders, type FulfilmentFailure, type SellerListInput } from '../fulfilment-flow';
import type { SellerOrderListView } from '../../domain/order-views';
import { SELLER_ORDER_ACTION_RULES } from '../order-list-actions';

/** The probes the row actions need (each asks the gate for one key). */
export interface SellerListOrdersProbes {
  readonly markReadyProbe: PermissionProbe;
  readonly confirmPickupProbe: PermissionProbe;
  readonly markDeliveredProbe: PermissionProbe;
  readonly markUnavailableProbe: PermissionProbe;
}

/**
 * The seller's paid seller orders, newest payment first, optionally by fulfilment step (rule
 * `permissions [ordering.seller-order.view]`). Every row carries `actions`: what the caller may
 * run on it (the row Actions menu), from the caller's keys and the order's state.
 */
export class SellerListOrders extends UseCase<
  SellerListInput,
  SellerOrderListView,
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
    private readonly probes: SellerListOrdersProbes,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellerListInput,
  ): Promise<Result<SellerOrderListView, FulfilmentFailure>> {
    const page = await listSellerOrders(this.deps, context, input);
    if (!page.ok) return page;
    const granted = await heldKeys(context, {
      [ORDERING_SELLER_ORDER_MARK_READY.key]: this.probes.markReadyProbe,
      [ORDERING_SELLER_ORDER_CONFIRM_PICKUP.key]: this.probes.confirmPickupProbe,
      [ORDERING_SELLER_ORDER_MARK_DELIVERED.key]: this.probes.markDeliveredProbe,
      [ORDERING_SELLER_ORDER_MARK_UNAVAILABLE.key]: this.probes.markUnavailableProbe,
    });
    return ok({
      ...page.value,
      sellerOrders: page.value.sellerOrders.map((order) => ({
        ...order,
        actions: rowActions(order, SELLER_ORDER_ACTION_RULES, granted),
      })),
    });
  }
}
