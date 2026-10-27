import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { Account } from '../../domain/account';
import { isSellerOwner, type SellerOwnerDependencies } from '../sellers/seller-owner';

export type OwnOwnerEmailFailure = { readonly code: 'access.denied' };

export interface OwnOwnerEmailDependencies extends SellerOwnerDependencies {
  readonly unitOfWork: UnitOfWork;
}

/**
 * `ownOwnerEmail` (payments, Accounts v2: Stripe requires a contact email to create the Seller
 * Owner's payout account): the calling account's own sign-in address, only when the caller is
 * the Seller Owner of its seller and the account is active with a verified email; otherwise
 * `null`. Rule `own-resources`, approved sellers only. The account is the session's, never
 * input, so no other account's address can be read. Personal data: the caller sends it to Stripe
 * once and never logs, stores or puts it in an event. One read-only unit (ADR-0025).
 */
export class OwnOwnerEmail extends UseCase<
  Record<string, never>,
  string | null,
  OwnOwnerEmailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.own-owner-email',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnOwnerEmailDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<string | null, OwnOwnerEmailFailure>> {
    const { market, actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    const read = await this.deps.unitOfWork.run<Account | null, never>(
      market,
      async () => {
        if (!(await isSellerOwner(this.deps, market, actor.accountId))) return ok(null);
        return ok(await this.deps.accounts.findById(market, actor.accountId));
      },
      { readOnly: true },
    );
    if (!read.ok) return ok(null);
    const account = read.value;
    const usable =
      account !== null &&
      account.state.population === 'seller' &&
      account.state.status === 'active' &&
      account.isEmailVerified;
    return ok(usable ? account.state.email.typed : null);
  }
}
