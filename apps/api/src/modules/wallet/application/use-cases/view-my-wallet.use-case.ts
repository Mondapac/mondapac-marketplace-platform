import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { viewMyWallet, type CustomerWalletFailure, type MyWalletView } from '../customer-flow';
import type { WalletDependencies } from '../wallet-dependencies';

export type { MyWalletView };

/** `wallet.view-my-wallet`: the signed-in customer reads their own wallet (rule `own-resources`; reads work in an acting-as session). */
export class ViewMyWallet extends UseCase<
  Record<string, never>,
  MyWalletView,
  CustomerWalletFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.view-my-wallet',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WalletDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewMyWallet(this.deps, context);
  }
}
