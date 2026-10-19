import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_ORDER_REFUND } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import { adminRefund, type RefundFailure, type RefundInput, type RefundView } from '../refund-flow';

/**
 * An admin refunds part or all of one seller order of a paid order (tax step 3; rule
 * `permissions [ordering.order.refund]`, a protected key). Off while `tax.refundCredit.enabled` is.
 */
export class AdminRefundOrder extends UseCase<
  RefundInput & { readonly orderId: unknown },
  RefundView,
  RefundFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-refund-order',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_REFUND.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: RefundInput & { readonly orderId: unknown }) {
    return adminRefund(this.deps, context, input);
  }
}
