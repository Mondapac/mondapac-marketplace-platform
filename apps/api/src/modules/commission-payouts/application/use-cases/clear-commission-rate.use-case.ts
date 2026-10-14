import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_RATE_EDIT } from '../../contracts/permissions';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import { clearCommissionRate, type RateFailure, type RateView } from '../rate-flow';

/**
 * `commission-payouts.clear-commission-rate`: an admin removes a seller's own rate, putting the
 * seller back on the Market rate (protected key).
 */
export class ClearCommissionRate extends UseCase<
  { readonly sellerId: unknown },
  RateView,
  RateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.clear-commission-rate',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_RATE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly sellerId: unknown }) {
    return clearCommissionRate(this.deps, context, input);
  }
}
