import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SECURITY_VIEW } from '../../contracts/permissions';
import { listAlerts, type AlertPage, type SecurityFailure } from '../respond-flow';
import type { SecurityDependencies } from '../security-dependencies';

export type { AlertPage, AlertSummaryView } from '../respond-flow';

interface ListInput {
  readonly state?: unknown;
  readonly severity?: unknown;
  readonly after?: unknown;
  readonly limit?: unknown;
}

/**
 * `security.list-security-alerts`: the Market's alerts by severity, newest first, filtered by state
 * and severity, a page at a time (security.centre.view).
 */
export class ListSecurityAlerts extends UseCase<ListInput, AlertPage, SecurityFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'security.list-security-alerts',
    rule: { kind: 'permissions', allOf: [SECURITY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SecurityDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: ListInput) {
    return listAlerts(this.deps, context, input);
  }
}
