import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SYSTEM_REQUESTS_REQUEST_VIEW } from '../../contracts/permissions';
import {
  approveMatching,
  MATCHING_FIELDS,
  type MatchingInput,
  type MatchingOutcome,
} from '../list-flow';
import type { SystemRequestsFailure } from '../request-flow';
import type { SystemRequestsDependencies } from '../system-requests-dependencies';

export { MATCHING_FIELDS, type MatchingInput, type MatchingOutcome };

/**
 * `system-requests.approve-matching-system-requests`: "select all matching" for bulk approve
 * (rule 14): approves up to 100 low-risk requests matching the list's view, search and filters
 * that the caller may decide, each in its own unit, and says how many remain.
 */
export class ApproveMatchingSystemRequests extends UseCase<
  MatchingInput,
  MatchingOutcome,
  SystemRequestsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'system-requests.approve-matching-system-requests',
    rule: { kind: 'permissions', allOf: [SYSTEM_REQUESTS_REQUEST_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SystemRequestsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: MatchingInput) {
    return approveMatching(this.deps, context, input);
  }
}
