import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { isActingAsSession } from '../sellers/access-decision-reads';
import type { AccountRepository } from '../ports/account.repository';

export interface OwnAccountTiedToSellerInput {
  readonly sellerId: Id<'Seller'>;
}

export type OwnAccountTiedToSellerFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface OwnAccountTiedToSellerDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
}

/**
 * `identity.own-account-tied-to-seller` (reviews: nobody reviews their own shop): whether the
 * signed-in customer's sign-in address is also the address of an active member of this seller's
 * team, so a person with a buyer account and a seller account on one address cannot review or rate
 * their own store. The account is the session's, never input. Rule `own-resources`; a customer
 * session only, an acting-as session is refused. A boolean and nothing about the other account.
 * A failed read is `access.unavailable`, and the caller fails closed. One read-only unit.
 */
export class OwnAccountTiedToSeller extends UseCase<
  OwnAccountTiedToSellerInput,
  boolean,
  OwnAccountTiedToSellerFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.own-account-tied-to-seller',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnAccountTiedToSellerDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnAccountTiedToSellerInput,
  ): Promise<Result<boolean, OwnAccountTiedToSellerFailure>> {
    const { market, actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'customer' ||
      isActingAsSession(actor)
    ) {
      return err({ code: 'access.denied' });
    }
    const read = await this.deps.unitOfWork.run<boolean, never>(
      market,
      async () =>
        ok(
          await this.deps.accounts.customerSharesAddressWithSellerMember(
            market,
            actor.accountId,
            input.sellerId,
          ),
        ),
      { readOnly: true },
    );
    return read.ok ? ok(read.value) : err({ code: 'access.unavailable' });
  }
}
