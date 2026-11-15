import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SYSTEM_REQUESTS_REQUEST_VIEW } from '../../contracts/permissions';
import { listRequests, type ListInput, type RequestListView } from '../list-flow';
import type { SystemRequestsFailure } from '../request-flow';
import type { SystemRequestsDependencies } from '../system-requests-dependencies';

export type { RequestListView };

type Input = ListInput;

/**
 * `system-requests.list-system-requests`: One page of a System requests view, every view's count and each row's actions for the caller (a super list).
 */
export class ListSystemRequests extends UseCase<Input, RequestListView, SystemRequestsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'system-requests.list-system-requests',
    rule: { kind: 'permissions', allOf: [SYSTEM_REQUESTS_REQUEST_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SystemRequestsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return listRequests(this.deps, context, input);
  }
}
