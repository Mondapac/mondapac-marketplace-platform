import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SECURITY_RESPOND } from '../../contracts/permissions';

/**
 * `security.alert-respond-probe`: asks the gate whether the caller holds `security.alerts.respond`.
 * It reads and writes nothing. The alert list calls it to name the row actions the caller may run;
 * `access.denied` means "no". Acknowledging and resolving check the key, the version and the s1
 * resolver rule again when they run.
 */
export class AlertRespondProbe extends UseCase<
  Record<string, never>,
  { readonly held: true },
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'security.alert-respond-probe',
    rule: { kind: 'permissions', allOf: [SECURITY_RESPOND.key] },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(): Promise<Result<{ readonly held: true }, { readonly code: 'access.denied' }>> {
    return Promise.resolve(ok({ held: true }));
  }
}
