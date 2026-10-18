import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of certification (certification design 7.1; platform-foundations 6.1).
// A key is declared with the first use case that names it, together with identity's seed of the
// default roles that receive it. The platform keys of the review package are view, review and
// approve; the issuer keys come with the issuer requests (slice 6); revoke and the document key
// with slice 11; the type keys with slice 12; the claim-policy keys with slice 13; the
// product-certificate view, edit and approve keys with slice 14 (`.revoke` with slice 15).

/**
 * Read the seller's own certificates, their status codes and reasons, and their own documents
 * (design 7.1). Seller scope: the Seller Owner holds every seller key; Store Manager and
 * Catalogue and Stock receive it by identity's seed.
 */
export const CERTIFICATION_OWN_CERTIFICATE_VIEW = definePermission('certification', {
  key: 'certification.own-certificate.view',
  scope: 'seller',
  protected: false,
});

/**
 * Create, edit, upload, submit and withdraw the seller's own certificates (design 7.1; brief s5,
 * AC 10). Seller scope; the Store Manager receives it by identity's seed.
 */
export const CERTIFICATION_OWN_CERTIFICATE_MANAGE = definePermission('certification', {
  key: 'certification.own-certificate.manage',
  scope: 'seller',
  protected: false,
});

/**
 * The review queue and the lists of seller certificates, with clear fields only: type, status
 * codes, dates, issuer, seller id, kind (design 7.1). No number, no document, no decrypted text.
 * Platform scope; Certification Reviewer and Onboarding and Compliance by identity's seed.
 */
export const CERTIFICATION_SELLER_CERTIFICATE_VIEW = definePermission('certification', {
  key: 'certification.seller-certificate.view',
  scope: 'platform',
  protected: false,
});

/**
 * The review page (decrypts the number, scope and reasons), the reviewer's reads of the files,
 * the record checks, the location and scope, and the issuer confirmation (design 7.1, 7.2). Each
 * decrypting read is audited. Platform scope; Certification Reviewer and Onboarding and
 * Compliance by identity's seed.
 */
export const CERTIFICATION_SELLER_CERTIFICATE_REVIEW = definePermission('certification', {
  key: 'certification.seller-certificate.review',
  scope: 'platform',
  protected: false,
});

/**
 * Approve, request changes and decline (design 7.1; brief s5 protected list). Protected (R11):
 * no default role lists it, the Platform Administrator grants it, and the second person the
 * owner trusts (Q3) holds it through a role granted by an administrator.
 */
export const CERTIFICATION_SELLER_CERTIFICATE_APPROVE = definePermission('certification', {
  key: 'certification.seller-certificate.approve',
  scope: 'platform',
  protected: true,
});

/**
 * Revoke an approved or expired seller certificate with a reason (design 7.1, 3.1; CERT-16, AC 16).
 * Protected (R11; accepted at G2, 19.2 item 7): no default role lists it; the Platform
 * Administrator holds it and grants it in a custom role.
 */
export const CERTIFICATION_SELLER_CERTIFICATE_REVOKE = definePermission('certification', {
  key: 'certification.seller-certificate.revoke',
  scope: 'platform',
  protected: true,
});

/**
 * Read the full status history of a seller certificate (design 7.1, 7.2, 11; VER-14, AC 22), each
 * read audited; later also the download of an original document. Protected: no default role lists
 * it; the Platform Administrator holds it and grants it in a custom role (the design's proposal of
 * the Certification Reviewer as a default holder cannot apply to a protected key, as for `.approve`).
 */
export const CERTIFICATION_DOCUMENT_VIEW = definePermission('certification', {
  key: 'certification.document.view',
  scope: 'platform',
  protected: true,
});

/**
 * The issuer registry and the queue of "my issuer is not listed" requests, including the
 * decrypted typed name and the request's files, each read audited (design 7.1, 7.2). Platform
 * scope; Onboarding and Compliance and Certification Reviewer by identity's seed.
 */
export const CERTIFICATION_ISSUER_VIEW = definePermission('certification', {
  key: 'certification.issuer.view',
  scope: 'platform',
  protected: false,
});

/**
 * Change the issuer registry (create, activate with an expert reference, the two deactivation
 * forms, propose and approve a reactivation, read the expert references) and answer issuer
 * requests (design 3.5, 7.1; CERT-04). A reactivation needs a second holder who is not the
 * proposer (H1). Protected: no default role lists it; the Platform Administrator holds it and
 * grants it in a custom role.
 */
export const CERTIFICATION_ISSUER_EDIT = definePermission('certification', {
  key: 'certification.issuer.edit',
  scope: 'platform',
  protected: true,
});

/**
 * The certification types of the Market: their published revisions, claim terms, status and any
 * pending proposal (design 7.1; CERT-01, CERT-03; slice 12). No personal data: every default admin
 * role holds it by identity's seed.
 */
export const CERTIFICATION_TYPE_VIEW = definePermission('certification', {
  key: 'certification.type.view',
  scope: 'platform',
  protected: false,
});

/**
 * Save a type revision, deactivate a type, propose its reactivation, and approve, reject or
 * withdraw a type proposal (design 3.6, 7.1; slice 12). A relaxing revision and a reactivation
 * need a second holder who is not the proposer (H1). Protected (accepted at G2, 19.2 item 7): no
 * default role lists it; the Platform Administrator holds it and grants it in a custom role.
 */
export const CERTIFICATION_TYPE_EDIT = definePermission('certification', {
  key: 'certification.type.edit',
  scope: 'platform',
  protected: true,
});

/**
 * The claim basis policies of the Market: published rows, revisions with their change reasons and
 * any pending relaxation (design 3.7, 7.1; CERT-42; slice 13). No personal data. Platform scope;
 * Catalogue Moderator and Viewer by identity's seed.
 */
export const CERTIFICATION_CLAIM_POLICY_VIEW = definePermission('certification', {
  key: 'certification.claim-policy.view',
  scope: 'platform',
  protected: false,
});

/**
 * Save a policy revision, and approve, reject or withdraw a policy relaxation (design 3.7, 7.1;
 * slice 13). A relaxing revision needs a second holder who is not its author (H1). Protected: it
 * decides where the manufacturer basis may apply (ADR-0012), so no default role lists it; the
 * Platform Administrator holds it and grants it in a custom role.
 */
export const CERTIFICATION_CLAIM_POLICY_EDIT = definePermission('certification', {
  key: 'certification.claim-policy.edit',
  scope: 'platform',
  protected: true,
});

/**
 * The manufacturer certificates of the Market and their coverage, with clear fields only (design
 * 3.4, 7.1; slice 14): no certificate number, no document. Platform scope; Catalogue Moderator and
 * Certification Reviewer by identity's seed.
 */
export const CERTIFICATION_PRODUCT_CERTIFICATE_VIEW = definePermission('certification', {
  key: 'certification.product-certificate.view',
  scope: 'platform',
  protected: false,
});

/**
 * Record and edit a manufacturer certificate, its fields and its coverage, and submit a revision
 * for review (design 3.4, 7.1; slice 14). Protected: it decides what the manufacturer basis may
 * cover (ADR-0012), so no default role lists it; the Platform Administrator holds it and grants it
 * in a custom role.
 */
export const CERTIFICATION_PRODUCT_CERTIFICATE_EDIT = definePermission('certification', {
  key: 'certification.product-certificate.edit',
  scope: 'platform',
  protected: true,
});

/**
 * Read a pending revision with its certificate number, and approve or reject it, as another person
 * than its creator and editors (design 3.4, 7.1; Q3, AC 20; slice 14). Protected (accepted at G2,
 * 19.2 item 7): no default role lists it; the Platform Administrator holds it and grants it in a
 * custom role (the design's Certification Reviewer default cannot hold a protected key, R11).
 */
export const CERTIFICATION_PRODUCT_CERTIFICATE_APPROVE = definePermission('certification', {
  key: 'certification.product-certificate.approve',
  scope: 'platform',
  protected: true,
});

export const CERTIFICATION_PERMISSIONS = declarePermissions('certification', [
  CERTIFICATION_OWN_CERTIFICATE_VIEW,
  CERTIFICATION_OWN_CERTIFICATE_MANAGE,
  CERTIFICATION_SELLER_CERTIFICATE_VIEW,
  CERTIFICATION_SELLER_CERTIFICATE_REVIEW,
  CERTIFICATION_SELLER_CERTIFICATE_APPROVE,
  CERTIFICATION_SELLER_CERTIFICATE_REVOKE,
  CERTIFICATION_DOCUMENT_VIEW,
  CERTIFICATION_ISSUER_VIEW,
  CERTIFICATION_ISSUER_EDIT,
  CERTIFICATION_TYPE_VIEW,
  CERTIFICATION_TYPE_EDIT,
  CERTIFICATION_CLAIM_POLICY_VIEW,
  CERTIFICATION_CLAIM_POLICY_EDIT,
  CERTIFICATION_PRODUCT_CERTIFICATE_VIEW,
  CERTIFICATION_PRODUCT_CERTIFICATE_EDIT,
  CERTIFICATION_PRODUCT_CERTIFICATE_APPROVE,
]);
