import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/**
 * What the per-actor counter allows for one refusal (pricing design 5.2, 8; M7): `record` its
 * audit row; `summarise`, the first refusal past the cap in the window, writes the one
 * `pricing.offer-write-refused.suppressed` row; `suppress` writes nothing.
 */
export type ActorRefusalSlot = 'record' | 'summarise' | 'suppress';

/**
 * The counters behind the refusal audit rows (pricing design 5.2, H3 and M7; pricing-data 3.8).
 * Each call runs in the refusal's own read-write unit, next to the audit row it decides on, so a
 * counter never advances without its row: when the unit rolls back, so does the counter. The
 * caller passes the instant from `Clock` and the window and cap from its policy.
 */
export interface WriteRefusalThrottleRepository {
  /**
   * Per (actor, Offer): true when no audit row was recorded for this pair within `windowMs`
   * before `now`, and the window now starts at `now`; false otherwise. Two concurrent calls for
   * one pair never both get true.
   */
  claimOfferWindow(
    market: MarketContext,
    actorAccountId: Id<'Account'>,
    offerId: Id<'Offer'>,
    now: Temporal.Instant,
    windowMs: number,
  ): Promise<boolean>;

  /**
   * Per actor, across Offers: counts one refusal in the actor's window of `windowMs` and answers
   * what it may write. A window older than `windowMs` restarts at `now`.
   */
  countActorRefusal(
    market: MarketContext,
    actorAccountId: Id<'Account'>,
    now: Temporal.Instant,
    windowMs: number,
    cap: number,
  ): Promise<ActorRefusalSlot>;

  /** Deletes both kinds of counter whose window started before `before` (the hourly purge). */
  purgeStartedBefore(market: MarketContext, before: Temporal.Instant): Promise<number>;
}

export const WRITE_REFUSAL_THROTTLE_REPOSITORY = Symbol('WRITE_REFUSAL_THROTTLE_REPOSITORY');
