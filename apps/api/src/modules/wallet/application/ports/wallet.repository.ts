import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { Lot, LotSource, Take } from '../../domain/lots';

export type InternalAccountKind =
  'promo_expense' | 'refund_clearing' | 'order_clearing' | 'holds' | 'breakage_income';

export type JournalKind =
  'grant-promo' | 'grant-refund' | 'hold' | 'capture' | 'release' | 'expire' | 'reverse';

export interface WalletAccountRecord {
  readonly id: Id<'WalletAccount'>;
  readonly status: 'active' | 'frozen' | 'closed';
  readonly currency: string;
}

export interface BalanceRecord {
  readonly walletAccountId: Id<'WalletAccount'>;
  readonly availableMinor: bigint;
  readonly heldMinor: bigint;
}

export interface JournalRecord {
  readonly id: Id<'WalletJournal'>;
  readonly fingerprint: string;
  /** The first answer, a JSON object of strings. */
  readonly result: Readonly<Record<string, string>>;
}

export interface NewJournal {
  readonly id: Id<'WalletJournal'>;
  readonly kind: JournalKind;
  /** The hold of a hold, capture or release journal; null otherwise. */
  readonly holdId: Id<'WalletHold'> | null;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly actor: { readonly kind: 'system' | 'admin' | 'customer'; readonly id: string | null };
  readonly reasonCode: string;
  readonly orderId: Id<'Order'> | null;
  readonly walletAccountId: Id<'WalletAccount'>;
  readonly result: Readonly<Record<string, string>>;
  readonly createdAt: Temporal.Instant;
  readonly currency: string;
  /** Signed legs by account; they must sum to zero. */
  readonly postings: readonly {
    readonly accountId: Id<'WalletAccount'>;
    readonly amountMinor: bigint;
  }[];
}

export interface HoldRecord {
  readonly id: Id<'WalletHold'>;
  readonly walletAccountId: Id<'WalletAccount'>;
  readonly orderId: Id<'Order'>;
  readonly amountMinor: bigint;
  readonly status: 'held' | 'captured' | 'released' | 'expired';
  readonly expiresAt: Temporal.Instant;
}

export interface NewLot {
  readonly id: Id<'WalletLot'>;
  readonly walletAccountId: Id<'WalletAccount'>;
  readonly source: LotSource;
  readonly journalId: Id<'WalletJournal'>;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly expiresAt: Temporal.Instant | null;
  readonly createdAt: Temporal.Instant;
}

export interface HistoryRow {
  readonly journalId: Id<'WalletJournal'>;
  readonly kind: JournalKind;
  /** The customer-side leg, signed: credit positive, spend negative. */
  readonly amountMinor: bigint;
  readonly reasonCode: string;
  readonly orderId: Id<'Order'> | null;
  readonly createdAt: Temporal.Instant;
}

export interface HistoryPage {
  readonly limit: number;
  readonly after: { readonly createdAt: Temporal.Instant; readonly id: Id<'WalletJournal'> } | null;
}

export interface DueLot {
  readonly lotId: Id<'WalletLot'>;
  readonly walletAccountId: Id<'WalletAccount'>;
}

export interface DueHold {
  readonly holdId: Id<'WalletHold'>;
  readonly walletAccountId: Id<'WalletAccount'>;
}

/** One place where the books of a Market disagree with themselves. */
export interface ReconcileMismatch {
  readonly check:
    | 'postings-vs-available'
    | 'lots-vs-available'
    | 'held-holds-vs-held'
    | 'journal-unbalanced'
    | 'holds-account-vs-held-holds';
  /** The wallet account id, the journal id, or the Market's `holds` account id. */
  readonly subject: string;
  readonly expected: bigint;
  readonly actual: bigint;
}

/**
 * The wallet ledger of one Market (`wallet.*`). Every method runs inside the caller's unit.
 * Journals, postings and hold lots are insert-only; the database refuses anything else.
 */
export interface WalletRepository {
  /** The customer's wallet account, or null. */
  findWallet(
    market: MarketContext,
    customerAccountId: Id<'Account'>,
  ): Promise<WalletAccountRecord | null>;

  /** Creates the customer's wallet account and its zero balance if they do not exist yet. */
  ensureWallet(
    market: MarketContext,
    input: {
      readonly newAccountId: Id<'WalletAccount'>;
      readonly customerAccountId: Id<'Account'>;
      readonly currency: string;
      readonly now: Temporal.Instant;
    },
  ): Promise<WalletAccountRecord>;

  /** The Market's internal accounts of these kinds, created if missing. */
  ensureInternalAccounts(
    market: MarketContext,
    kinds: readonly InternalAccountKind[],
    input: {
      readonly newId: () => Id<'WalletAccount'>;
      readonly currency: string;
      readonly now: Temporal.Instant;
    },
  ): Promise<ReadonlyMap<InternalAccountKind, Id<'WalletAccount'>>>;

  /** Locks the wallet's balance row until the unit ends, and returns it (what was committed before the lock). */
  lockBalance(market: MarketContext, walletAccountId: Id<'WalletAccount'>): Promise<BalanceRecord>;

  /** The balance without a lock (for reads). */
  readBalance(
    market: MarketContext,
    walletAccountId: Id<'WalletAccount'>,
  ): Promise<{ readonly availableMinor: bigint; readonly heldMinor: bigint }>;

  saveBalance(market: MarketContext, balance: BalanceRecord, now: Temporal.Instant): Promise<void>;

  findJournal(market: MarketContext, idempotencyKey: string): Promise<JournalRecord | null>;
  hasJournals(market: MarketContext): Promise<boolean>;
  appendJournal(market: MarketContext, journal: NewJournal): Promise<void>;

  createLot(market: MarketContext, lot: NewLot): Promise<void>;
  /** All lots of the wallet with credit left (locked for the unit). */
  lotsWithCredit(
    market: MarketContext,
    walletAccountId: Id<'WalletAccount'>,
  ): Promise<readonly Lot[]>;
  /** The wallet account a lot belongs to. */
  findLotWallet(market: MarketContext, lotId: Id<'WalletLot'>): Promise<Id<'WalletAccount'> | null>;
  setLotRemaining(
    market: MarketContext,
    lotId: Id<'WalletLot'>,
    remainingMinor: bigint,
  ): Promise<void>;
  findLot(market: MarketContext, lotId: Id<'WalletLot'>): Promise<Lot | null>;

  findHold(
    market: MarketContext,
    orderId: Id<'Order'>,
    walletAccountId?: Id<'WalletAccount'>,
  ): Promise<HoldRecord | null>;
  findHoldById(market: MarketContext, holdId: Id<'WalletHold'>): Promise<HoldRecord | null>;
  createHold(
    market: MarketContext,
    hold: HoldRecord & { readonly currency: string; readonly createdAt: Temporal.Instant },
    takes: readonly Take[],
  ): Promise<void>;
  holdLots(market: MarketContext, holdId: Id<'WalletHold'>): Promise<readonly Take[]>;
  settleHold(
    market: MarketContext,
    holdId: Id<'WalletHold'>,
    status: 'captured' | 'released' | 'expired',
    now: Temporal.Instant,
  ): Promise<void>;

  history(
    market: MarketContext,
    walletAccountId: Id<'WalletAccount'>,
    page: HistoryPage,
  ): Promise<readonly HistoryRow[]>;
  expiringLots(
    market: MarketContext,
    walletAccountId: Id<'WalletAccount'>,
    before: Temporal.Instant,
    after: Temporal.Instant,
    limit: number,
  ): Promise<readonly Lot[]>;

  /**
   * Read-only. The mismatches between postings, lots, holds and the cached balances (empty when
   * the books agree): per wallet, postings = available = lots and held holds = held; every journal
   * sums to zero; the `holds` account = all held holds. The base of the nightly reconciliation.
   */
  reconcile(market: MarketContext): Promise<readonly ReconcileMismatch[]>;

  dueLots(market: MarketContext, now: Temporal.Instant, limit: number): Promise<readonly DueLot[]>;
  dueHolds(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly DueHold[]>;
}

export const WALLET_REPOSITORY = Symbol('WALLET_REPOSITORY');
