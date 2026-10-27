import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { DisputeDependencies } from '../dispute-dependencies';
import { syncDispute, type DisputeEventFailure, type SyncOutcome } from '../dispute-flow';

interface Input {
  readonly delivery: EventDelivery;
  readonly disputeId: string;
}

/**
 * `commission-payouts.sync-dispute`, from the subscription of the same name on
 * `payments.dispute-changed.v1`: reads the dispute through payments and brings the case, the
 * holds and the seller notices up to date. Rule `system`.
 */
export class SyncDispute extends UseCase<Input, SyncOutcome, DisputeEventFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.sync-dispute',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DisputeDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return syncDispute(this.deps, context, input);
  }
}
