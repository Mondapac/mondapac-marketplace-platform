import type { ContentHash, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type {
  StoreProfileContent,
  StoreProfileContentInvalid,
} from '../../domain/store-profile-content';
import type { SellerKeyDestroyed } from './seller-file-cipher';
import type { SealedStoreProfileContent } from './store-profile-content.repository';

/** The sealed content of a revision and the keyed hash over the same canonical bytes. */
export interface SealedStoreContent {
  readonly ciphertext: SealedStoreProfileContent;
  readonly contentHash: ContentHash;
}

/**
 * Seals the content of a store profile revision and hashes it (sellers design 8.1; data design
 * 3.8): the canonical JSON under the seller's subject key with the label
 * `sellers.store-profile-revision.content`; the hash is `SubjectKeyService.hmac` with the purpose
 * `sellers.store-profile.content` over the same bytes, so the text cannot be guessed from the
 * hash and both die with the seller's key. Called outside a read-write unit (PP 3.1 row 5). A
 * missing key throws; a destroyed one answers `subject-key.destroyed`; nothing falls back to
 * plaintext. The content never reaches a log or an error.
 */
export interface StoreProfileContentSealer {
  seal(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    content: StoreProfileContent,
  ): Promise<Result<SealedStoreContent, SellerKeyDestroyed | StoreProfileContentInvalid>>;

  /** Opens a stored revision; a content of another shape than the reader knows is invalid. */
  open(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    sealed: SealedStoreProfileContent,
  ): Promise<Result<StoreProfileContent, SellerKeyDestroyed | StoreProfileContentInvalid>>;
}

export const STORE_PROFILE_CONTENT_SEALER = Symbol('STORE_PROFILE_CONTENT_SEALER');
