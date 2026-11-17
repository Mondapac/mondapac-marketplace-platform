import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SECURITY_RESPOND } from '../../contracts/permissions';
import { acknowledge, type AlertDetailView, type SecurityFailure } from '../respond-flow';
import type { SecurityDependencies } from '../security-dependencies';

interface AckInput {
  readonly alertId?: unknown;
  readonly expectedVersion?: unknown;
}

/**
 * `security.acknowledge-security-alert`: a responder takes an open alert of any severity; its
 * escalation stops. Refused in acting-as; audited; a stale version is a conflict (security.alerts.respond).
 */
export class AcknowledgeSecurityAlert extends UseCase<AckInput, AlertDetailView, SecurityFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'security.acknowledge-security-alert',
    rule: { kind: 'permissions', allOf: [SECURITY_RESPOND.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SecurityDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: AckInput) {
    return acknowledge(this.deps, context, input);
  }
}
