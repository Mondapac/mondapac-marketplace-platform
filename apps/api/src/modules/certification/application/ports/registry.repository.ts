import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { IssuerState } from '../../domain/issuer';
import type { ProposalState, ProposalSubject, TypeStatus } from '../../domain/registry';
import type { TypeRevisionContent, VerificationMode } from '../../domain/type-revision';

// The admin registry of certification slice 12 (design 3.5, 3.6, 7.6; data design 3.1 to 3.3, 3.7,
// 3.20, 3.22): types and their revisions, issuers, relaxation proposals and the Market's platform
// subject. Every method runs in the caller's open unit; the Market comes from the `MarketContext`
// only. Nothing here deletes a row; a revision, its texts and terms are insert-only.

/** A certification type root (data design 3.1). */
export interface StoredType {
  readonly id: Id<'CertificationType'>;
  readonly code: string;
  readonly status: TypeStatus;
  readonly verificationMode: VerificationMode;
  readonly publishedRevisionId: Id<'CertificationTypeRevision'>;
  readonly version: number;
}

/** One revision with its texts and terms (data design 3.2, 3.3). */
export interface StoredTypeRevision {
  readonly id: Id<'CertificationTypeRevision'>;
  readonly typeId: Id<'CertificationType'>;
  readonly revisionNo: number;
  readonly content: TypeRevisionContent;
  readonly authorAccountId: string;
  readonly changeReasonCiphertext: string | null;
  readonly createdAt: Temporal.Instant;
}

/** A type in the admin list: its root, its published names and which proposals wait. */
export interface TypeListRow {
  readonly type: StoredType;
  readonly publishedRevisionNo: number;
  readonly names: Readonly<Record<string, string>>;
  readonly pendingSubjects: readonly ProposalSubject[];
}

/** A relaxation proposal (data design 3.20). */
export interface StoredProposal {
  readonly id: Id<'RelaxationProposal'>;
  readonly subject: ProposalSubject;
  readonly subjectId: string;
  readonly basedOnRevisionId: string | null;
  readonly proposedRevisionId: string | null;
  readonly proposedExpertReferenceCiphertext: string | null;
  readonly state: ProposalState;
  readonly proposerAccountId: string;
  readonly proposedAt: Temporal.Instant;
  readonly decidedByAccountId: string | null;
  readonly decidedAt: Temporal.Instant | null;
  readonly changeReasonCiphertext: string | null;
  readonly version: number;
}

/** An issuer of the registry (data design 3.7). */
export interface StoredIssuer {
  readonly id: Id<'Issuer'>;
  readonly typeId: Id<'CertificationType'>;
  readonly typeCode: string;
  readonly displayName: string;
  readonly accreditationNumber: string | null;
  readonly state: IssuerState;
  readonly expertReferenceCiphertext: string | null;
  readonly stateChangedAt: Temporal.Instant;
  readonly stateChangedByKind: 'admin' | 'seed';
  readonly stateChangedByAccountId: string | null;
  readonly version: number;
  readonly createdAt: Temporal.Instant;
}

export interface NewTypeRevision {
  readonly id: Id<'CertificationTypeRevision'>;
  readonly typeId: Id<'CertificationType'>;
  readonly content: TypeRevisionContent;
  readonly authorAccountId: Id<'Account'>;
  readonly changeReasonCiphertext: string | null;
  readonly createdAt: Temporal.Instant;
}

export interface NewProposal {
  readonly id: Id<'RelaxationProposal'>;
  readonly subject: ProposalSubject;
  readonly subjectId: string;
  readonly basedOnRevisionId: string | null;
  readonly proposedRevisionId: string | null;
  readonly proposedExpertReferenceCiphertext: string | null;
  readonly proposerAccountId: Id<'Account'>;
  readonly changeReasonCiphertext: string | null;
  readonly proposedAt: Temporal.Instant;
}

export interface NewIssuer {
  readonly id: Id<'Issuer'>;
  readonly typeId: Id<'CertificationType'>;
  readonly displayName: string;
  readonly displayNameKey: string;
  readonly accreditationNumber: string | null;
  readonly accountId: Id<'Account'>;
  readonly createdAt: Temporal.Instant;
}

export interface IssuerStateWrite {
  readonly id: Id<'Issuer'>;
  readonly expectedVersion: number;
  readonly state: IssuerState;
  /** Set only on activation and reactivation; untouched when absent. */
  readonly expertReferenceCiphertext?: string;
  readonly accountId: Id<'Account'>;
  readonly changedAt: Temporal.Instant;
}

export interface CertificationRegistryRepository {
  /** Every type of the Market, by code (a Market has a handful). */
  listTypes(market: MarketContext): Promise<readonly TypeListRow[]>;
  type(market: MarketContext, typeId: Id<'CertificationType'>): Promise<StoredType | null>;
  revision(
    market: MarketContext,
    revisionId: Id<'CertificationTypeRevision'>,
  ): Promise<StoredTypeRevision | null>;
  /**
   * Inserts a revision with the next number of its type, its texts and its terms. A concurrent
   * save that took the same number throws `StaleAggregateError`.
   */
  addRevision(market: MarketContext, revision: NewTypeRevision): Promise<number>;
  /** Points the type at `revisionId` and moves its version; a moved version throws stale. */
  publishRevision(
    market: MarketContext,
    typeId: Id<'CertificationType'>,
    revisionId: Id<'CertificationTypeRevision'>,
    expectedVersion: number,
  ): Promise<void>;
  /** Sets the status and moves the version; a moved version throws stale. */
  setTypeStatus(
    market: MarketContext,
    typeId: Id<'CertificationType'>,
    status: TypeStatus,
    expectedVersion: number,
  ): Promise<void>;

  /** The pending proposal of one subject kind for one subject, or null. */
  pendingProposal(
    market: MarketContext,
    subject: ProposalSubject,
    subjectId: string,
  ): Promise<StoredProposal | null>;
  proposal(market: MarketContext, id: Id<'RelaxationProposal'>): Promise<StoredProposal | null>;
  /** `review.proposal-pending` when the subject already has one (the partial unique index). */
  addProposal(
    market: MarketContext,
    proposal: NewProposal,
  ): Promise<'review.proposal-pending' | null>;
  /** Moves a pending proposal to a final state under its version; a miss throws stale. */
  closeProposal(
    market: MarketContext,
    write: {
      readonly id: Id<'RelaxationProposal'>;
      readonly expectedVersion: number;
      readonly state: Exclude<ProposalState, 'pending'>;
      readonly decidedByAccountId: Id<'Account'> | null;
      readonly decidedAt: Temporal.Instant;
    },
  ): Promise<void>;

  /** A page of issuers by id, optionally of one type and state. */
  listIssuers(
    market: MarketContext,
    filter: {
      readonly typeId: Id<'CertificationType'> | null;
      readonly state: IssuerState | null;
      readonly afterId: Id<'Issuer'> | null;
      readonly limit: number;
    },
  ): Promise<readonly StoredIssuer[]>;
  issuer(market: MarketContext, issuerId: Id<'Issuer'>): Promise<StoredIssuer | null>;
  /** Inserts a `proposed` issuer; a taken name key or accreditation number answers its code. */
  addIssuer(
    market: MarketContext,
    issuer: NewIssuer,
  ): Promise<'issuer.name-taken' | 'issuer.accreditation-taken' | null>;
  /** Writes a state change under the version; a moved version throws stale. */
  setIssuerState(market: MarketContext, write: IssuerStateWrite): Promise<void>;
  /** Approved seller certificates whose approved submission names the issuer (brief s12). */
  approvedCertificateCount(market: MarketContext, issuerId: Id<'Issuer'>): Promise<number>;
  /**
   * The sellers of those certificates, by id after `afterSellerId`. One per seller: a seller has
   * at most one open certificate per type (T1), and an issuer has one type.
   */
  affectedSellers(
    market: MarketContext,
    issuerId: Id<'Issuer'>,
    afterSellerId: Id<'Seller'> | null,
    limit: number,
  ): Promise<readonly Id<'Seller'>[]>;

  /** The Market's platform subject (data design 3.22), or null before its first use. */
  platformSubject(market: MarketContext): Promise<Id | null>;
  /** Inserts it; a concurrent insert throws (the caller reads again). */
  addPlatformSubject(
    market: MarketContext,
    subjectId: Id,
    createdAt: Temporal.Instant,
  ): Promise<void>;
}

export const CERTIFICATION_REGISTRY_REPOSITORY = Symbol('CERTIFICATION_REGISTRY_REPOSITORY');
