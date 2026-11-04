import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { WALLET_SETTINGS_MANAGE } from '../../contracts/permissions';
import {
  setStatus,
  WALLET_SETTINGS_CHANGES,
  type SettingsFailure,
  type SettingsPage,
} from '../settings-flow';
import type { WalletDependencies } from '../wallet-dependencies';

interface Input {
  readonly status: unknown;
  readonly reasonCode?: unknown;
  readonly expectedVersion?: unknown;
}

/**
 * `wallet.set-wallet-status`: an admin moves the Market's wallet between off, active, paused and
 * frozen (protected key). Refused in acting-as, audited, idempotent.
 */
export class SetWalletStatus extends UseCase<Input, SettingsPage, SettingsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.set-wallet-status',
    rule: { kind: 'permissions', allOf: [WALLET_SETTINGS_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WalletDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<SettingsPage, SettingsFailure>> {
    const result = await setStatus(this.deps, context, input);
    if (!result.ok) {
      // On a conflict the winning change is named.
      return this.deps.trail.namingTheWinner(context, WALLET_SETTINGS_CHANGES, result, [
        'wallet.settings-conflict',
      ]);
    }
    const lastChanged = await this.deps.trail.lastChanged(context, WALLET_SETTINGS_CHANGES);
    return ok({ ...result.value, lastChanged });
  }
}
