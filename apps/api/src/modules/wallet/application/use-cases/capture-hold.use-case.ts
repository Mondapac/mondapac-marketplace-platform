import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SettleHoldRequest, HoldResult, WalletFailure } from '../../contracts/wallet.facade';
import type { WalletDependencies } from '../wallet-dependencies';
import { captureHold } from '../wallet-flow';

/** `wallet.capture-hold`: Spends the credit held for an order. Rule `system`. */
export class CaptureHold extends UseCase<SettleHoldRequest, HoldResult, WalletFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.capture-hold',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WalletDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: SettleHoldRequest) {
    return captureHold(this.deps, context, input);
  }
}
