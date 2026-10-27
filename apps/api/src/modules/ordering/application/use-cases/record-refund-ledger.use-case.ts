import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OrderingDependencies } from '../checkout-flow';
import { recordRefundLedger, type RefundLedgerRecording } from '../ledger-flow';

/**
 * Writes succeeded refunds into the seller ledger (commission-payouts). Rule `system`: only the
 * worker's job `ordering.record-refund-ledger` calls it.
 */
export class RecordRefundLedger extends UseCase<
  Record<string, never>,
  RefundLedgerRecording,
  never
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.record-refund-ledger',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return recordRefundLedger(this.deps, context);
  }
}
