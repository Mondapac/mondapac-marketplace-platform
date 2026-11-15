import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { ShipToRetention } from '../../domain/ship-to-retention';

/** Where one run of the purge stopped: the last order it looked at, in (confirmedAt, id) order. */
export interface ShipToPurgeCursor {
  readonly confirmedAt: Temporal.Instant;
  readonly orderId: string;
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
   * Clears (sets to null) the sealed ship-to of at most `limit` confirmed orders of `market`
   * after `after`, whose seller orders all exist and were all delivered at or before `cutoff`
   * (`isShipToPurgeable`). Orders already cleared are not looked at again.
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
