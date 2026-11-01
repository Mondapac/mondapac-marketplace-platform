import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_MARKET_SETTING_MANAGE } from '../../contracts/permissions';
import type { SettingsDependencies } from '../settings-dependencies';
import { changeSetting, type SettingsFailure, type SettingView } from '../settings-flow';

interface Input {
  readonly code?: unknown;
  readonly value?: unknown;
  readonly expectedVersion?: unknown;
}

/**
 * `settings.change-market-setting`: an admin changes one editable setting from the version they
 * saw. Refused in acting-as, audited, idempotent, and a stale version is a conflict.
 */
export class ChangeMarketSetting extends UseCase<Input, SettingView, SettingsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.change-market-setting',
    rule: { kind: 'permissions', allOf: [SETTINGS_MARKET_SETTING_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return changeSetting(this.deps, context, input);
  }
}
