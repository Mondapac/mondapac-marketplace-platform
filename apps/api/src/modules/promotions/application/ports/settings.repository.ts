import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { FirstOrderSettings } from './promotions-policy';

/** The first-order discount an admin has edited (`promotions.first_order_settings`); none means the config defaults. */
export interface FirstOrderSettingsRepository {
  find(market: MarketContext): Promise<FirstOrderSettings | null>;
  save(
    market: MarketContext,
    settings: FirstOrderSettings,
    at: Temporal.Instant,
    by: Id<'Account'>,
  ): Promise<void>;
}

export interface ShippingThresholdRecord {
  readonly id: Id<'FreeShippingThreshold'>;
  readonly zoneCode: string;
  readonly thresholdMinor: bigint;
}

/** The free-shipping thresholds per delivery zone (`promotions.free_shipping_thresholds`). */
export interface ShippingThresholdRepository {
  list(market: MarketContext): Promise<readonly ShippingThresholdRecord[]>;
  find(market: MarketContext, zoneCode: string): Promise<ShippingThresholdRecord | null>;
  /** Sets the zone's threshold (inserting the row with `newId` when the zone has none). */
  save(
    market: MarketContext,
    newId: Id<'FreeShippingThreshold'>,
    zoneCode: string,
    thresholdMinor: bigint,
    at: Temporal.Instant,
    by: Id<'Account'>,
  ): Promise<void>;
  /** Removes the zone's row: the zone then uses the Market default. */
  remove(market: MarketContext, zoneCode: string): Promise<void>;
}

export const FIRST_ORDER_SETTINGS_REPOSITORY = Symbol('PROMOTIONS_FIRST_ORDER_SETTINGS_REPOSITORY');
export const SHIPPING_THRESHOLD_REPOSITORY = Symbol('PROMOTIONS_SHIPPING_THRESHOLD_REPOSITORY');
