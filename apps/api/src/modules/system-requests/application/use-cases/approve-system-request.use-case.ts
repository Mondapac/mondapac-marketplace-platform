import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SYSTEM_REQUESTS_REQUEST_VIEW } from '../../contracts/permissions';
import { approveRequest, type RequestView, type SystemRequestsFailure } from '../request-flow';
import type { SystemRequestsDependencies } from '../system-requests-dependencies';

type Input = { readonly requestId: unknown };

/**
 * `system-requests.approve-system-request`: Another admin who holds the area's review key approves; the change stays live (step-up for high risk).
 */
export class ApproveSystemRequest extends UseCase<Input, RequestView, SystemRequestsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'system-requests.approve-system-request',
    rule: { kind: 'permissions', allOf: [SYSTEM_REQUESTS_REQUEST_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SystemRequestsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return approveRequest(this.deps, context, input);
  }
}
