import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_REFUND_LIMITS_VIEW } from '../../contracts/permissions';
import type { OrderingDependencies } from '../checkout-flow';
import {
  viewRefundLimits,
  type RefundLimitsFailure,
  type RefundLimitsView,
  type RefundLimitView,
} from '../refund-limits-flow';

export type { RefundLimitView, RefundLimitsView };

/** The caps on seller refunds of the Market, and of one seller when named (rule `permissions [ordering.refund-limits.view]`). */
export class AdminViewRefundLimits extends UseCase<
  { readonly sellerId: unknown },
  RefundLimitsView,
  RefundLimitsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-view-refund-limits',
    rule: { kind: 'permissions', allOf: [ORDERING_REFUND_LIMITS_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly sellerId: unknown }) {
    return viewRefundLimits(this.deps, context, input);
  }
}
