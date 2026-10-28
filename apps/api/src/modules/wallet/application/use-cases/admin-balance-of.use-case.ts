import { err } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type PermissionKey,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { WalletBalanceView, WalletFailure } from '../../contracts/wallet.facade';
import type { WalletDependencies } from '../wallet-dependencies';
import { isActingAs } from '../settings-flow';
import { balanceOf } from '../wallet-flow';

/** The protected key of customers' `buyer-account.delete`; only the declaring module can brand it, so it is cast here. */
const DELETION_KEY = 'customers.buyer-account.delete' as PermissionKey;

/**
 * `wallet.admin-balance-of`: a customer's balance for an admin's deletion request for a buyer
 * (customers package 5c). Rule `permissions [customers.buyer-account.delete]`: the actor must be a platform admin and not an
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
    // The key is customers' (package 5c, Hassan M1): only a caller that may delete a buyer's account
    // reads this; the key is customers' (a contract test pins it to the declaration).
    rule: { kind: 'permissions', allOf: [DELETION_KEY] },
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
