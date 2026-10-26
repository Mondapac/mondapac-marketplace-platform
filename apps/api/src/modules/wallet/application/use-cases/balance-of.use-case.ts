import type { CallContext, Id } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { WalletBalanceView, WalletFailure } from '../../contracts/wallet.facade';
import type { WalletDependencies } from '../wallet-dependencies';
import { balanceOf } from '../wallet-flow';

/** `wallet.balance-of`: a customer's balance for a system caller; works in every wallet state. */
export class BalanceOf extends UseCase<
  { readonly customerAccountId: Id<'Account'> },
  WalletBalanceView,
  WalletFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.balance-of',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WalletDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly customerAccountId: Id<'Account'> }) {
    return balanceOf(this.deps, context, input.customerAccountId);
  }
}
