import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_LIST_PAGING_VIEW } from '../../contracts/permissions';
import type { SettingsDependencies } from '../settings-dependencies';
import { LIST_PAGING_CODE } from '../../domain/definitions';
import { viewSettings, type SettingsFailure, type SettingView } from '../settings-flow';

export type { SettingView };

/** `settings.view-list-paging-setting`: an admin reads the List paging setting (its own view key; each setting has its own keys, ADR-0026 decision 7). */
export class ViewListPagingSetting extends UseCase<
  Record<string, never>,
  readonly SettingView[],
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.view-list-paging-setting',
    rule: { kind: 'permissions', allOf: [SETTINGS_LIST_PAGING_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewSettings(this.deps, context, [LIST_PAGING_CODE]);
  }
}
