import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EngagementDependencies } from '../engagement-dependencies';
import {
  recordCustomerEvent,
  type RecordFailure,
  type Recorded,
  type RecordInput,
} from '../engagement-flow';

/** `engagement.record-event`: a signed-in customer's shopping behaviour (rule `own-resources`). */
export class RecordEvent extends UseCase<RecordInput, Recorded, RecordFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.record-event',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: EngagementDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: RecordInput) {
    return recordCustomerEvent(this.deps, context, input);
  }
}
