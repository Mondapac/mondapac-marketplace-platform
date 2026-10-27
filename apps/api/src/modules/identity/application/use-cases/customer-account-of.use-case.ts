import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { AccountRepository } from '../ports/account.repository';
import { isActingAsSession } from '../sellers/access-decision-reads';

export interface CustomerAccountOfInput {
  /** As the caller passed it; parsed here and never echoed. */
  readonly accountId: string;
}

/** The customer account that exists and is active: its id only, no personal data. */
export interface CustomerAccountRefView {
  readonly accountId: Id<'Account'>;
}

export type CustomerAccountOfFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface CustomerAccountOfDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
}

/**
 * `customerAccountOf` (wallet package 2a, review S1): whether `accountId` names an active
 * customer account of the context's Market, for an admin flow that writes to a customer's records
 * (the wallet's admin credit). It answers the id only, never a name or an address. An unknown or
 * malformed id, another population's account (a seller or an admin), another Market's account and
 * a disabled (closed) account all answer `null`, alike. Rule `own-resources`, denied while the
 * seller is not approved; the actor must be a platform admin and not an acting-as session, checked
 * here, otherwise `access.denied`. The caller has already passed its own permission gate. One
 * read-only unit; a failed read answers `access.unavailable` so the caller fails closed.
 */
export class CustomerAccountOf extends UseCase<
  CustomerAccountOfInput,
  CustomerAccountRefView | null,
  CustomerAccountOfFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.customer-account-of',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerAccountOfDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CustomerAccountOfInput,
  ): Promise<Result<CustomerAccountRefView | null, CustomerAccountOfFailure>> {
    const { actor, market } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'admin' ||
      actor.sellerId !== null ||
      isActingAsSession(actor)
    ) {
      return err({ code: 'access.denied' });
    }
    const raw = input?.accountId as unknown;
    const parsed = typeof raw === 'string' ? parseId<'Account'>(raw) : null;
    if (parsed === null || !parsed.ok) return ok(null);
    const accountId = parsed.value;
    let read: Result<CustomerAccountRefView | null, never>;
    try {
      read = await this.deps.unitOfWork.run<CustomerAccountRefView | null, never>(
        market,
        async () => {
          // The status only: no credential (a social sign-in customer has none), no address.
          const status = await this.deps.accounts.customerStatus(market, accountId);
          return ok(status === 'active' ? { accountId } : null);
        },
        { readOnly: true },
      );
    } catch {
      return err({ code: 'access.unavailable' });
    }
    return read.ok ? ok(read.value) : err({ code: 'access.unavailable' });
  }
}
