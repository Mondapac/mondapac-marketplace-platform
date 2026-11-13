import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OwnCommissionPreview } from '../../contracts/commission-payouts.facade';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import { ownCommissionOn, type RatesFailure } from '../rate-flow';

/**
 * `commission-payouts.own-commission-on`: the commission the signed-in approved seller would pay on
 * an amount, from its own rate (own resources: the seller is the session's, never a request
 * field). For `promotions`' payout preview; not exposed over HTTP.
 */
export class OwnCommissionOn extends UseCase<
  { readonly amount: bigint; readonly taxInclusive: boolean },
  OwnCommissionPreview,
  RatesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.own-commission-on',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly amount: bigint; readonly taxInclusive: boolean },
  ) {
    return ownCommissionOn(this.deps, context, input);
  }
}
