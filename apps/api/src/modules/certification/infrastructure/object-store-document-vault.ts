import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { ObjectStore } from '../../../platform/storage/object-store';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import type {
  DocumentVault,
  SellerKeyDestroyed,
  VaultedDocument,
} from '../application/ports/document-ports';
import { DOCUMENT_DATA_KEY_LABEL } from './certification-labels';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The key of a file's object: `certification/<sellerId>/<documentId>` (design 9.1). */
export function documentObjectKey(
  sellerId: Id<'Seller'>,
  documentId: Id<'UploadedDocument'>,
): string {
  return `certification/${sellerId}/${documentId}`;
}

/**
 * {@link DocumentVault} on the platform object store and the seller's subject key (certification
 * design 9.4 T6 A, simplified: one store, no Object Lock). Each file is encrypted with a random
 * AES-256-GCM key and a random nonce; the stored object is `nonce | tag | ciphertext`, and the
 * object key is the authenticated data, so bytes copied under another key do not open. The data
 * key is wrapped by `SubjectKeyService.encrypt` under the seller's key and kept in the row as the
 * envelope: destroying the seller's key makes every object unreadable. The hash recorded for the
 * row is the SHA-256 of the stored bytes, checked again at every read.
 */
export class ObjectStoreDocumentVault implements DocumentVault {
  constructor(
    private readonly store: ObjectStore,
    private readonly keys: SubjectKeyService,
  ) {}

  async seal(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    documentId: Id<'UploadedDocument'>,
    plain: Buffer,
  ): Promise<Result<VaultedDocument, SellerKeyDestroyed>> {
    const dataKey = randomBytes(KEY_BYTES);
    try {
      const wrapped = await this.keys.encrypt(
        market,
        sellerId,
        DOCUMENT_DATA_KEY_LABEL,
        dataKey.toString('base64'),
      );
      if (!wrapped.ok) return err(wrapped.error);
      const objectKey = documentObjectKey(sellerId, documentId);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
      cipher.setAAD(Buffer.from(objectKey, 'utf8'));
      const body = Buffer.concat([cipher.update(plain), cipher.final()]);
      const stored = Buffer.concat([iv, cipher.getAuthTag(), body]);
      await this.store.put(objectKey, stored);
      return ok({
        objectKey,
        dataKeyEnvelope: wrapped.value,
        cleanSha256: createHash('sha256').update(stored).digest(),
      });
    } finally {
      dataKey.fill(0);
    }
  }

  async open(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    document: VaultedDocument,
  ): Promise<Result<Buffer | null, SellerKeyDestroyed>> {
    const stored = await this.store.get(document.objectKey);
    if (stored === null) return ok(null);
    const hash = createHash('sha256').update(stored).digest();
    if (!hash.equals(document.cleanSha256) || stored.length < IV_BYTES + TAG_BYTES) {
      throw new Error('certification document: the stored bytes do not match their hash');
    }
    const unwrapped = await this.keys.decrypt(
      market,
      sellerId,
      DOCUMENT_DATA_KEY_LABEL,
      document.dataKeyEnvelope,
    );
    if (!unwrapped.ok) return err(unwrapped.error);
    const dataKey = Buffer.from(unwrapped.value, 'base64');
    try {
      const decipher = createDecipheriv('aes-256-gcm', dataKey, stored.subarray(0, IV_BYTES));
      decipher.setAAD(Buffer.from(document.objectKey, 'utf8'));
      decipher.setAuthTag(stored.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return ok(
        Buffer.concat([decipher.update(stored.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]),
      );
    } finally {
      dataKey.fill(0);
    }
  }

  async discard(objectKey: string): Promise<void> {
    await this.store.delete(objectKey);
  }
}
