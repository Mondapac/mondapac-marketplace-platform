import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_REFUND_LIMITS_MANAGE } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import {
  setRefundLimit,
  type RefundLimitsFailure,
  type RefundLimitsView,
} from '../refund-limits-flow';

/** Sets the Market's default cap on seller refunds or one seller's own (decision 6; Hassan F2; rule `permissions [ordering.refund-limits.manage]`, a protected key). */
export class AdminSetRefundLimit extends UseCase<
  {
    readonly sellerId: unknown;
    readonly maxCount: unknown;
    readonly maxAmount: unknown;
    readonly expectedVersion: unknown;
  },
  RefundLimitsView,
  RefundLimitsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-set-refund-limit',
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
    input: {
      readonly sellerId: unknown;
      readonly maxCount: unknown;
      readonly maxAmount: unknown;
      readonly expectedVersion: unknown;
    },
  ) {
    return setRefundLimit(this.deps, context, input);
  }
}
