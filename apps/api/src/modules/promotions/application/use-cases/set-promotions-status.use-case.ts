import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PROMOTIONS_SETTINGS_MANAGE } from '../../contracts/permissions';
import type { PromotionsDependencies } from '../promotions-dependencies';
import { setStatus, type SettingsFailure, type SettingsView } from '../settings-flow';

interface Input {
  readonly status?: unknown;
}

/**
 * `promotions.set-promotions-status`: an admin moves the Market's promotions between off and
 * active (protected key). Refused in acting-as, audited, idempotent.
 */
export class SetPromotionsStatus extends UseCase<Input, SettingsView, SettingsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.set-promotions-status',
    rule: { kind: 'permissions', allOf: [PROMOTIONS_SETTINGS_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return setStatus(this.deps, context, input);
  }
}
