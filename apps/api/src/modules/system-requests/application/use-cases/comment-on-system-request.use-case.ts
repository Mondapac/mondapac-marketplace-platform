import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SYSTEM_REQUESTS_REQUEST_VIEW } from '../../contracts/permissions';
import { commentOnRequest, type ActivityView, type SystemRequestsFailure } from '../request-flow';
import type { SystemRequestsDependencies } from '../system-requests-dependencies';

type Input = { readonly requestId: unknown; readonly body: unknown };

/**
 * `system-requests.comment-on-system-request`: Anyone who sees the queue comments on a request, whatever its status; no decision.
 */
export class CommentOnSystemRequest extends UseCase<Input, ActivityView, SystemRequestsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'system-requests.comment-on-system-request',
    rule: { kind: 'permissions', allOf: [SYSTEM_REQUESTS_REQUEST_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SystemRequestsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return commentOnRequest(this.deps, context, input);
  }
}
