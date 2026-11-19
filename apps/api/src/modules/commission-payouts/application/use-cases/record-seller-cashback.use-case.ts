import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SellerCashback } from '../../contracts/commission-payouts.facade';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import { recordSellerCashback, type LedgerFailure } from '../ledger-flow';

/**
 * `commission-payouts.record-seller-cashback`: debits a seller's cashback for its exclusive
 * customer from the seller order's payout (customers phase 4c). Rule `system`: only promotions'
 * delivery handler calls it, through the facade.
 */
export class RecordSellerCashback extends UseCase<
  SellerCashback,
  'recorded' | 'already-recorded',
  LedgerFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.record-seller-cashback',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: SellerCashback) {
    return recordSellerCashback(this.deps, context, input);
  }
}
