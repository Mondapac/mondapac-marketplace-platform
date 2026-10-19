import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_REFUND } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import {
  sellerRefund,
  type RefundFailure,
  type RefundInput,
  type RefundView,
} from '../refund-flow';

/**
 * The seller refunds part or all of one of its own paid seller orders (tax step 3; rule
 * `permissions [ordering.seller-order.refund]`, a protected key). Off while
 * `tax.refundCredit.enabled` is.
 */
export class SellerRefundOrder extends UseCase<RefundInput, RefundView, RefundFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-refund-order',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_REFUND.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: RefundInput) {
    return sellerRefund(this.deps, context, input);
  }
}
