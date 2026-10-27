import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { AccountDeletionRequest } from '../../domain/account-deletion-request';

/**
 * The deletion requests (`customers.account_deletion_requests`). Every method runs inside the
 * caller's unit of work and is scoped by the Market. At most one open (pending or executing)
 * request per account (a partial unique index); requests are closed once and never deleted.
 * Every transition is one conditional update (`WHERE status = ...`), so two callers racing for the
 * same row cannot both win it.
 */
export interface AccountDeletionRequestRepository {
  /** Inserts a pending request; false when the account already has an open one (the unique index). */
  insertPending(market: MarketContext, request: AccountDeletionRequest): Promise<boolean>;

  /** The account's open request (pending or executing), or null. */
  findActiveOf(
    market: MarketContext,
    accountId: Id<'Account'>,
  ): Promise<AccountDeletionRequest | null>;

  /** Closes a pending request as cancelled; false when it was not pending (claimed, closed or gone). */
  cancel(
    market: MarketContext,
    id: Id<'AccountDeletionRequest'>,
    reason: 'customer' | 'sign-in',
    at: Temporal.Instant,
  ): Promise<boolean>;

  /**
   * The job's claim, before any irreversible step: a pending request whose date has come becomes
   * `executing` at `at`, or an `executing` one whose claim is not newer than `staleBefore` is
   * claimed again. False when it matched neither (cancelled, claimed by another run, closed).
   */
  claim(
    market: MarketContext,
    id: Id<'AccountDeletionRequest'>,
    at: Temporal.Instant,
    staleBefore: Temporal.Instant,
  ): Promise<boolean>;

  /**
   * Gives a claim back (`executing` to `pending`) when the job finds a blocker after claiming;
   * only the claim made at `claimedAt`. False when it was no longer that claim.
   */
  release(
    market: MarketContext,
    id: Id<'AccountDeletionRequest'>,
    claimedAt: Temporal.Instant,
  ): Promise<boolean>;

  /** Closes an executing request as completed; false when it was not executing. */
  complete(
    market: MarketContext,
    id: Id<'AccountDeletionRequest'>,
    at: Temporal.Instant,
  ): Promise<boolean>;

  /**
   * Requests the job should look at: pending ones whose date has come, then executing ones whose
   * claim is not newer than `staleBefore`; stale claims first (older work), then by date, at most
   * `limit` in all.
   */
  listDue(
    market: MarketContext,
    now: Temporal.Instant,
    staleBefore: Temporal.Instant,
    limit: number,
  ): Promise<readonly AccountDeletionRequest[]>;
}

export const ACCOUNT_DELETION_REQUEST_REPOSITORY = Symbol('ACCOUNT_DELETION_REQUEST_REPOSITORY');
