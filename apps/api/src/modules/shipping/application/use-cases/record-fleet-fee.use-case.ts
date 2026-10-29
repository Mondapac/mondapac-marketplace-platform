import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  recordFleetFee,
  type RecordFleetFeeFailure,
  type RecordFleetFeeOutcome,
} from '../fleet-fee-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/**
 * `shipping.record-fleet-fee`: records a fee a fleet charged the platform (cancel, waiting, return)
 * in the fleet-fee ledger. Rule `system`: the fleet adapters' webhook and invoice handlers call it,
 * through the shipping facade. Not exposed over HTTP.
 */
export class RecordFleetFee extends UseCase<unknown, RecordFleetFeeOutcome, RecordFleetFeeFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.record-fleet-fee',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: unknown) {
    return recordFleetFee(this.deps, context, input);
  }
}
