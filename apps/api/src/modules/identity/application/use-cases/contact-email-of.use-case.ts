import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { Account } from '../../domain/account';
import { readSellerPeople, type SellerOwnerDependencies } from '../sellers/seller-owner';
import type { AccountRepository } from '../ports/account.repository';

/** Whose address is wanted: a customer's own, or a seller's Owner (who is told of new orders). */
export type ContactEmailInput =
  | { readonly kind: 'customer'; readonly accountId: Id<'Account'> }
  | { readonly kind: 'seller-owner'; readonly sellerId: Id<'Seller'> };

export type ContactEmailFailure = { readonly code: 'access.denied' };

export interface ContactEmailOfDependencies extends SellerOwnerDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
}

/**
 * `contactEmailOf` (Phase 6 package 1, the order emails): the address to mail an order notice
 * to, read at send time and never stored or put in an event or a log. Rule `system`. It answers
 * the address of a customer account of the context's Market, or of a seller's Owner, only when
 * the account is active and its email is verified; otherwise `null`, and the caller sends
 * nothing. No reason is given: a missing, disabled and unverified account answer alike.
 */
export class ContactEmailOf extends UseCase<ContactEmailInput, string | null, ContactEmailFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.contact-email-of',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ContactEmailOfDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ContactEmailInput,
  ): Promise<Result<string | null, ContactEmailFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const read = await this.deps.unitOfWork.run<Account | null, never>(
      market,
      async () => {
        if (input.kind === 'customer') {
          const account = await this.deps.accounts.findById(market, input.accountId);
          return ok(account !== null && account.state.population === 'customer' ? account : null);
        }
        return ok((await readSellerPeople(this.deps, market, input.sellerId)).owner);
      },
      { readOnly: true },
    );
    if (!read.ok) return ok(null);
    const account = read.value;
    const usable = account !== null && account.state.status === 'active' && account.isEmailVerified;
    return ok(usable ? account.state.email.typed : null);
  }
}
