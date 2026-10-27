import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_PAYOUT_TERMS_VIEW } from '../../contracts/permissions';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import { viewPayoutTerms, type TermsFailure, type PayoutTermsView } from '../terms-flow';

export type { PayoutTermsView };

type Input = { readonly sellerId: unknown };

/** `commission-payouts.view-seller-payout-terms`: an admin reads a seller's effective payout terms (the Market's with the seller's own over them). */
export class ViewSellerPayoutTerms extends UseCase<Input, PayoutTermsView, TermsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.view-seller-payout-terms',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_PAYOUT_TERMS_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return viewPayoutTerms(this.deps, context, input);
  }
}
