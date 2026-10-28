import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { TransferFailureCode, TransferState } from '../../domain/transfer';

/** One row of `payments.transfer_executions`: a transfer command, or the tombstone of a key. */
export interface TransferRecord {
  readonly id: string;
  readonly instructionKey: string;
  /** Null only for a tombstone (a key abandoned before anything was sent). */
  readonly sellerId: string | null;
  /** The destination at the time of the send (acct_...); null only for a tombstone. */
  readonly accountRef: string | null;
  readonly amountMinor: bigint | null;
  /** Upper-case ISO 4217; null only for a tombstone. */
  readonly currency: string | null;
  /** The payout id of commission-payouts; null only for a tombstone. */
  readonly reference: string | null;
  readonly state: TransferState;
  /** tr_...; written once. */
  readonly providerTransferRef: string | null;
  readonly failureCode: TransferFailureCode | null;
  readonly reversedMinor: bigint;
  /** 0 or 1: a transfer is sent at most once. */
  readonly sendCount: 0 | 1;
  readonly leaseUntil: Temporal.Instant | null;
  readonly abandonedAt: Temporal.Instant | null;
  /** Set once when a transfer was found for a row that had been abandoned. */
  readonly fenceBreachedAt: Temporal.Instant | null;
  readonly executedAt: Temporal.Instant | null;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  /** 1 when stored, plus one per change; the version of its `transfer-changed` events. */
  readonly version: number;
}

/** What one guarded change writes; the database trigger refuses any change the machine forbids. */
export interface TransferChange {
  readonly state: TransferState;
  readonly providerTransferRef?: string;
  readonly failureCode?: TransferFailureCode;
  readonly executedAt?: Temporal.Instant;
  readonly abandonedAt?: Temporal.Instant;
  readonly fenceBreachedAt?: Temporal.Instant;
  readonly reversedMinor?: bigint;
}

/**
 * `payments.transfer_executions` of one Market. Runs inside the caller's unit of work. The
 * content never changes after the insert; each change names the state and version it was decided
 * from, so a row another run moved first is left alone (false).
 */
export interface TransferStore {
  findByKey(market: MarketContext, instructionKey: string): Promise<TransferRecord | null>;

  /** The rows of these keys in this Market, in one statement; unknown keys are left out. */
  findManyByKey(
    market: MarketContext,
    instructionKeys: readonly string[],
  ): Promise<readonly TransferRecord[]>;

  /** Inserts a command row; `conflict` when the key is stored already (command or tombstone). */
  insert(market: MarketContext, record: TransferRecord): Promise<'inserted' | 'conflict'>;

  /** Inserts the tombstone of a key; `conflict` when the key is stored already. */
  insertTombstone(
    market: MarketContext,
    tombstone: {
      readonly id: string;
      readonly instructionKey: string;
      readonly at: Temporal.Instant;
    },
  ): Promise<'inserted' | 'conflict'>;

  /** Applies one change while the row is still `from` at `expectedVersion`; the version goes up by one. */
  change(
    market: MarketContext,
    id: string,
    from: { readonly state: TransferState; readonly version: number },
    change: TransferChange,
    at: Temporal.Instant,
  ): Promise<boolean>;

  /** Rows still `sending` whose lease ended at or before `now`, oldest first. */
  sendingPastLease(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly TransferRecord[]>;

  /** The total of transfers executed in `[from, to)` in this currency, in minor units. */
  executedTotal(
    market: MarketContext,
    currency: string,
    from: Temporal.Instant,
    to: Temporal.Instant,
  ): Promise<bigint>;
}

export const TRANSFER_STORE = Symbol('TRANSFER_STORE');
