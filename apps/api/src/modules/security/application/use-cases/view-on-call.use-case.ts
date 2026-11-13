import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SECURITY_VIEW } from '../../contracts/permissions';
import { viewOnCall, type OnCallView, type SecurityFailure } from '../respond-flow';
import type { SecurityDependencies } from '../security-dependencies';

export type { OnCallView } from '../respond-flow';

/**
 * `security.view-on-call`: the on-call tab: who is on call, the s1 escalation chain, the next four
 * weeks and the channels by severity; names only (security.centre.view).
 */
export class ViewOnCall extends UseCase<Record<string, never>, OnCallView, SecurityFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'security.view-on-call',
    rule: { kind: 'permissions', allOf: [SECURITY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SecurityDependencies,
  ) {
    super(gate);
  }

  protected handle() {
    return Promise.resolve(viewOnCall(this.deps));
  }
}
