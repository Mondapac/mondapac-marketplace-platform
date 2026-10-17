import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { DocumentMediaType, DocumentRefusalCode } from '../intake/document-inspection';

/** What a file is after intake: the type found in its content and the bytes to store. */
export interface InspectedDocument {
  readonly mediaType: DocumentMediaType;
  /** The bytes to keep: an image written again from its pixels, a PDF as received. */
  readonly bytes: Buffer;
  readonly pageCount: number | null;
}

/**
 * The intake of an uploaded certificate file (certification design 9.3, simplified): the type
 * from the content only (JPEG, PNG, PDF), a size cap, images decoded and written again without
 * metadata, a PDF checked for encryption, active content and its page count. A refused file is
 * not stored. No scanner and no sandbox in this release.
 */
export interface DocumentIntake {
  inspect(
    bytes: Buffer,
  ): Promise<Result<InspectedDocument, { readonly code: DocumentRefusalCode }>>;
}

export const DOCUMENT_INTAKE = Symbol('CERTIFICATION_DOCUMENT_INTAKE');

/** A stored, encrypted file as the vault needs to find it again. */
export interface VaultedDocument {
  readonly objectKey: string;
  readonly dataKeyEnvelope: string;
  readonly cleanSha256: Buffer;
}

/** The seller's key was destroyed (erasure): nothing can be sealed or opened for them. */
export type SellerKeyDestroyed = { readonly code: 'subject-key.destroyed' };

/**
 * Encrypted storage of the files (design 9.4, simplified: one object store, no evidence bucket).
 * Each file gets a random AES-256-GCM data key; the key is wrapped under the seller's subject key
 * and its envelope is kept in the row. `seal` writes the object and answers what the row keeps;
 * `discard` removes an object (a missing one is not an error).
 */
export interface DocumentVault {
  seal(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    documentId: Id<'UploadedDocument'>,
    plain: Buffer,
  ): Promise<Result<VaultedDocument, SellerKeyDestroyed>>;
  /** The plain bytes; null when the object is gone. The stored hash is checked first. */
  open(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    document: VaultedDocument,
  ): Promise<Result<Buffer | null, SellerKeyDestroyed>>;
  discard(objectKey: string): Promise<void>;
}

export const DOCUMENT_VAULT = Symbol('CERTIFICATION_DOCUMENT_VAULT');

/** The encrypted text fields of a certificate (data design 4.2 labels). */
export type CertificateField =
  | 'draft-certificate-number'
  | 'draft-self-declaration-note'
  | 'submission-certificate-number'
  | 'submission-self-declaration-note';

/**
 * Field encryption and the content hash under the seller's subject key (design 10.1, 10.2).
 * `hash` answers the lower-case hex of the keyed hash of the canonical content.
 */
export interface CertificateFieldCipher {
  seal(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    field: CertificateField,
    value: string,
  ): Promise<Result<string, SellerKeyDestroyed>>;
  open(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    field: CertificateField,
    sealed: string,
  ): Promise<Result<string, SellerKeyDestroyed>>;
  hash(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    canonicalContent: string,
  ): Promise<Result<string, SellerKeyDestroyed>>;
}

export const CERTIFICATE_FIELD_CIPHER = Symbol('CERTIFICATION_CERTIFICATE_FIELD_CIPHER');
