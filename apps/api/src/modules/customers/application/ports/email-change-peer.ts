import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';

// What the admin email change asks of identity (customers admin email change), as the smallest
// interface it needs. The real facade satisfies it structurally; `CustomersAccountDeletionModule`
// binds it at start, and until then every call fails closed (as the deletion flow's peers).

type Failure = { readonly code: string };

export interface EmailChangePeer {
  /**
   * identity owns the account and the write, and spends the admin's step-up proof in its own
   * unit. A refusal carries its code (and `retryAfterSeconds` or `actionKey` where they apply).
   */
  requestCustomerEmailChangeForAdmin(
    context: CallContext,
    request: {
      readonly accountId: Id<'Account'>;
      readonly email: string;
      readonly origin: string;
    },
  ): Promise<
    Result<{ readonly changed: boolean; readonly requestedAt: Temporal.Instant | null }, Failure>
  >;
  cancelCustomerEmailChangeForAdmin(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<{ readonly code: 'email-change.cancelled' }, Failure>>;
  /** The pending change for the customer page (the full new address: personal data), or null. */
  customerPendingEmailOf(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<
    Result<{ readonly email: string; readonly requestedAt: Temporal.Instant } | null, Failure>
  >;
  /** A deletion was requested: the pending change is cancelled (rule `system`, repeat-safe). */
  cancelCustomerEmailChangeForDeletion(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<Result<{ readonly cancelled: boolean }, Failure>>;
}

export const EMAIL_CHANGE_PEER = Symbol('EMAIL_CHANGE_PEER');
