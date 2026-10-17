import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { IssuerRequestOutcome, IssuerRequestState } from '../../domain/issuer-request';
import type { StoredDocument } from './seller-certificate.repository';

/** One request as stored (data design 3.8). The typed name is ciphertext; it is never decrypted here. */
export interface StoredIssuerRequest {
  readonly id: Id<'IssuerRequest'>;
  readonly sellerId: Id<'Seller'>;
  readonly typeId: Id<'CertificationType'>;
  readonly typeCode: string;
  readonly typedNameCiphertext: string;
  readonly state: IssuerRequestState;
  readonly answerReasonCode: string | null;
  readonly issuerId: Id<'Issuer'> | null;
  readonly answeredAt: Temporal.Instant | null;
  readonly version: number;
  readonly createdAt: Temporal.Instant;
  /** The files in order (one today). */
  readonly documents: readonly StoredDocument[];
}

/** A row of the admin queue: clear fields only (no typed name, no file). */
export interface IssuerRequestQueueEntry {
  readonly id: Id<'IssuerRequest'>;
  readonly sellerId: Id<'Seller'>;
  readonly typeCode: string;
  readonly version: number;
  readonly documentCount: number;
  readonly createdAt: Temporal.Instant;
}

/** Everything a new request writes in its one unit: the file, its link and the request. */
export interface NewIssuerRequest {
  readonly id: Id<'IssuerRequest'>;
  readonly sellerId: Id<'Seller'>;
  readonly typeId: Id<'CertificationType'>;
  readonly typedNameCiphertext: string;
  readonly document: {
    readonly id: Id<'UploadedDocument'>;
    readonly mediaType: StoredDocument['mediaType'];
    readonly byteSize: number;
    readonly pageCount: number | null;
    readonly objectKey: string;
    readonly dataKeyEnvelope: string;
    readonly cleanSha256: Buffer;
  };
  readonly now: Temporal.Instant;
}

/** The answer as written: the request moves from `open` once, under its version. */
export interface IssuerRequestAnswerWrite {
  readonly id: Id<'IssuerRequest'>;
  readonly expectedVersion: number;
  readonly outcome: IssuerRequestOutcome;
  readonly issuerId: Id<'Issuer'> | null;
  readonly reasonCode: string | null;
  readonly accountId: Id<'Account'>;
  readonly answeredAt: Temporal.Instant;
}

/** What the answer mail needs: the outcome as stored, the seller, the type code, the reason code. */
export interface IssuerRequestNotice {
  readonly sellerId: Id<'Seller'>;
  readonly typeCode: string;
  readonly state: IssuerRequestState;
  readonly answerReasonCode: string | null;
}

/**
 * `certification.issuer_requests` and its files (data design 3.8). Every method runs in the open
 * unit of its caller and takes the Market from the `MarketContext`; a request of another Market is
 * the same `null` as an unknown id. A write that finds the version moved throws
 * `StaleAggregateError`. No method takes or returns the typed name in clear, and nothing here
 * writes to `issuers`, a draft or a submission (AC 11).
 */
export interface IssuerRequestRepository {
  add(market: MarketContext, request: NewIssuerRequest): Promise<void>;
  /** The open requests of the Market, oldest first (created, then id); at most `cap`. */
  openQueue(market: MarketContext, cap: number): Promise<readonly IssuerRequestQueueEntry[]>;
  find(market: MarketContext, id: Id<'IssuerRequest'>): Promise<StoredIssuerRequest | null>;
  answer(market: MarketContext, write: IssuerRequestAnswerWrite): Promise<void>;
  notice(market: MarketContext, id: Id<'IssuerRequest'>): Promise<IssuerRequestNotice | null>;
}

export const ISSUER_REQUEST_REPOSITORY = Symbol('CERTIFICATION_ISSUER_REQUEST_REPOSITORY');
