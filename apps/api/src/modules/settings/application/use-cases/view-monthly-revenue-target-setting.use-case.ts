import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_MONTHLY_REVENUE_TARGET_VIEW } from '../../contracts/permissions';
import { MONTHLY_REVENUE_TARGET_CODE } from '../../domain/definitions';
import type { SettingsDependencies } from '../settings-dependencies';
import { viewSettings, type SettingsFailure, type SettingView } from '../settings-flow';

/**
 * `settings.view-monthly-revenue-target-setting`: an admin reads the Market's monthly revenue
 * target with its version (its own view key, ADR-0026 decision 7). `none` while none is set.
 */
export class ViewMonthlyRevenueTargetSetting extends UseCase<
  Record<string, never>,
  readonly SettingView[],
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.view-monthly-revenue-target-setting',
    rule: { kind: 'permissions', allOf: [SETTINGS_MONTHLY_REVENUE_TARGET_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewSettings(this.deps, context, [MONTHLY_REVENUE_TARGET_CODE]);
  }
}
