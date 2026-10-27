import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_PAYOUT_TERMS_EDIT } from '../../contracts/permissions';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import { setPayoutTerms, type TermsFailure, type PayoutTermsView } from '../terms-flow';

export type { PayoutTermsView };

type Input = {
  readonly sellerId: unknown;
  readonly terms: unknown;
  readonly expectedVersion: unknown;
};

/** `commission-payouts.set-seller-payout-terms`: an admin sets a seller's own payout terms (protected key). */
export class SetSellerPayoutTerms extends UseCase<Input, PayoutTermsView, TermsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.set-seller-payout-terms',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_PAYOUT_TERMS_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return setPayoutTerms(this.deps, context, input);
  }
}
