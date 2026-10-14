import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_SETTLEMENT_VIEW } from '../../contracts/permissions';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import {
  viewSellerLedger,
  type LedgerFailure,
  type LedgerView,
  type PageInput,
} from '../ledger-flow';

type Input = PageInput & { readonly sellerId: unknown };

/** `commission-payouts.view-seller-ledger`: an admin reads a seller's ledger and balance. */
export class ViewSellerLedger extends UseCase<Input, LedgerView, LedgerFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.view-seller-ledger',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_SETTLEMENT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return viewSellerLedger(this.deps, context, input);
  }
}
