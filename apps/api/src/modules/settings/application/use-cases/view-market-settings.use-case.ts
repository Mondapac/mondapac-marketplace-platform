import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_MARKET_SETTING_VIEW } from '../../contracts/permissions';
import type { SettingsDependencies } from '../settings-dependencies';
import { viewSettings, type SettingsFailure, type SettingView } from '../settings-flow';

export type { SettingView };

/** `settings.view-market-settings`: an admin reads every editable setting of the Market. */
export class ViewMarketSettings extends UseCase<
  Record<string, never>,
  readonly SettingView[],
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.view-market-settings',
    rule: { kind: 'permissions', allOf: [SETTINGS_MARKET_SETTING_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewSettings(this.deps, context);
  }
}
