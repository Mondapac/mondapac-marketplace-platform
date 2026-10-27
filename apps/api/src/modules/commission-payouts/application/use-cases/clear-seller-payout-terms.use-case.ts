import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_PAYOUT_TERMS_EDIT } from '../../contracts/permissions';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import { clearPayoutTerms, type TermsFailure, type PayoutTermsView } from '../terms-flow';

export type { PayoutTermsView };

type Input = {
  readonly sellerId: unknown;
  readonly expectedVersion: unknown;
  readonly reasonCode: unknown;
};

/** `commission-payouts.clear-seller-payout-terms`: an admin removes a seller's own payout terms (protected key). */
export class ClearSellerPayoutTerms extends UseCase<Input, PayoutTermsView, TermsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.clear-seller-payout-terms',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_PAYOUT_TERMS_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return clearPayoutTerms(this.deps, context, input);
  }
}
