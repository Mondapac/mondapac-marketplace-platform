import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_EARNINGS_VIEW } from '../../contracts/permissions';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import { viewOwnLedger, type LedgerFailure, type LedgerView, type PageInput } from '../ledger-flow';

export type { LedgerView };

/** `commission-payouts.view-own-ledger`: the acting seller reads its own ledger and balance. */
export class ViewOwnLedger extends UseCase<PageInput, LedgerView, LedgerFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.view-own-ledger',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_EARNINGS_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: PageInput) {
    return viewOwnLedger(this.deps, context, input);
  }
}
