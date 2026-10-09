import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { AvailabilityStatus } from '../../domain/events';
import type { StoredSignal } from '../../domain/stock';

export interface NewAvailabilitySignal {
  readonly id: Id<'AvailabilitySignal'>;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly sellerId: Id<'Seller'>;
  readonly status: AvailabilityStatus;
  readonly onlyLeft: number | null;
  readonly changedAt: Temporal.Instant;
  readonly version: number;
}

/** The store of availability signals, one per sell unit (data design 3.9). */
export interface AvailabilitySignalRepository {
  find(
    market: MarketContext,
    offerId: Id<'Offer'>,
    variantId: Id<'Variant'>,
  ): Promise<StoredSignal | null>;

  insert(market: MarketContext, signal: NewAvailabilitySignal): Promise<void>;

  /**
   * Writes the new status and count and the version, only if the stored version is
   * `expectedVersion`. Under the stock lock of the sell unit nothing else writes it, so `stale`
   * means a bug, and the caller throws.
   */
  update(
    market: MarketContext,
    id: Id<'AvailabilitySignal'>,
    expectedVersion: number,
    change: {
      readonly status: AvailabilityStatus;
      readonly onlyLeft: number | null;
      readonly changedAt: Temporal.Instant;
      readonly version: number;
    },
  ): Promise<'saved' | 'stale'>;
}

export const AVAILABILITY_SIGNAL_REPOSITORY = Symbol('AVAILABILITY_SIGNAL_REPOSITORY');
