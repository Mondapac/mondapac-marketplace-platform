import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_EARNINGS_VIEW } from '../../contracts/permissions';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import {
  viewOwnExclusiveCommission,
  type ExclusiveCommissionFailure,
  type ExclusiveCommissionView,
} from '../exclusive-savings-flow';

export type { ExclusiveCommissionView };

/**
 * `commission-payouts.view-own-exclusive-commission`: the acting seller's lower commission on its
 * exclusive customers and what it saved by month (customers management phase 4b).
 */
export class ViewOwnExclusiveCommission extends UseCase<
  Record<string, never>,
  ExclusiveCommissionView,
  ExclusiveCommissionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.view-own-exclusive-commission',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_EARNINGS_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewOwnExclusiveCommission(this.deps, context);
  }
}
