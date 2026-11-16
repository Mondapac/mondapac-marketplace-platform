import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SYSTEM_REQUESTS_POLICY_VIEW } from '../../contracts/permissions';
import { viewPolicy, type PolicyView } from '../policy-flow';
import type { SystemRequestsFailure } from '../request-flow';
import type { SystemRequestsDependencies } from '../system-requests-dependencies';

export type { AreaPolicyView, DueDaysView, PolicyChangeView, PolicyView } from '../policy-flow';

type Input = Record<string, never>;

/**
 * `system-requests.view-review-policy`: Every area's review policy and the review period, defaults included.
 */
export class ViewReviewPolicy extends UseCase<Input, PolicyView, SystemRequestsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'system-requests.view-review-policy',
    rule: { kind: 'permissions', allOf: [SYSTEM_REQUESTS_POLICY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SystemRequestsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewPolicy(this.deps, context);
  }
}
