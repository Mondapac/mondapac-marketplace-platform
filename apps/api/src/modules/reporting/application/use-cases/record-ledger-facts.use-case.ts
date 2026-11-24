import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import {
  recordLedgerFromEvent,
  type LedgerFactsDependencies,
  type LedgerFactsFailure,
} from '../ledger-facts-sync';

export interface RecordLedgerFactsInput {
  readonly delivery: EventDelivery;
  readonly sellerOrderId: string;
}

/**
 * `reporting.record-ledger-facts` (dashboards v2, phase 1, PR 4): the handler of
 * `commission-payouts.ledger-recorded.v1`. Rule `system`. Reads the seller order's commission and
 * seller-cashback rows from commission-payouts and records them with the ledger rollup of every
 * seller day they fall on, once per delivery.
 */
export class RecordLedgerFacts extends UseCase<
  RecordLedgerFactsInput,
  { readonly handled: boolean; readonly entries: number },
  LedgerFactsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reporting.record-ledger-facts',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: LedgerFactsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: RecordLedgerFactsInput,
  ): Promise<Result<{ readonly handled: boolean; readonly entries: number }, LedgerFactsFailure>> {
    return recordLedgerFromEvent(this.deps, context, input.delivery, input.sellerOrderId);
  }
}
