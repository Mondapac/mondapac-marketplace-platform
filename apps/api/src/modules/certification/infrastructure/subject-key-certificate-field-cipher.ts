import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import type {
  CertificateField,
  CertificateFieldCipher,
  SellerKeyDestroyed,
} from '../application/ports/document-ports';
import { CERTIFICATE_FIELD_LABELS, SUBMISSION_CONTENT_HASH_PURPOSE } from './certification-labels';

/**
 * {@link CertificateFieldCipher} on the platform `SubjectKeyService` (certification design 10.1,
 * 10.2): the subject is the seller id, whose key `identity` created with the seller;
 * `certification` never calls `createKey` (a missing key throws `SubjectKeyMissingError`, a
 * programming error). The v1 envelope and its binding to Market, subject and label are the
 * platform's.
 */
export class SubjectKeyCertificateFieldCipher implements CertificateFieldCipher {
  constructor(private readonly keys: SubjectKeyService) {}

  seal(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    field: CertificateField,
    value: string,
  ): Promise<Result<string, SellerKeyDestroyed>> {
    return this.keys.encrypt(market, sellerId, CERTIFICATE_FIELD_LABELS[field], value);
  }

  open(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    field: CertificateField,
    sealed: string,
  ): Promise<Result<string, SellerKeyDestroyed>> {
    return this.keys.decrypt(market, sellerId, CERTIFICATE_FIELD_LABELS[field], sealed);
  }

  hash(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    canonicalContent: string,
  ): Promise<Result<string, SellerKeyDestroyed>> {
    return this.keys.hmac(
      market,
      sellerId,
      SUBMISSION_CONTENT_HASH_PURPOSE,
      new TextEncoder().encode(canonicalContent),
    );
  }
}
