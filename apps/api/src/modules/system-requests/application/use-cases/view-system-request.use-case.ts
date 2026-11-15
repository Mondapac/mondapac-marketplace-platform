import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SYSTEM_REQUESTS_REQUEST_VIEW } from '../../contracts/permissions';
import { viewRequest, type RequestDetailView, type SystemRequestsFailure } from '../request-flow';
import type { SystemRequestsDependencies } from '../system-requests-dependencies';

export type { ActivityView, RequestDetailView, RequestView } from '../request-flow';

type Input = { readonly requestId: unknown };

/**
 * `system-requests.view-system-request`: One request with the values before and after, its history and the caller's actions.
 */
export class ViewSystemRequest extends UseCase<Input, RequestDetailView, SystemRequestsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'system-requests.view-system-request',
    rule: { kind: 'permissions', allOf: [SYSTEM_REQUESTS_REQUEST_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SystemRequestsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return viewRequest(this.deps, context, input);
  }
}
