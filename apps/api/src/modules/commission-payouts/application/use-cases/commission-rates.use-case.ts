import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CommissionRateMap } from '../../contracts/commission-payouts.facade';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import { readCommissionRates, type RatesFailure } from '../rate-flow';

/**
 * `commission-payouts.commission-rates`: the rate in force for up to 100 sellers, for `ordering`
 * to freeze on the order lines at checkout (called with the signed-in customer's context). The
 * method is not exposed over HTTP.
 */
export class CommissionRates extends UseCase<
  { readonly sellerIds: unknown },
  CommissionRateMap,
  RatesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.commission-rates',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly sellerIds: unknown }) {
    return readCommissionRates(this.deps, context, input);
  }
}
