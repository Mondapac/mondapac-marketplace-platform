import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_SETTLEMENT_VIEW } from '../../contracts/permissions';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import { viewCommissionRate, type RateFailure, type RateView } from '../rate-flow';

export type { RateView };

/** `commission-payouts.view-commission-rate`: an admin reads a seller's commission rate. */
export class ViewCommissionRate extends UseCase<
  { readonly sellerId: unknown },
  RateView,
  RateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.view-commission-rate',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_SETTLEMENT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly sellerId: unknown }) {
    return viewCommissionRate(this.deps, context, input);
  }
}
