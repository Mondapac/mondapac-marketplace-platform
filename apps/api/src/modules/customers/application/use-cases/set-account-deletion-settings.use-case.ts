import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ACCOUNT_DELETION_SETTINGS_MANAGE } from '../../contracts/permissions';
import {
  setAccountDeletionSettings,
  type AccountDeletionSettingsFailure,
  type AccountDeletionSettingsView,
} from '../account-deletion-settings-flow';
import type { CustomersDependencies } from '../customers-dependencies';

interface Input {
  readonly settings: unknown;
  readonly expectedVersion: unknown;
  readonly reason: unknown;
}

/**
 * `customers.set-account-deletion-settings`: an admin replaces the Market's account deletion
 * setting (protected key and a fresh admin step-up proof of
 * `customers.account-deletion-settings.change`, spent inside the flow).
 */
export class SetAccountDeletionSettings extends UseCase<
  Input,
  AccountDeletionSettingsView,
  AccountDeletionSettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.set-account-deletion-settings',
    rule: { kind: 'permissions', allOf: [ACCOUNT_DELETION_SETTINGS_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomersDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return setAccountDeletionSettings(this.deps, context, input);
  }
}
