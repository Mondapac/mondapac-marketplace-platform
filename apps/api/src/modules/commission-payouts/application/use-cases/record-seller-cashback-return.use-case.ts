import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SellerCashbackReturn } from '../../contracts/commission-payouts.facade';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import { recordSellerCashbackReturn, type LedgerFailure } from '../ledger-flow';

/**
 * `commission-payouts.record-seller-cashback-return`: credits back to the seller what a refund
 * took back of its cashback from the customer's wallet (customers phase 4c-2). Rule `system`: only
 * promotions' refund handler calls it, through the facade.
 */
export class RecordSellerCashbackReturn extends UseCase<
  SellerCashbackReturn,
  'recorded' | 'already-recorded',
  LedgerFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.record-seller-cashback-return',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: SellerCashbackReturn) {
    return recordSellerCashbackReturn(this.deps, context, input);
  }
}
