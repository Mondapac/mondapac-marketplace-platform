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

  /**
   * One page of the reminder stages taken for one account's cart (customers management phase 2b),
   * by `takenAt` then the cart change and stage in `direction`. Read-only. The rows are kept 30 days.
   */
  pageOfAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    direction: 'asc' | 'desc',
    window: { readonly offset: number; readonly limit: number },
  ): Promise<readonly (CartReminderKey & { readonly takenAt: Temporal.Instant })[]>;

  /** How many reminder stages were taken for the account (kept 30 days). Read-only. */
  countOfAccount(market: MarketContext, accountId: Id<'Account'>): Promise<number>;

  /** Deletes up to `limit` rows taken before `cutoff`, oldest first; answers how many. */
  purgeTakenBefore(market: MarketContext, cutoff: Temporal.Instant, limit: number): Promise<number>;
}

export const CART_REMINDER_REPOSITORY = Symbol('CART_REMINDER_REPOSITORY');
