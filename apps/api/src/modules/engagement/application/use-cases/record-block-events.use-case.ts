import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  recordBlockEvents,
  type BlockCountDependencies,
  type RecordBlockEventsFailure,
  type RecordBlockEventsInput,
} from '../block-count-flow';

/**
 * `engagement.record-block-events`: the storefront reports that blocks of a published page were
 * shown or clicked (rule `anonymous`: no session, cookie or any identifier of the sender is read).
 * Adds to the daily counts of the placements storefront serves now; skips the rest silently.
 */
export class RecordBlockEvents extends UseCase<
  RecordBlockEventsInput,
  { readonly recorded: boolean },
  RecordBlockEventsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.record-block-events',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlockCountDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: RecordBlockEventsInput) {
    return recordBlockEvents(this.deps, context, input);
  }
}
