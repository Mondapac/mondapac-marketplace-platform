import { err } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { WalletBalanceView, WalletFailure } from '../../contracts/wallet.facade';
import type { WalletDependencies } from '../wallet-dependencies';
import { isActingAs } from '../settings-flow';
import { balanceOf } from '../wallet-flow';

/**
 * `wallet.admin-balance-of`: a customer's balance for an admin's deletion request for a buyer
 * (customers package 5c). Rule `own-resources`: the actor must be a platform admin and not an
 * acting-as session, checked here; the calling use case holds the permission. Reads work in every
 * wallet state, as `wallet.balance-of`.
 */
export class AdminBalanceOf extends UseCase<
  { readonly customerAccountId: Id<'Account'> },
  WalletBalanceView,
  WalletFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'wallet.admin-balance-of',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: WalletDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly customerAccountId: Id<'Account'> },
  ) {
    const actor = context.actor;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'admin' ||
      actor.sellerId !== null ||
      isActingAs(context)
    ) {
      return err({ code: 'access.denied' } as const);
    }
    return balanceOf(this.deps, context, input.customerAccountId);
  }
}
