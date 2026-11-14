import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SECURITY_VIEW } from '../../contracts/permissions';
import { viewAlert, type AlertDetailView, type SecurityFailure } from '../respond-flow';
import type { SecurityDependencies } from '../security-dependencies';

export type { AlertDetailView } from '../respond-flow';

/**
 * `security.view-security-alert`: one alert in full with its delivery timeline (security.centre.view).
 */
export class ViewSecurityAlert extends UseCase<
  { readonly alertId?: unknown },
  AlertDetailView,
  SecurityFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'security.view-security-alert',
    rule: { kind: 'permissions', allOf: [SECURITY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SecurityDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly alertId?: unknown }) {
    return viewAlert(this.deps, context, input);
  }
}
