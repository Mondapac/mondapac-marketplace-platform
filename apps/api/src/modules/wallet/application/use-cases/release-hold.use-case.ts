import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SettleHoldRequest, HoldResult, WalletFailure } from '../../contracts/wallet.facade';
import type { WalletDependencies } from '../wallet-dependencies';
import { releaseHold } from '../wallet-flow';

/** `wallet.release-hold`: Gives the credit held for an order back to its lots. Rule `system`. */
export class ReleaseHold extends UseCase<SettleHoldRequest, HoldResult, WalletFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.release-hold',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WalletDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: SettleHoldRequest) {
    return releaseHold(this.deps, context, input);
  }
}
