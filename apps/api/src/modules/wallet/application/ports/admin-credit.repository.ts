import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  AdminCreditReason,
  AdminCreditRejectReason,
  AdminCreditStatus,
  ApprovalReason,
} from '../../domain/admin-credit';

/** One admin credit issue or request (`wallet.admin_credit_requests`). */
export interface AdminCreditRecord {
  readonly id: Id<'WalletCreditRequest'>;
  readonly customerAccountId: Id<'Account'>;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly reasonCode: AdminCreditReason;
  readonly note: string | null;
  readonly status: AdminCreditStatus;
  /** Null for an issue granted at once. */
  readonly approvalReason: ApprovalReason | null;
  readonly requestedBy: Id<'Account'>;
  readonly requestedAt: Temporal.Instant;
  /** The requesting admin's calendar day in the Market's zone, `YYYY-MM-DD`. */
  readonly localDay: string;
  /** Null for an issue granted at once. */
  readonly expiresAt: Temporal.Instant | null;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly decidedBy: Id<'Account'> | null;
  readonly decidedAt: Temporal.Instant | null;
  readonly decisionReason: AdminCreditRejectReason | null;
  readonly journalId: Id<'WalletJournal'> | null;
}

export type NewAdminCredit = Omit<AdminCreditRecord, 'decidedBy' | 'decidedAt' | 'decisionReason'>;

export interface AdminCreditDecision {
  readonly status: 'approved' | 'rejected' | 'expired';
  readonly decidedBy: Id<'Account'> | null;
  readonly decidedAt: Temporal.Instant;
  readonly decisionReason: AdminCreditRejectReason | null;
  readonly journalId: Id<'WalletJournal'> | null;
}

export interface AdminCreditPage {
  readonly statuses: readonly AdminCreditStatus[];
  readonly limit: number;
  readonly after: {
    readonly requestedAt: Temporal.Instant;
    readonly id: Id<'WalletCreditRequest'>;
  } | null;
}

/**
 * The admin credit requests of one Market. Every method runs inside the caller's unit and filters
 * on the Market. A row is never deleted; only a pending one is decided, once.
 */
export interface AdminCreditRepository {
  /**
   * Locks the admin's day (one row per admin and local day, created on first use) until the unit
   * ends, so two issues by one admin on one day run one after the other: the daily cap is
   * counted under this lock.
   */
  lockDay(
    market: MarketContext,
    adminAccountId: Id<'Account'>,
    localDay: string,
    now: Temporal.Instant,
  ): Promise<void>;
  /** The amount of the admin's day that counts toward the daily cap (granted, pending, approved). */
  countedOnDay(
    market: MarketContext,
    adminAccountId: Id<'Account'>,
    localDay: string,
  ): Promise<bigint>;
  findByKey(market: MarketContext, idempotencyKey: string): Promise<AdminCreditRecord | null>;
  find(market: MarketContext, id: Id<'WalletCreditRequest'>): Promise<AdminCreditRecord | null>;
  /** Locks the row until the unit ends (a no-change update) and returns it, or null. */
  findForUpdate(
    market: MarketContext,
    id: Id<'WalletCreditRequest'>,
  ): Promise<AdminCreditRecord | null>;
  create(market: MarketContext, record: NewAdminCredit): Promise<void>;
  /** Decides a pending request; false when it was no longer pending. */
  decide(
    market: MarketContext,
    id: Id<'WalletCreditRequest'>,
    decision: AdminCreditDecision,
  ): Promise<boolean>;
  /** Newest first. */
  list(market: MarketContext, page: AdminCreditPage): Promise<readonly AdminCreditRecord[]>;
  /** Pending requests whose expiry is at or before `now`, oldest expiry first. */
  duePending(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly Id<'WalletCreditRequest'>[]>;
}

export const ADMIN_CREDIT_REPOSITORY = Symbol('ADMIN_CREDIT_REPOSITORY');
