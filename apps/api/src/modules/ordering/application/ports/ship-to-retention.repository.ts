import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { ShipToRetention } from '../../domain/ship-to-retention';

/**
 * Where one run of the purge stopped. The run walks confirmed orders by (confirmedAt, id), then
 * cancelled orders by (cancelledAt, id); `at` and `orderId` are the last order looked at in that
 * phase, null at its start. Opaque to the use case.
 */
export interface ShipToPurgeCursor {
  readonly phase: 'confirmed' | 'cancelled';
  readonly at: Temporal.Instant | null;
  readonly orderId: string | null;
}

/** What one batch of the purge did. */
export interface ShipToPurgeBatch {
  readonly cleared: number;
  /** Null when the batch was the last one (fewer orders left than the limit). */
  readonly next: ShipToPurgeCursor | null;
}

/**
 * The ship-to retention setting of a Market (owner decision 2026-11-15) and the purge it drives.
 * Every method runs inside the caller's open unit of `market`.
 */
export interface ShipToRetentionRepository {
  /** The Market's setting; null when an admin never set it (off). */
  find(market: MarketContext): Promise<ShipToRetention | null>;
  /**
   * Inserts the setting when `expectedVersion` is 0 (`stale` when another admin inserted it
   * first), else updates the row that still has that version (`stale` when none has).
   */
  save(
    market: MarketContext,
    setting: ShipToRetention,
    expectedVersion: number,
  ): Promise<'saved' | 'stale'>;
  /**
   * Looks at up to `limit` orders of `market` after `after` that still hold a sealed ship-to and
   * could be settled by `cutoff`, and clears (sets to null) the ship-to of those
   * `isShipToPurgeable` allows. Orders already cleared are not looked at again. `next` is null
   * once both phases are done.
   */
  clearDeliveredShipTo(
    market: MarketContext,
    cutoff: Temporal.Instant,
    after: ShipToPurgeCursor | null,
    limit: number,
  ): Promise<ShipToPurgeBatch>;
}

export const SHIP_TO_RETENTION_REPOSITORY = Symbol('SHIP_TO_RETENTION_REPOSITORY');

/** The IANA zone of a Market (Market configuration): the purge counts its months there. */
export interface MarketZones {
  zoneOf(market: MarketContext): string;
}

export const MARKET_ZONES = Symbol('ORDERING_MARKET_ZONES');
