import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { pollFleetStatus, type PollFailure, type PollSummary } from '../fleet-webhook-flow';
import type { ShippingDependencies } from '../shipping-dependencies';

/**
 * `shipping.poll-fleet-status`: asks the fleets that send no verifiable webhook (Zoom2u,
 * Australia Post) about their open bookings. Rule `system`, run by the worker's job once per
 * hosted Market. Not exposed over HTTP.
 */
export class PollFleetStatus extends UseCase<Record<string, never>, PollSummary, PollFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'shipping.poll-fleet-status',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShippingDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return pollFleetStatus(this.deps, context);
  }
}
