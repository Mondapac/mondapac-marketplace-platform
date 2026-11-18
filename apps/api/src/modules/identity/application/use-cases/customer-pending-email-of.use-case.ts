import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result, Temporal } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  UseCase,
  type AccessDeclaration,
  type PermissionKey,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import { EMAIL_CHANGE_PURPOSE, isPlainAdmin } from './admin-request-customer-email-change.use-case';

/** customers' key of the customer page; only the declaring module can brand it. */
const CUSTOMER_VIEW_KEY = 'customers.customers.view' as PermissionKey;

export interface CustomerPendingEmailOfInput {
  /** As the caller passed it; parsed here and never echoed. */
  readonly accountId: string;
}

/** A pending change as the customer page shows it. PERSONAL DATA: the full new address. */
export interface CustomerPendingEmailView {
  readonly email: string;
  readonly requestedAt: Temporal.Instant;
}

export type CustomerPendingEmailOfFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface CustomerPendingEmailOfDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
}

/**
 * `identity.customer-pending-email-of`: the pending email change of a customer account, for the
 * admin customer page (customers admin email change; Mohammad 10: read from identity at read
 * time). Rule `permissions [customers.customers.view]` (customers' key; a contract test pins it),
 * a platform admin that is not acting as a seller only. An unknown, malformed or non-customer id,
 * another Market's account, no pending change and a lapsed one (older than the link's lifetime in
 * this Market) all answer `null`. One read-only unit; a failed read is `access.unavailable`. Not
 * exposed over HTTP.
 */
export class CustomerPendingEmailOf extends UseCase<
  CustomerPendingEmailOfInput,
  CustomerPendingEmailView | null,
  CustomerPendingEmailOfFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.customer-pending-email-of',
    rule: { kind: 'permissions', allOf: [CUSTOMER_VIEW_KEY] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerPendingEmailOfDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CustomerPendingEmailOfInput,
  ): Promise<Result<CustomerPendingEmailView | null, CustomerPendingEmailOfFailure>> {
    const { market } = context;
    if (!isPlainAdmin(context)) return err({ code: 'access.denied' });
    const raw = input?.accountId as unknown;
    const parsed = typeof raw === 'string' ? parseId<'Account'>(raw) : null;
    if (parsed === null || !parsed.ok) return ok(null);
    const lifetime = this.deps.policy.linkLifetimeMinutes(market, EMAIL_CHANGE_PURPOSE);
    if (lifetime === null) return ok(null);
    try {
      const read = await this.deps.unitOfWork.run<CustomerPendingEmailView | null, never>(
        market,
        async () => {
          const account = await this.deps.accounts.findById(market, parsed.value);
          if (account === null || account.state.population !== 'customer') return ok(null);
          const pending = account.pendingEmailChange(this.deps.clock.now(), lifetime);
          return ok(
            pending === null
              ? null
              : { email: pending.email.typed, requestedAt: pending.requestedAt },
          );
        },
        { readOnly: true },
      );
      return read.ok ? ok(read.value) : err({ code: 'access.unavailable' });
    } catch {
      return err({ code: 'access.unavailable' });
    }
  }
}
