import { err } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { WalletBalanceView, WalletFailure } from '../../contracts/wallet.facade';
import type { WalletDependencies } from '../wallet-dependencies';
import { balanceOf } from '../wallet-flow';

/**
 * `wallet.own-balance-of`: the calling customer's own balance for another module's check (account
 * deletion asks it before it accepts a request). Rule `own-resources`, customers only; the account
 * is the session's, never an input. Reads work in every wallet state, as `wallet.balance-of`.
 */
export class OwnBalanceOf extends UseCase<Record<string, never>, WalletBalanceView, WalletFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.own-balance-of',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WalletDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext) {
    const actor = context.actor;
    if (actor.kind !== 'authenticated' || actor.population !== 'customer') {
      return err({ code: 'access.denied' } as const);
    }
    return balanceOf(this.deps, context, actor.accountId);
  }
}
