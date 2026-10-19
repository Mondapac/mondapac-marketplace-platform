import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EngagementDependencies } from '../engagement-dependencies';
import {
  recordGuestEvent,
  type GuestCookie,
  type RecordFailure,
  type Recorded,
  type RecordGuestInput,
} from '../engagement-flow';

/**
 * `engagement.record-guest-event`: a guest's shopping behaviour (rule `anonymous`: no session),
 * kept under the hash of the engagement guest cookie for 30 days.
 */
export class RecordGuestEvent extends UseCase<
  RecordGuestInput,
  Recorded & { readonly cookie: GuestCookie },
  RecordFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.record-guest-event',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: EngagementDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: RecordGuestInput) {
    return recordGuestEvent(this.deps, context, input);
  }
}
