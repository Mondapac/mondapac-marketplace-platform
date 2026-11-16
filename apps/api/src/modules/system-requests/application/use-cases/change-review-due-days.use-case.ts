import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SYSTEM_REQUESTS_POLICY_MANAGE } from '../../contracts/permissions';
import { changeDueDays, type DueDaysView, type PolicyChangeView } from '../policy-flow';
import type { SystemRequestsFailure } from '../request-flow';
import type { SystemRequestsDependencies } from '../system-requests-dependencies';

type Input = {
  readonly reviewDueDays: unknown;
  readonly expectedVersion: unknown;
  readonly note: unknown;
};

/**
 * `system-requests.change-review-due-days`: Changes after how many days an open request is overdue (step-up); the change is itself reviewed, as high risk.
 */
export class ChangeReviewDueDays extends UseCase<
  Input,
  PolicyChangeView<DueDaysView>,
  SystemRequestsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'system-requests.change-review-due-days',
    rule: { kind: 'permissions', allOf: [SYSTEM_REQUESTS_POLICY_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SystemRequestsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return changeDueDays(this.deps, context, input);
  }
}
