import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { OfferQueueBacklogReason } from '../../domain/offer-queue-backlog';

/**
 * The alerts of the Offer review queue backlog (`notifications.offer_queue_backlog_alerts`): one
 * for each crossing of a limit, open until the queue is back within both. Every method runs in the
 * open unit of the use case, through the Market-scoped client.
 */
export interface OfferQueueBacklogRepository {
  /**
   * Opens an alert unless one is already open in the Market. True only for the caller that opened
   * it, so overlapping runs raise one alert.
   */
  raise(
    market: MarketContext,
    id: Id<'OfferQueueBacklogAlert'>,
    at: Temporal.Instant,
    reason: OfferQueueBacklogReason,
    queueSize: number,
  ): Promise<boolean>;

  /** Closes the open alert, if any; true when one was closed. */
  clear(market: MarketContext, at: Temporal.Instant): Promise<boolean>;
}

export const OFFER_QUEUE_BACKLOG_REPOSITORY = Symbol('OFFER_QUEUE_BACKLOG_REPOSITORY');
