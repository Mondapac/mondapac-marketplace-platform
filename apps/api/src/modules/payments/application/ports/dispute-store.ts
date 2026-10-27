import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { DisputeState } from '../../domain/dispute';

/** One row of `payments.disputes`. */
export interface DisputeRecord extends DisputeState {
  readonly id: string;
  readonly providerDisputeId: string;
  readonly orderId: string;
  readonly paymentIntentRef: string;
  readonly amountMinor: bigint;
  /** Upper-case ISO 4217. */
  readonly currency: string;
  readonly openedAt: Temporal.Instant;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  /** The read from Stripe the stored state came from; an older read never replaces it. */
  readonly lastReadAt: Temporal.Instant;
  /** 1 when recorded, plus one per change; the version of its `dispute-changed` event. */
  readonly version: number;
}

/**
 * `payments.disputes` of one Market: one row per Stripe dispute. Runs inside the caller's unit of
 * work. The ids, the order, the amount and the currency never change after the insert.
 */
export interface DisputeStore {
  findByRef(market: MarketContext, providerDisputeId: string): Promise<DisputeRecord | null>;

  /** Inserts a new dispute at version 1; `conflict` when its Stripe id is stored already. */
  insert(market: MarketContext, record: DisputeRecord): Promise<'inserted' | 'conflict'>;

  /**
   * Stores the next state when the row is still at `expectedVersion` and was not read later than
   * `readAt`; the version goes up by one. False when another run got in first.
   */
  update(
    market: MarketContext,
    id: string,
    expectedVersion: number,
    next: DisputeState,
    readAt: Temporal.Instant,
  ): Promise<boolean>;

  /** The disputes of these ids in this Market; unknown ids are left out. */
  findMany(market: MarketContext, ids: readonly string[]): Promise<DisputeRecord[]>;
}

export const DISPUTE_STORE = Symbol('DISPUTE_STORE');
