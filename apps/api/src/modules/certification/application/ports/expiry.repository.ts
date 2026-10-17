import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { ExpiryFacts, ExpiryPolicy } from '../../domain/expiry';
import type { SellerCertificationStatus } from '../../domain/validity';

// The expiry and warning job on the tables of `certification` (data design 3.4, 3.6, 3.18; A9).
// Every method runs in the open unit of its caller and takes the Market from the `MarketContext`
// only. A version guard that finds the root moved throws `StaleAggregateError`.

/** One approved certificate with an expiry, as the job decides on it. */
export interface ExpiryCandidate extends ExpiryFacts {
  readonly certificateId: Id<'SellerCertification'>;
  readonly version: number;
  readonly sellerId: Id<'Seller'>;
  readonly typeId: Id<'CertificationType'>;
  /** The approved submission (the pointer). */
  readonly submissionId: Id<'Submission'>;
  readonly typeRevisionId: Id<'CertificationTypeRevision'>;
}

/** Where the next page of candidates starts: after this (boundary, id). */
export interface ExpiryCursor {
  readonly boundary: Temporal.Instant;
  readonly certificateId: Id<'SellerCertification'>;
}

/**
 * One page of the selection (A9). The cursor and the stop condition come from the raw rows the
 * statement returned, never from the candidates kept (Mojtaba C1, Hassan L1): a row that cannot
 * be a candidate (approved without a usable approved decision) is dropped from `candidates` and
 * counted in `inconsistent`, and paging still moves past it.
 */
export interface ExpiryPage {
  readonly candidates: readonly ExpiryCandidate[];
  /** Rows the statement returned, before any was dropped. */
  readonly rawCount: number;
  /** The (boundary, id) of the last row returned; null for an empty page. */
  readonly last: ExpiryCursor | null;
  /** Rows dropped as inconsistent. */
  readonly inconsistent: number;
}

export interface ExpireWrite {
  readonly certificateId: Id<'SellerCertification'>;
  readonly submissionId: Id<'Submission'>;
  readonly historyId: Id<'CertificationHistory'>;
  readonly now: Temporal.Instant;
}

export interface WarningWrite {
  readonly submissionId: Id<'Submission'>;
  readonly thresholdDays: number;
  readonly now: Temporal.Instant;
}

/** What the expiry mails read when they are sent (ids only travel in the event). */
export interface ExpiryNotice {
  readonly sellerId: Id<'Seller'>;
  readonly typeCode: string;
  readonly status: SellerCertificationStatus;
  readonly approvedSubmissionId: Id<'Submission'> | null;
  /** The approved submission's expiry date, a local date; null without one. */
  readonly expiryDate: Temporal.PlainDate | null;
  /** The approval's boundary (recomputed in the approval zone when usable); null without one. */
  readonly boundary: Temporal.Instant | null;
}

export interface SellerCertificateExpiryRepository {
  /**
   * `approved` roots whose stored boundary is before `horizon`, ordered by (boundary, id), after
   * the cursor, at most `limit` rows (A9). Each kept row with its approved submission and the
   * thresholds already marked for it; see {@link ExpiryPage} for the paging fields.
   */
  candidates(
    market: MarketContext,
    horizon: Temporal.Instant,
    after: ExpiryCursor | null,
    limit: number,
  ): Promise<ExpiryPage>;
  /** The same read for one root, whatever its status; null when there is none. */
  candidate(
    market: MarketContext,
    certificateId: Id<'SellerCertification'>,
  ): Promise<ExpiryCandidate | null>;
  /**
   * The first statement of the job's unit: moves the root's version from `expectedVersion` by
   * one, which takes the row lock (lock first, then read). A moved version throws
   * `StaleAggregateError`.
   */
  lockVersion(
    market: MarketContext,
    certificateId: Id<'SellerCertification'>,
    expectedVersion: number,
    now: Temporal.Instant,
  ): Promise<void>;
  /** `approved` → `expired` and the history row (system actor); after `lockVersion`. */
  expire(market: MarketContext, write: ExpireWrite): Promise<void>;
  /** Inserts the marker; a marker that exists throws (the caller re-read it under the lock). */
  recordWarning(market: MarketContext, write: WarningWrite): Promise<void>;
  notice(
    market: MarketContext,
    certificateId: Id<'SellerCertification'>,
  ): Promise<ExpiryNotice | null>;
}

export const SELLER_CERTIFICATE_EXPIRY_REPOSITORY = Symbol(
  'CERTIFICATION_SELLER_CERTIFICATE_EXPIRY_REPOSITORY',
);

/**
 * The Market's warning thresholds and renewal submit-by days (design 5.1), from the
 * `certification` section of its configuration. Every hosted Market has one (checked at
 * start-up); a Market without one throws, never a default or a null policy.
 */
export interface ExpiryPolicyProvider {
  policyFor(market: MarketContext): ExpiryPolicy;
}

export const EXPIRY_POLICY_PROVIDER = Symbol('CERTIFICATION_EXPIRY_POLICY_PROVIDER');
