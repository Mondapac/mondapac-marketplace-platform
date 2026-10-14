import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OrderingDependencies } from '../checkout-flow';
import { recordLedger, type LedgerRecording } from '../ledger-flow';

/**
 * Writes paid seller orders into the seller ledger (commission-payouts). Rule `system`: only the
 * worker's job `ordering.record-ledger` calls it.
 */
export class RecordLedger extends UseCase<Record<string, never>, LedgerRecording, never> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.record-ledger',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return recordLedger(this.deps, context);
  }
}
