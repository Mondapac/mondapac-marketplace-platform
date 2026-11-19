import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SECURITY_VIEW } from '../../contracts/permissions';
import { viewSummary, type SecurityFailure, type SummaryView } from '../respond-flow';
import type { SecurityDependencies } from '../security-dependencies';

export type { SummaryView } from '../respond-flow';

/**
 * `security.view-security-summary`: the live alerts by severity, when the rules last ran and who is
 * on call now: the top of the security centre and the S1 badge (security.centre.view).
 */
export class ViewSecuritySummary extends UseCase<
  Record<string, never>,
  SummaryView,
  SecurityFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'security.view-security-summary',
    rule: { kind: 'permissions', allOf: [SECURITY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SecurityDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewSummary(this.deps, context);
  }
}
