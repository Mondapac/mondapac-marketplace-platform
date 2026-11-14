import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { deliverDueAlerts, type DeliveryReport } from '../deliver-flow';
import type { SecurityDependencies } from '../security-dependencies';

/**
 * `security.deliver-security-alerts`: takes the due delivery step of each open alert of one Market
 * (s1 escalation, s2 in business hours). Rule `system`: run by the delivery job every minute only.
 */
export class DeliverSecurityAlerts extends UseCase<Record<string, never>, DeliveryReport, never> {
  static override readonly access: AccessDeclaration = {
    name: 'security.deliver-security-alerts',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SecurityDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return deliverDueAlerts(this.deps, context);
  }
}
