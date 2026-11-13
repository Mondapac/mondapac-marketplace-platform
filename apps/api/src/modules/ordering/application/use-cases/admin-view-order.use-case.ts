import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_ORDER_VIEW } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import type { LabelledAdminOrderView } from '../../domain/order-views';
import { viewAnyOrder, type ReadFailure } from '../read-flow';
import { refundsOfOrder, type RefundView } from '../refund-flow';

/** The admin order page: the order, its refunds, and whether refunds are switched on. */
export interface AdminOrderDetailView extends LabelledAdminOrderView {
  /** Every refund of the order, oldest first (any state). */
  readonly refunds: readonly RefundView[];
  /** The Market switch `tax.refundCredit.enabled`: off, the page offers no refund or cancel. */
  readonly refundsEnabled: boolean;
}

/** One order of the Market for support and oversight (rule `permissions [ordering.order.view]`). */
export class AdminViewOrder extends UseCase<
  { readonly orderId: unknown },
  AdminOrderDetailView,
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

  protected async handle(context: CallContext, input: { readonly orderId: unknown }) {
    const read = await viewAnyOrder(this.deps, context, input);
    if (!read.ok) return read;
    // Refunds made while the switch was on stay visible after it is turned off.
    const refunds = await refundsOfOrder(this.deps, context, read.value.orderId);
    const refundsEnabled = this.deps.policy.refundsEnabled(context.market);
    return { ok: true as const, value: { ...read.value, refunds, refundsEnabled } };
  }
}
