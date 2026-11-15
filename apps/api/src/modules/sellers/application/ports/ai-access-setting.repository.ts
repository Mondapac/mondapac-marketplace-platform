import type { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';

/** The AI switch of a seller (SEL-25) as the row holds it, after the row was locked. */
export interface AiAccessSettingState {
  readonly enabled: boolean;
  /** The version of the admin settings row after this unit's bump. */
  readonly version: number;
}

/** The AI switch with when it last changed, for the admin read. */
export interface AiAccessSettingView {
  readonly enabled: boolean;
  readonly changedAt: Temporal.Instant | null;
}

/**
 * `ai_enabled` in `sellers.seller_admin_settings` (SEL-25, ADR-0019 decision 7). Every method
 * runs inside the caller's unit and is scoped by the Market.
 */
export interface AiAccessSettingRepository {
  /**
   * Locks the seller's setting row (it raises the row's version, which holds the row lock until
   * the unit ends) and returns the switch and the new version; null when the seller has no row in
   * the Market (an unknown seller and another Market's seller alike).
   */
  lock(market: MarketContext, sellerId: Id<'Seller'>): Promise<AiAccessSettingState | null>;

  /** Sets the switch with who and when; the row was locked by this unit. */
  set(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    change: {
      readonly enabled: boolean;
      readonly by: Id<'Account'>;
      readonly at: Temporal.Instant;
    },
  ): Promise<void>;

  /** Reads the switch and its change time; null when there is no row in the Market. */
  read(market: MarketContext, sellerId: Id<'Seller'>): Promise<AiAccessSettingView | null>;
}

export const AI_ACCESS_SETTING_REPOSITORY = Symbol('AI_ACCESS_SETTING_REPOSITORY');
