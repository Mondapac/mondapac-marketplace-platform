import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SYSTEM_REQUESTS_POLICY_MANAGE } from '../../contracts/permissions';
import { changeAreaPolicy, type AreaPolicyView, type PolicyChangeView } from '../policy-flow';
import type { SystemRequestsFailure } from '../request-flow';
import type { SystemRequestsDependencies } from '../system-requests-dependencies';

type Input = {
  readonly area: unknown;
  readonly enabled: unknown;
  readonly risk: unknown;
  readonly expectedVersion: unknown;
  readonly note: unknown;
};

/**
 * `system-requests.change-area-review-policy`: Turns an area's review on or off or changes its default risk (step-up); the change is itself reviewed, as high risk.
 */
export class ChangeAreaReviewPolicy extends UseCase<
  Input,
  PolicyChangeView<AreaPolicyView>,
  SystemRequestsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'system-requests.change-area-review-policy',
    rule: { kind: 'permissions', allOf: [SYSTEM_REQUESTS_POLICY_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SystemRequestsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return changeAreaPolicy(this.deps, context, input);
  }
}
