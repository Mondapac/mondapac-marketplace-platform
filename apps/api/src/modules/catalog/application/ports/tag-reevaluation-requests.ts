import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** What a fan-out run did, kept on the request as a metric (design 5.6; 19.2 item 5). */
export interface ReevaluationCounts {
  readonly asked: number;
  readonly kept: number;
  readonly switched: number;
  readonly suspended: number;
  readonly restored: number;
  readonly unavailable: number;
}

export const NO_COUNTS: ReevaluationCounts = Object.freeze({
  asked: 0,
  kept: 0,
  switched: 0,
  suspended: 0,
  restored: 0,
  unavailable: 0,
});

/** One pending `revision-published` request (data design 3.18). */
export interface PendingReevaluation {
  readonly id: Id<'TagReevaluationRequest'>;
  readonly productId: Id<'Product'>;
  readonly productRevisionId: Id<'ProductRevision'>;
  /** The last Offer settled by an earlier run; the next run starts after it. */
  readonly cursorOfferId: Id<'Offer'> | null;
  readonly counts: ReevaluationCounts;
  /** When the publish wrote it; a request still pending long after is logged for operators. */
  readonly createdAt: Temporal.Instant;
}

/**
 * The work queue of the tag re-ask fan-out (`catalog.tag_reevaluation_requests`, data design
 * 3.18; design 5.4). Every method runs in the caller's unit through the Market-scoped client.
 */
export interface TagReevaluationRequestRepository {
  /**
   * In a publish unit: supersedes the product's pending request (a newer revision makes it moot)
   * and writes the pending request for the revision just published. Writing the same revision
   * twice is refused by the database (one request per revision).
   */
  requestForPublish(
    market: MarketContext,
    request: {
      readonly id: Id<'TagReevaluationRequest'>;
      readonly productId: Id<'Product'>;
      readonly productRevisionId: Id<'ProductRevision'>;
      readonly now: Temporal.Instant;
    },
  ): Promise<void>;

  /** Pending `revision-published` requests, oldest first, at most `limit`. */
  listPending(market: MarketContext, limit: number): Promise<readonly PendingReevaluation[]>;

  /**
   * Stores the counts and moves the cursor, only while the request is pending and never back (a
   * late overlapping run never moves it back). An equal cursor, or none while the stored one is
   * none, stores the counts only, so a run that stopped before settling an Offer still records
   * what it saw (Mojtaba F4). False when nothing changed.
   */
  progress(
    market: MarketContext,
    id: Id<'TagReevaluationRequest'>,
    update: { readonly cursorOfferId: Id<'Offer'> | null; readonly counts: ReevaluationCounts },
  ): Promise<boolean>;

  /** Ends a pending request as `settled` or `superseded`; false when it was not pending. */
  close(
    market: MarketContext,
    id: Id<'TagReevaluationRequest'>,
    end: {
      readonly state: 'settled' | 'superseded';
      readonly counts: ReevaluationCounts;
      readonly now: Temporal.Instant;
    },
  ): Promise<boolean>;
}

export const TAG_REEVALUATION_REQUESTS = Symbol('TAG_REEVALUATION_REQUESTS');
