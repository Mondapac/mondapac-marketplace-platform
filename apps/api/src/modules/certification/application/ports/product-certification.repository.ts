import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { CoverageEntry } from '../../domain/product-certification';
import type { ProductCertificationStatus } from '../../domain/validity';
import type { RegistryRowsShared } from './review.repository';

// The manufacturer certificate of certification slice 14 (design 2.1, 3.4; data design 3.15,
// 3.16): the root with its draft, the draft's coverage and editors, the insert-only revisions with
// their coverage, editors and decision, and the status history. Every method runs in the caller's
// open unit; the Market comes from the `MarketContext` only. Nothing is deleted but the draft's
// coverage and editor rows, which the draft owns.

/** The draft as stored on the root (the number only as ciphertext). */
export interface StoredProductDraftRow {
  readonly manufacturerName: string | null;
  readonly issuerId: Id<'Issuer'> | null;
  readonly certificateNumberCiphertext: string | null;
  readonly issueDate: Temporal.PlainDate | null;
  readonly expiryDate: Temporal.PlainDate | null;
  readonly coverage: readonly CoverageEntry[];
}

/** A root (data design 3.15) with its draft and the admins who edited the draft. */
export interface StoredProductCertification {
  readonly id: Id<'ProductCertification'>;
  readonly typeId: Id<'CertificationType'>;
  readonly status: ProductCertificationStatus;
  readonly pendingRevisionId: Id<'ProductCertificationRevision'> | null;
  readonly approvedRevisionId: Id<'ProductCertificationRevision'> | null;
  readonly approvedBoundaryAt: Temporal.Instant | null;
  /** The admin who created the record; never its approver (AC 20). */
  readonly authorAccountId: string;
  readonly draft: StoredProductDraftRow;
  /** Every admin who saved the draft since its last approval (design 3.4 row 1). */
  readonly draftEditorAccountIds: readonly string[];
  readonly statusChangedAt: Temporal.Instant;
  readonly lastChangedAt: Temporal.Instant;
  readonly version: number;
  readonly createdAt: Temporal.Instant;
}

export interface StoredProductDecision {
  readonly outcome: 'approved' | 'rejected' | 'withdrawn';
  readonly expiryBoundaryAt: Temporal.Instant | null;
  readonly boundaryZone: string | null;
  readonly reasonCode: string | null;
  readonly decidedByAccountId: string | null;
  readonly decidedAt: Temporal.Instant;
}

/** One insert-only revision (data design 3.16) with its coverage, editors and decision. */
export interface StoredProductRevision {
  readonly id: Id<'ProductCertificationRevision'>;
  readonly productCertificationId: Id<'ProductCertification'>;
  readonly typeId: Id<'CertificationType'>;
  /** The type revision in force at submission (I1). */
  readonly typeRevisionId: Id<'CertificationTypeRevision'>;
  readonly revisionNo: number;
  readonly issuerId: Id<'Issuer'>;
  readonly manufacturerName: string;
  readonly certificateNumberCiphertext: string;
  readonly issueDate: Temporal.PlainDate | null;
  readonly expiryDate: Temporal.PlainDate | null;
  readonly authorAccountId: string;
  readonly submittedByAccountId: string;
  readonly submittedAt: Temporal.Instant;
  readonly coverage: readonly CoverageEntry[];
  /** Every admin who edited the draft this revision came from, and its submitter. */
  readonly editorAccountIds: readonly string[];
  readonly decision: StoredProductDecision | null;
}

/** One row of the admin list: clear fields only (no number). */
export interface ProductCertificationSummary {
  readonly id: Id<'ProductCertification'>;
  readonly typeId: Id<'CertificationType'>;
  readonly status: ProductCertificationStatus;
  readonly pendingRevisionId: string | null;
  readonly approvedRevisionId: string | null;
  readonly manufacturerName: string | null;
  readonly coverageEntries: number;
  readonly lastChangedAt: Temporal.Instant;
  readonly version: number;
}

export interface ProductDraftWrite {
  readonly certificateId: Id<'ProductCertification'>;
  readonly manufacturerName: string | null;
  readonly issuerId: Id<'Issuer'> | null;
  /** `undefined` keeps the stored ciphertext. */
  readonly certificateNumberCiphertext: string | null | undefined;
  readonly issueDate: Temporal.PlainDate | null;
  readonly expiryDate: Temporal.PlainDate | null;
  /** The whole coverage list; replaces the draft's. */
  readonly coverage: readonly CoverageEntry[];
  readonly editorAccountId: Id<'Account'>;
  readonly now: Temporal.Instant;
}

export interface ProductSubmitWrite {
  readonly certificateId: Id<'ProductCertification'>;
  readonly revisionId: Id<'ProductCertificationRevision'>;
  readonly typeId: Id<'CertificationType'>;
  readonly typeRevisionId: Id<'CertificationTypeRevision'>;
  readonly issuerId: Id<'Issuer'>;
  readonly manufacturerName: string;
  readonly certificateNumberCiphertext: string;
  readonly issueDate: Temporal.PlainDate | null;
  readonly expiryDate: Temporal.PlainDate | null;
  readonly authorAccountId: string;
  readonly contentHash: string;
  readonly submitterAccountId: Id<'Account'>;
  readonly coverage: readonly CoverageEntry[];
  /** The draft's editors and the submitter, copied onto the revision. */
  readonly editorAccountIds: readonly string[];
  readonly fromStatus: ProductCertificationStatus;
  readonly toStatus: ProductCertificationStatus;
  readonly historyId: Id<'ProductCertificationHistory'>;
  readonly now: Temporal.Instant;
}

export interface ProductDecisionWrite {
  readonly certificateId: Id<'ProductCertification'>;
  readonly revisionId: Id<'ProductCertificationRevision'>;
  readonly outcome: 'approved' | 'rejected';
  readonly expiryBoundaryAt: Temporal.Instant | null;
  readonly boundaryZone: string | null;
  readonly reasonCode: string | null;
  readonly authorAccountId: string;
  readonly deciderAccountId: Id<'Account'>;
  readonly fromStatus: ProductCertificationStatus;
  readonly toStatus: ProductCertificationStatus;
  readonly historyId: Id<'ProductCertificationHistory'>;
  readonly now: Temporal.Instant;
}

export interface ProductCertificationRepository {
  /** Inserts a root in `draft` at version 1 with an empty draft. */
  create(
    market: MarketContext,
    root: {
      readonly id: Id<'ProductCertification'>;
      readonly typeId: Id<'CertificationType'>;
      readonly authorAccountId: Id<'Account'>;
      readonly now: Temporal.Instant;
    },
  ): Promise<void>;
  /**
   * Lock first: moves the root's version from `expectedVersion` (+1) and its `last_changed_at`,
   * taking the row lock, so every read after it in the unit sees what committed before and a
   * concurrent writer waits. A moved version throws `StaleAggregateError`.
   */
  lock(
    market: MarketContext,
    certificateId: Id<'ProductCertification'>,
    expectedVersion: number,
    now: Temporal.Instant,
  ): Promise<void>;
  get(
    market: MarketContext,
    certificateId: Id<'ProductCertification'>,
  ): Promise<StoredProductCertification | null>;
  /** One revision of the record (another record's revision is absent). */
  revision(
    market: MarketContext,
    certificateId: Id<'ProductCertification'>,
    revisionId: Id<'ProductCertificationRevision'>,
  ): Promise<StoredProductRevision | null>;
  /** The draft fields, its whole coverage and the editor (recorded once). */
  saveDraft(market: MarketContext, write: ProductDraftWrite): Promise<void>;
  /**
   * Revision N+1 from the draft: the revision, its coverage and editors, the pending pointer, the
   * status and a history row. Answers the revision number.
   */
  submit(market: MarketContext, write: ProductSubmitWrite): Promise<number>;
  /**
   * The decision on the pending revision: the decision row, a history row, the pointers (an
   * approval moves the approved pointer and its boundary and clears the draft's editors) and the
   * status.
   */
  decide(market: MarketContext, write: ProductDecisionWrite): Promise<void>;
  /**
   * Takes `FOR SHARE` on the type and, when named, the issuer (after the root's lock), and answers
   * their status: a deactivation either committed before and is seen, or waits for this unit.
   */
  shareRegistryRows(
    market: MarketContext,
    typeId: Id<'CertificationType'>,
    issuerId: Id<'Issuer'> | null,
  ): Promise<RegistryRowsShared>;
  /** A page of roots, newest first, optionally of one status and type. */
  list(
    market: MarketContext,
    filter: {
      readonly status: ProductCertificationStatus | null;
      readonly typeId: Id<'CertificationType'> | null;
      readonly limit: number;
      readonly offset: number;
    },
  ): Promise<readonly ProductCertificationSummary[]>;
}

export const PRODUCT_CERTIFICATION_REPOSITORY = Symbol(
  'CERTIFICATION_PRODUCT_CERTIFICATION_REPOSITORY',
);
