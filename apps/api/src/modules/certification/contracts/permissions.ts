import { declarePermissions, definePermission } from '../../../platform/authz';

// The permission catalogue of certification (certification design 7.1; platform-foundations 6.1).
// A key is declared with the first use case that names it, together with identity's seed of the
// default roles that receive it. The platform keys of the review package are view, review and
// approve; the issuer keys come with the issuer requests (slice 6); revoke and the document, type
// and policy keys come with their slices.

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
 * Change the issuer registry and answer issuer requests (design 7.1; CERT-04). Protected: no
 * default role lists it; the Platform Administrator holds it and grants it in a custom role.
 */
export const CERTIFICATION_ISSUER_EDIT = definePermission('certification', {
  key: 'certification.issuer.edit',
  scope: 'platform',
  protected: true,
});

export const CERTIFICATION_PERMISSIONS = declarePermissions('certification', [
  CERTIFICATION_OWN_CERTIFICATE_VIEW,
  CERTIFICATION_OWN_CERTIFICATE_MANAGE,
  CERTIFICATION_SELLER_CERTIFICATE_VIEW,
  CERTIFICATION_SELLER_CERTIFICATE_REVIEW,
  CERTIFICATION_SELLER_CERTIFICATE_APPROVE,
  CERTIFICATION_ISSUER_VIEW,
  CERTIFICATION_ISSUER_EDIT,
]);
