import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { WALLET_SETTINGS_MANAGE } from '../../contracts/permissions';
import { setStatus, type SettingsFailure, type SettingsView } from '../settings-flow';
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
export class SetWalletStatus extends UseCase<Input, SettingsView, SettingsFailure> {
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

  protected handle(context: CallContext, input: Input) {
    return setStatus(this.deps, context, input);
  }
}
