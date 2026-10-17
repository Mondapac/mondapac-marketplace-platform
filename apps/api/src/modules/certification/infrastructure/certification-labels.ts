import { fieldLabel, hashPurpose } from '../../../platform/subject-keys/labels';
import type { CertificateField } from '../application/ports/document-ports';

/**
 * The labels of the seller's encrypted fields (certification data design 4.2; PF 4 row 3). Each is
 * bound into its ciphertext, so a value copied to another column, or to another seller's row, does
 * not decrypt. Constants of this module, never built from input; changing one makes every stored
 * value of its column unreadable.
 */
export const CERTIFICATE_FIELD_LABELS = Object.freeze({
  'draft-certificate-number': fieldLabel(
    'certification.seller-certification.draft-certificate-number',
  ),
  'draft-self-declaration-note': fieldLabel(
    'certification.seller-certification.draft-self-declaration-note',
  ),
  'submission-certificate-number': fieldLabel('certification.submission.certificate-number'),
  'submission-self-declaration-note': fieldLabel('certification.submission.self-declaration-note'),
  'decision-reason-text': fieldLabel('certification.submission-decision.reason-text'),
  'scope-location': fieldLabel('certification.scope-reading.location'),
  'scope-text': fieldLabel('certification.scope-reading.scope'),
  'confirmation-reference': fieldLabel('certification.issuer-confirmation.reference'),
  'issuer-request-typed-name': fieldLabel('certification.issuer-request.typed-name'),
} satisfies Record<CertificateField, ReturnType<typeof fieldLabel>>);

/** The label under which a file's data key is wrapped (data design 4.2). */
export const DOCUMENT_DATA_KEY_LABEL = fieldLabel('certification.document.data-key');

/** The purpose of `seller_certification_submissions.content_hash` (data design 4.2). */
export const SUBMISSION_CONTENT_HASH_PURPOSE = hashPurpose('certification.submission.content');
