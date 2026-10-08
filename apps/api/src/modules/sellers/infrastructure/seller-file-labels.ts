import { fieldLabel, hashPurpose, type FieldLabel } from '../../../platform/subject-keys/labels';
import type { SealedField } from '../domain/sealed';

/** The label of `business_file_revisions.content_ciphertext` (data design 4.2). */
export const REVISION_CONTENT_LABEL = fieldLabel('sellers.business-file-revision.content');

/** The hash purpose of `business_file_revisions.content_hash` (sellers design 2.4 rule 2). */
export const REVISION_CONTENT_HASH_PURPOSE = hashPurpose('sellers.business-file.content');

/**
 * The field labels of the draft's ciphertext columns (sellers data design 4.2; PF 4 row 3):
 * `sellers.seller-file.<field>`. Each is bound into its ciphertext, so a value copied to another
 * column, or to another seller's row, does not decrypt. Constants of this module, never built
 * from input; changing one makes every stored value of its column unreadable.
 */
export const SELLER_FILE_LABELS: Readonly<Record<SealedField, FieldLabel>> = Object.freeze({
  'business-name': fieldLabel('sellers.seller-file.business-name'),
  phone: fieldLabel('sellers.seller-file.phone'),
  'contact-email': fieldLabel('sellers.seller-file.contact-email'),
  address: fieldLabel('sellers.seller-file.address'),
  'registered-address': fieldLabel('sellers.seller-file.registered-address'),
  identifier: fieldLabel('sellers.seller-file.identifier'),
});
