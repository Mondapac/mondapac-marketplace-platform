import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { RefundedSellerOrder } from '../../contracts/commission-payouts.facade';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import { recordRefund, type LedgerFailure } from '../ledger-flow';

/**
 * `commission-payouts.record-refund`: writes the ledger reversal rows of a succeeded refund. Rule
 * `system`: only ordering's worker job calls it, through the facade.
 */
export class RecordRefund extends UseCase<
  RefundedSellerOrder,
  'recorded' | 'already-recorded' | 'nothing-to-post',
  LedgerFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.record-refund',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: RefundedSellerOrder) {
    return recordRefund(this.deps, context, input);
  }
}
