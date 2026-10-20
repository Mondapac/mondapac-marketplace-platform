import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** One cart reminder stage of one cart change (personalization 1c). */
export interface CartReminderKey {
  readonly accountId: Id<'Account'>;
  readonly cartChangedAt: Temporal.Instant;
  readonly stage: 1 | 2;
}

/**
 * The record of cart reminders taken for sending (`notifications.cart_reminders`). Every method
 * runs in the open unit of the use case, through the Market-scoped client.
 */
export interface CartReminderRepository {
  /**
   * Takes the stage for sending: inserts the row unless it exists. True only for the caller that
   * inserted it, so overlapping runs send a stage once.
   */
  take(market: MarketContext, key: CartReminderKey, at: Temporal.Instant): Promise<boolean>;

  /** Deletes up to `limit` rows taken before `cutoff`, oldest first; answers how many. */
  purgeTakenBefore(market: MarketContext, cutoff: Temporal.Instant, limit: number): Promise<number>;
}

export const CART_REMINDER_REPOSITORY = Symbol('CART_REMINDER_REPOSITORY');
