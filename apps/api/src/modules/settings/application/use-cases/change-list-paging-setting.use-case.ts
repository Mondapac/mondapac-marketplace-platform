import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_LIST_PAGING_MANAGE } from '../../contracts/permissions';
import { LIST_PAGING_CODE } from '../../domain/definitions';
import type { SettingsDependencies } from '../settings-dependencies';
import { changeSetting, type SettingsFailure, type SettingChangeView } from '../settings-flow';

interface Input {
  readonly code?: unknown;
  readonly value?: unknown;
  readonly expectedVersion?: unknown;
  /** The note for the reviewer (System requests); needed only where the area is reviewed. */
  readonly note?: unknown;
}

/**
 * `settings.change-list-paging-setting`: an admin changes List paging, under its own manage key, from the version they
 * saw. Refused in acting-as, audited, idempotent, and a stale version is a conflict.
 */
export class ChangeListPagingSetting extends UseCase<Input, SettingChangeView, SettingsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.change-list-paging-setting',
    rule: { kind: 'permissions', allOf: [SETTINGS_LIST_PAGING_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return changeSetting(this.deps, context, LIST_PAGING_CODE, input);
  }
}
