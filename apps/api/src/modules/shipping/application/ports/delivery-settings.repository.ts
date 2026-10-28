import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { DeliveryMethod } from '../../domain/delivery-methods';
import type { DeliverySettings, DeliverySettingsInput } from '../../domain/delivery-settings';
import type { ActorId } from './fleet-selection.repository';

/**
 * The delivery settings of a Market (`shipping.delivery_settings`) and the methods taken away
 * from each seller (`shipping.seller_delivery_methods`). Every method runs inside the caller's
 * unit of work and is scoped by the Market.
 */
export interface DeliverySettingsRepository {
  /** The Market's settings, or the defaults (version 0) while nothing was saved. */
  settings(market: MarketContext): Promise<DeliverySettings>;

  /**
   * Saves the settings when the stored version is still `expectedVersion` (0: nothing saved
   * yet); the stored version becomes `expectedVersion + 1`. `conflict` otherwise.
   */
  saveSettings(
    market: MarketContext,
    settings: DeliverySettingsInput,
    expectedVersion: number,
    by: ActorId,
    at: Temporal.Instant,
  ): Promise<DeliverySettings | 'conflict'>;

  /** The methods taken away from each asked seller; a seller without a row is absent. */
  unsupportedOf(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, readonly DeliveryMethod[]>>;

  setUnsupported(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    methods: readonly DeliveryMethod[],
    by: ActorId,
    at: Temporal.Instant,
  ): Promise<void>;
}

export const DELIVERY_SETTINGS_REPOSITORY = Symbol('DELIVERY_SETTINGS_REPOSITORY');
