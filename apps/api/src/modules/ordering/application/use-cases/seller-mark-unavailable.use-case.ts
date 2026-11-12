import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_SELLER_ORDER_MARK_UNAVAILABLE } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import {
  sellerUnavailableRefund,
  type RefundFailure,
  type RefundView,
  type UnavailableInput,
} from '../refund-flow';

/**
 * The seller marks units of one of its own paid seller orders unavailable before it is ready
 * (order detail decision 6); they are refunded to the customer at once and the seller bears it.
 * Rule `permissions [ordering.seller-order.mark-unavailable]`, a protected key. A seller that is
 * not approved is refused, like the ready signal. Off while `tax.refundCredit.enabled` is.
 */
export class SellerMarkUnavailable extends UseCase<UnavailableInput, RefundView, RefundFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-mark-unavailable',
    rule: { kind: 'permissions', allOf: [ORDERING_SELLER_ORDER_MARK_UNAVAILABLE.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: UnavailableInput) {
    return sellerUnavailableRefund(this.deps, context, input);
  }
}
