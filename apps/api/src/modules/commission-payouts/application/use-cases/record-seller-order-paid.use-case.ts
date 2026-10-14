import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PaidSellerOrder } from '../../contracts/commission-payouts.facade';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import { recordSellerOrderPaid, type LedgerFailure } from '../ledger-flow';

/**
 * `commission-payouts.record-seller-order-paid`: writes the ledger rows of a paid seller order.
 * Rule `system`: only ordering's worker job calls it, through the facade.
 */
export class RecordSellerOrderPaid extends UseCase<
  PaidSellerOrder,
  'recorded' | 'already-recorded',
  LedgerFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.record-seller-order-paid',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: PaidSellerOrder) {
    return recordSellerOrderPaid(this.deps, context, input);
  }
}
