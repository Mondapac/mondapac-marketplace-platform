import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { CheckResult, DecisionOutcome } from '../../domain/review';
import type { SubmissionKind } from '../../domain/seller-certificate';
import type { VerificationMode } from '../../domain/type-revision';
import type { IssuerState, SellerCertificationStatus } from '../../domain/validity';
import type { StoredCertificate, StoredDocument } from './seller-certificate.repository';

// The admin side of the seller certificates on the tables of `certification` (data design 3.5,
// 3.6, 3.10, 3.13, 3.16a, 3.17). Every method runs in the open unit of its caller and takes the
// Market from the `MarketContext` only. A write that finds the root's version moved throws
// `StaleAggregateError`. Nothing here decrypts: the use cases do, outside any unit.

/** One waiting submission as the queue lists it: clear fields only (design 7.1). */
export interface ReviewQueueEntry {
  readonly certificateId: Id<'SellerCertification'>;
  readonly version: number;
  readonly sellerId: Id<'Seller'>;
  readonly typeCode: string;
  readonly submissionId: Id<'Submission'>;
  readonly submissionNo: number;
  readonly kind: SubmissionKind;
  readonly submittedAt: Temporal.Instant;
  readonly issuerName: string | null;
}

export interface ReviewChannel {
  readonly id: Id<'IssuerContactChannel'>;
  readonly kind: 'email-domain' | 'phone' | 'web-page';
  readonly value: string;
  readonly retired: boolean;
}

export interface ReviewIssuer {
  readonly id: Id<'Issuer'>;
  readonly typeId: Id<'CertificationType'>;
  readonly displayName: string;
  readonly state: IssuerState;
  readonly channels: readonly ReviewChannel[];
}

export interface StoredReviewCheck {
  readonly id: Id<'ReviewCheck'>;
  readonly code: string;
  readonly result: CheckResult;
  readonly recordedAt: Temporal.Instant;
  readonly recordedByAccountId: Id<'Account'>;
}

export interface StoredScope {
  readonly locationCiphertext: string;
  readonly scopeCiphertext: string;
  readonly recordedAt: Temporal.Instant;
}

export interface StoredConfirmation {
  readonly issuerId: Id<'Issuer'>;
  readonly channelId: Id<'IssuerContactChannel'>;
  readonly confirmedOn: Temporal.PlainDate;
  readonly referenceCiphertext: string;
  readonly recordedAt: Temporal.Instant;
}

export interface StoredDecision {
  readonly outcome: DecisionOutcome | 'withdrawn';
  readonly reasonCode: string | null;
  readonly reasonTextCiphertext: string | null;
  readonly decidedAt: Temporal.Instant;
  readonly actorKind: 'seller' | 'admin' | 'system';
}

/** The submission under review with everything the review page and the decision guards need. */
export interface ReviewSubmission {
  readonly id: Id<'Submission'>;
  readonly submissionNo: number;
  readonly kind: SubmissionKind;
  readonly typeRevisionId: Id<'CertificationTypeRevision'>;
  readonly verificationMode: VerificationMode;
  readonly requiresIssuerRegistry: boolean;
  readonly requiresDocument: boolean;
  readonly requiresExpiry: boolean;
  readonly issuer: ReviewIssuer | null;
  readonly certificateNumberCiphertext: string | null;
  readonly issueDate: Temporal.PlainDate | null;
  readonly expiryDate: Temporal.PlainDate | null;
  readonly selfDeclared: boolean | null;
  readonly selfDeclarationNoteCiphertext: string | null;
  readonly submittedZone: string;
  readonly submittedAt: Temporal.Instant;
  readonly documents: readonly StoredDocument[];
  /** The latest row per check code. */
  readonly checks: readonly StoredReviewCheck[];
  readonly scope: StoredScope | null;
  readonly confirmation: StoredConfirmation | null;
  readonly decision: StoredDecision | null;
}

export interface ReviewHistoryRow {
  readonly fromStatus: SellerCertificationStatus | null;
  readonly toStatus: SellerCertificationStatus;
  readonly occurredAt: Temporal.Instant;
  readonly actorKind: 'seller' | 'admin' | 'system';
  readonly reasonCode: string | null;
}

/**
 * A certificate with the submission a reviewer works on: the pending one, else the approved one
 * (a late issuer confirmation is allowed on it), else null.
 */
export interface ReviewSnapshot {
  readonly certificate: StoredCertificate;
  readonly submission: ReviewSubmission | null;
  /** The submission is the record's pending one (it can be decided). */
  readonly pending: boolean;
  /** The latest rows, newest last, at most 20. */
  readonly history: readonly ReviewHistoryRow[];
}

export interface DuplicateHint {
  readonly kind: 'number' | 'file';
  readonly certificateId: Id<'SellerCertification'>;
  readonly sellerId: Id<'Seller'>;
}

export interface CheckWrite {
  readonly id: Id<'ReviewCheck'>;
  readonly submissionId: Id<'Submission'>;
  readonly code: string;
  readonly result: CheckResult;
  readonly accountId: Id<'Account'>;
  readonly now: Temporal.Instant;
}

export interface ScopeWrite {
  readonly id: Id<'ScopeReading'>;
  readonly submissionId: Id<'Submission'>;
  readonly locationCiphertext: string;
  readonly scopeCiphertext: string;
  readonly accountId: Id<'Account'>;
  readonly now: Temporal.Instant;
}

export interface ConfirmationWrite {
  readonly certificateId: Id<'SellerCertification'>;
  readonly expectedVersion: number;
  readonly submissionId: Id<'Submission'>;
  readonly issuerId: Id<'Issuer'>;
  readonly channelId: Id<'IssuerContactChannel'>;
  readonly confirmedOn: Temporal.PlainDate;
  readonly referenceCiphertext: string;
  readonly accountId: Id<'Account'>;
  readonly now: Temporal.Instant;
}

/** Everything a decision writes in its one unit (design 3.2 rows 3 to 5; data design 3.6, 3.13). */
export interface DecisionWrite {
  readonly certificateId: Id<'SellerCertification'>;
  readonly submissionId: Id<'Submission'>;
  readonly outcome: DecisionOutcome;
  readonly accountId: Id<'Account'>;
  readonly decidedAt: Temporal.Instant;
  /** Approval only: the zone that gave the boundary, and the boundary (null without expiry). */
  readonly approvedZone: string | null;
  readonly expiryBoundaryAt: Temporal.Instant | null;
  readonly reasonCode: string | null;
  readonly reasonTextCiphertext: string | null;
  readonly fromStatus: SellerCertificationStatus;
  readonly toStatus: SellerCertificationStatus;
  readonly historyId: Id<'CertificationHistory'>;
}

export interface SellerOverviewRow {
  readonly sellerId: Id<'Seller'>;
  readonly validTypeCodes: readonly string[];
  readonly pendingTypeCodes: readonly string[];
}

export interface DecisionNotice {
  readonly certificateId: Id<'SellerCertification'>;
  readonly sellerId: Id<'Seller'>;
  readonly typeCode: string;
  readonly outcome: DecisionOutcome | 'withdrawn';
  readonly reasonCode: string | null;
}

export interface CertificateReviewRepository {
  /** Every waiting submission, oldest first (then by id); at most `limit`. */
  queue(market: MarketContext, limit: number): Promise<readonly ReviewQueueEntry[]>;
  snapshot(
    market: MarketContext,
    certificateId: Id<'SellerCertification'>,
  ): Promise<ReviewSnapshot | null>;
  /**
   * Other sellers' certificates whose keyed number or file index equals one of this submission's
   * (design 3.2 rule 6, 10.2); at most 10. The match is on the stored HMAC rows, so nothing is
   * decrypted and no key is needed.
   */
  duplicateHints(
    market: MarketContext,
    submissionId: Id<'Submission'>,
    sellerId: Id<'Seller'>,
  ): Promise<readonly DuplicateHint[]>;
  /**
   * Both take `FOR SHARE` on the root while it still points at the submission as pending, so they
   * serialise against a decision. They answer `false` (nothing written) when it no longer does.
   */
  recordCheck(market: MarketContext, write: CheckWrite): Promise<boolean>;
  recordScope(market: MarketContext, write: ScopeWrite): Promise<boolean>;
  /** Moves the root's version (the confirmation is a state change with an event). */
  recordConfirmation(
    market: MarketContext,
    write: ConfirmationWrite,
  ): Promise<'recorded' | 'exists'>;
  /**
   * The first statement of a decision unit: moves the root's version under the version the
   * reviewer saw (a moved version throws `StaleAggregateError`) and so takes the row lock. Every
   * later read of the unit then sees every committed check, scope and confirmation, and a
   * concurrent `recordCheck`/`recordScope` (which share-lock the root) waits or has finished.
   */
  lockForDecision(
    market: MarketContext,
    certificateId: Id<'SellerCertification'>,
    expectedVersion: number,
    now: Temporal.Instant,
  ): Promise<void>;
  /** Writes the decision rows; call `lockForDecision` first in the same unit. */
  decide(market: MarketContext, write: DecisionWrite): Promise<void>;
  /** Per requested seller (at most 100), the types with a valid and with a waiting certificate. */
  overview(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
    now: Temporal.Instant,
  ): Promise<readonly SellerOverviewRow[]>;
  /** The decision on a submission, for the mail; null while none is recorded. */
  decisionNotice(
    market: MarketContext,
    submissionId: Id<'Submission'>,
  ): Promise<DecisionNotice | null>;
  /** Deletes the seller's rows of both keyed indexes (L4); answers how many went. */
  eraseIndexRows(market: MarketContext, sellerId: Id<'Seller'>): Promise<number>;
}

export const CERTIFICATE_REVIEW_REPOSITORY = Symbol('CERTIFICATION_CERTIFICATE_REVIEW_REPOSITORY');
