import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { WALLET_SETTINGS_VIEW } from '../../contracts/permissions';
import { viewSettings, type SettingsFailure, type SettingsView } from '../settings-flow';
import type { WalletDependencies } from '../wallet-dependencies';

export type { SettingsView };

/** `wallet.view-wallet-settings`: an admin reads the wallet state of the Market (default off). */
export class ViewWalletSettings extends UseCase<
  Record<string, never>,
  SettingsView,
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.view-wallet-settings',
    rule: { kind: 'permissions', allOf: [WALLET_SETTINGS_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WalletDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewSettings(this.deps, context);
  }
}
