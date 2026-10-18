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
  'history-note': fieldLabel('certification.history.note'),
  'scope-location': fieldLabel('certification.scope-reading.location'),
  'scope-text': fieldLabel('certification.scope-reading.scope'),
  'confirmation-reference': fieldLabel('certification.issuer-confirmation.reference'),
  'issuer-request-typed-name': fieldLabel('certification.issuer-request.typed-name'),
} satisfies Record<CertificateField, ReturnType<typeof fieldLabel>>);

/** The label under which a file's data key is wrapped (data design 4.2). */
export const DOCUMENT_DATA_KEY_LABEL = fieldLabel('certification.document.data-key');

/** The purpose of `seller_certification_submissions.content_hash` (data design 4.2). */
export const SUBMISSION_CONTENT_HASH_PURPOSE = hashPurpose('certification.submission.content');

/**
 * The registry's admin text (data design CE7, CE8, 3.22). The expert approval is sealed under the
 * Market's platform subject, with one label per column that holds it; the change reason under the
 * key of the row that holds it (a type revision or a relaxation proposal), so one label serves both.
 */
export const EXPERT_REFERENCE_LABELS = Object.freeze({
  issuer: fieldLabel('certification.issuer.expert-reference'),
  proposal: fieldLabel('certification.relaxation-proposal.expert-reference'),
});

export const CHANGE_REASON_LABEL = fieldLabel('certification.registry-change.reason');

/**
 * A manufacturer certificate's number (data design 3.15, 3.16; slice 14), under the Market's
 * platform subject, one label per column; and the purpose of a revision's `content_hash`.
 */
export const PRODUCT_NUMBER_LABELS = Object.freeze({
  draft: fieldLabel('certification.product-certification.draft-certificate-number'),
  revision: fieldLabel('certification.product-certification-revision.certificate-number'),
});

export const PRODUCT_CONTENT_HASH_PURPOSE = hashPurpose('certification.product-revision.content');

/** The note of a manufacturer certificate's suspension or revocation (history row; slice 15). */
export const PRODUCT_HISTORY_NOTE_LABEL = fieldLabel(
  'certification.product-certification.history-note',
);
