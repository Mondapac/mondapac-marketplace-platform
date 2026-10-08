import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/**
 * What one refusal may write (pricing design 5.2, 8; H3 and M7): `record` its
 * `pricing.offer-write.refused` row; `summarise`, the first refusal past the per-actor cap in
 * the actor's window, writes the one `pricing.offer-write.refusals-suppressed` row for the window
 * starting at `windowStartedAt`; `none` writes nothing (the pair already has a row this minute,
 * or the actor is suppressed).
 */
export type RefusalAdmission =
  | { readonly kind: 'record' }
  | { readonly kind: 'summarise'; readonly windowStartedAt: Temporal.Instant }
  | { readonly kind: 'none' };

/**
 * The counters behind the refusal audit rows (pricing design 5.2, H3 and M7; pricing-data 3.8).
 * Each call runs in the refusal's own read-write unit, next to the audit row it decides on, so a
 * counter never advances without its row: when the unit rolls back, so does the counter. The
 * caller passes the instant from `Clock` and the window and cap from its policy.
 *
 * **Lock order (pricing design 19 conditions (b) and (e), settled in slice 1 part 3b):** a
 * refusal locks the actor row first, then the (actor, Offer) row, and only one place takes them:
 * {@link admitRefusal}. Every caller goes through it, so two units of one actor never wait on
 * each other's second row (`40P01`). The purge never holds both: each table is purged in its own
 * unit, the actor table first.
 */
export interface WriteRefusalThrottleRepository {
  /**
   * Decides what one refusal of `actorAccountId` on `offerId` may write, in the fixed order:
   * 1. the per-actor counter (`write_refusal_actor_throttles`): a slot under `cap` in the
   *    actor's window of `windowMs` (a window older than that restarts at `now`), else the first
   *    refusal past the cap elects the summary row, else nothing; when the actor is past the cap
   *    the (actor, Offer) row is never touched (condition (b): no counter row grows for a
   *    suppressed actor);
   * 2. only with a slot: the (actor, Offer) window (`write_refusal_throttles`). When the pair
   *    already had a row within `windowMs`, the slot is given back (`recorded_count - 1`, on
   *    the actor row this unit already holds), so `recorded_count` keeps counting rows written
   *    (pricing-data 3.8) and repeats on one Offer never use up the actor's cap.
   */
  admitRefusal(
    market: MarketContext,
    actorAccountId: Id<'Account'>,
    offerId: Id<'Offer'>,
    now: Temporal.Instant,
    windowMs: number,
    cap: number,
  ): Promise<RefusalAdmission>;

  /** Deletes the per-actor counters whose window started before `before` (the hourly purge). */
  purgeActorWindowsStartedBefore(market: MarketContext, before: Temporal.Instant): Promise<number>;

  /** Deletes the (actor, Offer) counters whose window started before `before` (the hourly purge). */
  purgeOfferWindowsStartedBefore(market: MarketContext, before: Temporal.Instant): Promise<number>;
}

export const WRITE_REFUSAL_THROTTLE_REPOSITORY = Symbol('WRITE_REFUSAL_THROTTLE_REPOSITORY');
