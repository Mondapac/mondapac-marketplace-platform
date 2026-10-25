import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PlaceHoldRequest, HoldResult, WalletFailure } from '../../contracts/wallet.facade';
import type { WalletDependencies } from '../wallet-dependencies';
import { placeHold } from '../wallet-flow';

/** `wallet.place-hold`: Sets credit aside for an order. Rule `system`. */
export class PlaceHold extends UseCase<PlaceHoldRequest, HoldResult, WalletFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.place-hold',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WalletDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: PlaceHoldRequest) {
    return placeHold(this.deps, context, input);
  }
}
