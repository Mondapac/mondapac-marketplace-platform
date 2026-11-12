import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_CART_MODE_MANAGE } from '../../contracts/permissions';
import { CART_MODE_CODE } from '../../domain/definitions';
import type { SettingsDependencies } from '../settings-dependencies';
import { changeSetting, type SettingsFailure, type SettingView } from '../settings-flow';

interface Input {
  readonly code?: unknown;
  readonly value?: unknown;
  readonly expectedVersion?: unknown;
}

/**
 * `settings.change-cart-mode-setting`: an admin changes Cart mode, under its own manage key, from the version they
 * saw. Refused in acting-as, audited, idempotent, and a stale version is a conflict.
 */
export class ChangeCartModeSetting extends UseCase<Input, SettingView, SettingsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.change-cart-mode-setting',
    rule: { kind: 'permissions', allOf: [SETTINGS_CART_MODE_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return changeSetting(this.deps, context, CART_MODE_CODE, input);
  }
}
