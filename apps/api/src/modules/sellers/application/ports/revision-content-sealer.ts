import type { ContentHash, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { BusinessFileContent, ContentInvalid } from '../../domain/business-file-revision';
import type { SealedRevisionContent } from '../../domain/sealed';
import type { SellerKeyDestroyed } from './seller-file-cipher';

/** The sealed content of a revision and the keyed hash over the same canonical bytes. */
export interface SealedRevision {
  readonly ciphertext: SealedRevisionContent;
  /** `hmac-sha256:<hex>` under the seller's key (design 2.4 rule 2; ADR-0009 decision 6). */
  readonly contentHash: ContentHash;
}

/**
 * Seals the content of a business file revision and hashes it (sellers design 2.4 rule 2; data
 * design 3.2, 4.2): the ciphertext is the canonical JSON under the seller's subject key with the
 * label `sellers.business-file-revision.content`; the hash is `SubjectKeyService.hmac` with the
 * purpose `sellers.business-file.content` over the same canonical bytes, so the content cannot be
 * guessed from the hash and both die with the seller's key. Called outside the use case's
 * read-write unit (PP 3.1 row 5), like `SellerFileCipher`. A missing key throws; a destroyed one
 * answers `subject-key.destroyed`; nothing falls back to plaintext. The content never reaches a
 * log or an error.
 */
export interface RevisionContentSealer {
  seal(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    content: BusinessFileContent,
  ): Promise<Result<SealedRevision, SellerKeyDestroyed | ContentInvalid>>;

  /** Opens a stored revision; a content of another shape than the reader knows is invalid. */
  open(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    sealed: SealedRevisionContent,
  ): Promise<Result<BusinessFileContent, SellerKeyDestroyed | ContentInvalid>>;

  /**
   * The keyed hash of a content, without sealing it: to check that what a reviewer opened is
   * what the revision recorded (an integrity check; the revision's hash is compared by the caller).
   */
  hash(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    content: BusinessFileContent,
  ): Promise<Result<ContentHash, SellerKeyDestroyed | ContentInvalid>>;
}

export const REVISION_CONTENT_SEALER = Symbol('REVISION_CONTENT_SEALER');
