import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_ORDER_REFUND } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import {
  adminCancelOrder,
  type CancelFailure,
  type CancelInput,
  type CancelView,
} from '../refund-flow';

export type { CancelView };

/**
 * An admin cancels a paid order and refunds all of it while no seller has started on it (order
 * detail decision 1; rule `permissions [ordering.order.refund]`, the protected refund key: a
 * cancellation gives money back). Off while `tax.refundCredit.enabled` is.
 */
export class AdminCancelOrder extends UseCase<CancelInput, CancelView, CancelFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-cancel-order',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_REFUND.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: CancelInput) {
    return adminCancelOrder(this.deps, context, input);
  }
}
