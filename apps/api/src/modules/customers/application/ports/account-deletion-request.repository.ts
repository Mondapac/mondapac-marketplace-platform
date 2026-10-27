import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { AccountDeletionRequest } from '../../domain/account-deletion-request';

/**
 * The deletion requests (`customers.account_deletion_requests`). Every method runs inside the
 * caller's unit of work and is scoped by the Market. At most one pending request per account (a
 * partial unique index); requests are closed once and never deleted.
 */
export interface AccountDeletionRequestRepository {
  /** Inserts a pending request; false when the account already has one (the unique index). */
  insertPending(market: MarketContext, request: AccountDeletionRequest): Promise<boolean>;

  /** The account's pending request, or null. */
  findPendingOf(
    market: MarketContext,
    accountId: Id<'Account'>,
  ): Promise<AccountDeletionRequest | null>;

  /** Closes a pending request as cancelled; false when it was no longer pending. */
  cancel(
    market: MarketContext,
    id: Id<'AccountDeletionRequest'>,
    reason: 'customer' | 'sign-in',
    at: Temporal.Instant,
  ): Promise<boolean>;

  /** Closes a pending request as completed; false when it was no longer pending. */
  complete(
    market: MarketContext,
    id: Id<'AccountDeletionRequest'>,
    at: Temporal.Instant,
  ): Promise<boolean>;

  /** Pending requests whose date has come, oldest date first. */
  listDue(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly AccountDeletionRequest[]>;
}

export const ACCOUNT_DELETION_REQUEST_REPOSITORY = Symbol('ACCOUNT_DELETION_REQUEST_REPOSITORY');
