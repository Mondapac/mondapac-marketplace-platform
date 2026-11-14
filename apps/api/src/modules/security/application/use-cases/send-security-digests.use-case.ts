import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { sendDigests, type DigestReport } from '../deliver-flow';
import type { SecurityDependencies } from '../security-dependencies';

/**
 * `security.send-security-digests`: the daily s3 digest and the weekly s4 report of one Market, once
 * per period, in business hours. Rule `system`: run by the digest job hourly only.
 */
export class SendSecurityDigests extends UseCase<Record<string, never>, DigestReport, never> {
  static override readonly access: AccessDeclaration = {
    name: 'security.send-security-digests',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SecurityDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return sendDigests(this.deps, context);
  }
}
