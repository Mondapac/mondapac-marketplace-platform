import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ACCOUNT_DELETION_SETTINGS_VIEW } from '../../contracts/permissions';
import {
  viewAccountDeletionSettings,
  type AccountDeletionSettingsFailure,
  type AccountDeletionSettingsView,
} from '../account-deletion-settings-flow';
import type { CustomersDependencies } from '../customers-dependencies';

/** `customers.view-account-deletion-settings`: an admin reads the Market's account deletion setting. */
export class ViewAccountDeletionSettings extends UseCase<
  Record<string, never>,
  AccountDeletionSettingsView,
  AccountDeletionSettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.view-account-deletion-settings',
    rule: { kind: 'permissions', allOf: [ACCOUNT_DELETION_SETTINGS_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomersDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewAccountDeletionSettings(this.deps, context);
  }
}
