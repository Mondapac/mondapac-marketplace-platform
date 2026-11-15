import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_REFUND_LIMITS_MANAGE } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import {
  removeRefundLimit,
  type RefundLimitsFailure,
  type RefundLimitsView,
} from '../refund-limits-flow';

/** Removes a seller's own cap on seller refunds; the Market default is in force again (rule `permissions [ordering.refund-limits.manage]`). */
export class AdminRemoveRefundLimit extends UseCase<
  { readonly sellerId: unknown; readonly expectedVersion: unknown },
  RefundLimitsView,
  RefundLimitsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-remove-refund-limit',
    rule: { kind: 'permissions', allOf: [ORDERING_REFUND_LIMITS_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly sellerId: unknown; readonly expectedVersion: unknown },
  ) {
    return removeRefundLimit(this.deps, context, input);
  }
}
