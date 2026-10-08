import { err, ok } from '@mondapac/shared-kernel';
import type { ContentHash, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { hmacContentHash } from '../../../platform/hashing/content-hash';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import type {
  RevisionContentSealer,
  SealedRevision,
} from '../application/ports/revision-content-sealer';
import type { SellerKeyDestroyed } from '../application/ports/seller-file-cipher';
import {
  canonicalContent,
  parseContent,
  type BusinessFileContent,
  type ContentInvalid,
} from '../domain/business-file-revision';
import type { SealedRevisionContent } from '../domain/sealed';
import { REVISION_CONTENT_HASH_PURPOSE, REVISION_CONTENT_LABEL } from './seller-file-labels';

/**
 * {@link RevisionContentSealer} on the platform `SubjectKeyService` (data design 3.2, 4.2): the
 * subject is the seller id, whose key `identity` created. The same canonical string is encrypted
 * and hashed, so opening a revision and hashing what came out reproduces `content_hash`.
 */
export class SubjectKeyRevisionContentSealer implements RevisionContentSealer {
  constructor(private readonly keys: SubjectKeyService) {}

  async seal(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    content: BusinessFileContent,
  ): Promise<Result<SealedRevision, SellerKeyDestroyed | ContentInvalid>> {
    const canonical = canonicalContent(content);
    if (!canonical.ok) return canonical;
    const hash = await this.hash(market, sellerId, content);
    if (!hash.ok) return hash;
    const sealed = await this.keys.encrypt(
      market,
      sellerId,
      REVISION_CONTENT_LABEL,
      canonical.value,
    );
    if (!sealed.ok) return sealed;
    return ok({ ciphertext: sealed.value as SealedRevisionContent, contentHash: hash.value });
  }

  async open(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    sealed: SealedRevisionContent,
  ): Promise<Result<BusinessFileContent, SellerKeyDestroyed | ContentInvalid>> {
    const opened = await this.keys.decrypt(market, sellerId, REVISION_CONTENT_LABEL, sealed);
    if (!opened.ok) return opened;
    return parseContent(opened.value);
  }

  async hash(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    content: BusinessFileContent,
  ): Promise<Result<ContentHash, SellerKeyDestroyed | ContentInvalid>> {
    const bytes = canonicalContent(content);
    if (!bytes.ok) return err(bytes.error);
    const hex = await this.keys.hmac(
      market,
      sellerId,
      REVISION_CONTENT_HASH_PURPOSE,
      new TextEncoder().encode(bytes.value),
    );
    return hex.ok ? ok(hmacContentHash(hex.value)) : hex;
  }
}
