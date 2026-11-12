import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_CART_MODE_VIEW } from '../../contracts/permissions';
import type { SettingsDependencies } from '../settings-dependencies';
import { CART_MODE_CODE } from '../../domain/definitions';
import { viewSettings, type SettingsFailure, type SettingView } from '../settings-flow';

export type { SettingView };

/** `settings.view-cart-mode-setting`: an admin reads the Cart mode setting (its own view key; each setting has its own keys, ADR-0026 decision 7). */
export class ViewCartModeSetting extends UseCase<
  Record<string, never>,
  readonly SettingView[],
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.view-cart-mode-setting',
    rule: { kind: 'permissions', allOf: [SETTINGS_CART_MODE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewSettings(this.deps, context, [CART_MODE_CODE]);
  }
}
