import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SYSTEM_REQUESTS_REQUEST_VIEW } from '../../contracts/permissions';
import { withdrawRequest, type RequestView, type SystemRequestsFailure } from '../request-flow';
import type { SystemRequestsDependencies } from '../system-requests-dependencies';

type Input = { readonly requestId: unknown; readonly reason: unknown };

/**
 * `system-requests.withdraw-system-request`: The author reverts their own change with a reason; the value before is restored if nobody changed it since (step-up for high risk).
 */
export class WithdrawSystemRequest extends UseCase<Input, RequestView, SystemRequestsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'system-requests.withdraw-system-request',
    rule: { kind: 'permissions', allOf: [SYSTEM_REQUESTS_REQUEST_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SystemRequestsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return withdrawRequest(this.deps, context, input);
  }
}
