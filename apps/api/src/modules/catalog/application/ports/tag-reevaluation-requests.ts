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

/**
 * The certification events catalog consumes (design 5.5; certification slices 12, 14 and 15), as
 * the cause of a `certification-event` request (data design 3.18 `cause`, a closed list). The
 * issuer events join when catalog consumes them.
 */
export const CERTIFICATION_CAUSES = [
  'seller-certification-approved',
  'seller-certification-expired',
  'seller-certification-revoked',
  'seller-certification-issuer-confirmed',
  'claim-policy-changed',
  'product-certification-approved',
  'product-certification-coverage-changed',
  'product-certification-coverage-recheck',
  'product-certification-suspended',
  'product-certification-revoked',
  'product-certification-expired',
] as const;
export type CertificationCause = (typeof CERTIFICATION_CAUSES)[number];

/**
 * The causes whose subject is a certification type id (slice 14): their requests select the tags
 * of that type (`offer_tags.type_code`), the code resolved through certification at run time.
 */
export const TYPE_CAUSES = [
  'claim-policy-changed',
  'product-certification-approved',
  'product-certification-coverage-changed',
] as const satisfies readonly CertificationCause[];

/**
 * The causes that end a certificate (Hassan M-1, PR #398): their requests are listed first, and
 * every run marks their selected `active` tags `rechecking` before any ask, however many other
 * requests are pending, so no badge outlives a revoked or expired certificate by more than a run.
 * A manufacturer certificate's coverage change (Hassan M2, slice 14) is one too for the tags
 * based on that certificate: a product it no longer covers must lose its badge as fast; so are a
 * manufacturer certificate's suspension, revocation and expiry (certification slice 15), selected
 * by the certificate id. Never a {@link TYPE_CAUSES} cause (their selection needs a type code the
 * pre-marking does not resolve).
 */
export const ENDING_CAUSES = [
  'seller-certification-expired',
  'seller-certification-revoked',
  'product-certification-coverage-recheck',
  'product-certification-suspended',
  'product-certification-revoked',
  'product-certification-expired',
] as const satisfies readonly CertificationCause[];

/** What a pending request has in common: its id, cursor, counts and age. */
interface PendingCommon {
  readonly id: Id<'TagReevaluationRequest'>;
  /** The last Offer settled by an earlier run; the next run starts after it. */
  readonly cursorOfferId: Id<'Offer'> | null;
  readonly counts: ReevaluationCounts;
  /** When it was written; a request still pending long after is logged for operators. */
  readonly createdAt: Temporal.Instant;
}

/** One pending `revision-published` request (data design 3.18). */
export interface PendingPublishReevaluation extends PendingCommon {
  readonly kind: 'revision-published';
  readonly productId: Id<'Product'>;
  readonly productRevisionId: Id<'ProductRevision'>;
}

/** One pending `certification-event` request (design 5.5; slice 12). */
export interface PendingCertificationReevaluation extends PendingCommon {
  readonly kind: 'certification-event';
  readonly cause: CertificationCause;
  /** The seller, certificate, submission or type id the selection matches (by cause). */
  readonly subjectId: Id;
  /** The consumed event; recorded on the tag history rows the request writes. */
  readonly sourceEventId: Id;
}

export type PendingReevaluation = PendingPublishReevaluation | PendingCertificationReevaluation;

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

  /**
   * In a handler unit (`runOnce`): the pending `certification-event` request of a consumed event
   * (design 5.5). One request per event: a second write of the same event id is a no-op (the
   * inbox already makes the handler run once; the unique on `source_event_id` backs it).
   */
  requestForEvent(
    market: MarketContext,
    request: {
      readonly id: Id<'TagReevaluationRequest'>;
      readonly cause: CertificationCause;
      readonly subjectId: Id;
      readonly sourceEventId: Id;
      readonly now: Temporal.Instant;
    },
  ): Promise<void>;

  /**
   * True when a pending `certification-event` request of this cause and subject exists that no
   * run has started (no cursor) and that was written strictly after `createdAfter` (the new
   * event's `occurredAt`): it already reflects the newer state, so the handler of a type cause
   * skips writing another (Hassan M2). A started one does not count (the Offers before its cursor
   * would miss the change); nor does an older one, which a run may already be asking on its first
   * page from the state before the event (Hassan N1).
   */
  pendingUnstarted(
    market: MarketContext,
    request: {
      readonly cause: CertificationCause;
      readonly subjectId: Id;
      readonly createdAfter: Temporal.Instant;
    },
  ): Promise<boolean>;

  /**
   * Pending requests of the kinds this build settles (`revision-published`,
   * `certification-event`), at most `limit`: the {@link ENDING_CAUSES} requests first, then the
   * others, each group oldest first.
   */
  listPending(market: MarketContext, limit: number): Promise<readonly PendingReevaluation[]>;

  /**
   * Pending `certification-event` requests of an {@link ENDING_CAUSES} cause, by id after
   * `afterId` (null for the first page), at most `limit`: the pre-marking of every run.
   */
  listPendingEnding(
    market: MarketContext,
    page: { readonly afterId: Id<'TagReevaluationRequest'> | null; readonly limit: number },
  ): Promise<readonly PendingCertificationReevaluation[]>;

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
