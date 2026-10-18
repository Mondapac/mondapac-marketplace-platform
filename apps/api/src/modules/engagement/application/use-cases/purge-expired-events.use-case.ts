import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EngagementDependencies } from '../engagement-dependencies';
import { purgeExpiredEvents } from '../engagement-flow';

export interface PurgeExpiredEventsOutput {
  readonly accountEvents: number;
  readonly guestEvents: number;
}

/**
 * `engagement.purge-expired-events`: for one Market, deletes the behaviour past its retention
 * (12 months for an account, 30 days for a guest). Rule `system`: run by the daily job only.
 */
export class PurgeExpiredEvents extends UseCase<
  Record<string, never>,
  PurgeExpiredEventsOutput,
  never
> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.purge-expired-events',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: EngagementDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return purgeExpiredEvents(this.deps, context);
  }
}
