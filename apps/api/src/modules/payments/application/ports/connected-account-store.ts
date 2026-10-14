import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { AccountSnapshot, AccountStatus } from '../../domain/connected-account';
import type { ChangeKind } from '../../domain/payout-change';

/** The payout schedule payments last set (or marked to be set again); null = never touched. */
export type AppliedSchedule = 'manual' | 'normal';

/** One change of the seller's payout destination: when, what kind, and the waiting period. */
export interface PayoutChangeRecord {
  readonly id: string;
  readonly kind: ChangeKind;
  readonly detectedAt: Temporal.Instant;
  readonly coolingOffUntil: Temporal.Instant | null;
}

/** A change as it is stored: no bank detail, no Stripe id. */
export interface NewPayoutChange extends PayoutChangeRecord {
  /** The Stripe event that reported it: stored once, so a repeated event adds nothing. */
  readonly sourceEventId: string;
}

/** A page of the admin list: newest created first, `after` is the last row of the page before. */
export interface AccountPage {
  readonly limit: number;
  readonly after: { readonly createdAt: Temporal.Instant; readonly sellerId: string } | null;
}

/** A seller's connected account as stored. */
export interface ConnectedAccountRecord {
  readonly sellerId: string;
  /** Null until Stripe has answered the create call. */
  readonly accountRef: string | null;
  readonly status: AccountStatus;
  readonly detailsSubmitted: boolean;
  readonly transfersActive: boolean;
  readonly payoutsEnabled: boolean;
  readonly requirementsDue: number;
  readonly requirementsPastDue: boolean;
  readonly lastReadAt: Temporal.Instant | null;
  readonly createdAt: Temporal.Instant;
  /** The end of the waiting period after the latest bank change, or null. */
  readonly coolingOffUntil: Temporal.Instant | null;
  /** Stripe payouts are kept manual until this instant, or null. */
  readonly payoutsPausedUntil: Temporal.Instant | null;
  readonly payoutScheduleApplied: AppliedSchedule | null;
  /** Counts the times a seller's undo of the pause was found; part of the schedule write key. */
  readonly payoutScheduleRevision: number;
  /** The latest change; null before any. */
  readonly lastChangeId: string | null;
}

/**
 * The connected accounts of one Market (`payments.connected_accounts`). Every method runs inside
 * the caller's unit of work and is scoped by the Market.
 */
export interface ConnectedAccountStore {
  /** The seller's account row, or null. */
  find(market: MarketContext, sellerId: string): Promise<ConnectedAccountRecord | null>;

  /** The account row by Stripe's id, or null. */
  findByRef(market: MarketContext, accountRef: string): Promise<ConnectedAccountRecord | null>;

  /** Stores the seller's row (status `not-started`, no Stripe id) once; false when it exists. */
  insert(market: MarketContext, sellerId: string, at: Temporal.Instant): Promise<boolean>;

  /** Sets the Stripe id once; false when an id is already stored. */
  linkRef(
    market: MarketContext,
    sellerId: string,
    accountRef: string,
    at: Temporal.Instant,
  ): Promise<boolean>;

  /**
   * Stores what a read of the account showed, unless a read at the same time or later is already
   * stored. False when nothing changed.
   */
  applyRead(
    market: MarketContext,
    sellerId: string,
    snapshot: AccountSnapshot,
    status: AccountStatus,
    readAt: Temporal.Instant,
  ): Promise<boolean>;

  /** The stored account of each of these sellers (at most 100): absent sellers are left out. */
  recordsOf(
    market: MarketContext,
    sellerIds: readonly string[],
  ): Promise<ReadonlyMap<string, ConnectedAccountRecord>>;

  /**
   * Stores a change and moves the waiting period and the pause to `until` (both), only while the
   * account's latest change is still `expectedLastChangeId`. `duplicate` when the source event
   * is stored already; `conflict` when another change got there first (nothing is written).
   */
  recordChange(
    market: MarketContext,
    sellerId: string,
    change: NewPayoutChange,
    expectedLastChangeId: string | null,
    until: Temporal.Instant | null,
    at: Temporal.Instant,
  ): Promise<'recorded' | 'duplicate' | 'conflict'>;

  /** The latest changes of the seller, newest first. */
  changesOf(
    market: MarketContext,
    sellerId: string,
    limit: number,
  ): Promise<readonly PayoutChangeRecord[]>;

  /**
   * A read showed the schedule is not manual while payouts should be paused: the pause is to be
   * written again (applied state back to `normal`, revision up), whatever the applied state was.
   */
  markRepause(market: MarketContext, sellerId: string, at: Temporal.Instant): Promise<boolean>;

  /** Accounts with a Stripe id whose applied schedule differs from the wanted one at `now`. */
  dueForScheduleSync(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly ConnectedAccountRecord[]>;

  /**
   * Records the schedule just written to Stripe, only while the account's latest change and
   * revision are still the ones the write was made for. False (nothing stored) when they moved:
   * the next run decides again.
   */
  markScheduleApplied(
    market: MarketContext,
    sellerId: string,
    applied: AppliedSchedule,
    at: Temporal.Instant,
    expected: { readonly lastChangeId: string; readonly revision: number },
  ): Promise<boolean>;

  /**
   * Stripe answered a schedule write with an error, which it keeps for the key: the revision goes
   * up (only while it is still `expectedRevision`) so the next run uses a new key.
   */
  bumpScheduleRevision(
    market: MarketContext,
    sellerId: string,
    expectedRevision: number,
    at: Temporal.Instant,
  ): Promise<boolean>;

  /** The Market's accounts, newest created first, optionally of one status. */
  list(
    market: MarketContext,
    status: AccountStatus | null,
    page: AccountPage,
  ): Promise<readonly ConnectedAccountRecord[]>;
}

export const CONNECTED_ACCOUNT_STORE = Symbol('CONNECTED_ACCOUNT_STORE');
