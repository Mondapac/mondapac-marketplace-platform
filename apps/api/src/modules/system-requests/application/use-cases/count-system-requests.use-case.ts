import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SYSTEM_REQUESTS_REQUEST_VIEW } from '../../contracts/permissions';
import { badgeCounts, type BadgeView } from '../list-flow';
import type { SystemRequestsFailure } from '../request-flow';
import type { SystemRequestsDependencies } from '../system-requests-dependencies';

export type { BadgeView };

type Input = Record<string, never>;

/**
 * `system-requests.count-system-requests`: The menu badge: open requests the caller may review (not their own), and the overdue count.
 */
export class CountSystemRequests extends UseCase<Input, BadgeView, SystemRequestsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'system-requests.count-system-requests',
    rule: { kind: 'permissions', allOf: [SYSTEM_REQUESTS_REQUEST_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SystemRequestsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return badgeCounts(this.deps, context);
  }
}
