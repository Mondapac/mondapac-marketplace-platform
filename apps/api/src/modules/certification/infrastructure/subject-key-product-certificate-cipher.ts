import type { MarketContext } from '@mondapac/shared-kernel';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import type {
  ProductCertificateCipher,
  ProductNumberHolder,
} from '../application/ports/product-certificate-cipher';
import {
  PRODUCT_CONTENT_HASH_PURPOSE,
  PRODUCT_HISTORY_NOTE_LABEL,
  PRODUCT_NUMBER_LABELS,
} from './certification-labels';
import type { SubjectKeyRegistryCipher } from './subject-key-registry-cipher';

/**
 * {@link ProductCertificateCipher} on the platform `SubjectKeyService` under the Market's platform
 * subject (data design CE7; slice 14), which the registry cipher creates on first use. The platform
 * key is never destroyed, so a destroyed key is a fault here, never an erasure: it throws.
 */
export class SubjectKeyProductCertificateCipher implements ProductCertificateCipher {
  constructor(
    private readonly keys: SubjectKeyService,
    private readonly registryCipher: SubjectKeyRegistryCipher,
  ) {}

  async sealNumber(
    market: MarketContext,
    holder: ProductNumberHolder,
    number: string,
  ): Promise<string> {
    const subject = await this.registryCipher.platformSubject(market);
    const sealed = await this.keys.encrypt(market, subject, PRODUCT_NUMBER_LABELS[holder], number);
    if (!sealed.ok) throw new Error('certification: the platform subject key was destroyed');
    return sealed.value;
  }

  async openNumber(
    market: MarketContext,
    holder: ProductNumberHolder,
    sealed: string,
  ): Promise<string> {
    const subject = await this.registryCipher.platformSubject(market);
    const opened = await this.keys.decrypt(market, subject, PRODUCT_NUMBER_LABELS[holder], sealed);
    if (!opened.ok) throw new Error('certification: the platform subject key was destroyed');
    return opened.value;
  }

  async sealHistoryNote(market: MarketContext, note: string): Promise<string> {
    const subject = await this.registryCipher.platformSubject(market);
    const sealed = await this.keys.encrypt(market, subject, PRODUCT_HISTORY_NOTE_LABEL, note);
    if (!sealed.ok) throw new Error('certification: the platform subject key was destroyed');
    return sealed.value;
  }

  async contentHash(market: MarketContext, canonicalContent: string): Promise<string> {
    const subject = await this.registryCipher.platformSubject(market);
    const hashed = await this.keys.hmac(
      market,
      subject,
      PRODUCT_CONTENT_HASH_PURPOSE,
      new TextEncoder().encode(canonicalContent),
    );
    if (!hashed.ok) throw new Error('certification: the platform subject key was destroyed');
    return `hmac-sha256:${hashed.value}`;
  }
}
