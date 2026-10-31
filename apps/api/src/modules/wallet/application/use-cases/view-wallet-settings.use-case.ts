import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { WALLET_SETTINGS_VIEW } from '../../contracts/permissions';
import {
  viewSettings,
  WALLET_SETTINGS_CHANGES,
  type SettingsFailure,
  type SettingsPage,
  type SettingsView,
} from '../settings-flow';
import type { WalletDependencies } from '../wallet-dependencies';

export type { SettingsView };

/** `wallet.view-wallet-settings`: an admin reads the wallet state of the Market (default off). */
export class ViewWalletSettings extends UseCase<
  Record<string, never>,
  SettingsPage,
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

  protected async handle(context: CallContext): Promise<Result<SettingsPage, SettingsFailure>> {
    const view = await viewSettings(this.deps, context);
    if (!view.ok) return view;
    const lastChanged = await this.deps.trail.lastChanged(context, WALLET_SETTINGS_CHANGES);
    return ok({ ...view.value, lastChanged });
  }
}

export type { SettingsPage };
