import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SECURITY_RESPOND } from '../../contracts/permissions';
import { resolve, type AlertDetailView, type SecurityFailure } from '../respond-flow';
import type { SecurityDependencies } from '../security-dependencies';

interface ResolveInput {
  readonly alertId?: unknown;
  readonly expectedVersion?: unknown;
  readonly resolution?: unknown;
  readonly note?: unknown;
}

/**
 * `security.resolve-security-alert`: a responder closes an alert with an outcome and a note. An s1
 * alert only by the roster's incident commander or security owner (D2). Refused in acting-as;
 * audited; a stale version is a conflict (security.alerts.respond).
 */
export class ResolveSecurityAlert extends UseCase<ResolveInput, AlertDetailView, SecurityFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'security.resolve-security-alert',
    rule: { kind: 'permissions', allOf: [SECURITY_RESPOND.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SecurityDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: ResolveInput) {
    return resolve(this.deps, context, input);
  }
}
