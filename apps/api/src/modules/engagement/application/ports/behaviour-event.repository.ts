import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { BehaviourFacts } from '../../domain/behaviour-event';

/** Whose behaviour an event is: a signed-in customer's account, or a guest token's hash. */
export type BehaviourSubject =
  | { readonly kind: 'account'; readonly accountId: Id<'Account'> }
  | { readonly kind: 'guest'; readonly guestHash: string };

/** One recorded event. Never changed; deleted at the end of its retention or on request. */
export interface BehaviourEventRecord {
  readonly id: Id<'BehaviourEvent'>;
  readonly subject: BehaviourSubject;
  readonly facts: BehaviourFacts;
  readonly occurredAt: Temporal.Instant;
}

/**
 * `engagement.behaviour_events`. Every read and delete is scoped by the Market; runs inside the
 * caller's unit of work.
 */
export interface BehaviourEventRepository {
  append(market: MarketContext, event: BehaviourEventRecord): Promise<void>;

  /** Deletes every event of one account in the Market; answers how many went. */
  deleteForAccount(market: MarketContext, accountId: Id<'Account'>): Promise<number>;

  /**
   * Deletes the events past their retention: an account's before `accountBefore`, a guest's
   * before `guestBefore`. Answers how many of each went.
   */
  purgeBefore(
    market: MarketContext,
    accountBefore: Temporal.Instant,
    guestBefore: Temporal.Instant,
  ): Promise<{ readonly accountEvents: number; readonly guestEvents: number }>;
}

export const BEHAVIOUR_EVENT_REPOSITORY = Symbol('BEHAVIOUR_EVENT_REPOSITORY');
