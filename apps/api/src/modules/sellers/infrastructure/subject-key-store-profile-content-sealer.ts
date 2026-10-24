import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { hmacContentHash } from '../../../platform/hashing/content-hash';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import type { SellerKeyDestroyed } from '../application/ports/seller-file-cipher';
import type {
  SealedStoreContent,
  StoreProfileContentSealer,
} from '../application/ports/store-profile-content-sealer';
import type { SealedStoreProfileContent } from '../application/ports/store-profile-content.repository';
import {
  canonicalStoreContent,
  parseStoreContent,
  type StoreProfileContent,
  type StoreProfileContentInvalid,
} from '../domain/store-profile-content';
import {
  STORE_PROFILE_CONTENT_HASH_PURPOSE,
  STORE_PROFILE_CONTENT_LABEL,
} from './seller-file-labels';

/**
 * {@link StoreProfileContentSealer} on the platform `SubjectKeyService` (data design 3.8, 4.2):
 * the subject is the seller id, whose key `identity` created. The same canonical string is
 * encrypted and hashed, so opening a revision and hashing what came out reproduces
 * `content_hash`.
 */
export class SubjectKeyStoreProfileContentSealer implements StoreProfileContentSealer {
  constructor(private readonly keys: SubjectKeyService) {}

  async seal(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    content: StoreProfileContent,
  ): Promise<Result<SealedStoreContent, SellerKeyDestroyed | StoreProfileContentInvalid>> {
    const canonical = canonicalStoreContent(content);
    if (!canonical.ok) return canonical;
    const hex = await this.keys.hmac(
      market,
      sellerId,
      STORE_PROFILE_CONTENT_HASH_PURPOSE,
      new TextEncoder().encode(canonical.value),
    );
    if (!hex.ok) return hex;
    const sealed = await this.keys.encrypt(
      market,
      sellerId,
      STORE_PROFILE_CONTENT_LABEL,
      canonical.value,
    );
    if (!sealed.ok) return sealed;
    return ok({
      ciphertext: sealed.value as SealedStoreProfileContent,
      contentHash: hmacContentHash(hex.value),
    });
  }

  async open(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    sealed: SealedStoreProfileContent,
  ): Promise<Result<StoreProfileContent, SellerKeyDestroyed | StoreProfileContentInvalid>> {
    const opened = await this.keys.decrypt(market, sellerId, STORE_PROFILE_CONTENT_LABEL, sealed);
    if (!opened.ok) return err(opened.error);
    return parseStoreContent(opened.value);
  }
}
