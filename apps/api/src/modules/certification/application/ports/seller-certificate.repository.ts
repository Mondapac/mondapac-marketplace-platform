import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { SubmissionKind } from '../../domain/seller-certificate';
import type { IssuerState, SellerCertificationStatus } from '../../domain/validity';

/** The draft columns of the root (data design 3.4); the number and the note are ciphertext. */
export interface StoredDraft {
  readonly issuerId: Id<'Issuer'> | null;
  readonly certificateNumberCiphertext: string | null;
  readonly issueDate: Temporal.PlainDate | null;
  readonly expiryDate: Temporal.PlainDate | null;
  readonly selfDeclared: boolean | null;
  readonly selfDeclarationNoteCiphertext: string | null;
}

/** One seller certificate with what its seller-visible status needs (design 3.3). */
export interface StoredCertificate {
  readonly id: Id<'SellerCertification'>;
  readonly sellerId: Id<'Seller'>;
  readonly typeId: Id<'CertificationType'>;
  readonly typeCode: string;
  readonly status: SellerCertificationStatus;
  readonly pendingSubmissionId: Id<'Submission'> | null;
  readonly pendingKind: SubmissionKind | null;
  readonly approvedSubmissionId: Id<'Submission'> | null;
  /** The boundary stored at approval, for the status display only (never a claim input). */
  readonly approvedBoundaryAt: Temporal.Instant | null;
  readonly approvedIssuerState: IssuerState | null;
  /** Submissions ever made: zero means the record can still be deleted. */
  readonly submissionCount: number;
  readonly statusChangedAt: Temporal.Instant;
  readonly lastChangedAt: Temporal.Instant;
  readonly createdAt: Temporal.Instant;
  readonly version: number;
  readonly draft: StoredDraft;
}

/** One stored file with its place on a draft. The envelope and the key never leave the module. */
export interface StoredDocument {
  readonly id: Id<'UploadedDocument'>;
  readonly position: number;
  readonly mediaType: 'image/jpeg' | 'image/png' | 'application/pdf';
  readonly byteSize: number;
  readonly pageCount: number | null;
  readonly createdAt: Temporal.Instant;
  readonly objectKey: string;
  readonly dataKeyEnvelope: string;
  readonly cleanSha256: Buffer;
  /** True once a submission holds the file (it then stays for the record, never deleted). */
  readonly submitted: boolean;
  /** What the file is for; a seller-certificate submission holds only `seller-certificate` files. */
  readonly purpose: string;
}

export interface NewCertificate {
  readonly id: Id<'SellerCertification'>;
  readonly sellerId: Id<'Seller'>;
  readonly typeId: Id<'CertificationType'>;
  readonly now: Temporal.Instant;
}

export interface NewDocument {
  readonly id: Id<'UploadedDocument'>;
  readonly certificateId: Id<'SellerCertification'>;
  readonly expectedVersion: number;
  readonly sellerId: Id<'Seller'>;
  readonly typeId: Id<'CertificationType'>;
  readonly position: number;
  readonly mediaType: StoredDocument['mediaType'];
  readonly byteSize: number;
  readonly pageCount: number | null;
  readonly objectKey: string;
  readonly dataKeyEnvelope: string;
  readonly cleanSha256: Buffer;
  readonly now: Temporal.Instant;
}

/** Everything a submit writes in its one unit (design 3.2 row 1; data design 3.5, 3.11, 3.13). */
export interface SubmitWrite {
  readonly certificateId: Id<'SellerCertification'>;
  readonly expectedVersion: number;
  readonly sellerId: Id<'Seller'>;
  readonly typeId: Id<'CertificationType'>;
  readonly typeRevisionId: Id<'CertificationTypeRevision'>;
  readonly submissionId: Id<'Submission'>;
  readonly submissionNo: number;
  readonly kind: SubmissionKind;
  readonly issuerId: Id<'Issuer'> | null;
  readonly certificateNumberCiphertext: string | null;
  readonly issueDate: Temporal.PlainDate | null;
  readonly expiryDate: Temporal.PlainDate | null;
  readonly selfDeclared: boolean | null;
  readonly selfDeclarationNoteCiphertext: string | null;
  readonly contentSchemaVersion: number;
  /** `hmac-sha256:<64 hex>`. */
  readonly contentHash: string;
  readonly submittedZone: string;
  readonly submittedAt: Temporal.Instant;
  readonly submittedByAccountId: Id<'Account'>;
  /** The draft's files in order; each joins the submission at its position (1, 2, ...). */
  readonly documentIds: readonly Id<'UploadedDocument'>[];
  readonly fromStatus: SellerCertificationStatus;
  readonly toStatus: SellerCertificationStatus;
  readonly historyId: Id<'CertificationHistory'>;
}

/** Everything a withdrawal writes (design 3.2 row 2; data design 3.6, 3.13). */
export interface WithdrawWrite {
  readonly certificateId: Id<'SellerCertification'>;
  readonly expectedVersion: number;
  readonly submissionId: Id<'Submission'>;
  readonly cause: 'edited' | 'cancelled' | 'revoked';
  readonly accountId: Id<'Account'>;
  readonly decidedAt: Temporal.Instant;
  readonly fromStatus: SellerCertificationStatus;
  readonly toStatus: SellerCertificationStatus;
  readonly historyId: Id<'CertificationHistory'>;
}

/**
 * The seller's certificates, their draft, files, submissions and history, on the tables of
 * `certification` (data design 3.4 to 3.13). Every method runs in the open unit of its caller and
 * takes the seller id from the caller's actor, never from a request: a certificate of another
 * seller is the same `null` as an unknown id. A write that finds the root's version moved throws
 * `StaleAggregateError`.
 */
export interface SellerCertificateRepository {
  /** Inserts a draft record; `certificate.exists` when the seller has an open one of the type (T1). */
  add(market: MarketContext, certificate: NewCertificate): Promise<'certificate.exists' | null>;
  findOwn(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    id: Id<'SellerCertification'>,
  ): Promise<StoredCertificate | null>;
  /** Newest first (created, then id), after the given id; at most `limit`. */
  listOwn(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    page: { readonly afterId: Id<'SellerCertification'> | null; readonly limit: number },
  ): Promise<readonly StoredCertificate[]>;
  saveDraft(
    market: MarketContext,
    id: Id<'SellerCertification'>,
    expectedVersion: number,
    draft: StoredDraft,
    now: Temporal.Instant,
  ): Promise<void>;
  /**
   * Removes a record that never had a submission, with its draft links and its files (no
   * submission can hold them); false when it has a submission.
   */
  deleteNeverSubmitted(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    id: Id<'SellerCertification'>,
  ): Promise<boolean>;
  /** The files of the draft in order. */
  listDocuments(
    market: MarketContext,
    certificateId: Id<'SellerCertification'>,
  ): Promise<readonly StoredDocument[]>;
  /** A file that belongs to the seller and to the certificate's draft or one of its submissions. */
  findDocumentForRead(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    certificateId: Id<'SellerCertification'>,
    documentId: Id<'UploadedDocument'>,
  ): Promise<StoredDocument | null>;
  /** Inserts the file and its draft link and moves the root's version. */
  addDocument(market: MarketContext, document: NewDocument): Promise<void>;
  /**
   * Takes a file off the draft and moves the root's version. A file no submission holds is
   * deleted ('deleted'); one a submission holds only leaves the draft ('unlinked'); 'missing' when
   * it is not on the draft.
   */
  removeDocument(
    market: MarketContext,
    certificateId: Id<'SellerCertification'>,
    documentId: Id<'UploadedDocument'>,
    expectedVersion: number,
    now: Temporal.Instant,
  ): Promise<'deleted' | 'unlinked' | 'missing'>;
  submit(market: MarketContext, write: SubmitWrite): Promise<void>;
  withdraw(market: MarketContext, write: WithdrawWrite): Promise<void>;
  /**
   * Adds `bytes` to the seller's draft quota when the sum stays within `limit`: one guarded
   * statement, so two uploads cannot both pass (data design 3.12).
   */
  reserveQuota(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    bytes: number,
    limit: number,
    now: Temporal.Instant,
  ): Promise<boolean>;
  releaseQuota(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    bytes: number,
    now: Temporal.Instant,
  ): Promise<void>;
}

export const SELLER_CERTIFICATE_REPOSITORY = Symbol('CERTIFICATION_SELLER_CERTIFICATE_REPOSITORY');
