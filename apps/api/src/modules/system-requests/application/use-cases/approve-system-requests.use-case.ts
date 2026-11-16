import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SYSTEM_REQUESTS_REQUEST_VIEW } from '../../contracts/permissions';
import { approveRequests, type BulkOutcome, type SystemRequestsFailure } from '../request-flow';
import type { SystemRequestsDependencies } from '../system-requests-dependencies';

export type { BulkOutcome };

type Input = { readonly requestIds: unknown };

/**
 * `system-requests.approve-system-requests`: Bulk approve of low-risk requests, each in its own unit; one refusal does not stop the others.
 */
export class ApproveSystemRequests extends UseCase<
  Input,
  readonly BulkOutcome[],
  SystemRequestsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'system-requests.approve-system-requests',
    rule: { kind: 'permissions', allOf: [SYSTEM_REQUESTS_REQUEST_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SystemRequestsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return approveRequests(this.deps, context, input);
  }
}
